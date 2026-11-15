"""GCS breadth and safe single-owner USB bench request contract."""
from io import BytesIO

from fastapi.testclient import TestClient
from pymavlink.dialects.v20 import ardupilotmega as mavlink
import pytest

from vihanga.app import create_app
from vihanga.operator_contract import (
    BenchQuery, BenchRequest, MESSAGE_IDS, OPERATIONS,
    catalog, encode_bench_query,
)
from vihanga.telemetry import MAVLinkProjector


def decode(packet: bytes):
    frames = mavlink.MAVLink(None).parse_buffer(packet)
    assert frames is not None and len(frames) == 1
    return frames[0]


def test_complete_operation_catalog_cannot_expose_actuation():
    overview = catalog(bench_enabled=True, local_serial=True, connected=True)
    assert overview["physical_flight_control_enabled"] is False
    assert overview["cloud_command_dispatch_enabled"] is False
    codes = {item["code"]: item for item in overview["operations"]}
    assert len(codes) == len(OPERATIONS)
    for name in ("ARM", "DISARM", "TAKEOFF", "LAND", "RTL", "SET_MODE",
                 "GUIDED_TARGET", "MISSION_UPLOAD", "MISSION_START",
                 "PARAM_WRITE", "CALIBRATE_ESC", "MOTOR_TEST",
                 "RC_OVERRIDE", "REBOOT_FC"):
        assert codes[name]["enabled"] is False
        assert codes[name]["status"] == "LOCKED"
        assert codes[name]["bench_query"] is None
    for name in ("FC_VERSION", "GPS", "GPS2", "EKF", "PARAM_READ",
                 "PARAM_LIST", "MISSION_DOWNLOAD", "RC"):
        assert codes[name]["enabled"] is True
        assert codes[name]["status"] == "READY"

    for ready in (catalog(bench_enabled=False, local_serial=True, connected=True),
                  catalog(bench_enabled=True, local_serial=False, connected=True),
                  catalog(bench_enabled=True, local_serial=True, connected=False)):
        assert all(not entry["enabled"] for entry in ready["operations"])


@pytest.mark.parametrize("kind,msg_id", list(MESSAGE_IDS.items()))
def test_bench_requests_never_encode_flight_changing_messages(kind, msg_id):
    decoded = decode(encode_bench_query(BenchQuery(query=kind), 1))
    assert decoded.get_type() == "COMMAND_LONG"
    assert decoded.command == mavlink.MAV_CMD_REQUEST_MESSAGE
    assert decoded.param1 == msg_id
    assert decoded.target_system == 1
    assert decoded.target_component == 1


def test_parameter_and_mission_read_packets_are_only_requests():
    param_read = decode(encode_bench_query(
        BenchQuery(query=BenchRequest.PARAMETER_READ, parameter="GPS_TYPE"), 1))
    assert param_read.get_type() == "PARAM_REQUEST_READ"
    assert param_read.param_index == -1
    assert str(param_read.param_id).strip("b'\\x00") != ""

    param_list = decode(encode_bench_query(
        BenchQuery(query=BenchRequest.PARAMETER_LIST), 1))
    assert param_list.get_type() == "PARAM_REQUEST_LIST"

    mission = decode(encode_bench_query(
        BenchQuery(query=BenchRequest.MISSION_SUMMARY), 1))
    assert mission.get_type() == "MISSION_REQUEST_LIST"
    assert mission.target_system == 1


@pytest.mark.parametrize("payload", [
    {"query": "ARM"}, {"query": "PARAMETER_WRITE"},
    {"query": "PARAMETER_READ"},
    {"query": "PARAMETER_READ", "parameter": "X;DROP"},
    {"query": "FC_VERSION", "parameter": "GPS_TYPE"},
])
def test_injecting_actuation_or_malformed_parameters_is_refused(payload):
    with pytest.raises(ValueError):
        # Includes Pydantic model validation and semantic .check().
        encode_bench_query(BenchQuery.model_validate(payload), 1)


def test_projector_only_accepts_parameters_from_matching_fc():
    p = MAVLinkProjector(1)
    for system_id, name, value in ((2, "GPS_TYPE", 99.0), (1, "GPS_TYPE", 1.0)):
        codec = mavlink.MAVLink(BytesIO())
        codec.srcSystem, codec.srcComponent = system_id, 1
        raw = mavlink.MAVLink_param_value_message(
            name.encode("ascii"), value, mavlink.MAV_PARAM_TYPE_REAL32, 420, 14
        ).pack(codec)
        p.push(raw)
    params = p.parameter_snapshot()
    assert params["received"] == 1
    assert params["reported_total"] == 420
    assert params["items"]["GPS_TYPE"]["value"] == 1.0


def test_default_backend_refuses_every_actuating_or_bench_write(tmp_path):
    c = TestClient(create_app(tmp_path / "operator.sqlite3"))
    vehicle = {"vehicle_id":"AH-HW-001","label":"Bench aircraft",
               "autopilot":"ARDUPILOT","interface":"USB"}
    assert c.post("/api/v1/vehicles", json=vehicle).status_code == 201
    items = c.get("/api/v1/operator/AH-HW-001/catalog").json()
    assert items["physical_flight_control_enabled"] is False
    assert all(not x["enabled"] for x in items["operations"])
    assert c.post("/api/v1/control/commands", json={"action":"ARM"}).status_code == 404
    url = "/api/v1/operator/AH-HW-001/bench-query"
    assert c.post(url, json={"query":"ARM"}).status_code == 422
    assert c.post(url, json={"query":"FC_VERSION"}).status_code == 403
    assert c.post(url, json={"query":"FC_VERSION"}, headers={
        "X-Vihanga-Bench-Read":"confirm-non-actuating-request",
        "Origin":"https://attacker.example",
    }).status_code == 403
    denied = c.post(url, json={"query":"FC_VERSION"}, headers={
        "X-Vihanga-Bench-Read":"confirm-non-actuating-request",
        "Origin":"http://127.0.0.1:5173",
    })
    assert denied.status_code == 409
    assert c.get("/api/v1/operator/AH-HW-001/parameters").json()["items"] == {}
