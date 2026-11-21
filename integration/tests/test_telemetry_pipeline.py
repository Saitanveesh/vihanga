"""In-process protocol acceptance: Edge -> Cloud WSS -> GCS telemetry contract.

Real MAVLink2 bytes are serialized, parsed, forwarded and projected.
The GCS projector is attached by the harness: this does NOT constitute a
physical serial, remote TLS network, or flight-control acceptance test.
"""
from hashlib import sha256
from io import BytesIO
import json
import os

from fastapi.testclient import TestClient
from pymavlink.dialects.v20 import ardupilotmega as mavlink

# Cloud module fails closed during import when no aircraft is provisioned.
# These fixtures are local test identities, never operational credentials.
os.environ["VIHANGA_CLOUD_AIRCRAFT_JSON"] = json.dumps([
    {"vehicle_id": "TEST-001", "system_id": 1, "organization": "lab-a",
     "device_token_sha256": sha256(("D" * 40).encode()).hexdigest(),
     "viewer_token_sha256": sha256(("V" * 40).encode()).hexdigest()},
    {"vehicle_id": "TEST-002", "system_id": 2, "organization": "lab-b",
     "device_token_sha256": sha256(("E" * 40).encode()).hexdigest(),
     "viewer_token_sha256": sha256(("W" * 40).encode()).hexdigest()},
])

from vihanga_cloud.app import AircraftIdentity, Broker, create_app as create_cloud, digest
from vihanga_edge.agent import FrameGate
from vihanga.app import create_app as create_gcs
from vihanga.telemetry import MAVLinkProjector, Session


def frame(message, sysid=1):
    encoder = mavlink.MAVLink(BytesIO())
    encoder.srcSystem = sysid
    encoder.srcComponent = 1
    return message.pack(encoder)


def identities():
    return [
        AircraftIdentity("TEST-001", 1, "lab-a", digest("D" * 40), digest("V" * 40)),
        AircraftIdentity("TEST-002", 2, "lab-b", digest("E" * 40), digest("W" * 40)),
    ]


def heartbeat():
    return mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3)


def attitude():
    return mavlink.MAVLink_attitude_message(100, .1, -.2, .3, 0, 0, 0)


def position():
    return mavlink.MAVLink_global_position_int_message(
        1234, 129710000, 775900000, 40000, 10000, 0, 0, 0, 0)


def gps(fix=3):
    return mavlink.MAVLink_gps_raw_int_message(
        1234, fix, 129710000, 775900000, 40000, 70, 70, 0, 0, 10)


def test_rc_receiver_input_survives_edge_cloud_projector_without_fake_standby():
    # A real RC_CHANNELS MAVLink message travels through the same validated
    # edge and broker gates as flight telemetry, not as a separate GCS link.
    rc = mavlink.MAVLink_rc_channels_message(
        120, 6, *([1510, 1500, 1030, 1200, 1820, 1100] + [65535] * 12 + [220])
    )
    raw = frame(rc)
    gate = FrameGate(1)
    assert gate.consume(raw) == [raw]

    slot = Broker(identities()).slots["TEST-001"]
    forwarded = slot.validate(raw, mavlink.MAVLink(None))
    assert forwarded == (raw, "RC_CHANNELS")
    projector = MAVLinkProjector(1)
    assert projector.push(forwarded[0]) == 1
    sample = projector.snapshot()
    assert sample["rc_input_status"] == "CHANNELS_REPORTED"
    assert sample["rc_channels_fresh"] is True
    assert sample["rc_channel_count"] == 6
    assert sample["rc_rssi_raw"] == 220
    assert sample["radio_rssi_raw"] is None
    assert sample["heartbeat_fresh"] is False
    assert gate.consume(frame(rc, sysid=2)) == []


def test_real_protocol_edge_to_cloud_to_gcs_instruments_and_map(tmp_path):
    broker = Broker(identities())
    gcs = create_gcs(tmp_path / "fleet.sqlite3")
    projector = MAVLinkProjector(1)
    gcs.state.links.sessions["TEST-001"] = Session(
        "TEST-001", "PROTOCOL_INTEGRATION_TEST", projector, state="CONNECTED")
    gate = FrameGate(1)
    with TestClient(gcs) as console, TestClient(create_cloud(broker)) as cloud:
        registered = console.post("/api/v1/vehicles", json={
            "vehicle_id": "TEST-001", "label": "Bench simulator",
            "autopilot": "ARDUPILOT", "interface": "UART"})
        assert registered.status_code == 201
        with cloud.websocket_connect("/ws/v1/view/TEST-001",
                headers={"Authorization": "Bearer " + "V" * 40}) as viewer:
            with cloud.websocket_connect("/ws/v1/device/TEST-001",
                    headers={"X-Vihanga-Device-Token": "D" * 40}) as device:
                def transmit(message):
                    packet = frame(message)
                    assert gate.consume(packet[:3]) == []
                    accepted = gate.consume(packet[3:])
                    assert accepted == [packet]
                    device.send_bytes(accepted[0])
                    relay_packet = viewer.receive_bytes()
                    assert relay_packet == packet
                    assert projector.push(relay_packet) == 1

                transmit(heartbeat())
                transmit(attitude())
                transmit(position())
                # A position transmitted without GPS fix must not appear on map.
                assert console.get("/api/v1/telemetry/TEST-001").json()["latitude"] is None
                assert console.get("/api/v1/flight-tracks/TEST-001").json()["count"] == 0
                transmit(gps())
                assert console.get("/api/v1/telemetry/TEST-001").json()["latitude"] is None
                transmit(position())
                sample = console.get("/api/v1/telemetry/TEST-001").json()
                assert sample["status"] == "LIVE"
                assert sample["heartbeat_fresh"] and sample["attitude_fresh"]
                assert sample["latitude"] == 12.971
                assert sample["longitude"] == 77.59
                assert sample["roll_deg"] > 5
                assert sample["pitch_deg"] < -10
                assert sample["flight_control_enabled"] is False
                assert console.get("/api/v1/flight-tracks/TEST-001").json()["count"] == 1
                with console.websocket_connect("/ws/v1/telemetry/TEST-001") as ui:
                    pushed = ui.receive_json()
                    assert pushed["status"] == "LIVE"
                    assert pushed["latitude"] == 12.971
                    assert pushed["flight_control_enabled"] is False
                # Neither corrupted telemetry nor a MAVLink command can pass
                # through the receive-only edge collector.
                corrupt = bytearray(frame(attitude()))
                corrupt[-1] ^= 0xFF
                assert gate.consume(bytes(corrupt)) == []
                command = mavlink.MAVLink_command_long_message(
                    1, 1, mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                    0, 1, 0, 0, 0, 0, 0, 0)
                assert gate.consume(frame(command)) == []
                assert gate.consume(frame(heartbeat(), sysid=2)) == []
                assert gate.rejected >= 3
                assert broker.slots["TEST-001"].frames_received == 5
                assert broker.slots["TEST-002"].frames_received == 0
                assert cloud.get("/health").json()["flight_control_enabled"] is False
                viewer.send_bytes(b"not-a-command-channel")
                assert broker.slots["TEST-001"].frames_received == 5
        assert broker.slots["TEST-001"].status()["status"] == "OFFLINE"
        assert broker.slots["TEST-001"].status()["heartbeat_fresh"] is False


def test_cross_vehicle_tokens_are_not_interchangeable_and_reconnect_resets_epoch():
    broker = Broker(identities())
    with TestClient(create_cloud(broker)) as client:
        from starlette.websockets import WebSocketDisconnect
        import pytest
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/v1/view/TEST-002",
                    headers={"Authorization": "Bearer " + "V" * 40}):
                pass
        with client.websocket_connect("/ws/v1/view/TEST-001",
                headers={"Authorization": "Bearer " + "V" * 40}) as viewer:
            with client.websocket_connect("/ws/v1/device/TEST-001",
                    headers={"X-Vihanga-Device-Token": "D" * 40}) as device:
                device.send_bytes(frame(heartbeat()))
                assert viewer.receive_bytes() == frame(heartbeat())
                epoch = broker.slots["TEST-001"].epoch
            assert not broker.slots["TEST-001"].device_connected
            assert not broker.slots["TEST-001"].status()["heartbeat_fresh"]
            with client.websocket_connect("/ws/v1/device/TEST-001",
                    headers={"X-Vihanga-Device-Token": "D" * 40}) as next_device:
                assert broker.slots["TEST-001"].epoch > epoch
                assert broker.slots["TEST-001"].status()["status"] == "WAITING_FOR_DATA"
                next_device.send_bytes(frame(attitude()))
                assert viewer.receive_bytes() == frame(attitude())
                assert not broker.slots["TEST-001"].status()["heartbeat_fresh"]
        assert broker.slots["TEST-001"].status()["status"] == "OFFLINE"



def test_broker_loss_recovery_rejects_old_epoch_and_requires_fresh_fc_state(tmp_path):
    """Real TestClient WebSockets and serialized MAVLink; no hosted TLS/FC.

    Keep an authenticated viewer through one device disconnect and reconnect.
    Verify that a new device epoch cannot inherit old heartbeat/attitude
    freshness or publish an aircraft position from an earlier epoch.
    """
    broker = Broker(identities())
    gate = FrameGate(1)
    gcs = create_gcs(tmp_path / "recovery.sqlite3")
    projector = MAVLinkProjector(1)
    gcs.state.links.sessions["TEST-001"] = Session(
        "TEST-001", "FAULT_INJECTION_HARNESS", projector, state="CONNECTED")
    with TestClient(gcs) as console, TestClient(create_cloud(broker)) as cloud:
        assert console.post("/api/v1/vehicles", json={
            "vehicle_id": "TEST-001", "label": "Recovery unit",
            "autopilot": "ARDUPILOT", "interface": "UART"
        }).status_code == 201
        with cloud.websocket_connect(
            "/ws/v1/view/TEST-001",
            headers={"Authorization": "Bearer " + "V" * 40}
        ) as viewer:
            with cloud.websocket_connect(
                "/ws/v1/device/TEST-001",
                headers={"X-Vihanga-Device-Token": "D" * 40}
            ) as first:
                for message in (heartbeat(), attitude(), gps(), position()):
                    packet = frame(message)
                    assert gate.consume(packet) == [packet]
                    first.send_bytes(packet)
                    relayed = viewer.receive_bytes()
                    assert relayed == packet
                    assert projector.push(relayed) == 1
                sample = console.get("/api/v1/telemetry/TEST-001").json()
                assert sample["status"] == "LIVE"
                assert sample["latitude"] == 12.971
                epoch_before = broker.slots["TEST-001"].epoch

            # Real broker disconnect invalidates its device liveness immediately.
            slot = broker.slots["TEST-001"]
            assert slot.epoch > epoch_before
            assert slot.status()["status"] == "OFFLINE"
            assert slot.status()["heartbeat_fresh"] is False
            assert slot.status()["attitude_fresh"] is False

            # Only the actual broker viewer client resets the GCS projector on
            # transport loss (tested independently in backend tests). This
            # in-process fixture deliberately models that reset and does not
            # claim a deployed GCS reconnection.
            projector = MAVLinkProjector(1)
            gcs.state.links.sessions["TEST-001"].projector = projector
            assert console.get("/api/v1/telemetry/TEST-001").json()["status"] != "LIVE"
            assert console.get("/api/v1/flight-tracks/TEST-001").json()["count"] == 0
            gate = FrameGate(1)

            with cloud.websocket_connect(
                "/ws/v1/device/TEST-001",
                headers={"X-Vihanga-Device-Token": "D" * 40}
            ) as replacement:
                assert slot.status()["status"] == "WAITING_FOR_DATA"
                for message in (attitude(), gps(), position()):
                    packet = frame(message)
                    assert gate.consume(packet) == [packet]
                    replacement.send_bytes(packet)
                    relayed = viewer.receive_bytes()
                    assert relayed == packet
                    assert projector.push(relayed) == 1
                assert slot.status()["heartbeat_fresh"] is False
                sample = console.get("/api/v1/telemetry/TEST-001").json()
                assert sample["status"] != "LIVE"
                assert sample["heartbeat_fresh"] is False
                packet = frame(heartbeat())
                assert gate.consume(packet) == [packet]
                replacement.send_bytes(packet)
                assert viewer.receive_bytes() == packet
                assert projector.push(packet) == 1
                assert slot.status()["status"] == "LIVE"
                assert console.get("/api/v1/telemetry/TEST-001").json()["status"] == "LIVE"
                assert console.get("/api/v1/flight-tracks/TEST-001").json()["count"] == 1


def test_corrupt_edge_packets_and_foreign_vehicle_do_not_poison_recovery():
    """Local fault injection preserves downstream continuity and identity."""
    broker = Broker(identities())
    gate = FrameGate(1)
    with TestClient(create_cloud(broker)) as cloud:
        with cloud.websocket_connect(
            "/ws/v1/view/TEST-001",
            headers={"Authorization": "Bearer " + "V" * 40}
        ) as viewer:
            with cloud.websocket_connect(
                "/ws/v1/device/TEST-001",
                headers={"X-Vihanga-Device-Token": "D" * 40}
            ) as device:
                malformed = bytearray(frame(attitude()))
                malformed[-1] ^= 0xFF
                assert gate.consume(bytes(malformed)) == []
                assert gate.consume(frame(heartbeat(), sysid=2)) == []
                # Simulate a compromised local sender attempting to bypass
                # the edge gate: the cloud still rejects this CRC corruption.
                device.send_bytes(bytes(malformed))
                device.send_bytes(frame(heartbeat(), sysid=2))
                good = frame(heartbeat())
                assert gate.consume(good) == [good]
                device.send_bytes(good)
                assert viewer.receive_bytes() == good
                good_att = frame(attitude())
                device.send_bytes(good_att)
                assert viewer.receive_bytes() == good_att
                slot = broker.slots["TEST-001"]
                assert slot.frames_received == 2
                assert slot.frames_rejected >= 2
                assert slot.status()["status"] == "LIVE"
                assert broker.slots["TEST-002"].frames_received == 0
                assert broker.slots["TEST-002"].status()["status"] == "OFFLINE"
                # No viewer input is routed to the flight controller.
                viewer.send_bytes(b"COMMAND_LONG")
                assert slot.frames_received == 2
