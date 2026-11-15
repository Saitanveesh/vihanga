"""Standalone, loopback-only Vihanga operations API.

No vehicle telemetry is fabricated. No MAVLink, arming, flight, or actuator
command route is implemented in this service.
"""
from __future__ import annotations

from contextlib import contextmanager
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

from fastapi import FastAPI, HTTPException
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

    app = FastAPI(title="Vihanga standalone operations API", version="0.1.0")

    @app.get("/api/v1/health")
    def health():
        return {"service": "vihanga-standalone", "status": "ok",
                "deployment": "LOCAL_DEVELOPMENT", "physical_flight_control": False,
                "live_vehicle_stream": False}

    @app.get("/api/v1/capabilities")
    def capabilities():
        return {
            "mission_draft": True, "aircraft_registration": True,
            "live_telemetry": False, "cloud_command_dispatch": False,
            "mission_upload": False, "remote_arm": False,
            "takeoff": False, "land": False, "rtl": False,
            "reason": "No authenticated edge agent or safety-qualified FC connection exists"
        }

    @app.get("/api/v1/vehicles")
    def vehicles():
        with db() as con:
            rows = con.execute("SELECT * FROM vehicles ORDER BY created_at, vehicle_id").fetchall()
            return [{**dict(row), "link_state": "OFFLINE", "control_authorized": False}
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
