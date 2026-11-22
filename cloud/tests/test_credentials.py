import json
from pathlib import Path
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from vihanga_cloud.app import DIAGNOSTICS_PROTOCOL, create_app, digest, from_environment


def test_rotation_expires_and_revokes_open_sockets(tmp_path, monkeypatch):
    file = tmp_path / "credentials.json"
    monkeypatch.setenv("VIHANGA_CLOUD_CREDENTIALS_FILE", str(file))
    expiry = int(time.time()) + 3600
    device, previous, replacement = "D" * 40, "V" * 40, "R" * 40

    def publish(viewers, device_expiry=expiry):
        candidate = file.with_suffix(".new")
        candidate.write_text(json.dumps({"version": 2, "aircraft": [{
            "vehicle_id": "AIR-001", "system_id": 1, "organization": "test",
            "device_credentials": [{"sha256": digest(device), "expires_at": device_expiry}],
            "viewer_credentials": [{"sha256": digest(token), "expires_at": expiry} for token in viewers],
        }]}))
        Path.replace(candidate, file)

    publish([previous])
    broker = from_environment()
    with TestClient(create_app(broker)) as client:
        path = "/api/v1/diagnostics/AIR-001"
        def headers(token):
            return {"Authorization": "Bearer " + token}
        assert client.get(path, headers=headers(device)).status_code == 401
        assert client.get("/api/v1/diagnostics/AIR-002", headers=headers(previous)).status_code == 401
        with client.websocket_connect("/ws/v1/view/AIR-001", headers=headers(previous)) as observer:
            with client.websocket_connect("/ws/v1/device/AIR-001", subprotocols=[DIAGNOSTICS_PROTOCOL],
                    headers={"X-Vihanga-Device-Token": device}) as edge:
                assert edge.accepted_subprotocol == DIAGNOSTICS_PROTOCOL
                edge.send_json({"version": 1, "uart_open": True, "uart_bytes": 8, "uart_accepted": 0,
                                "uart_rejected": 1, "uart_age_ms": None, "uplink_sent": 0, "uplink_dropped": 0})
                timeout = time.monotonic() + 2
                while time.monotonic() < timeout:
                    evidence = client.get(path, headers=headers(previous)).json()
                    if evidence["edge"] is not None:
                        break
                assert evidence["edge"]["uart_bytes"] == 8
                assert evidence["relay"]["received"] == 0
                publish([previous, replacement])
                broker.credential_file.next_check = 0
                assert client.get(path, headers=headers(previous)).status_code == 200
                assert client.get(path, headers=headers(replacement)).status_code == 200
                publish([replacement], device_expiry=int(time.time()) - 1)
                broker.credential_file.next_check = 0
                assert client.get(path, headers=headers(previous)).status_code == 401
                with pytest.raises(WebSocketDisconnect) as viewer_error:
                    observer.receive_bytes()
                assert viewer_error.value.code == 4401
                with pytest.raises(WebSocketDisconnect) as device_error:
                    edge.receive_bytes()
                assert device_error.value.code == 4401
                assert client.get(path, headers=headers(replacement)).status_code == 200
