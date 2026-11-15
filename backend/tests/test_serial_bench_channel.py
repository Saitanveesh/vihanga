"""Local hardware bench protocol tests with fake UART, no simulator or motors."""
import asyncio
from io import BytesIO
import time

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga.operator_contract import BenchQuery, BenchRequest
from vihanga.telemetry import LinkManager, SerialConnect


class FakeSerial:
    def __init__(self, *args, **kwargs):
        self.written = []
        self.closed = False

    def read(self, length):
        time.sleep(0.01)
        return b""

    def write(self, packet):
        if self.closed:
            raise OSError("port closed")
        self.written.append(bytes(packet))
        return len(packet)

    def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_serial_bench_request_is_opt_in_and_exactly_one_read_packet(monkeypatch):
    import vihanga.telemetry as t

    fake = FakeSerial()
    monkeypatch.setattr(t.serial, "Serial", lambda *a, **k: fake)
    manager = LinkManager()
    vehicle_id = "BENCH-001"
    try:
        await manager.start_serial(SerialConnect(vehicle_id=vehicle_id,
            port="COM3",baud=57600,fc_system_id=1))

        with pytest.raises(ValueError, match="disabled"):
            await manager.bench_request(vehicle_id, BenchQuery(query=BenchRequest.FC_VERSION))
        assert fake.written == []

        monkeypatch.setenv("VIHANGA_BENCH_READ_REQUESTS","1")
        result = await manager.bench_request(vehicle_id, BenchQuery(query=BenchRequest.FC_VERSION))
        assert result["fc_acknowledged"] is False
        assert result["result"] == "SERIAL_WRITE_COMPLETED"
        assert result["flight_control_enabled"] is False
        assert result["bytes_written"] == len(fake.written[0])

        parsed = mavlink.MAVLink(None).parse_buffer(fake.written[0])
        assert parsed is not None and len(parsed) == 1
        assert parsed[0].get_type() == "COMMAND_LONG"
        assert parsed[0].command == mavlink.MAV_CMD_REQUEST_MESSAGE
        assert parsed[0].param1 == 148.0
        assert manager.snapshot(vehicle_id)["flight_control_enabled"] is False

        with pytest.raises(ValueError, match="rate limit"):
            await manager.bench_request(vehicle_id, BenchQuery(query=BenchRequest.PARAMETER_LIST))
    finally:
        await manager.stop(vehicle_id)
    assert fake.closed


@pytest.mark.asyncio
async def test_bench_read_fails_without_serial_and_does_not_use_cloud(monkeypatch):
    manager = LinkManager()
    monkeypatch.setenv("VIHANGA_BENCH_READ_REQUESTS","1")
    with pytest.raises(ValueError, match="local serial receiver"):
        await manager.bench_request("AIR-001", BenchQuery(query=BenchRequest.GPS))
