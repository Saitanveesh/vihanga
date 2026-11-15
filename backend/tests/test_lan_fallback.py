"""Direct local Wi-Fi receive-only telemetry and TLS trust-boundary tests."""

import pytest
from fastapi.testclient import TestClient
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga.app import create_app
from vihanga.telemetry import (
    validate_lan_origin
)


def test_lan_address_is_strictly_private_ipv4():
    assert validate_lan_origin("https://192.168.1.7:8765") == "https://192.168.1.7:8765"
    assert validate_lan_origin("https://10.1.4.20:8766") == "https://10.1.4.20:8766"
    assert validate_lan_origin("https://172.16.2.5:8775") == "https://172.16.2.5:8775"
    for origin in (
        "http://192.168.1.7:8765", "https://127.0.0.1:8765",
        "https://8.8.8.8:8765", "https://100.65.1.1:8765",
        "https://169.254.1.1:8765", "https://192.168.1.7:8080",
        "https://user:password@192.168.1.7:8765",
        "https://192.168.1.7:8765/path",
        "https://192.168.1.7:8765/?token=secret",
        "https://private.local:8765", "https://[::1]:8765"
    ):
        with pytest.raises(ValueError):
            validate_lan_origin(origin)


def test_lan_api_fails_closed_without_trust_bundle(tmp_path, monkeypatch):
    monkeypatch.delenv("VIHANGA_LAN_CA_CERT", raising=False)
    c = TestClient(create_app(tmp_path / "lan.sqlite3"))
    vehicle = dict(vehicle_id="TEST-001", label="Ground station",
                   autopilot="ARDUPILOT",interface="UART")
    assert c.post("/api/v1/vehicles",json=vehicle).status_code == 201
    payload = dict(vehicle_id="TEST-001", origin="https://192.168.1.7:8765",
                   viewer_token="L"*40, fc_system_id=1)
    response = c.post("/api/v1/links/lan",json=payload)
    assert response.status_code == 422
    assert "VIHANGA_LAN_CA_CERT" in response.json()["detail"]
    assert c.post("/api/v1/links/lan",json={**payload,
        "origin":"https://attacker.example"}).status_code == 422
    assert c.post("/api/v1/links/backup/lan",json=payload).status_code == 422
    assert c.get("/api/v1/telemetry/TEST-001").json()["status"] == "OFFLINE"
