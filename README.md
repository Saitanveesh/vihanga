# VIHANGA
### Independent cloud-assisted ground control and telemetry platform

Vihanga is an independent React/TypeScript operator console with Python geospatial planning, local MAVLink telemetry ingestion, a vehicle-isolated cloud telemetry broker and a Raspberry Pi edge receiver. It does **not** import, embed or depend on Mission Planner. Older Mission Planner-based work is retained separately for reference.

**Engineering baseline: v0.15 (operator UI), 15 November 2026.** The test suite exercises real MAVLink2 packet serialization and decoding, but there has been no demonstrated physical command downlink through this new stack. **Do not use this repository to conduct an aircraft flight.**

## Capability and verification matrix

| System | Implemented in this repository | Verified boundary |
| --- | --- | --- |
| Operator console | MapLibre map, fleet selection, planning, survey geometry, telemetry instruments, live status, observed flight trails, video link | React TypeScript build and component regressions; on-screen operator acceptance still pending |
| Planning | Aircraft-specific draft missions, survey lanes, stored revisions, route measurement | API/geometry unit tests; no terrain, obstacles or airspace clearance |
| Local FC telemetry | Receive-only USB serial, TCP loopback and UDP SITL; parser checks FC SYSID | Synthetic fixtures encoded as real MAVLink2 bytes, local socket and fake serial tests |
| Operator diagnostic workspace | Fleet telemetry, GPS2/power/airspeed/throttle diagnostics, full-width map with labeled route markers, collapsible aircraft/context panels and a dedicated camera workstation | API and React regressions; real-world UI QA pending |
| Independent cloud broker | Authenticated device/viewer WSS endpoints, vehicle and role isolation, CRC checking, bounded fan-out | Automated WebSocket and integration tests; real hosted TLS deployment pending |
| Pi edge agent | One-owner serial access, validated receive-only packets, bounded WSS reconnection, systemd sample | Automated tests; physical UART ownership, wiring and long soak pending |
| Cloud -> local GCS | Dedicated viewer client, freshness handling, per-aircraft WebSocket telemetry and GNSS tracks | Protocol integration plus local client tests; real private network end-to-end soak pending |
| Simulator command authority | Exclusive pilot lease, monotonic sequence, bounded deadlines, MAVLink COMMAND_LONG serialization, FC ACK + post-ACK observation lifecycle | Standalone unit tests only; **not exposed through API or edge** |
| Simulator mission protocol | MISSION_ITEM_INT upload, request retries, FC acceptance and exact readback validation | Standalone protocol unit tests only; **no mission upload transport** |
| Staging Docker | Private broker container with read-only filesystem and loopback-only host publish | Compose validation and container build in CI; no Oracle deployment |
| Physical flight-control | **Not implemented** | No Pi/Oracle/Pixhawk command acceptance |

The cloud broker and Pi agent are **telemetry-only**. Their authenticated viewer connections cannot transmit commands to the aircraft. The isolated command and mission protocol libraries must not be interpreted as a flight-control feature.

## Quick start — Windows console

Install Python 3.12+, Node.js 20+, and Git, then use PowerShell:

~~~powershell
cd $env:USERPROFILE
if (!(Test-Path .\vihanga)) {
    git clone https://github.com/Saitanveesh/vihanga.git
}
cd .\vihanga
git pull --ff-only origin main
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Vihanga-Standalone.ps1
~~~

Open **http://127.0.0.1:5173** (console) and **http://127.0.0.1:8010/api/v1/health** (local API). The startup script starts the development processes. These ports must remain bound to loopback; do not expose the local development API to the internet.

### Connect a telemetry source

1. In FLEET, register an aircraft ID and configure the expected MAVLink flight-controller SYSID.
2. For local simulator testing choose UDP SITL and send authentic MAVLink data to the configured loopback port. The GCS listens, it does not issue commands.
3. For the independent cloud broker choose Vihanga Cloud and provide the private HTTPS broker origin plus the vehicle's viewer token. Provision the broker and edge separately according to [staging instructions](docs/STAGING_DEPLOYMENT.md).
4. For the pre-existing private Oracle relay, use the separate private-cloud connection type, with its relay-specific operator login. This legacy viewer uses a different protocol and credential type.
5. A **LIVE** indication requires fresh heartbeat and attitude packets from the expected FC identity. Positions require a validated GPS fix. Disconnect and reconnection invalidate cached instrument data.

Create survey polygons and waypoint missions in PLAN. They are **offline drafts** and must be independently checked for terrain, altitude limits, obstacles, geofences and airspace before any future mission upload. The camera tab opens a configured private viewing endpoint; it does not imply a camera control or flight command channel.

## Data path

~~~text
Pixhawk UART
     |
     v   receive-only
Pi edge: serial frame parser + per-aircraft WSS device token
     |
     v   private TLS gateway
Cloud broker: aircraft-bound device -> viewer fan-out
     |
     v   authenticated WSS viewer
Local operations API: MAVLink2 projector, freshness and observed GNSS
     |
     +----> React console: HUD, map, flight trails, link diagnostics

Separate development-only protocol engines:
   supervised SITL command authority / mission upload + readback
   (no connection to physical edge, cloud broker or GCS command UI)
~~~

The new cloud broker runs separately from the earlier Pi/Oracle relay and must not overwrite that deployment without dedicated acceptance testing.

## Automated verification

Run from the repository root:

~~~powershell
python -m pip install -e ".\backend[dev]" -e ".\cloud[dev]" -e ".\edge[dev]"
python -m pytest -q backend/tests cloud/tests edge/tests integration/tests
cd console
npm install --no-audit --no-fund
npm run test
npm run build
~~~

GitHub Actions separately checks backend, cloud, edge, the cross-service packet contract, console production build, staging Docker configuration and independence from legacy Mission Planner artifacts. **A green CI result does not certify field readiness.** The integration harness injects the decoded viewer stream into a local GCS session; hosted TLS, real private networking, sustained load, measured latency, HIL and flight safety remain unverified.

## Release gates still outstanding

- Demonstrate Pi -> independent cloud broker -> authenticated GCS viewer with real Pixhawk UART telemetry. Verify a moving HUD against direct USB, with no command traffic.
- Validate connection loss, process restarts, token rotation, 24-hour soak, bounded queues and multi-aircraft load. Report p50/p95/p99 packet age, throughput, drop counts and host resources.
- Verify camera streaming under traffic load, GNSS validity, survey geometry, map license and operator workflow on the target Windows machine.
- Before any physical control path: operator identity/MFA, short-lived pilot authority, vehicle-side safety arbiter, RC/manual precedence, link-loss policy, authenticated acknowledgements, HIL, propeller-free bench and supervised range acceptance.

See [Operator acceptance](docs/OPERATOR_ACCEPTANCE.md), [Architecture](docs/ARCHITECTURE.md) and [Staging deployment](docs/STAGING_DEPLOYMENT.md). Never commit operational device tokens or operator credentials.
