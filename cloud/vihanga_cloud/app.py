"""Independent Vihanga aircraft telemetry cloud broker.

Aircraft -> cloud -> viewers only. No FC command route exists.
Development deployment requires private TLS gateway, external identity hardening,
and a dedicated runtime. Never expose raw Uvicorn directly to the Internet.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass, field
from hashlib import sha256
import hmac
import json
import os
import re
import time
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pymavlink.dialects.v20 import ardupilotmega as mavlink

VEHICLE_ID = re.compile(r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
ACCEPTED_TYPES = frozenset({
    "HEARTBEAT", "ATTITUDE", "GPS_RAW_INT", "GPS2_RAW", "GLOBAL_POSITION_INT",
    "SYS_STATUS", "BATTERY_STATUS", "VFR_HUD", "STATUSTEXT", "HOME_POSITION",
    "EXTENDED_SYS_STATE", "EKF_STATUS_REPORT", "MISSION_CURRENT",
    "MISSION_ITEM_REACHED", "LOCAL_POSITION_NED", "NAV_CONTROLLER_OUTPUT",
    "COMMAND_ACK", "RADIO_STATUS", "GPS_STATUS", "AUTOPILOT_VERSION"
})


def digest(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class AircraftIdentity:
    vehicle_id: str
    system_id: int
    organization: str
    device_token_hash: str
    viewer_token_hash: str

    def __post_init__(self):
        if not VEHICLE_ID.fullmatch(self.vehicle_id):
            raise ValueError("Invalid vehicle identifier")
        if not 1 <= self.system_id <= 254:
            raise ValueError("MAVLink SYSID must be in 1..254")
        if not self.organization or len(self.organization) > 80:
            raise ValueError("Invalid organization")
        for hashed in (self.device_token_hash, self.viewer_token_hash):
            if not re.fullmatch(r"[a-f0-9]{64}", hashed):
                raise ValueError("Only SHA256 token digests may be configured")


@dataclass
class Slot:
    identity: AircraftIdentity
    epoch: int = 0
    device_connected: bool = False
    frames_received: int = 0
    frames_rejected: int = 0
    last_heartbeat: float = 0.0
    last_attitude: float = 0.0
    message_counts: Counter[str] = field(default_factory=Counter)
    viewers: set[asyncio.Queue] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def status(self) -> dict[str, Any]:
        now = time.monotonic()
        hb = self.device_connected and (now - self.last_heartbeat <= 3)
        att = self.device_connected and (now - self.last_attitude <= 3)
        return {
            "vehicle_id": self.identity.vehicle_id,
            "organization": self.identity.organization,
            "device_online": self.device_connected,
            "status": "LIVE" if hb and att else "PARTIAL" if hb else
                      "WAITING_FOR_DATA" if self.device_connected else "OFFLINE",
            "heartbeat_fresh": bool(hb),
            "attitude_fresh": bool(att),
            "frames_received": self.frames_received,
            "frames_rejected": self.frames_rejected,
            "viewers": len(self.viewers),
            "message_counts": dict(self.message_counts),
            "epoch": self.epoch,
            "flight_control_enabled": False
        }

    def validate(self, raw: bytes, parser: mavlink.MAVLink) -> tuple[bytes, str] | None:
        """Return authentic CRC-valid packet and message type for this aircraft."""
        if not isinstance(raw, bytes) or not 8 <= len(raw) <= 300:
            self.frames_rejected += 1
            return None
        try:
            messages = parser.parse_buffer(raw) or []
        except Exception:
            self.frames_rejected += 1
            return None
        # Edge sends exactly one complete MAVLink packet per websocket message.
        if len(messages) != 1:
            self.frames_rejected += 1
            return None
        msg = messages[0]
        typ = msg.get_type()
        if (typ not in ACCEPTED_TYPES or msg.get_srcSystem() != self.identity.system_id
                or msg.get_srcComponent() != 1 or bytes(msg.get_msgbuf()) != raw):
            self.frames_rejected += 1
            return None
        now = time.monotonic()
        self.frames_received += 1
        self.message_counts[typ] += 1
        if typ == "HEARTBEAT":
            self.last_heartbeat = now
        elif typ == "ATTITUDE":
            self.last_attitude = now
        return raw, typ


class Broker:
    def __init__(self, identities: list[AircraftIdentity]):
        if not 1 <= len(identities) <= 100:
            raise ValueError("Configure between 1 and 100 aircraft")
        if len(set(i.vehicle_id for i in identities)) != len(identities):
            raise ValueError("Duplicate aircraft identifier")
        credentials = [token for aircraft in identities for token in (
            aircraft.device_token_hash, aircraft.viewer_token_hash)]
        if len(set(credentials)) != len(credentials):
            raise ValueError("Credential digests must be unique across all aircraft and roles")
        self.slots = {i.vehicle_id: Slot(i) for i in identities}

    def authorize(self, vehicle_id: str, token: str, viewer: bool = False) -> Slot | None:
        slot = self.slots.get(vehicle_id)
        if slot is None or not isinstance(token, str) or len(token) < 32:
            return None
        expected = slot.identity.viewer_token_hash if viewer else slot.identity.device_token_hash
        return slot if hmac.compare_digest(digest(token), expected) else None


def from_environment() -> Broker:
    raw = os.environ.get("VIHANGA_CLOUD_AIRCRAFT_JSON", "")
    if not raw:
        raise RuntimeError("VIHANGA_CLOUD_AIRCRAFT_JSON is required; refusing open relay")
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("Expected a JSON list")
        identities = [AircraftIdentity(
            vehicle_id=item["vehicle_id"],
            system_id=int(item["system_id"]),
            organization=item["organization"],
            device_token_hash=item["device_token_sha256"],
            viewer_token_hash=item["viewer_token_sha256"]
        ) for item in data]
        return Broker(identities)
    except (ValueError, KeyError, TypeError) as exc:
        raise RuntimeError("Invalid Vihanga aircraft identity configuration") from exc


def bearer(ws: WebSocket, kind: str) -> str:
    if kind == "device":
        return ws.headers.get("x-vihanga-device-token", "")
    auth = ws.headers.get("authorization", "")
    return auth[7:] if auth.startswith("Bearer ") else ""


def create_app(broker: Broker | None = None) -> FastAPI:
    broker = broker or from_environment()
    app = FastAPI(title="Vihanga Cloud Telemetry Broker", version="0.1.0")
    app.state.broker = broker

    @app.get("/health")
    async def health():
        return {"status": "ok", "component": "vihanga-cloud",
                "provisioned_aircraft": len(broker.slots),
                "flight_control_enabled": False}

    @app.websocket("/ws/v1/device/{vehicle_id}")
    async def device(ws: WebSocket, vehicle_id: str):
        slot = broker.authorize(vehicle_id, bearer(ws, "device"))
        if slot is None:
            await ws.close(code=4401)
            return
        async with slot.lock:
            if slot.device_connected:
                await ws.close(code=4409)
                return
            slot.device_connected = True
            slot.epoch += 1
            slot.last_heartbeat = slot.last_attitude = 0.0
            parser = mavlink.MAVLink(None)
            epoch = slot.epoch
        try:
            await ws.accept()
            while True:
                message = await ws.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                raw = message.get("bytes")
                verified = slot.validate(raw, parser) if raw is not None else None
                if verified is None:
                    continue
                packet, _ = verified
                now = time.monotonic()
                for queue in tuple(slot.viewers):
                    if queue.full():
                        try:
                            queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                    try:
                        queue.put_nowait((epoch, now, packet))
                    except asyncio.QueueFull:
                        pass
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        finally:
            async with slot.lock:
                if slot.epoch == epoch:
                    slot.device_connected = False
                    slot.epoch += 1
                    slot.last_heartbeat = slot.last_attitude = 0.0
                    for queue in tuple(slot.viewers):
                        while not queue.empty():
                            queue.get_nowait()

    @app.websocket("/ws/v1/view/{vehicle_id}")
    async def viewer(ws: WebSocket, vehicle_id: str):
        slot = broker.authorize(vehicle_id, bearer(ws, "viewer"), viewer=True)
        if slot is None:
            await ws.close(code=4401)
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        slot.viewers.add(queue)
        try:
            await ws.accept()
            while True:
                wait_for_disconnect = asyncio.create_task(ws.receive())
                wait_for_frame = asyncio.create_task(queue.get())
                try:
                    done, pending = await asyncio.wait(
                        {wait_for_disconnect, wait_for_frame}, timeout=1.0,
                        return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in (wait_for_disconnect, wait_for_frame):
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(wait_for_disconnect, wait_for_frame,
                                         return_exceptions=True)
                if wait_for_disconnect in done:
                    message = wait_for_disconnect.result()
                    if message.get("type") == "websocket.disconnect":
                        break
                    # A viewer NEVER sends commands to device sockets.
                if wait_for_frame in done:
                    epoch, time_received, packet = wait_for_frame.result()
                    if (slot.device_connected and slot.epoch == epoch and
                            time.monotonic() - time_received <= 1.5):
                        await ws.send_bytes(packet)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        finally:
            slot.viewers.discard(queue)
            try:
                await ws.close(code=1000)
            except RuntimeError:
                pass

    return app


# Fail closed: launching the module without vehicle identities is an error.
app = create_app()
