from io import BytesIO

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga_edge.agent import FrameGate, Settings


def frame(message, sysid=1):
    codec = mavlink.MAVLink(BytesIO())
    codec.srcSystem = sysid
    codec.srcComponent = 1
    return message.pack(codec)


def test_edge_accepts_true_packet_framing_and_splits():
    gate = FrameGate(1)
    p = frame(mavlink.MAVLink_heartbeat_message(2,3,0,0,3,3))
    assert not gate.consume(p[:1])
    assert gate.consume(p[1:]) == [p]
    assert gate.accepted == 1


def test_edge_drops_wrong_aircraft_and_control_requests():
    gate = FrameGate(1)
    wrong = frame(mavlink.MAVLink_heartbeat_message(2,3,0,0,3,3),sysid=2)
    assert gate.consume(wrong) == []
    control = frame(mavlink.MAVLink_command_long_message(1,1,400,0,1,0,0,0,0,0,0))
    assert gate.consume(control) == []
    assert gate.rejected >= 2


def test_rc_channels_pass_pi_gate_but_not_flight_commands():
    gate = FrameGate(1)
    rc = mavlink.MAVLink_rc_channels_message(
        100, 6, *([1500, 1500, 1250, 1090, 1600, 1200] + [65535] * 12 + [255])
    )
    payload = frame(rc)
    assert gate.consume(payload) == [payload]
    assert gate.consume(frame(rc, sysid=2)) == []
    unsafe = frame(mavlink.MAVLink_command_long_message(1, 1, 400, 0, 1, 0, 0, 0, 0, 0, 0))
    assert gate.consume(unsafe) == []


def test_edge_configuration_requires_wss_and_strong_token():
    good = dict(vehicle_id="TEST-001", system_id=1, port="/dev/ttyAMA0",
                baud=57600, cloud_wss="wss://secure.example/ws/v1/device/TEST-001",
                token="T"*40)
    Settings(**good).validate()
    for patch in (
        {"cloud_wss": "ws://secure.example/ws/v1/device/TEST-001"},
        {"cloud_wss": "wss://secure.example/ws/v1/device/OTHER-001"},
        {"cloud_wss": "wss://user:pass@secure.example/ws/v1/device/TEST-001"},
        {"token": "short"},
        {"port": "/dev/tty/../../etc/passwd"},
        {"baud": 12345},
    ):
        with pytest.raises(ValueError):
            Settings(**{**good, **patch}).validate()
