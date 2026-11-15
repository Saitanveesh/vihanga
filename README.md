# VIHANGA — Independent Ground Control System

Vihanga is an original, cross-platform cloud ground-control platform for ArduPilot/PX4-class aircraft. The new console is **not based on Mission Planner**. The architecture is intended for fleet operations with an interchangeable LTE/5G edge communications module.

## Current executable version: 0.2 (engineering)

Unlike the initial scaffold, this release includes actual functional geospatial planning and real MAVLink telemetry reception:

| Feature | Implemented | Verified |
| --- | --- | --- |
| Satellite / street map | MapLibre with attributed map tiles; zoom, pan, selected-aircraft position | TypeScript build |
| Polygon survey planner | Click map vertices; line spacing, angle and altitude; computes genuine clipped parallel survey legs | Backend geometry unit tests |
| Manual waypoint route | Click to add geographic waypoints; save selected-aircraft route | API and console builds |
| Mission drafts | SQLite storage, deterministic SHA-256 revision, history | Backend API tests |
| Multiple registered aircraft | Fleet identity, selection and independent link sessions | API build; 12-aircraft load campaign pending |
| Local UDP SITL receive | Loopback-only UDP port; MAVLink decoded from physical protocol frames | Automated UDP receiver tests |
| Private cloud telemetry | Backend signs in to **existing** Vihanga Oracle private relay, reads authenticated WSS MAVLink viewer and projects live data | Code/tests; real cloud deployment test pending |
| Live flight instruments | HEARTBEAT, ATTITUDE, VFR_HUD, SYS_STATUS, GPS_RAW_INT, GLOBAL_POSITION_INT | Real serialized MAVLink protocol regression tests |
| Camera view | User-configured private HTTPS camera page, independent of FC telemetry | Frontend build; operator smoke test pending |
| Remote ARM / takeoff / land / RTL / upload | **NOT IMPLEMENTED** | Not permitted |
| Physical aircraft command channel | **NOT IMPLEMENTED** | Not permitted |

**No synthetic or fallback telemetry** is used. Aircraft position is hidden unless both real position and a fresh GPS fix exist. Heartbeat, attitude and other instrument fields expire when packets stop. Invalid or foreign MAVLink messages are rejected rather than shown as live.

## Install / update on Windows

Prerequisites: Python 3.12+, Node.js 20+, Git. Open PowerShell:

~~~powershell
cd $env:USERPROFILE
if (!(Test-Path .\vihanga)) {
    git clone https://github.com/Saitanveesh/vihanga.git
}
cd vihanga
git pull --ff-only origin main
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Vihanga-Standalone.ps1
~~~

Then open **http://127.0.0.1:5173**. The loopback API runs at **http://127.0.0.1:8010**. Keep both PowerShell server windows running. If Windows reports a busy port, first identify the owning process; do not kill an unidentified service.

## First use

1. Open **FLEET**. Register your aircraft ID, human-readable name, autopilot and physical FC interface. Registering does **not** establish telemetry.
2. Select the aircraft in the left fleet column, click **Connect**.
3. For an existing Vihanga Pi/Oracle deployment choose **Private cloud**, enter the private **https://YOUR-HOST.ts.net:8443** origin, its *dedicated relay* operator login and the verified flight-controller system ID (commonly 1). This is not the old legacy API on :443. The browser submits credentials to the local Vihanga API, which authenticates to the private relay. The API does not persist the password or JWT in SQLite.
4. For a simulator choose **Local UDP / SITL**, and make an ArduPilot SITL instance emit actual MAVLink datagrams to **127.0.0.1:14550** (or your selected port). This is a *listener*, not a command sender.
5. Watch the status. **LIVE** is only shown with fresh FC HEARTBEAT and ATTITUDE messages, not merely when a TCP/WebSocket connection exists. No GPS position is displayed without fresh fix evidence.
6. Open **PLAN**, choose **Draw survey area**, click at least three map vertices, set line spacing/direction/altitude, and generate survey lanes. The geometry is real but *not terrain/obstacle/airspace validated*. Review transitions. Save as an offline draft; no mission is sent to the FC.
7. Use **HISTORY** to reopen the actual saved route. Use **LINK** to view received/rejected frame counts, message age, connection errors and disconnect control.
8. **VIDEO** can open the actual authenticated private camera page, subject to the camera service allowing embedding. There is also an external viewer link.

## Architecture

~~~text
Map + operator controls  — React / MapLibre
             |
          API localhost 8010
             |
   +---------+-----------+
   |                     |
Geospatial mission    Read-only MAVLink manager
SQLite draft store       |                |
                       UDP SITL       HTTPS login -> WSS viewer
                     loopback only      existing Oracle relay
                                           |
                                      Existing Pi -> Pixhawk
~~~

The existing Vihanga Pi–Oracle telemetry service is **not reinstalled, restarted or modified** by this application. This console replaces the Windows Mission Planner viewer while reusing the already demonstrated, independently deployed *telemetry source*. There is currently no new edge agent or general command plane.

## Scope and safety

- The API is a local development interface and **does not implement application authentication**. Do not bind or expose port 8010/5173 on an untrusted network.
- Only private *.ts.net HTTPS :8443 telemetry origins can be configured for this development relay client; do not paste usernames/passwords into issues or commit them to Git.
- UDP input is bound to 127.0.0.1. A local simulator or producer on your own PC must send authentic MAVLink; it is not an authenticated operational network interface.
- Satellite basemap tiles require external connectivity and attribution. Obtain a properly licensed map provider/credentials before any commercial release.
- For an authorized physical flight-control product, separate role/lease authorization, onboard RC precedence, safety interlocks, readback/ACK tracking and measured SITL/HIL/propeller-free acceptance are still required. This version must **not** operate an aircraft.

## Tests

~~~powershell
python -m pip install -e ".\backend[dev]"
python -m pytest -q backend/tests
cd console
npm install
npm run build
~~~

See [architecture and engineering gates](docs/ARCHITECTURE.md). Current build evidence is in the GitHub Actions run for the exact commit. The initial November 9 Mission Planner-based release lives only in the older **Vihanga-GCS** repository and is retained for fallback/reference.
