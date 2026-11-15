# VIHANGA

**Original, cloud-connected unmanned aircraft operations platform.**

VIHANGA is being built as an independent product—not a Mission Planner fork—comprising:

- **Vihanga Console:** original multi-aircraft operations cockpit, flight view, map and mission planning, video, audit and operator controls.
- **Vihanga Cloud:** authenticated, per-aircraft telemetry transport, authorization, command/ack lifecycle, mission scheduling and fleet observability.
- **Vihanga Edge:** interchangeable on-aircraft agent with MAVLink-compatible ArduPilot/PX4 integration, edge watchdog and eventual Wi-Fi/LTE/5G communications.
- **Vihanga Fleet:** 12-aircraft concurrency target, per-aircraft isolation, access control, and mission operations.

This project is developed independently. AlgoBotix is a public-market functional benchmark, not a source of proprietary code or branding.

## Engineering principles

1. Real telemetry or clearly absent data; never fabricated flight state.
2. Native cloud authorization and independently enforceable aircraft safety gates; no public arbitrary MAVLink control tunnel.
3. Flight stabilization, immediate failsafes, and pilot override remain onboard.
4. Separate command transport acknowledgement, flight-controller acknowledgement, and observed vehicle state.
5. One integrated release architecture, tested in SITL/HIL before physically supervised aircraft trials.
6. No Mission Planner code, dependencies, executable or skins.

## Initial deliverable

The standalone local operations console and API are the first engineering increment: aircraft identity registration, persistent mission drafts and offline capability reporting. **They do not command a real aircraft.** Hardware interfaces, authenticated cloud services and full flight-control release require separate implementation and acceptance.

See `docs/ARCHITECTURE.md` for the component boundaries and validation plan.

## Background

The previous `Saitanveesh/Vihanga-GCS` repository is retained as an archived source/engineering reference only. Its November 9 stable working deployment must not be modified by this rewrite.
