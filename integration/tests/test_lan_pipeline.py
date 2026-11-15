"""Actual authenticated TLS edge-to-GCS loopback integration, no UART actuation."""
import asyncio
from io import BytesIO
import ssl
import subprocess
import shutil

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink
from vihanga.telemetry import LinkManager, Session, MAVLinkProjector


@pytest.mark.asyncio
async def test_backend_receives_tls_lan_frames_with_fresh_state(tmp_path):
    if not shutil.which("openssl"):
        pytest.skip("OpenSSL unavailable for ephemeral TLS test")
    from websockets.asyncio.client import connect
    from vihanga_edge.lan import LanFanout

    cert = tmp_path / "lan.pem"
    key = tmp_path / "lan.key"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(key), "-out", str(cert), "-days", "1",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"
    ], check=True, capture_output=True)
    trust = ssl.create_default_context(cafile=str(cert))
    fanout = LanFanout("TEST-001", "L"*40)
    mgr = LinkManager()
    async with fanout.server("127.0.0.1", 0, fanout.tls_context(
            str(cert),str(key))) as server:
        port = server.sockets[0].getsockname()[1]
        session = Session("TEST-001","DIRECT_LAN_WSS",MAVLinkProjector(1))
        mgr.sessions["TEST-001"] = session
        task = asyncio.create_task(mgr._run_lan(
            session, f"https://127.0.0.1:{port}", "L"*40, trust))
        session.task = task
        try:
            for _ in range(100):
                if fanout.queues:
                    break
                await asyncio.sleep(.015)
            assert fanout.queues
            writer = mavlink.MAVLink(BytesIO())
            writer.srcSystem = 1
            writer.srcComponent = 1
            for msg in (
                mavlink.MAVLink_heartbeat_message(2,3,0,0,3,3),
                mavlink.MAVLink_attitude_message(100,.1,.2,-.3,0,0,0),
            ):
                fanout.publish(msg.pack(writer))
            for _ in range(100):
                if mgr.snapshot("TEST-001")["status"] == "LIVE":
                    break
                await asyncio.sleep(.015)
            state = mgr.snapshot("TEST-001")
            assert state["status"] == "LIVE", state
            assert state["transport"] == "DIRECT_LAN_WSS"
            assert state["flight_control_enabled"] is False
            assert state["frames_total"] == 2
            # Interrupting the Pi UART invalidates the authenticated viewer
            # and the GCS projector cannot present cached live data.
            await fanout.invalidate()
            for _ in range(100):
                if mgr.snapshot("TEST-001")["status"] != "LIVE":
                    break
                await asyncio.sleep(.015)
            assert mgr.snapshot("TEST-001")["heartbeat_fresh"] is False
        finally:
            await mgr.stop("TEST-001")
