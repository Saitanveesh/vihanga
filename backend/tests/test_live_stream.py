from io import BytesIO

from fastapi.testclient import TestClient
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga.app import create_app
from vihanga.telemetry import MAVLinkProjector, Session


def frame(msg):
    port = mavlink.MAVLink(BytesIO())
    port.srcSystem = 1
    port.srcComponent = 1
    return msg.pack(port)


def setup(tmp_path):
    app = create_app(tmp_path / "live.sqlite3")
    c = TestClient(app)
    assert c.post("/api/v1/vehicles", json={
        "vehicle_id": "AIR-001", "label": "Test airframe",
        "autopilot": "ARDUPILOT", "interface": "UART"
    }).status_code == 201
    return app, c


def test_local_websocket_never_fabricates_telemetry(tmp_path):
    app, c = setup(tmp_path)
    with c.websocket_connect("/ws/v1/telemetry/AIR-001") as websocket:
        result = websocket.receive_json()
        assert result["status"] == "OFFLINE"
        assert result["latitude"] is None
        assert result["heartbeat_fresh"] is False
        assert result["flight_control_enabled"] is False


def test_websocket_reports_real_received_mavlink(tmp_path):
    app, c = setup(tmp_path)
    proj = MAVLinkProjector(1)
    session = Session("AIR-001", "TEST_MAVLINK", proj, state="CONNECTED")
    app.state.links.sessions["AIR-001"] = session
    proj.push(frame(mavlink.MAVLink_heartbeat_message(2,3,0,0,3,3)))
    proj.push(frame(mavlink.MAVLink_attitude_message(100,.1,-.2,.3,0,0,0)))
    with c.websocket_connect("/ws/v1/telemetry/AIR-001") as ws:
        sample = ws.receive_json()
        assert sample["status"] == "LIVE"
        assert sample["roll_deg"] > 5
        assert sample["pitch_deg"] < -10
        assert sample["flight_control_enabled"] is False


def test_gps_track_only_from_real_fix_and_packets(tmp_path):
    app, c = setup(tmp_path)
    projector = MAVLinkProjector(1)
    app.state.links.sessions["AIR-001"] = Session(
        "AIR-001", "TEST_MAVLINK", projector, state="CONNECTED")
    position = mavlink.MAVLink_global_position_int_message(
        1234, 129710000, 775900000, 40000, 10000, 0, 0, 0, 0
    assert projector.push(frame(position)) == 1
    assert c.get("/api/v1/flight-tracks/AIR-001").json()["count"] == 0
    gps = mavlink.MAVLink_gps_raw_int_message(
        1234, 3, 129710000, 775900000, 40000, 70, 70, 0, 0, 10)
    assert projector.push(frame(gps)) == 1
    assert projector.push(frame(position)) == 1
    trail = c.get("/api/v1/flight-tracks/AIR-001").json()
    assert trail["count"] == 1
    assert trail["status"] == "RECEIVED_GNSS_ONLY"
    assert trail["points"][0]["latitude"] == 12.971
    assert trail["points"][0]["longitude"] == 77.59
    assert c.get("/api/v1/flight-tracks/AIR-999").status_code == 404


def test_12_aircraft_registry_isolation_without_fake_online_status(tmp_path):
    app = create_app(tmp_path / "fleet.sqlite3")
    c = TestClient(app)
    for i in range(12):
        r = c.post("/api/v1/vehicles", json={
            "vehicle_id": f"UAV-{i+1:03}", "label": f"Aircraft {i+1}",
            "autopilot": "ARDUPILOT", "interface": "UART"
        })
        assert r.status_code == 201
    assert len(c.get("/api/v1/vehicles").json()) == 12
    for i in range(12):
        d = c.get(f"/api/v1/telemetry/UAV-{i+1:03}").json()
        assert d["status"] == "OFFLINE"
        assert d["flight_control_enabled"] is False
