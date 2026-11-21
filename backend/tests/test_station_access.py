import json
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from vihanga.app import create_app
from vihanga.station_auth import COOKIE, password_digest


def test_station_roles_aircraft_scope_logout_and_expiry(tmp_path, monkeypatch):
    salt = b"s" * 16
    password = "test account password"
    record = {"salt": salt.hex(), "password_scrypt": password_digest(password, salt).hex()}
    file = tmp_path / "operators.json"
    file.write_text(json.dumps({"version": 1, "operators": [
        {**record, "username": "admin", "role": "admin", "aircraft": []},
        {**record, "username": "observer", "role": "viewer", "aircraft": ["AIR-001"]},
        {**record, "username": "operator", "role": "operator", "aircraft": ["AIR-001"]},
    ]}))
    monkeypatch.setenv("VIHANGA_STATION_OPERATORS_FILE", str(file))
    app = create_app(tmp_path / "gcs.sqlite3")
    with TestClient(app) as client:
        assert client.get("/api/v1/station/session").json()["required"]
        assert client.get("/api/v1/health").status_code == 200
        assert client.get("/api/v1/vehicles").status_code == 401

        def login(name, **kwargs):
            return client.post("/api/v1/station/login", json={"username": name, "password": password}, **kwargs)

        assert login("admin", headers={"Origin": "https://outside.example"}).status_code == 403
        assert login("missing").status_code == 401
        assert "HttpOnly" in login("admin").headers["set-cookie"]
        for vehicle in ("AIR-001", "AIR-002"):
            assert client.post("/api/v1/vehicles", json={"vehicle_id": vehicle, "label": vehicle,
                            "autopilot": "ARDUPILOT", "interface": "UART"}).status_code == 201
        waypoints = [{"latitude": 1, "longitude": 2, "altitude_m": 35},
                     {"latitude": 2, "longitude": 2, "altitude_m": 35}]
        mission = client.post("/api/v1/missions", json={"vehicle_id": "AIR-002",
                              "title": "Other aircraft draft", "waypoints": waypoints}).json()
        assert login("observer").status_code == 200
        assert [item["vehicle_id"] for item in client.get("/api/v1/vehicles").json()] == ["AIR-001"]
        assert set(client.get("/api/v1/fleet/telemetry").json()) == {"AIR-001"}
        assert client.get("/api/v1/telemetry/AIR-002").status_code == 404
        assert client.get("/api/v1/missions").json() == []
        assert client.get("/api/v1/missions/" + mission["mission_id"]).status_code == 404
        assert client.post("/api/v1/bench/captures/AIR-001", json={"duration_seconds": 30}).status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/v1/telemetry/AIR-002"):
                pass
        with client.websocket_connect("/ws/v1/telemetry/AIR-001") as ws:
            assert ws.receive_json()["vehicle_id"] == "AIR-001"
            client.post("/api/v1/station/logout").raise_for_status()
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        assert client.get("/api/v1/vehicles").status_code == 401

        assert login("operator").status_code == 200
        assert client.post("/api/v1/vehicles", json={}).status_code == 403
        assert client.post("/api/v1/bench/captures/AIR-002", json={"duration_seconds": 30}).status_code == 404
        assert client.post("/api/v1/bench/captures/AIR-001", json={"duration_seconds": 30}).status_code == 201
        key = app.state.access.key(client.cookies.get(COOKIE))
        user, _ = app.state.access.sessions[key]
        app.state.access.sessions[key] = (user, time.monotonic() - 1)
        assert client.get("/api/v1/station/session").json()["username"] is None
        assert client.get("/api/v1/fleet/telemetry").status_code == 401
