from contextlib import ExitStack
from dataclasses import replace
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


def test_broker_rejects_reused_tokens_even_across_organizations_and_roles():
    first, second = identities(2)
    with pytest.raises(ValueError, match="Credential digests must be unique"):
        Broker([first, replace(second, device_token_hash=first.viewer_token_hash)])
    with pytest.raises(ValueError, match="Credential digests must be unique"):
        Broker([replace(first, viewer_token_hash=first.device_token_hash)])
    assert len(Broker([first, second]).slots) == 2


def test_twelve_concurrent_device_viewer_streams_are_vehicle_isolated():
    """Concurrent protocol sockets, not twelve real flight-tested aircraft."""
    n = 12
    broker = Broker(identities(n))
    with TestClient(create_app(broker)) as client, ExitStack() as stack:
        viewers, devices = {}, {}
        for i in range(n):
            vehicle = f"TEST-{i+1:03}"
            token = chr(86 + i) * 40
            viewers[vehicle] = stack.enter_context(client.websocket_connect(
                f"/ws/v1/view/{vehicle}",
                headers={"Authorization": "Bearer " + token}))
        for i in range(n):
            vehicle = f"TEST-{i+1:03}"
            token = chr(68 + i) * 40
            devices[vehicle] = stack.enter_context(client.websocket_connect(
                f"/ws/v1/device/{vehicle}",
                headers={"X-Vihanga-Device-Token": token}))

        # Every vehicle's wire packet differs by FC SYSID. A cross-routed
        # packet would fail the exact byte comparison at the viewer.
        for i in range(n):
            vehicle = f"TEST-{i+1:03}"
            devices[vehicle].send_bytes(frame(hb(), sysid=i+1))
        for i in range(n):
            vehicle = f"TEST-{i+1:03}"
            assert viewers[vehicle].receive_bytes() == frame(hb(), sysid=i+1)
        for i in range(n):
            vehicle = f"TEST-{i+1:03}"
            devices[vehicle].send_bytes(frame(att(), sysid=i+1))
        for i in range(n):
            vehicle = f"TEST-{i+1:03}"
            assert viewers[vehicle].receive_bytes() == frame(att(), sysid=i+1)
            status = broker.slots[vehicle].status()
            assert status["status"] == "LIVE", status
            assert status["frames_received"] == 2
            assert status["viewers"] == 1
            assert status["flight_control_enabled"] is False
    assert all(slot.status()["status"] == "OFFLINE" for slot in broker.slots.values())


def test_invalid_envelope_cannot_poison_next_packet():
    slot = Broker(identities()).slots["TEST-001"]
    decoder = mavlink.MAVLink(None)
    good = frame(hb())
    for malformed in (good[:10], good + good, b"x" + good):
        assert slot.validate(malformed, decoder) is None
        assert slot.validate(good, decoder) == (good, "HEARTBEAT")


def test_viewer_capacity_is_released_after_disconnect(monkeypatch):
    monkeypatch.setattr("vihanga_cloud.app.MAX_VIEWERS_PER_AIRCRAFT", 1)
    broker = Broker(identities())
    path = "/ws/v1/view/TEST-001"
    headers = {"Authorization": "Bearer " + "V" * 40}
    with TestClient(create_app(broker)) as client:
        with client.websocket_connect(path, headers=headers):
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(path, headers=headers):
                    pytest.fail("Unexpected second viewer")
        with client.websocket_connect(path, headers=headers):
            assert len(broker.slots["TEST-001"].viewers) == 1


def test_slow_viewer_overflow_timeout_and_task_cleanup(monkeypatch):
    import asyncio

    async def scenario():
        monkeypatch.setattr("vihanga_cloud.app.VIEWER_SEND_TIMEOUT_SECONDS", 0.1)
        monkeypatch.setattr("vihanga_cloud.app.MAX_VIEWERS_PER_AIRCRAFT", 1)
        broker = Broker(identities())
        slot = broker.slots["TEST-001"]
        routes = {route.name: route.endpoint for route in create_app(broker).routes}

        class Socket:
            def __init__(self, headers):
                self.headers = headers
                self.inbox = asyncio.Queue()
                self.accepted = asyncio.Event()
                self.sending = asyncio.Event()
                self.send_cancelled = False
                self.receives = 0
                self.closed = None

            async def accept(self):
                self.accepted.set()

            async def receive(self):
                self.receives += 1
                try:
                    return await self.inbox.get()
                finally:
                    self.receives -= 1

            async def send_bytes(self, packet):
                self.sending.set()
                try:
                    await asyncio.Future()
                finally:
                    self.send_cancelled = True

            async def close(self, code):
                self.closed = code

        headers = {"authorization": "Bearer " + "V" * 40}
        viewer = Socket(headers)
        device = Socket({"x-vihanga-device-token": "D" * 40})
        tasks = [asyncio.create_task(routes["viewer"](viewer, "TEST-001")),
                 asyncio.create_task(routes["device"](device, "TEST-001"))]
        try:
            await asyncio.wait_for(viewer.accepted.wait(), 1)
            await asyncio.wait_for(device.accepted.wait(), 1)
            rejected = [Socket(headers) for _ in range(8)]
            await asyncio.gather(*(routes["viewer"](s, "TEST-001") for s in rejected))
            assert all(s.closed == 1013 and not s.accepted.is_set() for s in rejected)

            packet = frame(hb())
            device.inbox.put_nowait({"bytes": packet})
            await asyncio.wait_for(viewer.sending.wait(), 1)
            for _ in range(80):
                device.inbox.put_nowait({"bytes": packet})
            await asyncio.sleep(0)
            assert slot.frames_received == 81
            assert slot.viewer_frames_dropped == 16
            await asyncio.wait_for(tasks[0], 1)
            assert viewer.send_cancelled and viewer.closed == 1013
            assert viewer.receives == 0 and not slot.viewers
            assert slot.viewer_send_timeouts == 1
            assert slot.viewer_frames_dropped == 80

            device.inbox.put_nowait({"type": "websocket.disconnect"})
            await asyncio.wait_for(tasks[1], 1)
            assert slot.status()["status"] == "OFFLINE"
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())


def test_versioned_config_requires_role_expiry(monkeypatch):
    import json
    from vihanga_cloud.app import from_environment

    identity = identities()[0]
    entry = {
        "vehicle_id": identity.vehicle_id, "system_id": identity.system_id,
        "organization": identity.organization, "device_token_sha256": identity.device_token_hash,
        "viewer_token_sha256": identity.viewer_token_hash,
    }
    config = {"version": 2, "aircraft": [entry]}
    monkeypatch.setenv("VIHANGA_CLOUD_AIRCRAFT_JSON", json.dumps(config))
    with pytest.raises(RuntimeError, match="Invalid Vihanga"):
        from_environment()
    entry.update(device_expires_at=1, viewer_expires_at=253402300799)
    monkeypatch.setenv("VIHANGA_CLOUD_AIRCRAFT_JSON", json.dumps(config))
    broker = from_environment()
    assert broker.authorize("TEST-001", "D" * 40) is None
    assert broker.authorize("TEST-001", "V" * 40, viewer=True) is not None


def test_already_connected_device_and_viewer_expire():
    import time

    expiry = int(time.time()) + 2
    identity = replace(identities()[0], device_expires_at=expiry, viewer_expires_at=expiry)
    broker = Broker([identity])
    with TestClient(create_app(broker)) as client:
        with client.websocket_connect("/ws/v1/view/TEST-001",
                                      headers={"Authorization": "Bearer " + "V" * 40}) as viewer:
            with client.websocket_connect("/ws/v1/device/TEST-001",
                                          headers={"X-Vihanga-Device-Token": "D" * 40}) as device:
                for socket in (device, viewer):
                    with pytest.raises(WebSocketDisconnect) as closed:
                        socket.receive_bytes()
                    assert closed.value.code == 4401
    slot = broker.slots["TEST-001"]
    assert not slot.device_connected and not slot.viewers
