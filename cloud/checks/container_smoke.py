"""Exercise the broker image over its real Uvicorn WebSocket listener."""
from hashlib import sha256
import os
import time
from urllib.request import urlopen

from pymavlink.dialects.v20 import ardupilotmega
from websockets.sync.client import connect
from websockets.exceptions import ConnectionClosed

origin = "127.0.0.1:8750"
deadline = time.monotonic() + 10
while True:
    try:
        with urlopen(f"http://{origin}/health", timeout=1) as response:
            assert response.status == 200
        break
    except OSError:
        if time.monotonic() >= deadline:
            raise
        time.sleep(0.1)

token = os.environ["VIHANGA_CI_TOKEN"]
viewer = {"Authorization": "Bearer " + sha256(token.encode()).hexdigest()}
device = {"X-Vihanga-Device-Token": token}
with connect(f"ws://{origin}/ws/v1/view/CI-001", additional_headers=viewer) as downstream:
    with connect(f"ws://{origin}/ws/v1/device/CI-001", additional_headers=device) as upstream:
        codec = ardupilotmega.MAVLink(None, srcSystem=1, srcComponent=1)
        packet = ardupilotmega.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3).pack(codec)
        upstream.send(packet)
        assert downstream.recv(timeout=2) == packet
        upstream.send(b"x" * 513)
        try:
            upstream.recv(timeout=2)
        except ConnectionClosed as exc:
            assert exc.rcvd and exc.rcvd.code == 1009
        else:
            raise AssertionError("Oversized packet did not close device connection")
print("Container broker WebSocket fan-out and frame limit passed")
