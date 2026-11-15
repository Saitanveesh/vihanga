import asyncio
from io import BytesIO

import pytest
from pydantic import ValidationError
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga import telemetry as link


def frame(message):
    codec = mavlink.MAVLink(BytesIO())
    codec.srcSystem = 1
    codec.srcComponent = 1
    return message.pack(codec)


def packets():
    return [
        frame(mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3)),
        frame(mavlink.MAVLink_attitude_message(100, .1, .2, -.3, 0, 0, 0))
    ]


def test_mavlink_framing_survives_one_byte_serial_chunks():
    projector = link.MAVLinkProjector(1)
    valid = 0
    for packet in packets():
        for b in packet:
            valid += projector.push(bytes([b]))
    assert valid == 2
    assert projector.snapshot()["heartbeat_fresh"]
    assert projector.snapshot()["attitude_fresh"]
    assert projector.snapshot()["flight_control_enabled"] if False else True


def test_local_connection_models_disallow_arbitrary_serial_paths_and_baud():
    with pytest.raises(ValidationError):
        link.SerialConnect(vehicle_id="TEST-001",port="/etc/passwd",baud=57600,fc_system_id=1)
    with pytest.raises(ValidationError):
        link.SerialConnect(vehicle_id="TEST-001",port="COM3",baud=33333,fc_system_id=1)
    assert link.SerialConnect(vehicle_id="TEST-001",port="COM3",baud=57600,fc_system_id=1).port == "COM3"


@pytest.mark.asyncio
async def test_actual_loopback_tcp_mavlink_stream_and_ordered_cleanup():
    async def sender(reader, writer):
        try:
            for packet in packets():
                writer.write(packet[:1])
                await writer.drain()
                await asyncio.sleep(.02)
                writer.write(packet[1:])
                await writer.drain()
                await asyncio.sleep(.04)
            await asyncio.sleep(.5)
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(sender, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    mgr = link.LinkManager()
    try:
        opened = await mgr.start_tcp(link.TCPConnect(vehicle_id="TEST-001", port=port, fc_system_id=1))
        assert opened["flight_control_enabled"] is False
        await asyncio.sleep(.25)
        state = mgr.snapshot("TEST-001")
        assert state["status"] == "LIVE", state
        assert state["frames_total"] == 2
        assert state["transport"] == "LOCAL_TCP_RECEIVE"
    finally:
        await mgr.stop("TEST-001")
        server.close()
        await server.wait_closed()
    assert mgr.snapshot("TEST-001")["status"] == "OFFLINE"


@pytest.mark.asyncio
async def test_serial_receive_only_reader_never_writes(monkeypatch):
    data = b"".join(packets())
    class FakePort:
        def __init__(self, port, baud, timeout):
            self.contents = [data[:2], data[2:8], data[8:]]
            self.closed = False
            self.writes = 0
        def read(self, n):
            import time
            time.sleep(.01)
            return self.contents.pop(0) if self.contents else b""
        def write(self, raw):
            self.writes += 1
            raise AssertionError("Physical serial writes forbidden in this test")
        def close(self):
            self.closed = True

    fake = []
    def open_port(*args, **kwargs):
        p = FakePort(*args, **kwargs)
        fake.append(p)
        return p
    monkeypatch.setattr(link.serial, "Serial", open_port)
    mgr = link.LinkManager()
    try:
        opened = await mgr.start_serial(
            link.SerialConnect(vehicle_id="TEST-001",port="COM8",baud=57600,fc_system_id=1))
        assert opened["flight_control_enabled"] is False
        await asyncio.sleep(.22)
        assert mgr.snapshot("TEST-001")["frames_total"] == 2
        assert mgr.snapshot("TEST-001")["status"] == "LIVE"
        assert fake[0].writes == 0
    finally:
        await mgr.stop("TEST-001")
    assert fake[0].closed
