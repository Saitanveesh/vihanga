# Telemetry fault injection and socket latency — evidence guide

This increment adds deterministic regression tests for the independent, **read-only**
VIHANGA pipeline. It does not change the existing Pi/Oracle deployment, camera,
mission planner, aircraft configuration, or flight-control authority.

## What is exercised

| Evidence | Implementation | Explicit limitation |
| --- | --- | --- |
| Corruption and foreign SYSID rejection | `integration/tests/test_telemetry_pipeline.py`, `test_corrupt_edge_packets_and_foreign_vehicle_do_not_poison_recovery` | TestClient protocol sockets, not a hostile physical UART |
| Device disconnect / fresh recovery | `test_broker_loss_recovery_rejects_old_epoch_and_requires_fresh_fc_state` | GCS projector reset is simulated by the fixture; this does not validate the real GCS broker client's reconnect timing |
| Role-scoped authentication | Existing cloud / integration API tests | Synthetic test credentials; not operator login |
| Measured authenticated WebSocket delivery | `cloud/checks/socket_latency.py` from the staging-package CI job | Client and broker all run in the same Docker container, over unencrypted 127.0.0.1 |
| Real broker Docker image | `cloud/checks/container_smoke.py` | Not hosted Oracle, Tailscale, Raspberry Pi or hardware |

The benchmark prints a JSON result with a labeled scope, number of verified
MAVLink2 frames, measured socket-send-to-viewer-receive p50/p95/p99 in milliseconds,
mean/max and packet identity checks. It does not claim an aircraft-to-GCS
end-to-end latency measurement or represent real flight performance.

## CI execution

```bash
python -m pip install -e './backend[dev]' -e './cloud[dev]' -e './edge[dev]'
python -m pytest -q integration/tests
```

The GitHub Actions `staging-package` job builds the actual broker Docker image,
runs `container_smoke.py`, and then executes the latency test with 160 packets on
the same authenticated loopback runtime. No host ports are exposed.

## Next system-level acceptance steps

1. Add a controlled full-process Pi agent ↔ broker ↔ GCS integration harness with
   a PTY-based UART emulator and independent real TCP/WSS transports.
2. Record p50/p95/p99 for the complete simulated UART-to-HUD path, loss, recovery
   time and CPU/memory under jitter and disconnects; label this as laboratory traffic.
3. Test broker restart, expired device/viewer credentials, simultaneous reconnects,
   primary/backup source selection and stale-state revocation using the actual
   processes rather than in-memory fixtures.
4. Repeat against approved private Oracle staging and a disarmed, propeller-free
   Pixhawk only after operator authorization. Do not turn on physical command paths.

Until those steps pass, keep the existing private relay as the proven telemetry
connection, and do not claim production availability or physical-flight acceptance.
