import asyncio
from io import BytesIO
import socket

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga.telemetry import MAVLinkProjector, LinkManager, UDPConnect, validate_private_origin


def frame(message, source_system=1):
    serializer = mavlink.MAVLink(BytesIO())
    serializer.srcSystem = source_system
    serializer.srcComponent = 1
    return message.pack(serializer)


def heartbeat():
    return mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3)


def attitude():
    return mavlink.MAVLink_attitude_message(100, .1, -.2, .3, 0, 0, 0)


def test_real_mavlink_heartbeat_and_attitude_drive_instruments():
    projector = MAVLinkProjector(1)
    assert projector.push(frame(heartbeat())) == 1
    assert projector.push(frame(attitude())) == 1
    data = projector.snapshot()
    assert data["heartbeat_fresh"] is True
    assert data["attitude_fresh"] is True
    assert abs(data["roll_deg"] - 5.73) < 0.05
    assert abs(data["pitch_deg"] + 11.46) < 0.05
    assert data["latitude"] is None
    assert data["armed"] is False


def test_reject_foreign_sysid_and_corrupted_checksum():
    projector = MAVLinkProjector(1)
    assert projector.push(frame(heartbeat(), 2)) == 0
    assert projector.snapshot()["heartbeat_fresh"] is False
    broken = bytearray(frame(heartbeat()))
    broken[-1] ^= 0xFF
    assert projector.push(bytes(broken)) == 0
    assert projector.snapshot()["heartbeat_fresh"] is False


def test_private_relay_host_check_blocks_untrusted_targets():
    assert validate_private_origin("https://aircraft.ts.net:8443") == "https://aircraft.ts.net:8443"
    for bad in ("http://aircraft.ts.net:8443", "https://127.0.0.1:8443",
                "https://attacker.com:8443", "https://aircraft.ts.net",
                "https://u:p@aircraft.ts.net:8443", "https://aircraft.ts.net:8443/other"):
        with pytest.raises(ValueError):
            validate_private_origin(bad)


@pytest.mark.asyncio
async def test_loopback_udp_sitl_ingress_and_disconnect():
    mgr = LinkManager()
    await mgr.start_udp(UDPConnect(vehicle_id="TEST-001", port=15450, fc_system_id=1))
    sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sender.sendto(frame(heartbeat()), ("127.0.0.1", 15450))
        sender.sendto(frame(attitude()), ("127.0.0.1", 15450))
        await asyncio.sleep(.15)
        sample = mgr.snapshot("TEST-001")
        assert sample["status"] == "LIVE", sample
        assert sample["frames_total"] == 2
        assert sample["flight_control_enabled"] is False
    finally:
        sender.close()
        await mgr.stop("TEST-001")
    assert mgr.snapshot("TEST-001")["status"] == "OFFLINE"
