from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga_cloud.app import AircraftIdentity, Broker, create_app, digest


def identities(count=2):
    return [
        AircraftIdentity(vehicle_id=f"TEST-{i+1:03}", system_id=i+1,
                         organization=f"lab-{i+1}",
                         device_token_hash=digest(chr(68+i)*40),
                         viewer_token_hash=digest(chr(86+i)*40))
        for i in range(count)
    ]


def frame(message, sysid=1):
    serializer = mavlink.MAVLink(BytesIO())
    serializer.srcSystem = sysid
    serializer.srcComponent = 1
    return message.pack(serializer)


def hb():
    return mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3)


def att():
    return mavlink.MAVLink_attitude_message(100, .1, -.2, 0, 0, 0, 0)


def test_broker_requires_credentials_and_aircraft_identity():
    broker = Broker(identities(2))
    assert broker.authorize("TEST-001", "D"*40) is broker.slots["TEST-001"]
    assert broker.authorize("TEST-001", "V"*40, viewer=True) is broker.slots["TEST-001"]
    assert broker.authorize("TEST-001", "E"*40) is None
    assert broker.authorize("TEST-002", "D"*40) is None
    assert broker.authorize("TEST-002", "V"*40, viewer=True) is None
    assert broker.authorize("TEST-999", "D"*40) is None
    assert all(not slot.status()["flight_control_enabled"] for slot in broker.slots.values())


def test_actual_mavlink_crc_origin_and_command_rejection():
    slot = Broker(identities()).slots["TEST-001"]
    parser = mavlink.MAVLink(None)
    good = frame(hb())
    assert slot.validate(good, parser)[1] == "HEARTBEAT"
    assert slot.frames_received == 1
    assert slot.validate(frame(hb(), 2), parser) is None
    tampered = bytearray(frame(att()))
    tampered[-1] ^= 0xFF
    assert slot.validate(bytes(tampered), parser) is None
    command = mavlink.MAVLink_command_long_message(1, 1, 400, 0, 1, 0, 0, 0, 0, 0, 0)
    assert slot.validate(frame(command), parser) is None
    assert slot.frames_rejected >= 3


def test_device_to_viewer_real_binary_fanout_never_accepts_viewer_commands():
    broker = Broker(identities())
    app = create_app(broker)
    with TestClient(app) as c:
        assert c.get("/health").json()["flight_control_enabled"] is False
        with c.websocket_connect("/ws/v1/view/TEST-001",
                                 headers={"Authorization": "Bearer " + "V"*40}) as viewer:
            with c.websocket_connect("/ws/v1/device/TEST-001",
                                     headers={"X-Vihanga-Device-Token": "D"*40}) as device:
                packet = frame(hb())
                device.send_bytes(packet)
                assert viewer.receive_bytes() == packet
                second = frame(att())
                device.send_bytes(second)
                assert viewer.receive_bytes() == second
                assert broker.slots["TEST-001"].frames_received == 2
                # Any viewer-to-broker bytes are ignored, never delivered to device.
                viewer.send_bytes(b"COMMAND_LONG")
                assert broker.slots["TEST-001"].frames_received == 2
        assert not broker.slots["TEST-001"].device_connected
        assert not broker.slots["TEST-001"].status()["heartbeat_fresh"]


def test_invalid_viewer_or_device_token_rejected_before_session():
    app = create_app(Broker(identities()))
    with TestClient(app) as c:
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws/v1/device/TEST-001",
                                     headers={"X-Vihanga-Device-Token": "BAD"*20}):
                pass
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws/v1/view/TEST-001",
                                     headers={"Authorization": "Bearer " + "D"*40}):
                pass


def test_twelve_aircraft_supported_as_isolated_provisioned_slots():
    broker = Broker(identities(12))
    assert len(broker.slots) == 12
    assert all(x.status()["status"] == "OFFLINE" for x in broker.slots.values())
    for i in range(12):
        id = f"TEST-{i+1:03}"
        assert broker.authorize(id, chr(68+i)*40) is broker.slots[id]
        other = f"TEST-{((i+1)%12)+1:03}"
        assert broker.authorize(other, chr(68+i)*40) is None
