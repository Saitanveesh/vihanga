"""Read-only MAVLink from a trusted private WSS relay or localhost UDP SITL.

No aircraft command encoder, serial writer, flight actuation, or synthetic data.
"""
from __future__ import annotations

import asyncio
import os
from collections import Counter, deque
from dataclasses import dataclass, field
from math import degrees, isfinite
import time
from urllib.parse import urlsplit

import httpx
import serial
from pymavlink import mavutil
from pymavlink.dialects.v20 import ardupilotmega as mavlink
from pydantic import BaseModel, ConfigDict, Field, field_validator
from websockets.asyncio.client import connect


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
            if (msg.get_type() == "BAD_DATA" or msg.get_srcSystem() != self.system_id
                    or msg.get_srcComponent() != 1):
                self.invalid_frames += 1
                continue
            now = time.monotonic()
            typ = msg.get_type()
            self.count[typ] += 1
            self.last_frame_at = now
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
            elif typ == "GPS_RAW_INT":
                self._set("gps_fix_type", int(msg.fix_type), now)
                sat = int(msg.satellites_visible)
                if 0 <= sat <= 100:
                    self._set("satellites", sat, now)
            elif typ == "GLOBAL_POSITION_INT":
                lat, lon = msg.lat / 1e7, msg.lon / 1e7
                if (-90 <= lat <= 90 and -180 <= lon <= 180 and
                        (lat != 0 or lon != 0)):
                    self._set("latitude_raw", lat, now)
                    self._set("longitude_raw", lon, now)
                    recent_fix = self.fields.get("gps_fix_type")
                    if recent_fix and recent_fix[0] >= 3 and now - recent_fix[1] <= 5.0:
                        # Real GNSS points only. A position without a valid GPS fix
                        # never becomes part of the flight track.
                        latest = self.track[-1] if self.track else None
                        if latest is None or abs(lat-latest[0]) > 1e-7 or abs(lon-latest[1]) > 1e-7:
                            self.track.append((round(lat, 7), round(lon, 7), now))
                            self.last_track_at = now
                alt = msg.relative_alt / 1000
                if -10000 <= alt <= 100000:
                    self._set("relative_alt_m", round(alt, 2), now)
            elif typ == "SYS_STATUS":
                if 0 <= msg.voltage_battery < 65535:
                    self._set("voltage_v", round(msg.voltage_battery / 1000, 2), now)
                if 0 <= msg.battery_remaining <= 100:
                    self._set("battery_pct", int(msg.battery_remaining), now)
            elif typ == "VFR_HUD":
                if isfinite(msg.groundspeed) and 0 <= msg.groundspeed <= 400:
                    self._set("groundspeed_mps", round(msg.groundspeed, 2), now)
                if isfinite(msg.climb) and abs(msg.climb) <= 150:
                    self._set("climb_mps", round(msg.climb, 2), now)
        return accepted

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
        return {
            "heartbeat_fresh": fresh("heartbeat") is True,
            "attitude_fresh": roll is not None and pitch is not None,
            "gps_fix_type": fix, "satellites": fresh("satellites", 5),
            "latitude": fresh("latitude_raw") if fix is not None and fix >= 3 else None,
            "longitude": fresh("longitude_raw") if fix is not None and fix >= 3 else None,
            "roll_deg": roll, "pitch_deg": pitch, "yaw_deg": fresh("yaw_deg"),
            "mode": fresh("mode"), "armed": fresh("armed"),
            "relative_alt_m": fresh("relative_alt_m"),
            "groundspeed_mps": fresh("groundspeed_mps"),
            "climb_mps": fresh("climb_mps"),
            "voltage_v": fresh("voltage_v"), "battery_pct": fresh("battery_pct"),
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

    def snapshot(self) -> dict:
        sample = self.projector.snapshot()
        state = self.state
        if state == "CONNECTED":
            state = ("LIVE" if sample["heartbeat_fresh"] and sample["attitude_fresh"]
                     else "PARTIAL" if sample["heartbeat_fresh"]
                     else "STALE" if sample["frames_total"] else "WAITING_FOR_FRAMES")
        return {
            "vehicle_id": self.vehicle_id, "transport": self.kind,
            "status": state, "error_code": self.error_code,
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
    def __init__(self):
        self.sessions: dict[str, Session] = {}

    def snapshot(self, vehicle_id):
        session = self.sessions.get(vehicle_id)
        if session:
            return session.snapshot()
        return {
            "vehicle_id": vehicle_id, "transport": None,
            "status": "OFFLINE", "error_code": None,
            "flight_control_enabled": False, **MAVLinkProjector(1).snapshot()
        }

    async def stop(self, vehicle_id):
        session = self.sessions.pop(vehicle_id, None)
        if session is None:
            return
        if session.udp:
            session.udp.close()
        if session.tcp_writer is not None:
            session.tcp_writer.close()
        if session.serial_port is not None:
            session.serial_port.close()
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
        while True:
            try:
                session.state = "CONNECTING" if failures == 0 else "RECONNECTING"
                session.error_code = None
                # Replace projector before every reconnect, no stale epochs.
                session.projector = MAVLinkProjector(session.projector.system_id)
                uri = origin.replace("https://", "wss://", 1) + (
                    "/ws/v1/view/" + session.vehicle_id)
                async with connect(uri,
                                   additional_headers={"Authorization": "Bearer " + token},
                                   open_timeout=10, close_timeout=3, ping_interval=15,
                                   max_size=1024, max_queue=16) as ws:
                    session.state = "CONNECTED"
                    failures = 0
                    async for raw in ws:
                        if isinstance(raw, bytes):
                            session.projector.push(raw)
                session.projector = MAVLinkProjector(session.projector.system_id)
                session.state, session.error_code = "RECONNECTING", "BROKER_VIEWER_CLOSED"
                failures += 1
            except asyncio.CancelledError:
                raise
            except Exception:
                session.projector = MAVLinkProjector(session.projector.system_id)
                session.state, session.error_code = "RECONNECTING", "BROKER_UNAVAILABLE"
                failures += 1
            await asyncio.sleep(min(2 ** min(failures, 4), 20))

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
                    failures = 0
                    session.state = "CONNECTED"
                    async for raw in ws:
                        if isinstance(raw, bytes):
                            session.projector.push(raw)
                session.projector = MAVLinkProjector(session.projector.system_id)
                session.state, session.error_code = "RECONNECTING", "CLOUD_VIEWER_CLOSED"
                failures = max(failures, 1)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Do not expose relay address, token or user credentials.
                session.projector = MAVLinkProjector(session.projector.system_id)
                session.state, session.error_code = "RECONNECTING", "PRIVATE_CLOUD_UNAVAILABLE"
                failures += 1
            # Exponential, bounded reconnect. Never automatically dispatch commands.
            await asyncio.sleep(min(2 ** min(failures, 4), 20))
