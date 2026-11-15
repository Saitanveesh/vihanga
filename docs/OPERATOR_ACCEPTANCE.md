# Vihanga v0.17 — operator acceptance

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
3. **Connection types:** in Connections, verify the contrast between Primary/Backup roles and Private relay, Vihanga Cloud, Serial/USB, UDP, and TCP transport settings. Confirm the cloud origin and username may persist locally, while passwords and viewer tokens do not. Confirm an existing primary cannot be replaced accidentally.
4. **Backup:** with a real independent secondary receive link, check BACKUP remains separate. Ensure mismatched FC SYSID and same transport class are rejected. Selecting an unverified backup must be disabled. With validated fresh heartbeat and attitude, manually select it and check the HUD follows only that source. Restore the primary only after its own fresh data arrives; loss of active backup must not show stale attitude as LIVE. Receiver changes must not dispatch commands.
5. **Radio and sensors:** open Diagnostics. Verify raw RADIO_STATUS values where present (including component 68), accurate GPS1/GPS2 fix/satellite reporting and SYS_STATUS health flags. If packets are absent, values must say unknown/not reported, not estimated. Never treat uncalibrated RSSI as a percent or dBm.
6. **Live instruments:** while disarmed with propellers removed, move the Pixhawk on the bench. Fresh HEARTBEAT and ATTITUDE, numerical roll/pitch and heading should change consistently. Inspect message counts and actual received frame rate in LINK.
4. **Freshness:** when telemetry stops, live status and attitude must expire. Never interpret a merely connected WebSocket as a live FC.
5. **GPS:** fix type below 3 or missing GNSS packets must not create an aircraft position or flight trail. GPS2 values can remain blank when no secondary GPS2 MAVLink packets are received.
6. **Panels:** hide/show each operator panel and the fleet sidebar without losing current mission draft or interrupting a live telemetry session. Camera should have a dedicated page rather than a second permanent right-side card.
7. **Camera:** select VIDEO and configure https://saitanveesh.tailf3ab6a.ts.net/cam/ for the correct aircraft. Confirm real camera video in the large embedded player. Refresh the browser and check the same aircraft still has its camera URL. Select a different aircraft and verify it does not inherit the previous aircraft's camera URL.
9. **FLIGHT:** verify the enlarged bottom attitude and heading instruments remain readable at the target screen resolution. Missing measurements must remain unavailable.
8. **PLAN and map:** confirm satellite tiles fill the complete map canvas, including after window resize and fleet-sidebar collapse. Add exactly one manual waypoint and verify its numbered pin appears at the clicked location. Add a second waypoint and check its pin and connecting line. Select waypoint 2 in the editable list and verify the corresponding map marker becomes highlighted; click waypoint 1 on the map and verify the list selection follows. Switch Satellite/Streets, close and reopen the planning panel, then fit the route, both with the planning panel open and closed. Draw a boundary, preview survey lanes, edit route points, save a draft and export GeoJSON. No FC upload should occur.
10. **Failure handling:** clear a stuck pending receiver from the Connect dialog before retrying. Never auto-disconnect a LIVE aircraft session without operator action.
11. **Safety boundary:** do not expect ARM, TAKEOFF, LAND, RTL, parameter writes or mission execution over this read-only transport. No controls should imply these commands were issued.

## Read-only diagnostic command

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Vihanga-Operator.ps1 -AircraftId AH-HW-001 -RequireLive
~~~

This command queries only the loopback GCS API and checks registered aircraft, status, heartbeat/attitude freshness, received/rejected frames and actual packet rates. It sends no MAVLink command. Omit -RequireLive to inspect a deliberately disconnected session.

## Evidence for release decision

Capture a flight HUD screenshot while the Pixhawk is stationary and after a physical tilt, an HTTP/WS diagnostics snapshot, visible camera frames, reconnect behavior, a stale-link screenshot, and the GitHub Actions run for the exact commit. Record actual p50/p95/p99 latency before making performance claims. No 24-hour soak, real 12-aircraft field load, production operator authentication, or physical cloud command acceptance has been demonstrated by the software CI suite alone.
