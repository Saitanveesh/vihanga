"""Real TLS LAN fan-out and single-serial-owner regression tests."""
from __future__ import annotations

import asyncio
from io import BytesIO
import shutil
import ssl
import subprocess
import time

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from vihanga_edge.agent import CloudUplink, FrameGate, Settings, read_uart
from vihanga_edge.lan import LanFanout


def frame(message, sysid=1):
    writer = mavlink.MAVLink(BytesIO())
    writer.srcSystem = sysid
    writer.srcComponent = 1
    return message.pack(writer)


@pytest.fixture
def ephemeral_certificate(tmp_path):
    if not shutil.which("openssl"):
        pytest.skip("OpenSSL required to generate ephemeral test cert")
    cert = tmp_path / "test-lan.crt"
    key = tmp_path / "test-lan.key"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-nodes", "-days", "1", "-keyout", str(key),
        "-out", str(cert), "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1",
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


@pytest.mark.asyncio
async def test_authenticated_tls_viewer_is_read_only_and_epoch_safe(ephemeral_certificate):
    cert, key = ephemeral_certificate
    fanout = LanFanout("TEST-001", "L" * 40)
    server_context = fanout.tls_context(str(cert), str(key))
    trust = ssl.create_default_context(cafile=str(cert))
    async with fanout.server("127.0.0.1", 0, server_context) as server:
        port = server.sockets[0].getsockname()[1]
        url = f"wss://127.0.0.1:{port}/ws/v1/view/TEST-001"

        async with connect(url, ssl=trust, additional_headers={
            "Authorization": "Bearer " + "B" * 40
        }) as rejected:
            with pytest.raises(ConnectionClosed):
                await rejected.recv()
        assert fanout.denied_sessions == 1
        assert not fanout.queues

        async with connect(url, ssl=trust, additional_headers={
            "Authorization": "Bearer " + "L" * 40
        }) as viewer:
            for _ in range(20):
                if fanout.queues:
                    break
                await asyncio.sleep(.01)
            assert len(fanout.queues) == 1
            good = frame(mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3))
            fanout.publish(good)
            assert await asyncio.wait_for(viewer.recv(), 2) == good
            assert fanout.sent_frames == 1
            await fanout.invalidate()
            with pytest.raises(ConnectionClosed):
                await viewer.recv()
        assert not fanout.queues

        async with connect(url, ssl=trust, additional_headers={
            "Authorization": "Bearer " + "L" * 40
        }) as viewer:
            await viewer.send(b"COMMAND_LONG")
            with pytest.raises(ConnectionClosed):
                await viewer.recv()
            assert fanout.counters["viewer_payload_rejected"] == 1


@pytest.mark.asyncio
async def test_uart_continues_while_cloud_is_disconnected(monkeypatch):
    import vihanga_edge.agent as agent

    packet = frame(mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3))
    class FakeUart:
        def __init__(self):
            self._packets = [packet]
            self.closed = False
        def __enter__(self): return self
        def __exit__(self, *args): self.closed = True
        def read(self, count):
            time.sleep(.005)
            return self._packets.pop(0) if self._packets else b""

    opened = []
    def create_uart(*args, **kwargs):
        port = FakeUart()
        opened.append(port)
        return port

    monkeypatch.setattr(agent.serial, "Serial", create_uart)
    settings = Settings(
        vehicle_id="TEST-001", system_id=1,
        port="/dev/ttyAMA0", baud=57600,
        cloud_wss="wss://cloud.example/ws/v1/device/TEST-001",
        token="D" * 40
    )
    uplink = CloudUplink()
    lan = LanFanout("TEST-001", "L" * 40)
    queue = asyncio.Queue(maxsize=48)
    lan.queues[object()] = queue
    task = asyncio.create_task(read_uart(settings, uplink, lan))
    try:
        stamp, cloud_packet = await asyncio.wait_for(uplink.queue.get(), 3)
        assert cloud_packet == packet
        epoch, t0, local_packet = await asyncio.wait_for(queue.get(), 3)
        assert local_packet == cloud_packet
        assert epoch == 0 and stamp <= time.monotonic()
        assert len(opened) == 1
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert opened[0].closed


def test_invalid_or_incomplete_local_tls_config_is_rejected(tmp_path):
    base = dict(vehicle_id="TEST-001", system_id=1, port="/dev/ttyAMA0",
                baud=57600,
                cloud_wss="wss://cloud.example/ws/v1/device/TEST-001",
                token="D" * 40)
    Settings(**base).validate()
    for extra in [
        dict(lan_token="bad"),
        dict(lan_cert="/tmp/missing.crt", lan_key="/tmp/missing.key"),
        dict(lan_token="D"*40, lan_cert="/tmp/missing.crt",
             lan_key="/tmp/missing.key"),
        dict(lan_token="L"*40, lan_cert="/tmp/missing.crt",
             lan_key="/tmp/missing.key", lan_bind_host="8.8.8.8"),
    ]:
        with pytest.raises(ValueError):
            Settings(**base, **extra).validate()
