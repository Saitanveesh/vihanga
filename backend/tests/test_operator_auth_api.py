"""Real FastAPI session, role and aircraft isolation integration tests."""
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest

from vihanga.app import create_app


PASSWORD = "A_safe_operator_password_2026"
A = "AH-HW-001"
B = "AH-HW-002"


def register(c, vehicle_id, csrf):
    result = c.post("/api/v1/vehicles", json={
        "vehicle_id": vehicle_id, "label": "Test aircraft " + vehicle_id,
        "autopilot": "ARDUPILOT", "interface": "UART"
    }, headers={"X-Vihanga-CSRF": csrf})
    assert result.status_code == 201, result.text


def sign_in(c, username):
    res = c.post("/api/v1/auth/login",
                 json={"username": username, "password": PASSWORD})
    assert res.status_code == 200, res.text
    return res.json()["csrf_token"]


def test_enforcement_guards_all_local_api_routes_and_scopes(tmp_path, monkeypatch):
    monkeypatch.setenv("VIHANGA_OPERATOR_AUTH", "required")
    app = create_app(tmp_path / "enforce.sqlite3")
    store = app.state.operator_store
    store.provision("admin-one", PASSWORD, "ADMIN")
    store.provision("pilot-one", PASSWORD, "PILOT", [A])
    store.provision("viewer-one", PASSWORD, "VIEWER", [A])

    with TestClient(app) as c:
        assert c.get("/api/v1/health").status_code == 200
        assert c.get("/api/v1/auth/status").json()["mode"] == "REQUIRED"
        assert c.get("/api/v1/vehicles").status_code == 401
        assert c.post("/api/v1/links/udp", json={
            "vehicle_id": A, "port": 17025, "fc_system_id": 1
        }).status_code == 401

        csrf = sign_in(c, "admin-one")
        register(c, A, csrf)
        register(c, B, csrf)
        draft = c.post("/api/v1/missions", json={
            "vehicle_id": B, "title": "Other aircraft",
            "waypoints": [{"latitude":12.97,"longitude":77.59,"altitude_m":30},
                          {"latitude":12.98,"longitude":77.60,"altitude_m":30}]
        }, headers={"X-Vihanga-CSRF": csrf})
        assert draft.status_code == 201, draft.text
        other_mission = draft.json()["mission_id"]
        assert len(c.get("/api/v1/vehicles").json()) == 2

        assert c.post("/api/v1/auth/logout",
                      headers={"X-Vihanga-CSRF": csrf}).status_code == 200
        assert c.get("/api/v1/vehicles").status_code == 401

        csrf = sign_in(c, "pilot-one")
        assert [v["vehicle_id"] for v in c.get("/api/v1/vehicles").json()] == [A]
        assert set(c.get("/api/v1/fleet/telemetry").json()) == {A}
        assert c.get("/api/v1/telemetry/" + B).status_code == 403
        assert c.get("/api/v1/flight-tracks/" + B).status_code == 403
        assert c.get("/api/v1/operator/" + B + "/catalog").status_code == 403
        assert c.get("/api/v1/missions/" + other_mission).status_code == 403
        assert c.get("/api/v1/missions").json() == []
        assert c.get("/api/v1/auth/audit").status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws/v1/telemetry/" + B):
                pass

        cross_vehicle = c.post("/api/v1/links/udp", json={
            "vehicle_id": B, "port": 17025, "fc_system_id": 1
        }, headers={"X-Vihanga-CSRF": csrf})
        assert cross_vehicle.status_code == 403, cross_vehicle.text
        assert B not in app.state.links.sessions
        assert c.post("/api/v1/vehicles", json={
            "vehicle_id": "AH-HW-003", "label": "Not allowed",
            "autopilot": "ARDUPILOT", "interface": "USB"
        }, headers={"X-Vihanga-CSRF": csrf}).status_code == 403

        no_csrf = c.post("/api/v1/missions", json={
            "vehicle_id": A, "title": "Pilot draft",
            "waypoints": [{"latitude":12.97,"longitude":77.59,"altitude_m":30},
                          {"latitude":12.98,"longitude":77.60,"altitude_m":30}]
        })
        assert no_csrf.status_code == 403
        allowed = c.post("/api/v1/missions", json={
            "vehicle_id": A, "title": "Pilot draft",
            "waypoints": [{"latitude":12.97,"longitude":77.59,"altitude_m":30},
                          {"latitude":12.98,"longitude":77.60,"altitude_m":30}]
        }, headers={"X-Vihanga-CSRF": csrf})
        assert allowed.status_code == 201, allowed.text
        assert len(c.get("/api/v1/missions").json()) == 1

        assert c.post("/api/v1/auth/logout",
                      headers={"X-Vihanga-CSRF": csrf}).status_code == 200
        viewer_csrf = sign_in(c, "viewer-one")
        assert c.get("/api/v1/telemetry/" + A).status_code == 200
        assert c.post("/api/v1/missions", json={
            "vehicle_id": A, "title": "Viewer cannot modify",
            "waypoints": [{"latitude":12.97,"longitude":77.59,"altitude_m":30},
                          {"latitude":12.98,"longitude":77.60,"altitude_m":30}]
        }, headers={"X-Vihanga-CSRF": viewer_csrf}).status_code == 403
        assert c.get("/api/v1/auth/me").json()["role"] == "VIEWER"


def test_legacy_local_profile_remains_backward_compatible(tmp_path, monkeypatch):
    monkeypatch.delenv("VIHANGA_OPERATOR_AUTH", raising=False)
    app = create_app(tmp_path / "legacy.sqlite3")
    with TestClient(app) as c:
        assert c.get("/api/v1/auth/status").json()["mode"] == "LEGACY"
        assert c.get("/api/v1/vehicles").status_code == 200
        assert c.get("/api/v1/auth/me").json()["authenticated"] is False
        assert c.post("/api/v1/auth/login", json={
            "username": "admin-one", "password": PASSWORD
        }).status_code == 409
