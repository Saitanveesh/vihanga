"""Vihanga supervised command authority — **simulator contract only**.

This module has NO hardware network/serial writer and is NOT installed into the
edge agent. It validates command lifecycle, assigns serialized MAVLink2 packets,
and handles real FC COMMAND_ACK plus observed state. Physical authorization,
onboard failsafes and field acceptance remain outside this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from io import BytesIO
from math import isfinite
import secrets
import time
from typing import Callable
from uuid import UUID

from pymavlink.dialects.v20 import ardupilotmega as mavlink


class Action(str, Enum):
    ARM = "ARM"
    DISARM = "DISARM"
    TAKEOFF = "TAKEOFF"
    RTL = "RTL"
    LAND = "LAND"


class Status(str, Enum):
    PENDING = "PENDING"
    ENCODED = "ENCODED"  # serialization complete; not proof of FC receipt
    FC_ACKNOWLEDGED = "FC_ACKNOWLEDGED"
    OBSERVED = "OBSERVED"
    REJECTED = "REJECTED"
    TIMED_OUT = "TIMED_OUT"
    UNKNOWN = "UNKNOWN"


class Refused(ValueError):
    """Fail-closed authorization or lifecycle rejection."""


@dataclass(frozen=True)
class VehicleHealth:
    vehicle_id: str
    system_id: int
    heartbeat_fresh: bool
    attitude_fresh: bool
    gps_fix: int | None
    home_verified: bool
    battery_pct: int | None
    failsafe: bool
    armed: bool | None
    mode: str | None
    altitude_m: float | None
    operator_override_available: bool
    is_ardupilot_sitl: bool  # verified by test harness; never inferred from UI
    observed_at: float


@dataclass
class Lease:
    vehicle_id: str
    pilot_identity: str
    token: str
    expires_at: float
    last_sequence: int = 0
    epoch: int = 1


@dataclass
class Command:
    command_id: str
    vehicle_id: str
    pilot_identity: str
    action: Action
    sequence: int
    expires_at: float
    system_id: int
    altitude_m: float | None
    status: Status = Status.PENDING
    fc_command_id: int | None = None
    reason: str | None = None
    encoded_packet: bytes | None = None
    submitted_at: float = 0.0
    fc_ack_at: float | None = None
    observed_at: float | None = None


class Authority:
    """One active pilot lease and one outstanding FC command per vehicle.

    Invariants: no implicit lease takeover, no auto-replay after reconnect,
    no false 'success' without both FC ACK and confirmed state transition.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.leases: dict[str, Lease] = {}
        self.commands: dict[str, Command] = {}
        self.active: dict[str, str] = {}
        self.events: list[tuple[float, str, str, str]] = []
        self._generation: dict[str, int] = {}

    def _log(self, vehicle: str, event: str, reason: str = "") -> None:
        self.events.append((self.clock(), vehicle, event, reason))

    def _check_snapshot(self, health: VehicleHealth, require_nav: bool):
        now = self.clock()
        if not health.is_ardupilot_sitl:
            raise Refused("SITL_ONLY")
        if health.observed_at > now or now - health.observed_at > 2:
            raise Refused("STALE_HEALTH")
        if not health.heartbeat_fresh or not health.attitude_fresh:
            raise Refused("MISSING_MAVLINK")
        if not health.operator_override_available or health.failsafe:
            raise Refused("PILOT_OVERRIDE_OR_FAILSAFE")
        if not 1 <= health.system_id <= 254:
            raise Refused("INVALID_FC_ID")
        if health.battery_pct is None or health.battery_pct < 20:
            raise Refused("BATTERY_NOT_VERIFIED")
        if require_nav and (health.gps_fix is None or health.gps_fix < 3 or
                            not health.home_verified):
            raise Refused("NAVIGATION_NOT_READY")

    def claim(self, vehicle: str, pilot: str, role: str, health: VehicleHealth) -> Lease:
        self._check_snapshot(health, require_nav=False)
        if role != "PILOT" or not pilot or vehicle != health.vehicle_id:
            raise Refused("PILOT_IDENTITY_REQUIRED")
        now = self.clock()
        current = self.leases.get(vehicle)
        if current and current.expires_at > now:
            raise Refused("AIRCRAFT_ALREADY_LEASED")
        epoch = self._generation.get(vehicle, 0) + 1
        self._generation[vehicle] = epoch
        lease = Lease(vehicle_id=vehicle, pilot_identity=pilot,
                      token=secrets.token_urlsafe(32), expires_at=now + 30, epoch=epoch)
        self.leases[vehicle] = lease
        self._log(vehicle, "LEASE_GRANTED", f"epoch={epoch}")
        return lease

    def revoke(self, vehicle: str, reason: str):
        self.leases.pop(vehicle, None)
        pending_id = self.active.pop(vehicle, None)
        if pending_id and pending_id in self.commands:
            command = self.commands[pending_id]
            if command.status not in (Status.OBSERVED, Status.REJECTED, Status.TIMED_OUT):
                command.status = Status.UNKNOWN
                command.reason = "REVOKED_" + reason
        self._log(vehicle, "LEASE_REVOKED", reason)

    def issue(self, *, lease_token: str, vehicle: str, pilot: str,
              command_id: str, sequence: int, action: Action,
              deadline: float, health: VehicleHealth,
              altitude_m: float | None = None) -> Command:
        now = self.clock()
        try:
            canonical_id = str(UUID(command_id))
        except (ValueError, TypeError) as exc:
            raise Refused("INVALID_REQUEST_ID") from exc
        if canonical_id != command_id:
            raise Refused("NONCANONICAL_REQUEST_ID")
        if canonical_id in self.commands:
            raise Refused("DUPLICATE_COMMAND_ID")
        lease = self.leases.get(vehicle)
        if (not lease or lease.expires_at <= now or lease.token != lease_token or
                lease.pilot_identity != pilot or vehicle != health.vehicle_id):
            raise Refused("NO_ACTIVE_PILOT_LEASE")
        if sequence <= lease.last_sequence or sequence > lease.last_sequence + 1000:
            raise Refused("REPLAY_OR_INVALID_SEQUENCE")
        if not now < deadline <= now + 5:
            raise Refused("EXPIRED_OR_OVERSIZED_TTL")
        if vehicle in self.active:
            raise Refused("COMMAND_ALREADY_PENDING")
        self._check_snapshot(health, require_nav=action in (Action.TAKEOFF, Action.RTL, Action.LAND))
        if action == Action.ARM and health.armed is not False:
            raise Refused("ARM_STATE_UNVERIFIED")
        if action == Action.DISARM and health.armed is not True:
            raise Refused("DISARM_STATE_UNVERIFIED")
        if action == Action.TAKEOFF and health.armed is not True:
            raise Refused("TAKEOFF_NOT_ARMED")
        if action == Action.TAKEOFF:
            if altitude_m is None or not isfinite(altitude_m) or not 2 <= altitude_m <= 50:
                raise Refused("TAKEOFF_ALTITUDE_INVALID")
        elif altitude_m is not None:
            raise Refused("UNEXPECTED_ALTITUDE")

        lease.last_sequence = sequence
        command = Command(canonical_id, vehicle, pilot, action, sequence,
                          deadline, health.system_id, altitude_m, submitted_at=now)
        self.commands[canonical_id] = command
        self.active[vehicle] = canonical_id
        self._log(vehicle, "REQUEST_ACCEPTED", action.value)
        return command

    def encode(self, command_id: str) -> bytes:
        command = self.commands.get(command_id)
        now = self.clock()
        if not command or command.status != Status.PENDING:
            raise Refused("UNKNOWN_OR_NON_PENDING_COMMAND")
        if now >= command.expires_at:
            self.expire(command_id)
            raise Refused("COMMAND_EXPIRED")
        mapping = {
            Action.ARM: mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            Action.DISARM: mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            Action.RTL: mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH,
            Action.LAND: mavlink.MAV_CMD_NAV_LAND,
            Action.TAKEOFF: mavlink.MAV_CMD_NAV_TAKEOFF,
        }
        cmd = mapping[command.action]
        parameters = [0.0] * 7
        if command.action == Action.ARM: parameters[0] = 1.0
        if command.action == Action.TAKEOFF: parameters[6] = command.altitude_m
        codec = mavlink.MAVLink(BytesIO())
        codec.srcSystem = 255
        codec.srcComponent = 190
        message = mavlink.MAVLink_command_long_message(
            command.system_id, 1, cmd, 0, *parameters)
        raw = message.pack(codec)
        command.encoded_packet = raw
        command.fc_command_id = cmd
        command.status = Status.ENCODED
        self._log(command.vehicle_id, "MAVLINK_ENCODED", str(cmd))
        return raw

    def accept_fc_ack(self, command_id: str, msg, source_system: int) -> bool:
        cmd = self.commands.get(command_id)
        if not cmd or cmd.status != Status.ENCODED:
            return False
        if self.clock() >= cmd.expires_at:
            self.expire(command_id)
            return False
        if (msg.get_type() != "COMMAND_ACK" or source_system != cmd.system_id or
                int(msg.command) != cmd.fc_command_id):
            return False
        if int(msg.result) != mavlink.MAV_RESULT_ACCEPTED:
            cmd.status, cmd.reason = Status.REJECTED, "FC_RESULT_" + str(int(msg.result))
            self.active.pop(cmd.vehicle_id, None)
            self._log(cmd.vehicle_id, "FC_REJECTED", cmd.reason)
            return True
        cmd.status = Status.FC_ACKNOWLEDGED
        cmd.fc_ack_at = self.clock()
        self._log(cmd.vehicle_id, "FC_ACKNOWLEDGED", str(cmd.fc_command_id))
        return True

    def observe(self, command_id: str, health: VehicleHealth) -> bool:
        cmd = self.commands.get(command_id)
        if not cmd or cmd.status != Status.FC_ACKNOWLEDGED:
            return False
        if self.clock() >= cmd.expires_at:
            self.expire(command_id)
            return False
        if (health.vehicle_id != cmd.vehicle_id or health.system_id != cmd.system_id or
                not health.heartbeat_fresh):
            return False
        observed = {
            Action.ARM: health.armed is True,
            Action.DISARM: health.armed is False,
            Action.RTL: health.mode == "RTL",
            Action.LAND: health.mode == "LAND",
            # Takeoff requires actual positive altitude from FC, not merely
            # its acceptance of a MAV_CMD_NAV_TAKEOFF.
            Action.TAKEOFF: (health.armed is True and health.altitude_m is not None and
                             health.altitude_m >= max(1.0, cmd.altitude_m * .5)),
        }[cmd.action]
        if not observed:
            return False
        cmd.status = Status.OBSERVED
        cmd.observed_at = self.clock()
        self.active.pop(cmd.vehicle_id, None)
        self._log(cmd.vehicle_id, "FC_STATE_OBSERVED", cmd.action.value)
        return True

    def expire(self, command_id: str):
        cmd = self.commands.get(command_id)
        if cmd and cmd.status not in (Status.OBSERVED, Status.REJECTED, Status.TIMED_OUT):
            cmd.status, cmd.reason = Status.TIMED_OUT, "ACK_OR_EFFECT_NOT_VERIFIED"
            self.active.pop(cmd.vehicle_id, None)
            self._log(cmd.vehicle_id, "COMMAND_TIMED_OUT", cmd.action.value)

