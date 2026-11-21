import os

import pytest
from fastapi.testclient import TestClient

from vihanga.app import create_app
from vihanga.telemetry import BrokerConnect, validate_broker_origin, LinkManager


def test_immediate_viewer_disconnects_back_off_and_keep_diagnostics(monkeypatch):
    import asyncio
    from vihanga import telemetry

    async def scenario():
        delays = []
        proof = []
        session = telemetry.Session("AIR-001", "VIHANGA_CLOUD_V2", telemetry.MAVLinkProjector(1))
        async def upstream(current, *_):
            proof.append(current.vehicle_id)
            await asyncio.Event().wait()

        class FlappingSocket:
            async def __aenter__(self):
                await asyncio.get_running_loop().run_in_executor(None, lambda: None)
                return self

            async def __aexit__(self, *exc):
                pass

            async def __aiter__(self):
                for item in ():
                    yield item

        async def observe_delay(delay):
            delays.append(delay)
            assert session.snapshot()["heartbeat_fresh"] is False
            assert len(proof) == 1
            if len(delays) == 6:
                raise asyncio.CancelledError

        monkeypatch.setattr(telemetry, "connect", lambda *a, **k: FlappingSocket())
        monkeypatch.setattr(telemetry, "poll_upstream", upstream)
        monkeypatch.setattr(telemetry.asyncio, "sleep", observe_delay)
        monkeypatch.setattr(telemetry, "uniform", lambda *_: 1)
        with pytest.raises(asyncio.CancelledError):
            await LinkManager()._run_broker(session, "https://test.ts.net", "test token")
        assert delays == [2, 4, 8, 16, 20, 20]
        assert session.reconnect_attempt == 5

    asyncio.run(scenario())


def test_broker_origin_allowlist_by_host_and_private_relay(monkeypatch):
    monkeypatch.delenv("VIHANGA_APPROVED_CLOUD_HOSTS", raising=False)
    assert validate_broker_origin("https://vihanga-vcn.ts.net:8443") == (
        "https://vihanga-vcn.ts.net:8443")
    for origin in [
        "http://vihanga-vcn.ts.net:8443",
        "https://127.0.0.1:8443",
        "https://attacker.example:8443",
        "https://user:pw@vihanga-vcn.ts.net:8443",
        "https://vihanga-vcn.ts.net:8443/other",
        "https://vihanga-vcn.ts.net:9999"
    ]:
        with pytest.raises(ValueError):
            validate_broker_origin(origin)
    monkeypatch.setenv("VIHANGA_APPROVED_CLOUD_HOSTS", "cloud.vihanga.example")
    assert validate_broker_origin("https://cloud.vihanga.example") == (
        "https://cloud.vihanga.example")


def test_broker_connect_is_bound_to_aircraft_and_rejects_invalid_creds(tmp_path):
    c = TestClient(create_app(tmp_path / "broker.sqlite3"))
    sample = dict(vehicle_id="AIR-001", origin="https://vihanga-vcn.ts.net:8443",
                  viewer_token="X"*40, fc_system_id=1)
    r = c.post("/api/v1/links/broker", json=sample)
    assert r.status_code == 404
    c.post("/api/v1/vehicles", json={
        "vehicle_id":"AIR-001","label":"Test UAV","autopilot":"ARDUPILOT",
        "interface":"UART"
    })
    assert c.post("/api/v1/links/broker", json={**sample,"viewer_token":"short"}).status_code == 422
    assert c.post("/api/v1/links/broker", json={**sample, "origin":"http://bad.example"}).status_code == 422
    # No network connection or hardware command is required to create a
    # bounded receive-only session; connect is background and may be pending.
    r = c.post("/api/v1/links/broker", json=sample)
    assert r.status_code == 200, r.text
    assert r.json()["flight_control_enabled"] is False
    assert r.json()["status"] in ("CONNECTING", "RECONNECTING")
    assert c.post("/api/v1/links/broker", json=sample).status_code == 422
    assert c.delete("/api/v1/links/AIR-001").status_code == 200
