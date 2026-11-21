from fastapi.testclient import TestClient
from vihanga.app import create_app


def client(tmp_path):
    return TestClient(create_app(tmp_path / "test.sqlite3"))


def test_serial_scan_reports_only_actual_host_ports(tmp_path, monkeypatch):
    from unittest.mock import Mock
    from vihanga import app as api
    monkeypatch.setattr(api.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        "serial.tools.list_ports.comports",
        lambda: [Mock(device="COM6"), Mock(device="COM4"), Mock(device="invalid-path")])
    reply = client(tmp_path).get("/api/v1/serial/ports")
    assert reply.status_code == 200
    assert reply.json() == {
        "host_platform": "WINDOWS", "ports": ["COM4", "COM6"],
        "scope": "API_HOST_ONLY"
    }


def test_oracle_does_not_claim_windows_usb_and_returns_specific_error(tmp_path, monkeypatch):
    from vihanga import app as api
    monkeypatch.setattr(api.platform, "system", lambda: "Linux")
    c = client(tmp_path)
    assert c.post("/api/v1/vehicles", json={
        "vehicle_id": "AH-HW-001", "label": "Bench Pixhawk",
        "autopilot": "ARDUPILOT", "interface": "UART"}).status_code == 201
    attempt = c.post("/api/v1/links/serial", json={
        "vehicle_id": "AH-HW-001", "port": "COM6", "baud": 57600,
        "fc_system_id": 1})
    assert attempt.status_code == 409
    assert "cannot open" in attempt.json()["detail"]
    backup = c.post("/api/v1/links/backup/serial", json={
        "vehicle_id": "AH-HW-001", "port": "COM6", "baud": 57600,
        "fc_system_id": 1})
    assert backup.status_code == 409
    assert "COM6" in backup.json()["detail"]


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


def test_fleet_telemetry_is_one_bounded_read_only_snapshot(tmp_path):
    from io import BytesIO
    from pymavlink.dialects.v20 import ardupilotmega as mavlink
    from vihanga.telemetry import MAVLinkProjector, Session

    app = create_app(tmp_path / "fleet-overview.sqlite3")
    c = TestClient(app)
    for i in range(12):
        vehicle_id = f"UAV-{i+1:03}"
        registered = c.post("/api/v1/vehicles", json={
            "vehicle_id": vehicle_id, "label": f"Aircraft {i+1}",
            "autopilot": "ARDUPILOT", "interface": "UART"})
        assert registered.status_code == 201

    projector = MAVLinkProjector(1)
    codec = mavlink.MAVLink(BytesIO())
    codec.srcSystem, codec.srcComponent = 1, 1
    raw_hb = mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3).pack(codec)
    raw_att = mavlink.MAVLink_attitude_message(100, .1, -.2, .3, 0, 0, 0).pack(codec)
    assert projector.push(raw_hb) == 1
    assert projector.push(raw_att) == 1
    app.state.links.sessions["UAV-001"] = Session(
        "UAV-001", "INTEGRATION", projector, state="CONNECTED")
    result = c.get("/api/v1/fleet/telemetry")
    assert result.status_code == 200
    data = result.json()
    assert len(data) == 12
    assert list(data) == [f"UAV-{i+1:03}" for i in range(12)]
    assert data["UAV-001"]["status"] == "LIVE"
    assert data["UAV-001"]["frames_total"] == 2
    assert data["UAV-001"]["frame_rate_5s_hz"] > 0
    for i in range(2, 13):
        sample = data[f"UAV-{i:03}"]
        assert sample["status"] == "OFFLINE"
        assert sample["frames_total"] == 0
        assert sample["latitude"] is None
        assert sample["flight_control_enabled"] is False


def test_development_api_rejects_dns_rebinding_host_and_allows_loopback(tmp_path):
    c = client(tmp_path)
    assert c.get("/api/v1/health", headers={"Host": "127.0.0.1:8010"}).status_code == 200
    assert c.get("/api/v1/health", headers={"Host": "localhost:8010"}).status_code == 200
    assert c.get("/api/v1/health", headers={"Host": "external.attacker.example"}).status_code == 400
    assert c.get("/api/v1/fleet/telemetry",
                 headers={"Host": "external.attacker.example"}).status_code == 400



def test_backup_endpoints_keep_primary_and_no_command_route(tmp_path):
    app = create_app(tmp_path / "dual-receiver.sqlite3")
    with TestClient(app) as c:
        vehicle = {"vehicle_id": "AH-HW-001", "label": "Bench aircraft",
                   "autopilot": "ARDUPILOT", "interface": "UART"}
        assert c.post("/api/v1/vehicles", json=vehicle).status_code == 201
        primary = c.post("/api/v1/links/udp", json={
            "vehicle_id": "AH-HW-001", "port": 15648, "fc_system_id": 1})
        assert primary.status_code == 200, primary.text
        data = primary.json()
        assert data["active_source"] == "PRIMARY"
        assert data["backup_status"] == "NOT_CONFIGURED"
        assert data["flight_control_enabled"] is False

        duplicate = c.post("/api/v1/links/backup/udp", json={
            "vehicle_id": "AH-HW-001", "port": 15649, "fc_system_id": 1})
        assert duplicate.status_code == 422
        assert "different transport" in duplicate.json()["detail"]
        wrong_identity = c.post("/api/v1/links/backup/tcp", json={
            "vehicle_id": "AH-HW-001", "port": 15649, "fc_system_id": 2})
        assert wrong_identity.status_code == 422
        assert "system ID" in wrong_identity.json()["detail"]

        # A second viewer cannot be selected until real, validated packets
        # arrive from that independent flight-controller receive path.
        refused = c.post("/api/v1/links/select/AH-HW-001/BACKUP")
        assert refused.status_code == 409
        assert c.get("/api/v1/telemetry/AH-HW-001").json()["active_source"] == "PRIMARY"
        assert c.delete("/api/v1/links/backup/AH-HW-001").json()["status"] == "WAITING_FOR_FRAMES"
        assert c.delete("/api/v1/links/AH-HW-001").json()["status"] == "OFFLINE"
        assert c.post("/api/v1/flight-control/arm", json={"vehicle_id":"AH-HW-001"}).status_code == 404
