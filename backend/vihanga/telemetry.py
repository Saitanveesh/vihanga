"""Read-only MAVLink from a trusted private WSS relay or localhost UDP SITL.

No aircraft command encoder, serial writer, flight actuation, or synthetic data.
"""
from __future__ import annotations

import asyncio
import os
import ssl
from pathlib import Path
from ipaddress import ip_address, ip_network
from collections import Counter, deque
from dataclasses import dataclass, field
from math import degrees, isfinite
import time
from urllib.parse import urlsplit

import httpx
import serial
from vihanga.operator_contract import BenchQuery, encode_bench_query
from pymavlink import mavutil
from pymavlink.dialects.v20 import ardupilotmega as mavlink
from pydantic import BaseModel, ConfigDict, Field, field_validator
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus
from vihanga.link_evidence import UpstreamEvidence, poll_upstream
from random import uniform


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CloudConnect(StrictModel):
    vehicle_id: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
    origin: str = Field(min_length=15, max_length=255)
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=512)
    fc_system_id: int = Field(ge=1, le=254)


class BrokerConnect(StrictModel):
    vehicle_id: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
    origin: str = Field(min_length=15, max_length=255)
    viewer_token: str = Field(min_length=32, max_length=512)
    fc_system_id: int = Field(ge=1, le=254)


def validate_broker_origin(origin: str) -> str:
    """No arbitrary SSRF. Allow private ts.net or explicitly provisioned hosts."""
    from ipaddress import ip_address
    try:
        p = urlsplit(origin)
        port = p.port
        host = p.hostname.lower() if p.hostname else ""
    except ValueError as exc:
        raise ValueError("Invalid broker origin") from exc
    approved = {x.lower().strip() for x in
                os.environ.get("VIHANGA_APPROVED_CLOUD_HOSTS", "").split(",") if x.strip()}
    valid_host = host.endswith(".ts.net") or host in approved
    if (p.scheme != "https" or not host or not valid_host
            or port not in (None, 443, 8443) or p.username or p.password
            or p.path not in ("", "/") or p.query or p.fragment):
        raise ValueError("Vihanga broker origin is not explicitly approved")
    try:
        ip_address(host)
        raise ValueError("Literal IP targets cannot be used as cloud origins")
    except ValueError as exc:
        if str(exc).startswith("Literal IP"):
            raise
    return "https://" + host + (":" + str(port) if port is not None else "")


class LanConnect(StrictModel):
    """Direct secure Wi-Fi connection to the Pi, not an Oracle broker."""
    vehicle_id: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
    origin: str = Field(min_length=20, max_length=255)
    viewer_token: str = Field(min_length=32, max_length=512)
    fc_system_id: int = Field(ge=1, le=254)


def validate_lan_origin(origin: str) -> str:
    """Direct local TLS only; forbid DNS rebinding, credentials and Internet IPs."""
    try:
        p = urlsplit(origin)
        host = p.hostname
        port = p.port
        addr = ip_address(host) if host else None
    except ValueError as exc:
        raise ValueError("Expected a direct private IPv4 LAN HTTPS origin") from exc
    allowed = bool(addr is not None and addr.version == 4 and any(
        addr in ip_network(cidr) for cidr in (
            "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"
        )))
    if (p.scheme != "https" or not allowed or
            port is None or not 8765 <= port <= 8775 or
            p.path not in ("", "/") or p.username or p.password or
            p.query or p.fragment):
        raise ValueError("LAN receiver must use private IPv4 HTTPS on an approved port")
    return f"https://{host}:{port}"


def verified_lan_ssl() -> ssl.SSLContext:
    """Require operator-provisioned trust anchor and TLS hostname checking."""
    cert = os.environ.get("VIHANGA_LAN_CA_CERT", "")
    if not cert or not Path(cert).is_absolute() or not Path(cert).is_file():
        raise ValueError("Configure VIHANGA_LAN_CA_CERT to a trusted local Pi certificate")
    context = ssl.create_default_context(cafile=cert)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


class UDPConnect(StrictModel):
    vehicle_id: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
    port: int = Field(ge=1024, le=65535)
    fc_system_id: int = Field(ge=1, le=254)


class TCPConnect(StrictModel):
    vehicle_id: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
    port: int = Field(ge=1024, le=65535)
    fc_system_id: int = Field(ge=1, le=254)


class SerialConnect(StrictModel):
    vehicle_id: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
    port: str = Field(pattern=r"^(COM[1-9][0-9]{0,2}|/dev/tty(?:USB|ACM)[0-9]{1,2})$")
    baud: int = Field(default=57600)
    fc_system_id: int = Field(ge=1, le=254)

    @field_validator("baud")
    @classmethod
    def check_baud(cls, baud: int):
        if baud not in (9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600):
            raise ValueError("Unsupported MAVLink baud rate")
        return baud


def validate_private_origin(origin: str) -> str:
    try:
        p = urlsplit(origin)
        port = p.port
    except ValueError as ex:
        raise ValueError("Invalid relay address") from ex
    if (p.scheme != "https" or not p.hostname or not p.hostname.lower().endswith(".ts.net")
            or port != 8443 or p.username or p.password or p.path not in ("", "/")
            or p.query or p.fragment):
        raise ValueError("Expected exact private https://<host>.ts.net:8443 origin")
    return f"https://{p.hostname.lower()}:8443"


@dataclass
class MAVLinkProjector:
    system_id: int
    parser: mavlink.MAVLink = field(default_factory=lambda: mavlink.MAVLink(None))
    count: Counter[str] = field(default_factory=Counter)
    fields: dict[str, tuple[object, float]] = field(default_factory=dict)
    invalid_frames: int = 0
    last_frame_at: float = -1.0
    track: deque = field(default_factory=lambda: deque(maxlen=1500))
    last_track_at: float = -1.0
    track_distance_m: float = 0.0
    recent_frames: deque = field(default_factory=lambda: deque(maxlen=512))
    # Parameter cache is bounded and only stores verified FC-origin responses.
    parameters: dict[str, tuple[float, int, float]] = field(default_factory=dict)
    parameter_total: int | None = None

    # Raw RF readings are transport-dependent. They are not dBm or percent.
    # Sensor flags are only available when SYS_STATUS actually arrives.


    def _set(self, key, value, now):
        self.fields[key] = (value, now)

    def push(self, raw: bytes) -> int:
        if not isinstance(raw, bytes) or not 1 <= len(raw) <= 1200:
            self.invalid_frames += 1
            return 0
        try:
            messages = self.parser.parse_buffer(raw) or []
        except Exception:
            self.invalid_frames += 1
            self.parser = mavlink.MAVLink(None)
            return 0
        accepted = 0
        for msg in messages:
            typ = msg.get_type()
            comp = msg.get_srcComponent()
            # FC state must come only from AUTOPILOT1 (component 1).
            # RADIO_STATUS may legitimately originate from MAV_COMP_ID_
            # TELEMETRY_RADIO (68) using the same aircraft system ID.
            radio_component = typ == "RADIO_STATUS" and comp == 68
            if (typ == "BAD_DATA" or msg.get_srcSystem() != self.system_id
                    or (comp != 1 and not radio_component)):
                self.invalid_frames += 1
                continue
            now = time.monotonic()
            self.count[typ] += 1
            self.last_frame_at = now
            self.recent_frames.append(now)
            accepted += 1
            if typ == "HEARTBEAT":
                self._set("heartbeat", True, now)
                self._set("armed", bool(msg.base_mode & mavlink.MAV_MODE_FLAG_SAFETY_ARMED), now)
                try:
                    mode = mavutil.mode_string_v10(msg)
                except Exception:
                    mode = "UNKNOWN"
                self._set("mode", mode, now)
            elif typ == "ATTITUDE":
                vals = [degrees(v) for v in (msg.roll, msg.pitch, msg.yaw)]
                if all(isfinite(v) for v in vals) and abs(vals[0]) <= 180 and abs(vals[1]) <= 90:
                    for name, value in zip(("roll_deg", "pitch_deg", "yaw_deg"), vals):
                        self._set(name, round(value, 2), now)
            elif typ == "HOME_POSITION":
                lat, lon = msg.latitude / 1e7, msg.longitude / 1e7
                if -90 <= lat <= 90 and -180 <= lon <= 180 and (lat or lon):
                    self._set("home", {"latitude": lat, "longitude": lon, "altitude_msl_m": msg.altitude / 1000}, now)
                else:
                    self.fields.pop("home", None)
            elif typ == "GPS2_RAW":
                fix2 = int(msg.fix_type)
                if 0 <= fix2 <= 6:
                    self._set("gps2_fix_type", fix2, now)
                sat2 = int(msg.satellites_visible)
                if 0 <= sat2 <= 100:
                    self._set("gps2_satellites", sat2, now)
            elif typ == "GPS_RAW_INT":
                self._set("gps_fix_type", int(msg.fix_type), now)
                if int(msg.fix_type) < 3:
                    self.fields.pop("latitude_raw", None)
                    self.fields.pop("longitude_raw", None)
                sat = int(msg.satellites_visible)
                if 0 <= sat <= 100:
                    self._set("satellites", sat, now)
            elif typ == "GLOBAL_POSITION_INT":
                lat, lon = msg.lat / 1e7, msg.lon / 1e7
                if (-90 <= lat <= 90 and -180 <= lon <= 180 and
                        (lat != 0 or lon != 0)):
                    recent_fix = self.fields.get("gps_fix_type")
                    if recent_fix and recent_fix[0] >= 3 and now - recent_fix[1] <= 5.0:
                        # A position without a valid recent GPS fix must not
                        # appear on either the live map or the flight track.
                        self._set("latitude_raw", lat, now)
                        self._set("longitude_raw", lon, now)
                        latest = self.track[-1] if self.track else None
                        if latest is None or abs(lat-latest[0]) > 1e-7 or abs(lon-latest[1]) > 1e-7:
                            self.track.append((round(lat, 7), round(lon, 7), now))
                            self.last_track_at = now
                alt = msg.relative_alt / 1000
                if -10000 <= alt <= 100000:
                    self._set("relative_alt_m", round(alt, 2), now)
            elif typ == "STATUSTEXT":
                # ArduPilot reports RC loss/restoration as FC-origin events.
                # Do not treat regular RC_CHANNELS updates as RF link proof:
                # a flight controller may keep reporting receiver-failsafe PWM.
                value = msg.text
                text = (value.decode("utf-8", "replace") if isinstance(value, bytes)
                        else str(value)).strip().lower().rstrip("\\x00")
                if "radio failsafe" in text or "rc failsafe" in text:
                    if any(term in text for term in ("cleared", "recovered", "ended", "off")):
                        self._set("rc_failsafe_event", False, now)
                    elif not any(term in text for term in ("disabled", "not enabled")):
                        self._set("rc_failsafe_event", True, now)
            elif typ in ("RC_CHANNELS", "RC_CHANNELS_RAW"):
                # Pixhawk's RC receiver (FlySky/IBUS/PPM/SBUS) is not a
                # MAVLink RADIO_STATUS telemetry modem. FC channel samples
                # are independent evidence and never create a backup GCS link.
                declared = int(msg.chancount) if typ == "RC_CHANNELS" else 8
                if 1 <= declared <= 18:
                    observed = [
                        int(getattr(msg, f"chan{i}_raw"))
                        for i in range(1, min(declared, 18) + 1)
                    ]
                    # Missing/invalid channels cannot establish live input.
                    valid = sum(1 for value in observed if 800 <= value <= 2200)
                    if valid:
                        self._set("rc_channel_count", valid, now)
                        self._set("rc_message_type", typ, now)
                        rssi = int(msg.rssi)
                        if 0 <= rssi < 255:
                            self._set("rc_rssi_raw", rssi, now)
                        else:
                            self.fields.pop("rc_rssi_raw", None)
            elif typ == "RADIO_STATUS":
                for name, raw_value in (
                    ("radio_rssi_raw", int(msg.rssi)),
                    ("radio_remote_rssi_raw", int(msg.remrssi)),
                    ("radio_noise_raw", int(msg.noise)),
                    ("radio_rx_errors", int(msg.rxerrors)),
                    ("radio_fixed_packets", int(msg.fixed)),
                    ("radio_txbuf_raw", int(msg.txbuf)),
                ):
                    if raw_value >= 0 and (name not in (
                        "radio_rssi_raw", "radio_remote_rssi_raw") or raw_value < 255):
                        self._set(name, raw_value, now)
            elif typ == "SYS_STATUS":
                # MAV_SYS_STATUS_SENSOR flags: 3D_GYRO=0, 3D_ACCEL=1,
                # 3D_MAG=2, GPS=5, RC_RECEIVER=16. Decode only reported
                # presence/enabled/health; never infer from packet arrival.
                present = int(msg.onboard_control_sensors_present)
                enabled = int(msg.onboard_control_sensors_enabled)
                healthy = int(msg.onboard_control_sensors_health)
                sensors = {}
                for label, bit in (
                    ("gyroscope", 0), ("accelerometer", 1),
                    ("magnetometer", 2), ("gps", 5),
                    ("rc_receiver", 16)
                ):
                    flag = 1 << bit
                    sensors[label] = ("ABSENT" if not present & flag
                        else "DISABLED" if not enabled & flag
                        else "HEALTHY" if healthy & flag else "FAULT")
                self._set("sensor_health", sensors, now)
                current = int(msg.current_battery)
                if 0 <= current < 32767:
                    self._set("battery_current_a", round(current / 100, 2), now)
                if 0 <= msg.voltage_battery < 65535:
                    self._set("voltage_v", round(msg.voltage_battery / 1000, 2), now)
                if 0 <= msg.battery_remaining <= 100:
                    self._set("battery_pct", int(msg.battery_remaining), now)
            elif typ == "PARAM_VALUE":
                raw_name = msg.param_id
                name = raw_name.decode("ascii", "ignore") if isinstance(raw_name, bytes) else str(raw_name)
                name = name.split("\x00", 1)[0].strip()
                value = float(msg.param_value)
                if (name and len(name) <= 16 and name.isascii() and
                        all(c.isalnum() or c == "_" for c in name) and isfinite(value)):
                    # Oldest value first. Never allow unbounded FC input to
                    # consume all GCS memory.
                    if name not in self.parameters and len(self.parameters) >= 1500:
                        oldest = next(iter(self.parameters))
                        del self.parameters[oldest]
                    self.parameters[name] = (value, int(msg.param_type), now)
                    count = int(msg.param_count)
                    if 0 <= count <= 100000:
                        self.parameter_total = count
            elif typ == "VFR_HUD":
                if isfinite(msg.airspeed) and 0 <= msg.airspeed <= 400:
                    self._set("airspeed_mps", round(msg.airspeed, 2), now)
                if 0 <= int(msg.throttle) <= 100:
                    self._set("throttle_pct", int(msg.throttle), now)
                if isfinite(msg.groundspeed) and 0 <= msg.groundspeed <= 400:
                    self._set("groundspeed_mps", round(msg.groundspeed, 2), now)
                if isfinite(msg.climb) and abs(msg.climb) <= 150:
                    self._set("climb_mps", round(msg.climb, 2), now)
        return accepted

    def parameter_snapshot(self) -> dict:
        return {
            "status": "OBSERVED_FC_PARAMETERS_ONLY",
            "received": len(self.parameters),
            "reported_total": self.parameter_total,
            "items": {name: {"value": value, "type": kind}
                      for name, (value, kind, _) in sorted(self.parameters.items())},
            "warning": "Readback values are not configuration changes. No parameter writes are enabled."
        }

    def track_snapshot(self) -> dict:
        return {
            "status": "RECEIVED_GNSS_ONLY",
            "points": [{"latitude": lat, "longitude": lon}
                       for lat, lon, _ in self.track],
            "count": len(self.track),
            "warning": "Track is a volatile observed position record, not a flight plan"
        }

    def snapshot(self) -> dict:
        now = time.monotonic()
        def fresh(name, limit=3.0):
            item = self.fields.get(name)
            return item[0] if item is not None and now - item[1] <= limit else None
        fix = fresh("gps_fix_type", 5)
        roll, pitch = fresh("roll_deg"), fresh("pitch_deg")
        rc_count = fresh("rc_channel_count", 5)
        sensors = fresh("sensor_health", 5)
        rc_sensor = sensors.get("rc_receiver") if sensors else None
        # Only reported FC flags or fresh RC channel samples may inform state.
        # Channel updates alone are not proof that the receiver is failsafe-free.
        rc_failsafe = self.fields.get("rc_failsafe_event", (None, 0))[0]
        rc_state = (
            "FAILSAFE" if rc_failsafe is True else
            "FC_FAULT" if rc_sensor == "FAULT" else
            "FC_DISABLED" if rc_sensor == "DISABLED" else
            "FC_ABSENT" if rc_sensor == "ABSENT" else
            "CHANNELS_REPORTED" if rc_count is not None else
            "FC_HEALTHY" if rc_sensor == "HEALTHY" else "NOT_REPORTED"
        )
        return {
            "heartbeat_fresh": fresh("heartbeat") is True,
            "attitude_fresh": roll is not None and pitch is not None,
            "home": self.fields.get("home", (None,))[0],
            "gps_fix_type": fix, "satellites": fresh("satellites", 5),
            "gps2_fix_type": fresh("gps2_fix_type", 5),
            "gps2_satellites": fresh("gps2_satellites", 5),
            "latitude": fresh("latitude_raw") if fix is not None and fix >= 3 else None,
            "longitude": fresh("longitude_raw") if fix is not None and fix >= 3 else None,
            "roll_deg": roll, "pitch_deg": pitch, "yaw_deg": fresh("yaw_deg"),
            "mode": fresh("mode"), "armed": fresh("armed"),
            "relative_alt_m": fresh("relative_alt_m"),
            "groundspeed_mps": fresh("groundspeed_mps"),
            "airspeed_mps": fresh("airspeed_mps"),
            "throttle_pct": fresh("throttle_pct"),
            "climb_mps": fresh("climb_mps"),
            "voltage_v": fresh("voltage_v"), "battery_pct": fresh("battery_pct"),
            "battery_current_a": fresh("battery_current_a"),
            "radio_rssi_raw": fresh("radio_rssi_raw", 5),
            "radio_remote_rssi_raw": fresh("radio_remote_rssi_raw", 5),
            "radio_noise_raw": fresh("radio_noise_raw", 5),
            "radio_rx_errors": fresh("radio_rx_errors", 5),
            "radio_fixed_packets": fresh("radio_fixed_packets", 5),
            "radio_txbuf_raw": fresh("radio_txbuf_raw", 5),
            "sensor_health": sensors,
            "rc_input_status": rc_state,
            "rc_failsafe_reported": rc_failsafe,
            "rc_channels_fresh": rc_count is not None,
            "rc_channel_count": rc_count,
            "rc_rssi_raw": fresh("rc_rssi_raw", 5),
            "rc_message_type": fresh("rc_message_type", 5),
            "frame_rate_5s_hz": round(sum(
                1 for stamp in self.recent_frames if 0 <= now - stamp <= 5) / 5, 2),
            "frames_total": sum(self.count.values()),
            "message_counts": dict(self.count), "rejected_frames": self.invalid_frames,
            "age_ms": round((now - self.last_frame_at) * 1000) if self.last_frame_at >= 0 else None,
            "track_points": len(self.track)
        }


@dataclass
class Session:
    vehicle_id: str
    kind: str
    projector: MAVLinkProjector
    state: str = "CONNECTING"
    error_code: str | None = None
    task: asyncio.Task | None = None
    udp: asyncio.DatagramTransport | None = None
    serial_port: object | None = None
    tcp_writer: asyncio.StreamWriter | None = None
    bench_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=8))
    bench_last_request_at: float = -1.0
    bench_sent: int = 0
    upstream: tuple[UpstreamEvidence, float] | None = None
    connected_at: float | None = None
    reconnect_attempt: int = 0

    def snapshot(self) -> dict:
        state = self.state
        # A broken transport is not evidence of live data, even if its last
        # packet was received 100 ms ago. Hide cached instruments instantly
        # on failure/reconnect rather than waiting out each field TTL.
        sample = (self.projector.snapshot() if state == "CONNECTED"
                  else MAVLinkProjector(self.projector.system_id).snapshot())
        if state == "CONNECTED":
            state = ("LIVE" if sample["heartbeat_fresh"] and sample["attitude_fresh"]
                     else "PARTIAL" if sample["heartbeat_fresh"]
                     else "STALE" if sample["frames_total"] else "WAITING_FOR_FRAMES")
        return {
            "vehicle_id": self.vehicle_id, "transport": self.kind,
            "status": state, "error_code": self.error_code,
            "path_evidence": self.upstream[0].snapshot(self.upstream[1], sample["age_ms"]) if self.upstream else None,
            "reconnect_attempt": self.reconnect_attempt,
            "flight_control_enabled": False, **sample
        }


class UDPReceiver(asyncio.DatagramProtocol):
    def __init__(self, session):
        self.session = session

    def datagram_received(self, data, addr):
        if addr[0] in ("127.0.0.1", "::1"):
            self.session.projector.push(data)

    def error_received(self, exc):
        self.session.error_code = "UDP_SOCKET_FAILURE"


class LinkManager:
    """Two independent receive-only sources per registered aircraft.

    The primary session retains the established API contract. A second
    LinkManager owns the standby receiver's sockets and reconnect task.
    Promotion is explicit and only permitted after fresh FC evidence.
    No MAVLink write path or automatic flight-control failover exists.
    """
    def __init__(self):
        self.sessions: dict[str, Session] = {}
        self.standby_managers: dict[str, LinkManager] = {}
        self.selected_sources: dict[str, str] = {}
        self._standby_lock = asyncio.Lock()

    def active_session(self, vehicle_id: str) -> Session | None:
        if self.selected_sources.get(vehicle_id) == "BACKUP":
            standby = self.standby_managers.get(vehicle_id)
            return standby.sessions.get(vehicle_id) if standby else None
        return self.sessions.get(vehicle_id)

    def snapshot(self, vehicle_id):
        primary = self.sessions.get(vehicle_id)
        manager = self.standby_managers.get(vehicle_id)
        backup = manager.sessions.get(vehicle_id) if manager else None
        role = self.selected_sources.get(vehicle_id, "PRIMARY")
        pri = primary.snapshot() if primary else None
        bak = backup.snapshot() if backup else None
        active = bak if role == "BACKUP" else pri
        selected_sample = active if active else {
            "vehicle_id": vehicle_id, "transport": None,
            "status": "OFFLINE", "error_code": None,
            "flight_control_enabled": False, **MAVLinkProjector(1).snapshot()
        }
        return {
            **selected_sample, "active_source": role,
            "primary_status": pri["status"] if pri else "OFFLINE",
            "primary_transport": pri["transport"] if pri else None,
            "primary_error_code": pri["error_code"] if pri else None,
            "primary_heartbeat_fresh": pri["heartbeat_fresh"] if pri else False,
            "primary_attitude_fresh": pri["attitude_fresh"] if pri else False,
            "primary_frame_rate_5s_hz": pri["frame_rate_5s_hz"] if pri else None,
            "primary_age_ms": pri["age_ms"] if pri else None,
            "primary_system_id": primary.projector.system_id if primary else None,
            "primary_path_evidence": pri["path_evidence"] if pri else None,
            "primary_frames_total": pri["frames_total"] if pri else None,
            "primary_reconnect_attempt": pri["reconnect_attempt"] if pri else None,
            "backup_status": bak["status"] if bak else "NOT_CONFIGURED",
            "backup_transport": bak["transport"] if bak else None,
            "backup_error_code": bak["error_code"] if bak else None,
            "backup_heartbeat_fresh": bak["heartbeat_fresh"] if bak else False,
            "backup_attitude_fresh": bak["attitude_fresh"] if bak else False,
            "backup_frame_rate_5s_hz": bak["frame_rate_5s_hz"] if bak else None,
            "backup_age_ms": bak["age_ms"] if bak else None,
            "backup_system_id": backup.projector.system_id if backup else None,
            "backup_serial_port": getattr(backup.serial_port, "port", None) if backup else None,
            "backup_path_evidence": bak["path_evidence"] if bak else None,
            "backup_frames_total": bak["frames_total"] if bak else None,
            "backup_reconnect_attempt": bak["reconnect_attempt"] if bak else None,
        }

    async def start_backup(self, request):
        # One concurrent provisioning transaction per manager. Prevents two
        # simultaneous HTTP requests creating orphaned serial/TCP readers.
        async with self._standby_lock:
            vehicle_id = request.vehicle_id
            primary = self.sessions.get(vehicle_id)
            if primary is None:
                raise ValueError("Connect primary telemetry before configuring backup")
            if vehicle_id in self.standby_managers:
                raise ValueError("Remove the existing backup receiver first")
            kinds = {
                BrokerConnect: ("VIHANGA_CLOUD_V2", "start_broker"),
                LanConnect: ("DIRECT_LAN_WSS", "start_lan"),
                CloudConnect: ("PRIVATE_CLOUD_WSS", "start_cloud"),
                SerialConnect: ("LOCAL_SERIAL_RECEIVE", "start_serial"),
                TCPConnect: ("LOCAL_TCP_RECEIVE", "start_tcp"),
                UDPConnect: ("LOCAL_UDP_SITL", "start_udp"),
            }
            key = type(request)
            if key not in kinds:
                raise ValueError("Unsupported backup transport")
            backup_kind, method = kinds[key]
            if primary.kind == backup_kind:
                raise ValueError("Backup must use a different transport type")
            if primary.projector.system_id != request.fc_system_id:
                raise ValueError("Backup FC system ID must match primary aircraft")
            # The subsidiary manager owns its independent read-only task/socket.
            # No alias to primary's parser or serial file handle is created.
            standby = LinkManager()
            await getattr(standby, method)(request)
            # The primary may have been disconnected while opening a
            # secondary TCP or serial socket. Do not retain an orphaned
            # standby receiver if its parent session changed.
            if self.sessions.get(vehicle_id) is not primary:
                await standby.stop(vehicle_id)
                raise ValueError("Primary receiver changed during standby setup")
            self.standby_managers[vehicle_id] = standby
            return self.snapshot(vehicle_id)

    def select_source(self, vehicle_id: str, source: str):
        if source not in ("PRIMARY", "BACKUP"):
            raise ValueError("Invalid telemetry source")
        target = (self.sessions.get(vehicle_id) if source == "PRIMARY"
                  else self.standby_managers.get(vehicle_id).sessions.get(vehicle_id)
                  if vehicle_id in self.standby_managers else None)
        if target is None or target.snapshot()["status"] != "LIVE":
            raise ValueError("Selected receiver needs fresh FC heartbeat and attitude")
        self.selected_sources[vehicle_id] = source
        return self.snapshot(vehicle_id)

    async def stop_backup(self, vehicle_id: str):
        async with self._standby_lock:
            standby = self.standby_managers.pop(vehicle_id, None)
            # Explicit removal of an active backup returns to the primary's
            # actual status, even if stale. No fictitious LIVE fallback.
            self.selected_sources.pop(vehicle_id, None)
            if standby:
                await standby.stop(vehicle_id)
            return self.snapshot(vehicle_id)

    async def stop(self, vehicle_id):
        if vehicle_id in self.standby_managers:
            await self.stop_backup(vehicle_id)
        self.selected_sources.pop(vehicle_id, None)
        session = self.sessions.pop(vehicle_id, None)
        if session is None:
            return
        if session.udp:
            session.udp.close()
        if session.tcp_writer is not None:
            session.tcp_writer.close()
        if session.serial_port is not None:
            session.serial_port.close()
        # Cancel pending queries before the receiver is shut down.
        while not session.bench_queue.empty():
            try:
                _packet, future = session.bench_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if not future.done():
                future.set_exception(RuntimeError("Serial receiver disconnected"))
        if session.task:
            session.task.cancel()
            try:
                await session.task
            except asyncio.CancelledError:
                pass

    async def start_udp(self, request: UDPConnect):
        if request.vehicle_id in self.sessions:
            raise ValueError("Disconnect the existing aircraft link first")
        s = Session(request.vehicle_id, "LOCAL_UDP_SITL", MAVLinkProjector(request.fc_system_id))
        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: UDPReceiver(s), local_addr=("127.0.0.1", request.port))
        s.udp = transport
        s.state = "CONNECTED"
        self.sessions[request.vehicle_id] = s
        return s.snapshot()

    async def start_serial(self, request: SerialConnect):
        if request.vehicle_id in self.sessions:
            raise ValueError("Disconnect the existing aircraft link first")
        # Only physical serial receive; no write() or MAVLink command sender.
        port = serial.Serial(request.port, request.baud, timeout=0.2)
        s = Session(request.vehicle_id, "LOCAL_SERIAL_RECEIVE", MAVLinkProjector(request.fc_system_id))
        s.serial_port = port
        s.state = "CONNECTED"
        self.sessions[request.vehicle_id] = s
        s.task = asyncio.create_task(self._read_serial(s))
        return s.snapshot()

    async def _read_serial(self, session: Session):
        try:
            while True:
                # One actor owns both directions of the serial port.
                # Queries are specifically allowlisted elsewhere and are never
                # arbitrary MAVLink packets supplied by an HTTP caller.
                if not session.bench_queue.empty():
                    packet, future = session.bench_queue.get_nowait()
                    try:
                        if session.state != "CONNECTED":
                            raise RuntimeError("Serial link not connected")
                        count = await asyncio.to_thread(session.serial_port.write, packet)
                        if count != len(packet):
                            raise RuntimeError("Incomplete serial request write")
                        session.bench_sent += 1
                        if not future.done():
                            future.set_result(count)
                    except Exception as exc:
                        if not future.done():
                            future.set_exception(exc)
                chunk = await asyncio.to_thread(session.serial_port.read, 512)
                if chunk:
                    session.projector.push(bytes(chunk))
        except asyncio.CancelledError:
            raise
        except Exception:
            session.state, session.error_code = "ERROR", "SERIAL_READ_FAILURE"
        finally:
            if session.serial_port is not None:
                session.serial_port.close()

    async def bench_request(self, vehicle_id: str, query: BenchQuery) -> dict:
        """Send a non-actuating read request through the existing serial owner.

        A serial write is not FC acknowledgement or command completion.
        Disabled by default, loopback-only, and never through the cloud.
        """
        if os.environ.get("VIHANGA_BENCH_READ_REQUESTS") != "1":
            raise ValueError("Bench read requests are disabled by default")
        session = self.active_session(vehicle_id)
        if (session is None or session.kind != "LOCAL_SERIAL_RECEIVE" or
                session.state != "CONNECTED" or session.serial_port is None or
                session.task is None or session.task.done()):
            raise ValueError("Connect a local serial receiver before bench requests")
        sample = session.projector.snapshot()
        if not sample["heartbeat_fresh"] or sample["armed"] is not False:
            raise ValueError("Fresh disarmed FC heartbeat required for bench reads")
        # Defense in depth: the serial owner performs the allowlist encoding.
        # Callers never provide arbitrary MAVLink bytes for transmission.
        packet = encode_bench_query(query, session.projector.system_id)
        if session.bench_queue.full():
            raise ValueError("Bench request queue full")
        now = time.monotonic()
        if session.bench_last_request_at >= 0 and now - session.bench_last_request_at < 0.25:
            raise ValueError("Bench read request rate limit")
        session.bench_last_request_at = now
        future = asyncio.get_running_loop().create_future()
        session.bench_queue.put_nowait((packet, future))
        try:
            written = await asyncio.wait_for(future, timeout=2.0)
        except (asyncio.TimeoutError, RuntimeError) as exc:
            raise ValueError("Bench serial request not confirmed as written") from exc
        return {
            "vehicle_id": vehicle_id,
            "result": "SERIAL_WRITE_COMPLETED",
            "bytes_written": written,
            "fc_acknowledged": False,
            "flight_control_enabled": False,
            "warning": "A request was written to the bench serial port. FC response is separate."
        }

    async def start_tcp(self, request: TCPConnect):
        if request.vehicle_id in self.sessions:
            raise ValueError("Disconnect the existing aircraft link first")
        # Localhost only, so arbitrary Internet/edge/vehicle targets cannot be dialed.
        reader, writer = await asyncio.open_connection("127.0.0.1", request.port)
        s = Session(request.vehicle_id, "LOCAL_TCP_RECEIVE", MAVLinkProjector(request.fc_system_id))
        s.tcp_writer = writer
        s.state = "CONNECTED"
        self.sessions[request.vehicle_id] = s
        s.task = asyncio.create_task(self._read_tcp(s, reader))
        return s.snapshot()

    async def _read_tcp(self, session: Session, reader: asyncio.StreamReader):
        try:
            while True:
                chunk = await reader.read(512)
                if not chunk:
                    session.state, session.error_code = "DISCONNECTED", "TCP_CLOSED"
                    return
                session.projector.push(chunk)
        except asyncio.CancelledError:
            raise
        except Exception:
            session.state, session.error_code = "ERROR", "TCP_READ_FAILURE"
        finally:
            if session.tcp_writer is not None:
                session.tcp_writer.close()

    async def start_lan(self, request: LanConnect):
        if request.vehicle_id in self.sessions:
            raise ValueError("Disconnect the existing aircraft link first")
        origin = validate_lan_origin(request.origin)
        # Validate certificate trust *before* starting the background task.
        context = verified_lan_ssl()
        session = Session(request.vehicle_id, "DIRECT_LAN_WSS",
                          MAVLinkProjector(request.fc_system_id))
        self.sessions[request.vehicle_id] = session
        session.task = asyncio.create_task(
            self._run_lan(session, origin, request.viewer_token, context))
        return session.snapshot()

    async def _run_lan(self, session: Session, origin: str,
                       token: str, context: ssl.SSLContext):
        """Authenticated, certificate-verified receive-only LAN client.

        This transport has no outbound MAVLink data path. Network loss resets
        cached FC state and reconnect starts from a new projector epoch.
        """
        failures = 0
        while True:
            try:
                session.state = "CONNECTING" if failures == 0 else "RECONNECTING"
                session.error_code = None
                session.projector = MAVLinkProjector(session.projector.system_id)
                uri = origin.replace("https://", "wss://", 1) + (
                    "/ws/v1/view/" + session.vehicle_id)
                async with connect(
                    uri, ssl=context,
                    additional_headers={"Authorization": "Bearer " + token},
                    open_timeout=5, close_timeout=3, ping_interval=15,
                    max_size=1024, max_queue=16, compression=None
                ) as ws:
                    await self._receive_view(session, ws)
                error = "LAN_VIEWER_CLOSED"
            except asyncio.CancelledError:
                raise
            except (ssl.SSLError, ssl.CertificateError):
                session.projector = MAVLinkProjector(session.projector.system_id)
                session.state, session.error_code = "ERROR", "LAN_TLS_TRUST_REJECTED"
                return
            except Exception:
                error = "LAN_VIEWER_UNAVAILABLE"
            failures = await self._retry_view(session, failures, error)

    @staticmethod
    async def _receive_view(session: Session, ws) -> None:
        session.state = "CONNECTED"
        session.connected_at = time.monotonic()
        async for raw in ws:
            if isinstance(raw, bytes):
                session.projector.push(raw)

    @staticmethod
    async def _retry_view(session: Session, failures: int, error: str) -> int:
        last = session.projector.snapshot()
        stable = (session.connected_at is not None and time.monotonic() - session.connected_at >= 15
                  and last["heartbeat_fresh"] and last["attitude_fresh"])
        failures = 1 if stable else min(failures + 1, 5)
        session.connected_at = None
        session.reconnect_attempt = failures
        session.projector = MAVLinkProjector(session.projector.system_id)
        session.state, session.error_code = "RECONNECTING", error
        await asyncio.sleep(min(20, 2 ** failures * uniform(.8, 1.2)))
        return failures

    async def start_broker(self, request: BrokerConnect):
        if request.vehicle_id in self.sessions:
            raise ValueError("Disconnect the existing aircraft link first")
        origin = validate_broker_origin(request.origin)
        session = Session(request.vehicle_id, "VIHANGA_CLOUD_V2", MAVLinkProjector(request.fc_system_id))
        self.sessions[request.vehicle_id] = session
        session.task = asyncio.create_task(
            self._run_broker(session, origin, request.viewer_token))
        return session.snapshot()

    async def _run_broker(self, session: Session, origin: str, token: str):
        """WebSocket viewer with vehicle-bound token and no command write path."""
        failures = 0
        # A working diagnostics endpoint can explain a failed viewer handshake or an idle stream.
        monitor = asyncio.create_task(poll_upstream(session, origin, token))
        uri = origin.replace("https://", "wss://", 1) + "/ws/v1/view/" + session.vehicle_id
        try:
            while True:
                try:
                    async with connect(uri, additional_headers={"Authorization": "Bearer " + token},
                                       open_timeout=10, close_timeout=3, ping_interval=15,
                                       max_size=1024, max_queue=16) as ws:
                        session.error_code = None
                        await self._receive_view(session, ws)
                    error = "BROKER_VIEWER_CLOSED"
                except InvalidStatus as exc:
                    error = ("BROKER_AUTH_REJECTED" if exc.response.status_code in (401, 403)
                             else "BROKER_UNAVAILABLE")
                except ConnectionClosed as exc:
                    error = ("BROKER_AUTH_REJECTED" if exc.rcvd and exc.rcvd.code == 4401
                             else "BROKER_VIEWER_CLOSED")
                except Exception:
                    error = "BROKER_UNAVAILABLE"
                failures = await self._retry_view(session, failures, error)
        finally:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
            session.upstream = None

    async def start_cloud(self, request: CloudConnect):
        if request.vehicle_id in self.sessions:
            raise ValueError("Disconnect the existing aircraft link first")
        origin = validate_private_origin(request.origin)
        s = Session(request.vehicle_id, "PRIVATE_CLOUD_WSS", MAVLinkProjector(request.fc_system_id))
        self.sessions[request.vehicle_id] = s
        s.task = asyncio.create_task(self._run_cloud(s, origin, request.username, request.password))
        return s.snapshot()

    async def _run_cloud(self, session, origin, username, password):
        """Reauthenticate after JWT expiry without replaying stale telemetry."""
        failures = 0
        while True:
            try:
                session.state = "CONNECTING" if failures == 0 else "RECONNECTING"
                session.error_code = None
                async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                    response = await client.post(origin + "/api/v1/auth/login", json={
                        "username": username, "password": password})
                if response.status_code in (401, 403):
                    session.state, session.error_code = "ERROR", "CLOUD_AUTH_REJECTED"
                    return
                if response.status_code != 200:
                    raise RuntimeError("login unavailable")
                token = response.json().get("access_token")
                if not isinstance(token, str) or len(token) < 20:
                    session.state, session.error_code = "ERROR", "INVALID_LOGIN_RESPONSE"
                    return
                uri = origin.replace("https://", "wss://", 1) + (
                    "/ws/mavlink/view/" + session.vehicle_id)
                # New epoch: old data must never be presented as live on reconnect.
                session.projector = MAVLinkProjector(session.projector.system_id)
                async with connect(uri, additional_headers={"Authorization": "Bearer " + token},
                                   open_timeout=10, close_timeout=3, ping_interval=15,
                                   max_size=1024, max_queue=16) as ws:
                    await self._receive_view(session, ws)
                error = "CLOUD_VIEWER_CLOSED"
            except asyncio.CancelledError:
                raise
            except Exception:
                # Do not expose relay address, token or user credentials.
                error = "PRIVATE_CLOUD_UNAVAILABLE"
            failures = await self._retry_view(session, failures, error)
