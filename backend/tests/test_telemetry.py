import asyncio
from io import BytesIO
import socket

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga.telemetry import MAVLinkProjector, LinkManager, UDPConnect, TCPConnect, validate_private_origin


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


def test_valid_vfr_hud_provides_airspeed_throttle_and_measured_rate():
    projector = MAVLinkProjector(1)
    msg = mavlink.MAVLink_vfr_hud_message(12.5, 4.25, 120, 36, 42.0, -1.5)
    assert projector.push(frame(msg)) == 1
    state = projector.snapshot()
    assert state["airspeed_mps"] == 12.5
    assert state["groundspeed_mps"] == 4.25
    assert state["throttle_pct"] == 36
    assert state["climb_mps"] == -1.5
    assert state["frame_rate_5s_hz"] > 0
    assert state["gps2_fix_type"] is None
    assert state["gps2_satellites"] is None
    assert state["battery_current_a"] is None
    assert state["heartbeat_fresh"] is False



def test_real_radio_and_sys_status_are_not_fabricated_when_missing():
    projector = MAVLinkProjector(1)
    before = projector.snapshot()
    assert before["radio_rssi_raw"] is None
    assert before["sensor_health"] is None
    status = mavlink.MAVLink_sys_status_message(
        (1 << 0) | (1 << 1) | (1 << 2) | (1 << 5) | (1 << 16),
        (1 << 0) | (1 << 1) | (1 << 2) | (1 << 5) | (1 << 16),
        (1 << 0) | (1 << 1) | (1 << 5), 120, 11850, 150, 72,
        0, 0, 0, 0, 0, 0)
    radio = mavlink.MAVLink_radio_status_message(
        rxerrors=4, fixed=2, rssi=172, remrssi=146, txbuf=83,
        noise=23, remnoise=27)
    assert projector.push(frame(status)) == 1
    assert projector.push(frame(radio)) == 1
    data = projector.snapshot()
    assert data["voltage_v"] == 11.85
    assert data["battery_current_a"] == 1.5
    assert data["radio_rssi_raw"] == 172
    assert data["radio_remote_rssi_raw"] == 146
    assert data["radio_rx_errors"] == 4
    assert data["radio_fixed_packets"] == 2
    assert data["sensor_health"]["gyroscope"] == "HEALTHY"
    assert data["sensor_health"]["accelerometer"] == "HEALTHY"
    assert data["sensor_health"]["magnetometer"] == "FAULT"
    assert data["sensor_health"]["gps"] == "HEALTHY"
    assert data["sensor_health"]["rc_receiver"] == "FAULT"
    # A healthy GPS sensor bit is not equivalent to a GNSS position fix.
    assert data["latitude"] is None
    assert data["gps_fix_type"] is None


@pytest.mark.asyncio
async def test_parallel_primary_udp_and_backup_tcp_require_manual_evidence_gated_switch():
    """Two actual independent sockets; never a command writer."""
    mgr = LinkManager()
    vehicle = "TEST-002"
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.bind(("127.0.0.1", 0))
    udp_port = probe.getsockname()[1]
    probe.close()
    sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    release = asyncio.Event()

    async def backup_feed(reader, writer):
        writer.write(frame(heartbeat()) + frame(attitude()))
        await writer.drain()
        await release.wait()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(backup_feed, "127.0.0.1", 0)
    tcp_port = server.sockets[0].getsockname()[1]
    try:
        await mgr.start_udp(UDPConnect(vehicle_id=vehicle, port=udp_port, fc_system_id=1))
        sender.sendto(frame(heartbeat()), ("127.0.0.1", udp_port))
        sender.sendto(frame(attitude()), ("127.0.0.1", udp_port))
        await asyncio.sleep(.05)
        assert mgr.snapshot(vehicle)["status"] == "LIVE"

        with pytest.raises(ValueError, match="different transport"):
            await mgr.start_backup(UDPConnect(vehicle_id=vehicle, port=udp_port+1, fc_system_id=1))
        await mgr.start_backup(TCPConnect(vehicle_id=vehicle, port=tcp_port, fc_system_id=1))
        await asyncio.sleep(.15)
        before = mgr.snapshot(vehicle)
        assert before["active_source"] == "PRIMARY"
        assert before["primary_status"] == "LIVE"
        assert before["backup_status"] == "LIVE"
        assert before["backup_transport"] == "LOCAL_TCP_RECEIVE"
        assert before["flight_control_enabled"] is False

        with pytest.raises(ValueError, match="existing backup receiver"):
            await mgr.start_backup(UDPConnect(vehicle_id=vehicle, port=udp_port+1, fc_system_id=1))

        promoted = mgr.select_source(vehicle, "BACKUP")
        assert promoted["active_source"] == "BACKUP"
        assert promoted["transport"] == "LOCAL_TCP_RECEIVE"
        assert promoted["status"] == "LIVE"
        assert mgr.active_session(vehicle) is mgr.standby_managers[vehicle].sessions[vehicle]

        restored = mgr.select_source(vehicle, "PRIMARY")
        assert restored["status"] == "LIVE"
        assert restored["transport"] == "LOCAL_UDP_SITL"
        await mgr.stop_backup(vehicle)
        assert mgr.snapshot(vehicle)["backup_status"] == "NOT_CONFIGURED"
        assert mgr.snapshot(vehicle)["status"] == "LIVE"
    finally:
        release.set()
        sender.close()
        await mgr.stop(vehicle)
        server.close()
        await server.wait_closed()
    assert mgr.snapshot(vehicle)["status"] == "OFFLINE"


@pytest.mark.asyncio
async def test_backup_cannot_be_selected_without_fresh_fc_attitude():
    mgr = LinkManager()
    vehicle = "TEST-003"
    primary_port = 15643
    backup_port = 15644
    try:
        await mgr.start_udp(UDPConnect(vehicle_id=vehicle, port=primary_port, fc_system_id=1))
        with pytest.raises(ValueError, match="must match primary"):
            await mgr.start_backup(TCPConnect(vehicle_id=vehicle, port=backup_port, fc_system_id=2))
        with pytest.raises((OSError, ConnectionRefusedError)):
            await mgr.start_backup(TCPConnect(vehicle_id=vehicle, port=backup_port, fc_system_id=1))
        with pytest.raises(ValueError, match="fresh FC"):
            mgr.select_source(vehicle, "BACKUP")
        assert mgr.snapshot(vehicle)["active_source"] == "PRIMARY"
        assert mgr.snapshot(vehicle)["backup_status"] == "NOT_CONFIGURED"
    finally:
        await mgr.stop(vehicle)
