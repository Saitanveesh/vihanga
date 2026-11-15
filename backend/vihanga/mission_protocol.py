"""MAVLink2 MISSION_ITEM_INT upload and readback transaction engine.

Pure protocol state machine for SITL/HIL tests. No serial/network command
transport. An FC MISSION_ACK means *accepted*, not that a mission was read back
or executed. Mission execution is explicitly outside this engine.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from hashlib import sha256
from io import BytesIO
import json
from math import isfinite
import time
from typing import Callable

from pymavlink.dialects.v20 import ardupilotmega as mavlink


class MissionFault(ValueError):
    pass


class Phase(str, Enum):
    READY = "READY"
    WAITING_ITEMS = "WAITING_ITEMS"
    WAITING_UPLOAD_ACK = "WAITING_UPLOAD_ACK"
    UPLOAD_ACCEPTED = "UPLOAD_ACCEPTED"
    WAITING_READBACK_COUNT = "WAITING_READBACK_COUNT"
    WAITING_READBACK_ITEMS = "WAITING_READBACK_ITEMS"
    VERIFIED = "VERIFIED"
    REFUSED = "REFUSED"
    TIMED_OUT = "TIMED_OUT"


@dataclass(frozen=True)
class MissionPoint:
    latitude: float
    longitude: float
    altitude_m: float

    def validate(self):
        if (not all(isfinite(x) for x in (self.latitude, self.longitude, self.altitude_m))
                or not -90 <= self.latitude <= 90 or not -180 <= self.longitude <= 180
                or not 0 <= self.altitude_m <= 120):
            raise MissionFault("Invalid geographic mission point")


class MissionTransaction:
    """One immutable plan, one verified FC SYSID, bounded item transfer."""

    def __init__(self, *, system_id: int, waypoints: list[MissionPoint],
                 expected_revision: str | None = None,
                 clock: Callable[[], float] = time.monotonic):
        if not 1 <= system_id <= 254:
            raise MissionFault("Invalid flight controller identity")
        if not 2 <= len(waypoints) <= 200:
            raise MissionFault("Only 2..200 mission waypoints are supported")
        self.system_id = system_id
        self.waypoints = tuple(waypoints)
        for point in self.waypoints:
            point.validate()
        self.fixed = [(round(p.latitude * 1e7), round(p.longitude * 1e7),
                       round(p.altitude_m, 2)) for p in self.waypoints]
        canonical = json.dumps(self.fixed, separators=(",", ":"))
        self.revision = sha256(canonical.encode("utf-8")).hexdigest()
        if expected_revision is not None and self.revision != expected_revision:
            raise MissionFault("Mission revision mismatch; refusing stale plan")
        self.phase = Phase.READY
        self.requested: set[int] = set()
        self.readback: set[int] = set()
        self.attempts: dict[int, int] = {}
        self.clock = clock
        self.last_event = clock()
        self.reason: str | None = None

    def _valid_source(self, message, src_system: int) -> bool:
        return src_system == self.system_id and message.get_srcComponent() == 1

    def _touch(self):
        if self.phase in (Phase.REFUSED, Phase.TIMED_OUT):
            raise MissionFault(self.reason or "Transaction has failed")
        if self.phase != Phase.READY and self.clock() - self.last_event > 6:
            self.phase, self.reason = Phase.TIMED_OUT, "MISSION_PROTOCOL_TIMEOUT"
            raise MissionFault(self.reason)
        self.last_event = self.clock()

    def _encode(self, message) -> bytes:
        writer = mavlink.MAVLink(BytesIO())
        writer.srcSystem = 255
        writer.srcComponent = 190
        return message.pack(writer)

    def begin_upload(self) -> bytes:
        if self.phase != Phase.READY:
            raise MissionFault("Mission upload already started")
        self._touch()
        self.phase = Phase.WAITING_ITEMS
        return self._encode(mavlink.MAVLink_mission_count_message(
            self.system_id, 1, len(self.waypoints), mavlink.MAV_MISSION_TYPE_MISSION))

    def on_request_int(self, message, src_system: int) -> bytes:
        self._touch()
        if self.phase not in (Phase.WAITING_ITEMS, Phase.WAITING_UPLOAD_ACK):
            raise MissionFault("FC item request outside mission upload")
        if message.get_type() != "MISSION_REQUEST_INT" or not self._valid_source(message, src_system):
            raise MissionFault("Untrusted or unsupported mission request")
        index = int(message.seq)
        if not 0 <= index < len(self.waypoints):
            raise MissionFault("FC requested mission item out of bounds")
        attempts = self.attempts.get(index, 0) + 1
        if attempts > 3:
            self.phase, self.reason = Phase.REFUSED, "TOO_MANY_ITEM_RETRIES"
            raise MissionFault(self.reason)
        self.attempts[index] = attempts
        self.requested.add(index)
        x, y, z = self.fixed[index]
        result = self._encode(mavlink.MAVLink_mission_item_int_message(
            self.system_id, 1, index, mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            mavlink.MAV_CMD_NAV_WAYPOINT, 1 if index == 0 else 0, 1,
            0, 0, 0, 0, x, y, z, mavlink.MAV_MISSION_TYPE_MISSION))
        if len(self.requested) == len(self.waypoints):
            self.phase = Phase.WAITING_UPLOAD_ACK
        return result

    def on_upload_ack(self, message, src_system: int) -> bool:
        self._touch()
        if (self.phase != Phase.WAITING_UPLOAD_ACK or message.get_type() != "MISSION_ACK"
                or not self._valid_source(message, src_system)):
            return False
        if int(message.type) != mavlink.MAV_MISSION_ACCEPTED:
            self.phase = Phase.REFUSED
            self.reason = "FC_REJECTED_MISSION_" + str(int(message.type))
            return True
        self.phase = Phase.UPLOAD_ACCEPTED
        return True

    def begin_readback(self) -> bytes:
        if self.phase != Phase.UPLOAD_ACCEPTED:
            raise MissionFault("FC must accept upload before readback")
        self._touch()
        self.phase = Phase.WAITING_READBACK_COUNT
        return self._encode(mavlink.MAVLink_mission_request_list_message(
            self.system_id, 1, mavlink.MAV_MISSION_TYPE_MISSION))

    def on_readback_count(self, message, src_system: int) -> bytes:
        self._touch()
        if (self.phase != Phase.WAITING_READBACK_COUNT or message.get_type() != "MISSION_COUNT"
                or not self._valid_source(message, src_system)):
            raise MissionFault("Unexpected or untrusted mission count")
        if int(message.count) != len(self.waypoints):
            self.phase, self.reason = Phase.REFUSED, "MISSION_READBACK_COUNT_MISMATCH"
            raise MissionFault(self.reason)
        self.phase = Phase.WAITING_READBACK_ITEMS
        return self._readback_request(0)

    def _readback_request(self, index: int) -> bytes:
        return self._encode(mavlink.MAVLink_mission_request_int_message(
            self.system_id, 1, index, mavlink.MAV_MISSION_TYPE_MISSION))

    def on_readback_item(self, message, src_system: int) -> bytes | None:
        self._touch()
        if (self.phase != Phase.WAITING_READBACK_ITEMS or
                message.get_type() != "MISSION_ITEM_INT" or
                not self._valid_source(message, src_system)):
            raise MissionFault("Unexpected or untrusted readback mission item")
        index = int(message.seq)
        if index != len(self.readback):
            raise MissionFault("Readback item sequence out of order")
        x, y, z = self.fixed[index]
        # Geographic lat/lon are exact E7. Altitude is rounded to cm.
        if (int(message.x) != x or int(message.y) != y or
                abs(float(message.z) - z) > 0.011 or
                int(message.frame) != mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT or
                int(message.command) != mavlink.MAV_CMD_NAV_WAYPOINT):
            self.phase, self.reason = Phase.REFUSED, "READBACK_ITEM_MISMATCH"
            raise MissionFault(self.reason)
        self.readback.add(index)
        if len(self.readback) == len(self.waypoints):
            self.phase = Phase.VERIFIED
            return None
        return self._readback_request(index + 1)

    def summary(self) -> dict:
        return {
            "phase": self.phase.value, "revision_sha256": self.revision,
            "waypoints": len(self.waypoints), "items_requested": len(self.requested),
            "items_read_back": len(self.readback),
            "fc_upload_accepted": self.phase in (
                Phase.UPLOAD_ACCEPTED, Phase.WAITING_READBACK_COUNT,
                Phase.WAITING_READBACK_ITEMS, Phase.VERIFIED),
            "verified": self.phase == Phase.VERIFIED,
            "mission_started": False,
            "reason": self.reason
        }
