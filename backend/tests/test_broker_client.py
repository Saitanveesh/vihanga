import os

import pytest
from fastapi.testclient import TestClient

from vihanga.app import create_app
from vihanga.telemetry import BrokerConnect, validate_broker_origin, LinkManager


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
