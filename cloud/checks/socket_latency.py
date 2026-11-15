"""CI-only loopback WebSocket latency sample for the real broker container.

Not an aircraft-to-cloud measurement: sends a serialized MAVLink frame from
a client INSIDE the broker container to its 127.0.0.1 Uvicorn listener and
measures until an authenticated viewer receives the identical frame.

No credentials are printed. Does not benchmark edge UART, TLS, Oracle WAN,
a Raspberry Pi, the GCS WebSocket or browser display latency.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
import statistics
import time

from pymavlink.dialects.v20 import ardupilotmega as mavlink
from websockets.sync.client import connect


def percentile(sorted_numbers: list[float], fraction: float) -> float:
    """Linearly interpolated percentile without another dependency."""
    if not sorted_numbers:
        raise ValueError("At least one measurement is required")
    offset = (len(sorted_numbers) - 1) * fraction
    lower = int(offset)
    upper = min(lower + 1, len(sorted_numbers) - 1)
    blend = offset - lower
    return sorted_numbers[lower] * (1.0 - blend) + sorted_numbers[upper] * blend


def benchmark(count: int) -> dict:
    if not 16 <= count <= 5000:
        raise ValueError("Frame count must be between 16 and 5000")
    token = os.environ["VIHANGA_CI_TOKEN"]
    origin = "ws://127.0.0.1:8750"
    device_headers = {"X-Vihanga-Device-Token": token}
    viewer_headers = {
        "Authorization": "Bearer " + sha256(token.encode("utf-8")).hexdigest()
    }
    codec = mavlink.MAVLink(None, srcSystem=1, srcComponent=1)
    measurements_ms = []
    payload_bytes = 0
    started = time.perf_counter()
    with connect(origin + "/ws/v1/view/CI-001",
                 additional_headers=viewer_headers,
                 open_timeout=5, close_timeout=3) as viewer:
        with connect(origin + "/ws/v1/device/CI-001",
                     additional_headers=device_headers,
                     open_timeout=5, close_timeout=3) as device:
            for index in range(count):
                # Every frame is an authentic MAVLink2 ATTITUDE packet with
                # different time_boot_ms; no simulated GPS or FC commands.
                packet = mavlink.MAVLink_attitude_message(
                    index * 20, 0.01, -0.02, 0.03, 0.0, 0.0, 0.0
                ).pack(codec)
                start = time.perf_counter_ns()
                device.send(packet)
                observed = viewer.recv(timeout=3)
                elapsed = (time.perf_counter_ns() - start) / 1e6
                if observed != packet:
                    raise AssertionError(f"Frame mismatch at sample {index}")
                measurements_ms.append(elapsed)
                payload_bytes += len(packet)
    duration = time.perf_counter() - started
    values = sorted(measurements_ms)
    return {
        "test_type": "in-container_broker_loopback_ws",
        "transport": "ws://127.0.0.1:8750",
        "includes": ["WebSocket client send", "Uvicorn broker", "viewer fan-out",
                     "viewer receive"],
        "excludes": ["serial", "edge agent", "remote TLS", "Oracle network",
                     "GCS backend", "browser display", "physical flight"],
        "frames": count,
        "verified_frames": len(measurements_ms),
        "payload_bytes": payload_bytes,
        "total_elapsed_s": round(duration, 4),
        "mean_ms": round(statistics.fmean(values), 4),
        "p50_ms": round(percentile(values, 0.50), 4),
        "p95_ms": round(percentile(values, 0.95), 4),
        "p99_ms": round(percentile(values, 0.99), 4),
        "max_ms": round(values[-1], 4),
        "flight_control_enabled": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=int, default=160)
    args = parser.parse_args()
    print(json.dumps(benchmark(args.frames), sort_keys=True))


if __name__ == "__main__":
    main()
