"""Standalone, loopback-only Vihanga operations API.

No vehicle telemetry is fabricated. No MAVLink, arming, flight, or actuator
command route is implemented in this service.
"""
from __future__ import annotations

from contextlib import contextmanager
import asyncio
from datetime import datetime, timezone
from hashlib import sha256
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Literal
import json
import os
import re
import sqlite3
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from starlette.middleware.trustedhost import TrustedHostMiddleware
from vihanga.survey import router as survey_router
from vihanga.operator_contract import BenchQuery, catalog
from vihanga.telemetry import BrokerConnect, CloudConnect, LanConnect, UDPConnect, TCPConnect, SerialConnect, LinkManager
from pydantic import BaseModel, ConfigDict, Field, field_validator


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VehicleCreate(StrictModel):
    vehicle_id: str = Field(min_length=3, max_length=32, pattern=r"^[A-Z0-9][A-Z0-9_-]+$")
    label: str = Field(min_length=3, max_length=80)
    autopilot: Literal["ARDUPILOT", "PX4", "OTHER"]
    interface: Literal["UART", "USB", "ETHERNET", "OTHER"]


class Waypoint(StrictModel):
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    altitude_m: float = Field(ge=0, le=120, allow_inf_nan=False)


class MissionDraftCreate(StrictModel):
    vehicle_id: str
    title: str = Field(min_length=3, max_length=100)
    waypoints: list[Waypoint] = Field(min_length=2, max_length=200)

    @field_validator("vehicle_id")
    @classmethod
    def vehicle_id_format(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{2,31}", value):
            raise ValueError("Invalid aircraft identifier")
        return value


def route_length_m(waypoints: list[dict]) -> float:
    total = 0.0
    for a, b in zip(waypoints, waypoints[1:]):
        lat1, lon1 = radians(a["latitude"]), radians(a["longitude"])
        lat2, lon2 = radians(b["latitude"]), radians(b["longitude"])
        dlat, dlon = lat2 - lat1, lon2 - lon1
        h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
        total += 2 * 6371000 * asin(min(1.0, sqrt(h)))
    return round(total, 2)


def create_app(db_path: str | Path | None = None) -> FastAPI:
    path = Path(db_path or os.environ.get("VIHANGA_DEV_DB", "data/vihanga-dev.sqlite3"))
    path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def db():
        con = sqlite3.connect(path, timeout=5)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        try:
            yield con
            con.commit()
        finally:
            con.close()

    with db() as con:
        con.execute("""CREATE TABLE IF NOT EXISTS vehicles (
            vehicle_id TEXT PRIMARY KEY, label TEXT NOT NULL, autopilot TEXT NOT NULL,
            interface TEXT NOT NULL, created_at TEXT NOT NULL
        )""")
        con.execute("""CREATE TABLE IF NOT EXISTS missions (
            mission_id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(vehicle_id),
            title TEXT NOT NULL, waypoint_json TEXT NOT NULL,
            revision_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
        )""")

    app = FastAPI(title="Vihanga standalone operations API", version="0.19.0")
    # Loopback-only development API. Reject DNS rebinding via arbitrary Host values.
    app.add_middleware(TrustedHostMiddleware,
                       allowed_hosts=["127.0.0.1", "localhost", "testserver"])
    links = LinkManager()
    app.state.links = links
    app.include_router(survey_router)

    def require_vehicle(vehicle_id: str) -> None:
        with db() as con:
            exists = con.execute("SELECT 1 FROM vehicles WHERE vehicle_id=?", (vehicle_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Aircraft not registered")

    @app.post("/api/v1/links/broker")
    async def connect_broker(request: BrokerConnect):
        require_vehicle(request.vehicle_id)
        try:
            await links.start_broker(request)
            return links.snapshot(request.vehicle_id)
        except ValueError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from ex

    @app.post("/api/v1/links/cloud")
    async def connect_cloud(request: CloudConnect):
        require_vehicle(request.vehicle_id)
        try:
            await links.start_cloud(request)
            return links.snapshot(request.vehicle_id)
        except ValueError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from ex

    @app.post("/api/v1/links/lan")
    async def connect_direct_lan(request: LanConnect):
        require_vehicle(request.vehicle_id)
        try:
            await links.start_lan(request)
            return links.snapshot(request.vehicle_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/v1/links/udp")
    async def connect_udp(request: UDPConnect):
        require_vehicle(request.vehicle_id)
        try:
            await links.start_udp(request)
            return links.snapshot(request.vehicle_id)
        except ValueError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from ex
        except OSError as ex:
            raise HTTPException(status_code=409, detail="Local UDP port unavailable") from ex

    @app.post("/api/v1/links/serial")
    async def connect_serial(request: SerialConnect):
        require_vehicle(request.vehicle_id)
        try:
            await links.start_serial(request)
            return links.snapshot(request.vehicle_id)
        except ValueError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from ex
        except Exception as ex:
            raise HTTPException(status_code=409, detail="Serial port cannot be opened") from ex

    @app.post("/api/v1/links/tcp")
    async def connect_tcp(request: TCPConnect):
        require_vehicle(request.vehicle_id)
        try:
            await links.start_tcp(request)
            return links.snapshot(request.vehicle_id)
        except ValueError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from ex
        except OSError as ex:
            raise HTTPException(status_code=409, detail="Local TCP endpoint unavailable") from ex

    async def create_backup_receiver(request):
        require_vehicle(request.vehicle_id)
        try:
            return await links.start_backup(request)
        except ValueError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from ex
        except Exception as ex:
            # Never echo credentials, serial device details or endpoint tokens.
            raise HTTPException(status_code=409, detail="Backup receiver could not be opened") from ex

    @app.post("/api/v1/links/backup/broker")
    async def backup_broker(request: BrokerConnect):
        return await create_backup_receiver(request)

    @app.post("/api/v1/links/backup/cloud")
    async def backup_cloud(request: CloudConnect):
        return await create_backup_receiver(request)

    @app.post("/api/v1/links/backup/lan")
    async def backup_direct_lan(request: LanConnect):
        return await create_backup_receiver(request)

    @app.post("/api/v1/links/backup/serial")
    async def backup_serial(request: SerialConnect):
        return await create_backup_receiver(request)

    @app.post("/api/v1/links/backup/udp")
    async def backup_udp(request: UDPConnect):
        return await create_backup_receiver(request)

    @app.post("/api/v1/links/backup/tcp")
    async def backup_tcp(request: TCPConnect):
        return await create_backup_receiver(request)

    @app.post("/api/v1/links/select/{vehicle_id}/{source}")
    async def select_receive_source(vehicle_id: str, source: Literal["PRIMARY", "BACKUP"]):
        require_vehicle(vehicle_id)
        try:
            return links.select_source(vehicle_id, source)
        except ValueError as ex:
            raise HTTPException(status_code=409, detail=str(ex)) from ex

    @app.delete("/api/v1/links/backup/{vehicle_id}")
    async def disconnect_backup(vehicle_id: str):
        require_vehicle(vehicle_id)
        return await links.stop_backup(vehicle_id)

    @app.delete("/api/v1/links/{vehicle_id}")
    async def disconnect_link(vehicle_id: str):
        require_vehicle(vehicle_id)
        await links.stop(vehicle_id)
        return links.snapshot(vehicle_id)

    @app.get("/api/v1/fleet/telemetry")
    async def fleet_telemetry():
        """Consistent vehicle-scoped snapshots in one bounded request.

        Avoid N independent per-aircraft HTTP polls for the operator fleet.
        Read-only; no credentials or actuation capability is exposed.
        """
        with db() as con:
            ids = [row["vehicle_id"] for row in
                   con.execute("SELECT vehicle_id FROM vehicles ORDER BY vehicle_id").fetchall()]
        return {vehicle_id: links.snapshot(vehicle_id) for vehicle_id in ids}

    @app.get("/api/v1/telemetry/{vehicle_id}")
    async def telemetry(vehicle_id: str):
        require_vehicle(vehicle_id)
        return links.snapshot(vehicle_id)

    @app.get("/api/v1/flight-tracks/{vehicle_id}")
    async def observed_track(vehicle_id: str):
        require_vehicle(vehicle_id)
        session = links.active_session(vehicle_id)
        if session is None:
            return {"vehicle_id": vehicle_id, "status": "NO_LIVE_SESSION",
                    "points": [], "count": 0,
                    "warning": "No physical GNSS data has been collected"}
        return {"vehicle_id": vehicle_id, **session.projector.track_snapshot()}

    @app.websocket("/ws/v1/telemetry/{vehicle_id}")
    async def live_telemetry_socket(socket: WebSocket, vehicle_id: str):
        # Browsers can open cross-origin WebSockets without a CORS preflight.
        origin = socket.headers.get("origin")
        if origin is not None and origin not in {
            "http://127.0.0.1:5173", "http://localhost:5173",
            "http://127.0.0.1:8010", "http://localhost:8010",
        }:
            await socket.close(code=1008)
            return
        with db() as con:
            known = con.execute("SELECT 1 FROM vehicles WHERE vehicle_id=?", (vehicle_id,)).fetchone()
        if not known:
            await socket.close(code=4404)
            return
        await socket.accept()
        try:
            while True:
                await socket.send_json(links.snapshot(vehicle_id))
                await asyncio.sleep(0.25)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass

    @app.on_event("shutdown")
    async def stop_links():
        for vehicle_id in tuple(links.sessions):
            await links.stop(vehicle_id)


    @app.get("/api/v1/operator/{vehicle_id}/catalog")
    def operator_catalog(vehicle_id: str):
        require_vehicle(vehicle_id)
        session = links.active_session(vehicle_id)
        local = session is not None and session.kind == "LOCAL_SERIAL_RECEIVE"
        connected = session is not None and session.state == "CONNECTED"
        return {
            "vehicle_id": vehicle_id,
            **catalog(
                bench_enabled=os.environ.get("VIHANGA_BENCH_READ_REQUESTS") == "1",
                local_serial=local,
                connected=connected,
                disarmed_verified=bool(connected and session.projector.snapshot()["heartbeat_fresh"]
                                       and session.projector.snapshot()["armed"] is False),
            )
        }

    @app.get("/api/v1/operator/{vehicle_id}/parameters")
    def read_observed_parameters(vehicle_id: str):
        require_vehicle(vehicle_id)
        session = links.active_session(vehicle_id)
        if session is None or session.state != "CONNECTED":
            return {
                "vehicle_id": vehicle_id,
                "status": "NO_SERIAL_DATA", "items": {},
                "received": 0, "reported_total": None
            }
        if session.kind != "LOCAL_SERIAL_RECEIVE":
            raise HTTPException(status_code=409, detail="Parameter bench readback requires local serial")
        return {"vehicle_id": vehicle_id, **session.projector.parameter_snapshot()}

    @app.post("/api/v1/operator/{vehicle_id}/bench-query")
    async def query_bench_fc(vehicle_id: str, payload: BenchQuery, request: Request):
        require_vehicle(vehicle_id)
        # An explicit local bench intent is not an authentication substitute.
        # No network command route or flight-changing MAVLink writer exists.
        if request.headers.get("x-vihanga-bench-read") != "confirm-non-actuating-request":
            raise HTTPException(status_code=403, detail="Explicit bench read header required")
        origin = request.headers.get("origin")
        if origin and origin not in {
            "http://127.0.0.1:5173", "http://localhost:5173",
            "http://127.0.0.1:8010", "http://localhost:8010",
        }:
            raise HTTPException(status_code=403, detail="Browser origin not approved")
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(status_code=403, detail="Cross-site bench requests rejected")
        session = links.active_session(vehicle_id)
        if session is None or session.kind != "LOCAL_SERIAL_RECEIVE":
            raise HTTPException(status_code=409, detail="Local USB serial connection required")
        try:
            result = await links.bench_request(vehicle_id, payload)
        except ValueError as ex:
            raise HTTPException(status_code=409, detail=str(ex)) from ex
        return {**result, "query": payload.query.value}

    @app.get("/api/v1/health")
    def health():
        return {"service": "vihanga-standalone", "status": "ok",
                "deployment": "LOCAL_DEVELOPMENT", "physical_flight_control": False,
                "live_vehicle_stream": any(links.snapshot(i)["status"] == "LIVE" for i in links.sessions)}

    @app.get("/api/v1/capabilities")
    def capabilities():
        return {
            "mission_draft": True, "aircraft_registration": True,
            "live_telemetry": True, "cloud_command_dispatch": False,
            "mission_upload": False, "remote_arm": False,
            "takeoff": False, "land": False, "rtl": False,
            "bench_nonactuating_requests": os.environ.get("VIHANGA_BENCH_READ_REQUESTS") == "1",
            "reason": "Real read-only private WSS and localhost SITL UDP available. No flight-control command transport."
        }

    @app.get("/api/v1/vehicles")
    def vehicles():
        with db() as con:
            rows = con.execute("SELECT * FROM vehicles ORDER BY created_at, vehicle_id").fetchall()
            return [{**dict(row), "link_state": links.snapshot(row["vehicle_id"])["status"],
                     "control_authorized": False}
                    for row in rows]

    @app.post("/api/v1/vehicles", status_code=201)
    def register_vehicle(vehicle: VehicleCreate):
        with db() as con:
            try:
                con.execute("INSERT INTO vehicles VALUES (?,?,?,?,?)",
                            (vehicle.vehicle_id, vehicle.label, vehicle.autopilot,
                             vehicle.interface, now_utc()))
            except sqlite3.IntegrityError as exc:
                raise HTTPException(status_code=409, detail="Aircraft ID already registered") from exc
        return {"vehicle_id": vehicle.vehicle_id, "link_state": "OFFLINE",
                "control_authorized": False}

    def mission_row(row: sqlite3.Row) -> dict:
        mission = dict(row)
        mission["waypoints"] = json.loads(mission.pop("waypoint_json"))
        mission["distance_m"] = route_length_m(mission["waypoints"])
        mission["status"] = "DRAFT_ONLY"
        return mission

    @app.get("/api/v1/missions")
    def missions():
        with db() as con:
            rows = con.execute("SELECT * FROM missions ORDER BY rowid DESC").fetchall()
            return [mission_row(row) for row in rows]

    @app.get("/api/v1/missions/{mission_id}")
    def mission(mission_id: str):
        with db() as con:
            row = con.execute("SELECT * FROM missions WHERE mission_id=?", (mission_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Mission draft not found")
        return mission_row(row)

    @app.post("/api/v1/missions", status_code=201)
    def create_mission(payload: MissionDraftCreate):
        waypoint_list = [p.model_dump() for p in payload.waypoints]
        canonical = json.dumps({
            "vehicle_id": payload.vehicle_id, "title": payload.title,
            "waypoints": waypoint_list
        }, sort_keys=True, separators=(",", ":"), allow_nan=False)
        digest = sha256(canonical.encode("utf-8")).hexdigest()
        mission_id = uuid4().hex
        with db() as con:
            known = con.execute("SELECT 1 FROM vehicles WHERE vehicle_id=?",
                                (payload.vehicle_id,)).fetchone()
            if known is None:
                raise HTTPException(status_code=404, detail="Register aircraft before drafting a mission")
            con.execute("INSERT INTO missions VALUES (?,?,?,?,?,?)",
                        (mission_id, payload.vehicle_id, payload.title,
                         json.dumps(waypoint_list, separators=(",", ":")), digest, now_utc()))
            row = con.execute("SELECT * FROM missions WHERE mission_id=?", (mission_id,)).fetchone()
        return mission_row(row)

    return app


app = create_app()
