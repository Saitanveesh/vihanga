"""Vihanga single-owner Pi edge: one UART, independent cloud and local LAN viewers.

Both paths are read-only. Loss of Oracle/cloud does not release the Pi UART or
interrupt locally authenticated telemetry. No serial write() exists here.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import fcntl
from ipaddress import ip_address
import time
import json
import logging
import os
from pathlib import Path
from random import uniform
import re
from urllib.parse import urlsplit

import serial
from pymavlink.dialects.v20 import ardupilotmega as mavlink
from websockets.asyncio.client import connect
from vihanga_edge.lan import LanFanout

LOG = logging.getLogger("vihanga.edge")
DIAGNOSTICS_PROTOCOL = "vihanga-diagnostics.v1"
VALID_MESSAGES = frozenset({
    "HEARTBEAT", "ATTITUDE", "GPS_RAW_INT", "GPS2_RAW", "GLOBAL_POSITION_INT",
    "SYS_STATUS", "BATTERY_STATUS", "VFR_HUD", "STATUSTEXT", "HOME_POSITION",
    "EXTENDED_SYS_STATE", "EKF_STATUS_REPORT", "MISSION_CURRENT",
    "MISSION_ITEM_REACHED", "LOCAL_POSITION_NED", "NAV_CONTROLLER_OUTPUT",
    "COMMAND_ACK", "RADIO_STATUS", "RC_CHANNELS", "RC_CHANNELS_RAW",
    "GPS_STATUS", "AUTOPILOT_VERSION"
})


def retry_delay(attempt: int) -> float:
    return min(20, 2 ** min(attempt, 5) * uniform(.8, 1.2))


@dataclass(frozen=True)
class Settings:
    vehicle_id: str
    system_id: int
    port: str
    baud: int
    cloud_wss: str
    token: str
    lockfile: str = "/tmp/vihanga-edge-serial.lock"
    lan_token: str = ""
    lan_bind_host: str = "127.0.0.1"
    lan_port: int = 8765
    lan_cert: str = ""
    lan_key: str = ""

    def validate(self) -> None:
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{2,31}", self.vehicle_id):
            raise ValueError("Invalid device ID")
        if not 1 <= self.system_id <= 254:
            raise ValueError("Invalid FC system ID")
        if not re.fullmatch(r"/dev/(?:ttyAMA|ttyUSB|ttyACM|ttyS)[0-9]{1,2}", self.port):
            raise ValueError("Edge port must be an approved Linux serial path")
        if self.baud not in (9600,19200,38400,57600,115200,230400,460800,921600):
            raise ValueError("Unsupported MAVLink baud")
        u = urlsplit(self.cloud_wss)
        if (u.scheme != "wss" or not u.hostname or u.username or u.password or
                u.query or u.fragment or u.path != "/ws/v1/device/" + self.vehicle_id):
            raise ValueError("WSS URL must be the exact vehicle-scoped TLS device endpoint")
        if len(self.token) < 32 or any(ch.isspace() for ch in self.token):
            raise ValueError("Device token missing or too short")
        if not Path(self.lockfile).is_absolute():
            raise ValueError("Serial lock must be an absolute path")
        if self.lan_token or self.lan_cert or self.lan_key:
            if not self.lan_token or not self.lan_cert or not self.lan_key:
                raise ValueError("All LAN token/TLS certificate/key fields are required")
            if (len(self.lan_token) < 32 or any(c.isspace() for c in self.lan_token)
                    or self.lan_token == self.token):
                raise ValueError("LAN viewer must have an independent strong token")
            try:
                addr = ip_address(self.lan_bind_host)
            except ValueError as exc:
                raise ValueError("LAN listener must use a literal private IPv4 bind") from exc
            if addr.version != 4 or (not addr.is_private and not addr.is_unspecified):
                raise ValueError("LAN listener must bind private IPv4 or 0.0.0.0")
            if not 1024 <= self.lan_port <= 65535:
                raise ValueError("Invalid LAN TCP port")
            LanFanout.tls_context(self.lan_cert, self.lan_key)


def from_environment() -> Settings:
    try:
        settings = Settings(
            vehicle_id=os.environ["VIHANGA_EDGE_VEHICLE_ID"],
            system_id=int(os.environ.get("VIHANGA_EDGE_SYSID", "1")),
            port=os.environ["VIHANGA_EDGE_SERIAL_PORT"],
            baud=int(os.environ.get("VIHANGA_EDGE_BAUD", "57600")),
            cloud_wss=os.environ["VIHANGA_EDGE_WSS"],
            token=os.environ["VIHANGA_EDGE_DEVICE_TOKEN"],
            lockfile=os.environ.get("VIHANGA_EDGE_LOCKFILE", "/tmp/vihanga-edge-serial.lock"),
            lan_token=os.environ.get("VIHANGA_EDGE_LAN_VIEW_TOKEN", ""),
            lan_bind_host=os.environ.get("VIHANGA_EDGE_LAN_BIND", "127.0.0.1"),
            lan_port=int(os.environ.get("VIHANGA_EDGE_LAN_PORT", "8765")),
            lan_cert=os.environ.get("VIHANGA_EDGE_LAN_CERT", ""),
            lan_key=os.environ.get("VIHANGA_EDGE_LAN_KEY", ""))
        settings.validate()
        return settings
    except (KeyError, ValueError) as exc:
        raise RuntimeError("Invalid Vihanga Edge configuration (credentials never logged)") from exc


class FrameGate:
    """Only full authentic, origin-bound FC frames are sent to the cloud."""

    def __init__(self, system_id: int):
        self.system_id = system_id
        self.parser = mavlink.MAVLink(None)
        self.accepted = 0
        self.rejected = 0

    def consume(self, chunk: bytes) -> list[bytes]:
        if not isinstance(chunk, bytes) or not 1 <= len(chunk) <= 1024:
            self.rejected += 1
            return []
        try:
            messages = self.parser.parse_buffer(chunk) or []
        except Exception:
            self.rejected += 1
            self.parser = mavlink.MAVLink(None)
            return []
        frames = []
        for message in messages:
            if (message.get_type() in VALID_MESSAGES and
                    message.get_srcSystem() == self.system_id and
                    message.get_srcComponent() == 1):
                packet = bytes(message.get_msgbuf())
                if 8 <= len(packet) <= 300:
                    frames.append(packet)
                    self.accepted += 1
                else:
                    self.rejected += 1
            else:
                self.rejected += 1
        return frames



class CloudUplink:
    """Bounded, expendable queue. No queued MAVLink frames survive reconnection."""

    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        self.websocket = None
        self.dropped = 0
        self.sent = 0
        self.uart_open = False
        self.uart_bytes = self.uart_accepted = self.uart_rejected = 0
        self.last_uart: float | None = None

    def diagnostic_report(self) -> str:
        return json.dumps({
            "version": 1, "uart_open": self.uart_open, "uart_bytes": self.uart_bytes,
            "uart_accepted": self.uart_accepted, "uart_rejected": self.uart_rejected,
            "uart_age_ms": round((time.monotonic() - self.last_uart) * 1000) if self.last_uart is not None else None,
            "uplink_sent": self.sent, "uplink_dropped": self.dropped,
        }, separators=(",", ":"))

    def offer(self, packet: bytes) -> None:
        if self.queue.full():
            self.queue.get_nowait()
            self.dropped += 1
        self.queue.put_nowait((time.monotonic(), packet))

    def clear(self) -> None:
        self.dropped += self.queue.qsize()
        while not self.queue.empty():
            self.queue.get_nowait()

    async def invalidate(self) -> None:
        self.clear()
        if self.websocket is not None:
            try:
                await asyncio.wait_for(self.websocket.close(code=1012), timeout=2)
            except (RuntimeError, OSError, asyncio.TimeoutError):
                pass

    async def run(self, settings: Settings) -> None:
        failures = 0
        while True:
            connected_at = None
            sent_before = self.sent
            try:
                async with connect(
                    settings.cloud_wss,
                    subprotocols=[DIAGNOSTICS_PROTOCOL],
                    additional_headers={"X-Vihanga-Device-Token": settings.token},
                    open_timeout=10, close_timeout=3, ping_interval=15,
                    max_size=1024, max_queue=8
                ) as websocket:
                    self.websocket = websocket
                    connected_at = time.monotonic()
                    self.clear()
                    LOG.info("Cloud telemetry connected for %s", settings.vehicle_id)
                    diagnostics = websocket.subprotocol == DIAGNOSTICS_PROTOCOL
                    next_report = time.monotonic()
                    while True:
                        if websocket.close_code is not None:
                            break
                        if diagnostics and time.monotonic() >= next_report:
                            await asyncio.wait_for(websocket.send(self.diagnostic_report()), timeout=3)
                            next_report = time.monotonic() + 2
                        try:
                            queued_at, packet = await asyncio.wait_for(
                                self.queue.get(), max(0, next_report - time.monotonic()) if diagnostics else 2)
                        except TimeoutError:
                            continue
                        if time.monotonic() - queued_at > 1.5:
                            self.dropped += 1
                            continue
                        await asyncio.wait_for(websocket.send(packet), timeout=3)
                        self.sent += 1
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            finally:
                self.websocket = None
                self.clear()
            stable = connected_at is not None and time.monotonic() - connected_at >= 15 and self.sent > sent_before
            failures = 1 if stable else min(failures + 1, 5)
            LOG.warning("Cloud uplink unavailable; backoff level %d", failures)
            await asyncio.sleep(retry_delay(failures))


async def read_uart(settings: Settings, uplink: CloudUplink,
                    lan: LanFanout | None) -> None:
    """UART remains independently owned even during total cloud outage."""
    failures = 0
    while True:
        opened_at = None
        try:
            gate = FrameGate(settings.system_id)
            with serial.Serial(settings.port, settings.baud, timeout=0.2) as fc:
                uplink.uart_open = True
                uplink.last_uart = None
                opened_at = time.monotonic()
                LOG.info("Vihanga UART reader active for %s", settings.vehicle_id)
                while True:
                    chunk = await asyncio.to_thread(fc.read, 512)
                    if not chunk:
                        continue
                    uplink.uart_bytes += len(chunk)
                    rejected = gate.rejected
                    packets = gate.consume(bytes(chunk))
                    uplink.uart_rejected += gate.rejected - rejected
                    uplink.uart_accepted += len(packets)
                    if packets:
                        uplink.last_uart = time.monotonic()
                    for packet in packets:
                        uplink.offer(packet)
                        if lan is not None:
                            lan.publish(packet)
        except asyncio.CancelledError:
            uplink.uart_open = False
            raise
        except Exception:
            uplink.uart_open = False
            stable = opened_at is not None and time.monotonic() - opened_at >= 15 and uplink.last_uart is not None
            failures = 1 if stable else min(failures + 1, 5)
            LOG.warning("Edge UART read failed; backoff level %d", failures)
            # A dead UART must close both remote sessions so that consumers
            # immediately invalidate their projector epochs and cached state.
            await uplink.invalidate()
            if lan is not None:
                await lan.invalidate()
            await asyncio.sleep(retry_delay(failures))


async def forward(settings: Settings) -> None:
    """One persistent UART producer and independently reconnecting consumers.

    Local LAN remains available while the cloud is disconnected. No incoming
    network payload is ever passed to serial or interpreted as a command.
    """
    settings.validate()
    lock_path = Path(settings.lockfile)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Vihanga Edge UART is already owned by another instance") from exc
        uplink = CloudUplink()
        lan = LanFanout(settings.vehicle_id, settings.lan_token) if settings.lan_token else None
        if lan is None:
            async with asyncio.TaskGroup() as group:
                group.create_task(read_uart(settings, uplink, None))
                group.create_task(uplink.run(settings))
        else:
            context = LanFanout.tls_context(settings.lan_cert, settings.lan_key)
            async with lan.server(settings.lan_bind_host, settings.lan_port, context):
                LOG.info("Private TLS LAN telemetry viewer enabled for %s", settings.vehicle_id)
                async with asyncio.TaskGroup() as group:
                    group.create_task(read_uart(settings, uplink, lan))
                    group.create_task(uplink.run(settings))


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        asyncio.run(forward(from_environment()))
    except KeyboardInterrupt:
        LOG.info("Edge stopped")


if __name__ == "__main__":
    main()
