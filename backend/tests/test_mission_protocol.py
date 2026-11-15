from io import BytesIO

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga.mission_protocol import MissionFault, MissionPoint, MissionTransaction, Phase


def fc(message, sysid=1):
    encoder = mavlink.MAVLink(BytesIO())
    encoder.srcSystem = sysid
    encoder.srcComponent = 1
    raw = message.pack(encoder)
    return mavlink.MAVLink(None).parse_buffer(raw)[0]


def decode(packet):
    return mavlink.MAVLink(None).parse_buffer(packet)[0]


def points():
    return [
        MissionPoint(12.971, 77.590, 35),
        MissionPoint(12.972, 77.591, 40),
        MissionPoint(12.973, 77.592, 42)
    ]


def mission_request(i):
    return fc(mavlink.MAVLink_mission_request_int_message(255, 190, i, 0))


def complete_upload(t):
    count = decode(t.begin_upload())
    assert count.get_type() == "MISSION_COUNT"
    assert count.count == 3
    assert t.summary()["verified"] is False
    for i in range(3):
        item = decode(t.on_request_int(mission_request(i), 1))
        assert item.get_type() == "MISSION_ITEM_INT"
        assert item.seq == i
        assert item.command == mavlink.MAV_CMD_NAV_WAYPOINT
    assert t.phase == Phase.WAITING_UPLOAD_ACK
    ack = fc(mavlink.MAVLink_mission_ack_message(255, 190, mavlink.MAV_MISSION_ACCEPTED, 0))
    assert t.on_upload_ack(ack, 1)
    assert t.phase == Phase.UPLOAD_ACCEPTED


def test_mission_upload_requires_real_fc_acceptance_and_exact_item_readback():
    t = MissionTransaction(system_id=1, waypoints=points())
    complete_upload(t)
    readback_request_list = decode(t.begin_readback())
    assert readback_request_list.get_type() == "MISSION_REQUEST_LIST"
    count = fc(mavlink.MAVLink_mission_count_message(255, 190, 3, 0))
    request = decode(t.on_readback_count(count, 1))
    assert request.get_type() == "MISSION_REQUEST_INT"
    assert request.seq == 0
    for i, (x, y, z) in enumerate(t.fixed):
        item = fc(mavlink.MAVLink_mission_item_int_message(
            255, 190, i, mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            mavlink.MAV_CMD_NAV_WAYPOINT, 1 if i == 0 else 0,
            1, 0, 0, 0, 0, x, y, z, mavlink.MAV_MISSION_TYPE_MISSION))
        next_request = t.on_readback_item(item, 1)
        if i < 2:
            assert decode(next_request).seq == i + 1
        else:
            assert next_request is None
    summary = t.summary()
    assert summary["phase"] == "VERIFIED"
    assert summary["fc_upload_accepted"] is True
    assert summary["verified"] is True
    assert summary["mission_started"] is False
    assert len(summary["revision_sha256"]) == 64


def test_untrusted_system_id_and_out_of_bounds_requests_refused():
    t = MissionTransaction(system_id=1, waypoints=points())
    t.begin_upload()
    with pytest.raises(MissionFault, match="Untrusted"):
        t.on_request_int(mission_request(0), 2)
    with pytest.raises(MissionFault, match="out of bounds"):
        t.on_request_int(mission_request(99), 1)
    assert t.summary()["verified"] is False


def test_readback_different_coordinate_is_refused_not_success():
    t = MissionTransaction(system_id=1, waypoints=points())
    complete_upload(t)
    t.begin_readback()
    t.on_readback_count(fc(mavlink.MAVLink_mission_count_message(255,190,3,0)),1)
    x,y,z = t.fixed[0]
    altered = fc(mavlink.MAVLink_mission_item_int_message(
        255,190,0,mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        mavlink.MAV_CMD_NAV_WAYPOINT,1,1,0,0,0,0,x+99,y,z,0))
    with pytest.raises(MissionFault,match="READBACK_ITEM_MISMATCH"):
        t.on_readback_item(altered,1)
    assert t.summary()["phase"] == "REFUSED"


def test_stale_revision_and_expired_transactions_refused():
    with pytest.raises(MissionFault,match="revision mismatch"):
        MissionTransaction(system_id=1, waypoints=points(), expected_revision="0"*64)
    clock = [10.0]
    t = MissionTransaction(system_id=1, waypoints=points(), clock=lambda:clock[0])
    t.begin_upload()
    clock[0] = 18.0
    with pytest.raises(MissionFault,match="TIMEOUT"):
        t.on_request_int(mission_request(0),1)
    assert t.summary()["phase"] == "TIMED_OUT"


def test_duplicate_upload_requests_are_bounded():
    t = MissionTransaction(system_id=1, waypoints=points())
    t.begin_upload()
    for _ in range(3):
        t.on_request_int(mission_request(0),1)
    with pytest.raises(MissionFault,match="TOO_MANY_ITEM_RETRIES"):
        t.on_request_int(mission_request(0),1)
    assert t.phase == Phase.REFUSED
