# Vihanga standalone architecture

## Product boundary

Vihanga is an original, cross-platform operations platform, not a rebranded Mission Planner fork. Avoid copying upstream Mission Planner source, screens, imagery or GPL-covered implementation into this working tree. Independent protocol implementations must comply with any libraries' licenses.

\`\`\`text
Operator console (React + TypeScript)
  | authenticated API / event streams (future)
  v
Vihanga cloud control plane
  | scoped aircraft identity / per-aircraft authority (future)
  v
Vihanga edge agent, interchangeable transport (future)
  | full-duplex MAVLink behind local safety arbiter (future)
  v
ArduPilot / PX4 flight controller
  ^ independent pilot radio, onboard failsafes
\`\`\`

## This increment — implemented

- Local operations console and API health.
- SQLite-backed aircraft registry; aircraft stay OFFLINE without authenticated live evidence.
- SQLite-backed bounded mission-draft lifecycle; immutable SHA-256 revision per draft.
- Validation of waypoint coordinates and altitude, deterministic route-length calculation.
- No cloud broker, live telemetry, camera stream, command dispatch or flight authorization.

## Future integration layers

**Edge:** Rust or Go service on Pi/industrial hardware, one MAVLink serial owner, physically verified 3.3V UART/electrical interface, identity-bound device enrollment, externally supervised pilot authority, watchdog and safe disconnected operation.

**Cloud:** authenticated, per-vehicle transport; one exclusive command owner and many observers; bounded queues, explicit no-replay semantics and durable audit; command state distinguishes issued, relayed, FC-ACKed and observed effect. TLS protects transport; MAVLink2 signing alone is not encryption.

**GCS:** aircraft status, map with actual GNSS, waypoint/survey planner, live video, operations, fleet, diagnostics, administrator settings, safety approvals. A clean responsive UX for Windows, Linux and browsers with an optional packaged desktop shell.

**Acceptance:** simulator-only command integration first, then HIL, disarmed propeller-free controller bench, supervised field testing. No arbitrary raw MAVLink write endpoint. Never place cloud round-trip timing inside stabilization or emergency avoidance loops.

## Non-goals of initial implementation

No pretending to operate twelve live UAVs, no spoofed HUD, no public cloud deployment, no flight-control API, no auto-arm, no mission upload to a physical FC, no artificial flight telemetry. The standalone console may be used to develop future features without placing the existing airframe at risk.
