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

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pymavlink.dialects.v20 import ardupilotmega as mavlink
from vihanga_cloud.credentials import CredentialFile

MAX_VIEWERS_PER_AIRCRAFT = 16
VIEWER_SEND_TIMEOUT_SECONDS = 2.0
DIAGNOSTICS_PROTOCOL = "vihanga-diagnostics.v1"
EDGE_COUNTERS = ("uart_bytes", "uart_accepted", "uart_rejected", "uplink_sent", "uplink_dropped")

VEHICLE_ID = re.compile(r"^[A-Z0-9][A-Z0-9_-]{2,31}$")
ACCEPTED_TYPES = frozenset({
    "HEARTBEAT", "ATTITUDE", "GPS_RAW_INT", "GPS2_RAW", "GLOBAL_POSITION_INT",
    "SYS_STATUS", "BATTERY_STATUS", "VFR_HUD", "STATUSTEXT", "HOME_POSITION",
    "EXTENDED_SYS_STATE", "EKF_STATUS_REPORT", "MISSION_CURRENT",
    "MISSION_ITEM_REACHED", "LOCAL_POSITION_NED", "NAV_CONTROLLER_OUTPUT",
    "COMMAND_ACK", "RADIO_STATUS", "RC_CHANNELS", "RC_CHANNELS_RAW",
    "GPS_STATUS", "AUTOPILOT_VERSION"
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
    last_packet: float | None = None
    edge_at: float | None = None
    edge_evidence: dict | None = None
    viewer_frames_dropped: int = 0
    viewer_send_timeouts: int = 0
    message_counts: Counter[str] = field(default_factory=Counter)
    viewers: set[asyncio.Queue] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def record_edge(self, raw: str) -> None:
        try:
            if len(raw) > 512:
                raise ValueError
            data = json.loads(raw)
            if (not isinstance(data, dict)
                    or set(data) != {"version", "uart_open", "uart_age_ms", *EDGE_COUNTERS}
                    or type(data["version"]) is not int or data["version"] != 1 or type(data["uart_open"]) is not bool):
                raise ValueError
            for key in (*EDGE_COUNTERS, "uart_age_ms"):
                value = data[key]
                if key == "uart_age_ms" and value is None:
                    continue
                if type(value) is not int or not 0 <= value <= 2**53 - 1:
                    raise ValueError
            self.edge_evidence, self.edge_at = data, time.monotonic()
        except (ValueError, TypeError):
            self.frames_rejected += 1

    def diagnostics(self) -> dict:
        now = time.monotonic()
        edge_age = round((now - self.edge_at) * 1000) if self.edge_at is not None else None
        return {
            "version": 1,
            "vehicle_id": self.identity.vehicle_id,
            "relay": {
                "online": self.device_connected, "epoch": self.epoch,
                "received": self.frames_received, "rejected": self.frames_rejected,
                "viewer_dropped": self.viewer_frames_dropped,
                "packet_age_ms": round((now - self.last_packet) * 1000) if self.last_packet is not None else None,
            },
            "edge_report_age_ms": edge_age,
            "edge": self.edge_evidence if edge_age is not None and edge_age <= 6000 else None,
        }

    def status(self) -> dict[str, Any]:
        now = time.monotonic()
        hb = self.device_connected and 0 < self.last_heartbeat <= now and now - self.last_heartbeat <= 3
        att = self.device_connected and 0 < self.last_attitude <= now and now - self.last_attitude <= 3
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
            "viewer_frames_dropped": self.viewer_frames_dropped,
            "viewer_send_timeouts": self.viewer_send_timeouts,
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
            msg = parser.decode(bytearray(raw))
        except Exception:
            self.frames_rejected += 1
            return None
        typ = msg.get_type()
        if (typ not in ACCEPTED_TYPES or msg.get_srcSystem() != self.identity.system_id
                or msg.get_srcComponent() != 1 or bytes(msg.get_msgbuf()) != raw):
            self.frames_rejected += 1
            return None
        now = time.monotonic()
        self.last_packet = now
        self.frames_received += 1
        self.message_counts[typ] += 1
        if typ == "HEARTBEAT":
            self.last_heartbeat = now
        elif typ == "ATTITUDE":
            self.last_attitude = now
        return raw, typ


class Broker:
    def __init__(self, identities: list[AircraftIdentity], credential_file: CredentialFile | None = None):
        if not 1 <= len(identities) <= 100:
            raise ValueError("Configure between 1 and 100 aircraft")
        if len(set(i.vehicle_id for i in identities)) != len(identities):
            raise ValueError("Duplicate aircraft identifier")
        credentials = [token for aircraft in identities for token in (
            aircraft.device_token_hash, aircraft.viewer_token_hash)]
        if len(set(credentials)) != len(credentials):
            raise ValueError("Credential digests must be unique across all aircraft and roles")
        self.slots = {i.vehicle_id: Slot(i) for i in identities}
        self.credential_file = credential_file

    def authorize(self, vehicle_id: str, token: str, viewer: bool = False) -> Slot | None:
        slot = self.slots.get(vehicle_id)
        if slot is None or not isinstance(token, str) or not 32 <= len(token) <= 512:
            return None
        if self.credential_file:
            return slot if self.credential_file.authorize(vehicle_id, "viewer" if viewer else "device", token) else None
        expected = slot.identity.viewer_token_hash if viewer else slot.identity.device_token_hash
        return slot if hmac.compare_digest(digest(token), expected) else None


def from_environment() -> Broker:
    filename = os.environ.get("VIHANGA_CLOUD_CREDENTIALS_FILE")
    if filename:
        try:
            credentials = CredentialFile(filename)
            identities = [AircraftIdentity(vehicle, system, organization,
                                          digest(vehicle + "/device"), digest(vehicle + "/viewer"))
                          for vehicle, (system, organization) in credentials.topology.items()]
            return Broker(identities, credentials)
        except (ValueError, KeyError, TypeError, OSError) as exc:
            raise RuntimeError("Invalid version 2 Vihanga credential file") from exc
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


def bearer(ws: WebSocket | Request, kind: str) -> str:
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

    @app.get("/api/v1/diagnostics/{vehicle_id}")
    async def diagnostics(vehicle_id: str, request: Request, response: Response):
        slot = broker.authorize(vehicle_id, bearer(request, "viewer"), viewer=True)
        if slot is None:
            raise HTTPException(401, "Viewer authentication required")
        response.headers["Cache-Control"] = "no-store"
        return slot.diagnostics()

    @app.websocket("/ws/v1/device/{vehicle_id}")
    async def device(ws: WebSocket, vehicle_id: str):
        token = bearer(ws, "device")
        slot = broker.authorize(vehicle_id, token)
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
            slot.last_packet = slot.edge_at = slot.edge_evidence = None
            parser = mavlink.MAVLink(None)
            epoch = slot.epoch
        try:
            diagnostics = DIAGNOSTICS_PROTOCOL in ws.scope.get("subprotocols", [])
            await ws.accept(subprotocol=DIAGNOSTICS_PROTOCOL if diagnostics else None)
            while True:
                if broker.authorize(vehicle_id, token) is None:
                    await ws.close(code=4401)
                    break
                try:
                    message = await asyncio.wait_for(ws.receive(), 1.0)
                except TimeoutError:
                    continue
                if message.get("type") == "websocket.disconnect":
                    break
                if broker.authorize(vehicle_id, token) is None:
                    await ws.close(code=4401)
                    break
                if diagnostics and message.get("text") is not None:
                    slot.record_edge(message["text"])
                    continue
                raw = message.get("bytes")
                verified = slot.validate(raw, parser)
                if verified is None:
                    continue
                packet, _ = verified
                now = time.monotonic()
                for queue in tuple(slot.viewers):
                    if queue.full():
                        queue.get_nowait()
                        slot.viewer_frames_dropped += 1
                    queue.put_nowait((epoch, now, packet))
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        finally:
            async with slot.lock:
                if slot.epoch == epoch:
                    slot.device_connected = False
                    slot.epoch += 1
                    slot.last_heartbeat = slot.last_attitude = 0.0
                    slot.last_packet = slot.edge_at = slot.edge_evidence = None
                    for queue in tuple(slot.viewers):
                        slot.viewer_frames_dropped += queue.qsize()
                        while not queue.empty():
                            queue.get_nowait()

    @app.websocket("/ws/v1/view/{vehicle_id}")
    async def viewer(ws: WebSocket, vehicle_id: str):
        token = bearer(ws, "viewer")
        slot = broker.authorize(vehicle_id, token, viewer=True)
        if slot is None:
            await ws.close(code=4401)
            return
        if len(slot.viewers) >= MAX_VIEWERS_PER_AIRCRAFT:
            await ws.close(code=1013)
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        slot.viewers.add(queue)
        close_code = 1000
        try:
            await ws.accept()
            while True:
                if broker.authorize(vehicle_id, token, viewer=True) is None:
                    close_code = 4401
                    break
                wait_for_disconnect = asyncio.create_task(ws.receive())
                wait_for_frame = asyncio.create_task(queue.get())
                try:
                    done, _ = await asyncio.wait(
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
                    if broker.authorize(vehicle_id, token, viewer=True) is None:
                        close_code = 4401
                        break
                    epoch, time_received, packet = wait_for_frame.result()
                    if (slot.device_connected and slot.epoch == epoch and
                            time.monotonic() - time_received <= 1.5):
                        try:
                            await asyncio.wait_for(ws.send_bytes(packet), VIEWER_SEND_TIMEOUT_SECONDS)
                        except asyncio.TimeoutError:
                            slot.viewer_send_timeouts += 1
                            close_code = 1013
                            break
                    else:
                        slot.viewer_frames_dropped += 1
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        finally:
            slot.viewers.discard(queue)
            slot.viewer_frames_dropped += queue.qsize()
            try:
                await asyncio.wait_for(ws.close(code=close_code), VIEWER_SEND_TIMEOUT_SECONDS)
            except (RuntimeError, OSError, asyncio.TimeoutError):
                pass

    return app


# Fail closed: launching the module without vehicle identities is an error.
app = create_app()
