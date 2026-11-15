"""Vihanga single-owner Pi edge agent — strictly receive-only FC serial.

Airframe controller UART -> validated MAVLink -> private WSS cloud.
The cloud never supplies vehicle actuation here. No serial write() exists.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import fcntl
import logging
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

import serial
from pymavlink.dialects.v20 import ardupilotmega as mavlink
from websockets.asyncio.client import connect

LOG = logging.getLogger("vihanga.edge")
VALID_MESSAGES = frozenset({
    "HEARTBEAT", "ATTITUDE", "GPS_RAW_INT", "GPS2_RAW", "GLOBAL_POSITION_INT",
    "SYS_STATUS", "BATTERY_STATUS", "VFR_HUD", "STATUSTEXT", "HOME_POSITION",
    "EXTENDED_SYS_STATE", "EKF_STATUS_REPORT", "MISSION_CURRENT",
    "MISSION_ITEM_REACHED", "LOCAL_POSITION_NED", "NAV_CONTROLLER_OUTPUT",
    "COMMAND_ACK", "RADIO_STATUS", "GPS_STATUS", "AUTOPILOT_VERSION"
})


@dataclass(frozen=True)
class Settings:
    vehicle_id: str
    system_id: int
    port: str
    baud: int
    cloud_wss: str
    token: str
    lockfile: str = "/tmp/vihanga-edge-serial.lock"

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


def from_environment() -> Settings:
    try:
        settings = Settings(
            vehicle_id=os.environ["VIHANGA_EDGE_VEHICLE_ID"],
            system_id=int(os.environ.get("VIHANGA_EDGE_SYSID", "1")),
            port=os.environ["VIHANGA_EDGE_SERIAL_PORT"],
            baud=int(os.environ.get("VIHANGA_EDGE_BAUD", "57600")),
            cloud_wss=os.environ["VIHANGA_EDGE_WSS"],
            token=os.environ["VIHANGA_EDGE_DEVICE_TOKEN"],
            lockfile=os.environ.get("VIHANGA_EDGE_LOCKFILE", "/tmp/vihanga-edge-serial.lock"))
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


async def forward(settings: Settings) -> None:
    """One serial reader, one outbound WSS. No replay queue on reconnect."""
    settings.validate()
    lock_path = Path(settings.lockfile)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Vihanga Edge UART is already owned by another instance") from exc
        failures = 0
        while True:
            try:
                async with connect(settings.cloud_wss,
                                   additional_headers={"X-Vihanga-Device-Token": settings.token},
                                   open_timeout=10, close_timeout=3, ping_interval=15,
                                   max_size=1024, max_queue=8) as ws:
                    failures = 0
                    gate = FrameGate(settings.system_id)
                    with serial.Serial(settings.port, settings.baud, timeout=0.2) as fc:
                        LOG.info("Connected to cloud as %s; serial receive-only", settings.vehicle_id)
                        while True:
                            chunk = await asyncio.to_thread(fc.read, 512)
                            if chunk:
                                for frame in gate.consume(bytes(chunk)):
                                    await ws.send(frame)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Deliberately no secret, hostname, URL or COM port in logs.
                failures += 1
                LOG.warning("Edge telemetry disconnected; retry attempt %d", failures)
                await asyncio.sleep(min(2 ** min(failures, 4), 20))


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        asyncio.run(forward(from_environment()))
    except KeyboardInterrupt:
        LOG.info("Edge stopped")


if __name__ == "__main__":
    main()
