from fastapi.testclient import TestClient
from vihanga.app import create_app


def client(tmp_path):
    return TestClient(create_app(tmp_path / "test.sqlite3"))


def test_no_physical_commands_are_exposed(tmp_path):
    c = client(tmp_path)
    assert c.get("/api/v1/health").json()["physical_flight_control"] is False
    assert c.get("/api/v1/capabilities").json()["cloud_command_dispatch"] is False
    assert c.post("/api/v1/control/commands", json={"action": "ARM"}).status_code == 404


def test_vehicle_identity_is_offline_and_unique(tmp_path):
    c = client(tmp_path)
    v = {"vehicle_id": "AH-HW-001", "label": "Bench Pixhawk",
         "autopilot": "ARDUPILOT", "interface": "UART"}
    assert c.post("/api/v1/vehicles", json=v).status_code == 201
    assert c.post("/api/v1/vehicles", json=v).status_code == 409
    items = c.get("/api/v1/vehicles").json()
    assert len(items) == 1
    assert items[0]["link_state"] == "OFFLINE"
    assert items[0]["control_authorized"] is False


def test_mission_draft_persists_and_hashes_but_cannot_execute(tmp_path):
    c = client(tmp_path)
    c.post("/api/v1/vehicles", json={"vehicle_id": "AIR-001",
           "label": "Test aircraft", "autopilot": "ARDUPILOT", "interface": "UART"})
    draft = {"vehicle_id": "AIR-001", "title": "Inspection draft",
             "waypoints": [{"latitude": 12.9, "longitude": 77.5, "altitude_m": 30},
                           {"latitude": 12.901, "longitude": 77.501, "altitude_m": 30}]}
    created = c.post("/api/v1/missions", json=draft)
    assert created.status_code == 201, created.text
    result = created.json()
    assert result["status"] == "DRAFT_ONLY"
    assert result["distance_m"] > 0
    assert len(result["revision_sha256"]) == 64
    assert c.get("/api/v1/missions/" + result["mission_id"]).json() == result
    assert c.post("/api/v1/missions/" + result["mission_id"] + "/start").status_code == 404


def test_reject_invalid_coordinates_extra_control_fields_and_unregistered_aircraft(tmp_path):
    c = client(tmp_path)
    c.post("/api/v1/vehicles", json={"vehicle_id": "AIR-001",
           "label": "Test aircraft", "autopilot": "OTHER", "interface": "OTHER"})
    base = {"vehicle_id": "AIR-001", "title": "Route draft",
            "waypoints": [{"latitude": 12.9, "longitude": 77.5, "altitude_m": 30},
                          {"latitude": 12.901, "longitude": 77.501, "altitude_m": 30}]}
    bad = {**base, "waypoints": [{**base["waypoints"][0], "latitude": 91},
                                base["waypoints"][1]]}
    assert c.post("/api/v1/missions", json=bad).status_code == 422
    assert c.post("/api/v1/missions", json={**base, "arm": True}).status_code == 422
    assert c.post("/api/v1/missions", json={**base, "vehicle_id": "AIR-404"}).status_code == 404
