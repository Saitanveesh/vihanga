# Vihanga v0.14 — operator acceptance

This is an operator **visual and operational smoke test**, not a certification of flight-control safety. The independent Vihanga app is telemetry-only. Keep the working Oracle :8443 private relay, Pi UART service and camera streamer unchanged while testing the new console. The old legacy Mission Planner fork is a separate repository and is not required.

## Windows setup

~~~powershell
cd $env:USERPROFILE\vihanga
git checkout main
git pull --ff-only origin main
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Vihanga-Standalone.ps1
~~~

Open http://127.0.0.1:5173. The API must be available at http://127.0.0.1:8010/api/v1/health.

## Functional inspection

1. **Fleet identity:** the selected actual aircraft ID is AH-HW-001 (the displayed nickname might be TEST001). Fleet count reflects registered aircraft, not the number currently online.
2. **Link:** choose Private relay for the pre-existing Oracle instance, using https://aerohelm-vcn.tailf3ab6a.ts.net:8443 and the separately provisioned operator login. Do not enter the newer independent broker viewer token into this form.
3. **Live instruments:** while disarmed with propellers removed, move the Pixhawk on the bench. Fresh HEARTBEAT and ATTITUDE, numerical roll/pitch and heading should change consistently. Inspect message counts and actual received frame rate in LINK.
4. **Freshness:** when telemetry stops, live status and attitude must expire. Never interpret a merely connected WebSocket as a live FC.
5. **GPS:** fix type below 3 or missing GNSS packets must not create an aircraft position or flight trail. GPS2 values can remain blank when no secondary GPS2 MAVLink packets are received.
6. **Camera:** select VIDEO and configure https://saitanveesh.tailf3ab6a.ts.net/cam/ for the correct aircraft. Confirm real camera video in the large embedded player. Refresh the browser and check the same aircraft still has its camera URL. Select a different aircraft and verify it does not inherit the previous aircraft's camera URL.
7. **FLIGHT:** inspect the right-side aircraft systems card on desktop. Its video preview is opt-in to avoid an additional background stream. Missing battery current, airspeed or GPS2 data must read unavailable.
8. **PLAN:** create a boundary, preview survey lines, edit route points, save a draft and export GeoJSON. Verify the map, draft history and the absence of flight-controller mission upload.
9. **Failure handling:** clear a stuck pending receiver from the Connect dialog before retrying. Never auto-disconnect a LIVE aircraft session without operator action.
10. **Safety boundary:** do not expect ARM, TAKEOFF, LAND, RTL, parameter writes or mission execution over this read-only transport. No controls should imply these commands were issued.

## Read-only diagnostic command

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Vihanga-Operator.ps1 -AircraftId AH-HW-001 -RequireLive
~~~

This command queries only the loopback GCS API and checks registered aircraft, status, heartbeat/attitude freshness, received/rejected frames and actual packet rates. It sends no MAVLink command. Omit -RequireLive to inspect a deliberately disconnected session.

## Evidence for release decision

Capture a flight HUD screenshot while the Pixhawk is stationary and after a physical tilt, an HTTP/WS diagnostics snapshot, visible camera frames, reconnect behavior, a stale-link screenshot, and the GitHub Actions run for the exact commit. Record actual p50/p95/p99 latency before making performance claims. No 24-hour soak, real 12-aircraft field load, production operator authentication, or physical cloud command acceptance has been demonstrated by the software CI suite alone.
