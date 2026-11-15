# Vihanga operator visual standard — v0.16

## Design intent

The console follows a map-first, operational UAV workstation layout. The visual reference was a user-provided drone-survey screenshot (15 November 2026). Layout hierarchy is adapted rather than cloning the other product's branding, controls, media assets or telemetry figures.

The objective is to reduce operator visual search time while preserving the existing aircraft data and camera integrations.

## Design tokens

| Purpose | Color | Meaning |
| --- | --- | --- |
| Application background | `#151B22` | Neutral charcoal base |
| Work panels | `#252F3A` | Distinct operator chrome above the map |
| Primary data | `#DCE5ED` | High-contrast readouts |
| Mission planning | `#E3AB52` | Draft geometry, selected waypoint and survey action |
| Live aircraft | `#58AC8F` | Fresh, verified telemetry only |
| Inactive/missing | Muted blue gray | Missing data stays blank rather than being synthesized |

Controls use restrained borders; accents encode meaning, not decoration. The map is the main workspace and does not receive unnecessary card backgrounds.

## Layout

- **Navigation:** a narrow, persistent workspace rail; current workspace is visible.
- **Fleet:** a separately collapsible aircraft list, with the real registered identity and link state.
- **Header:** currently selected aircraft label/autopilot, real link status, and the receiver connection entry.
- **Map:** satellite/streets layers, aircraft recenter (only with valid GPS), fit-route with panel-aware padding and persistent waypoint markers.
- **Mission inspector:** compact floating setup controls, genuine preview outcome, selected/editable waypoints, offline export and save.
- **Instrument dock:** symmetric measurement groups around a primary attitude and compass pair; unknown/stale sensor values remain unavailable.
- **Video:** separate private camera workstation, preserving per-aircraft HTTPS URL settings. It does not run extra preview streams in the flight map.

## Required operator interactions

1. Enter PLAN; select Survey or Waypoints. The active editing mode must be identifiable without relying on color alone.
2. Add one and then two route waypoints; numbered pins must be visible above both satellite and street tiles.
3. Select an existing waypoint in the list: its corresponding pin is highlighted. Select a pin: the list selection follows, with no duplicate map-click waypoint.
4. Open/close the survey panel and fleet rail. MapLibre must resize to the canvas without blank edges or stale overlay coordinates.
5. Use **Fit route** open and collapsed; the viewport fit should account for any visible inspector.
6. Generate a coverage preview. Survey polygon and planned route are distinct from the blue observed GNSS track. All measurements come from backend data.
7. Show camera video via the existing private stream URL without editing the Oracle relay or Raspberry Pi services.
8. With the aircraft disconnected, the HUD shows missing measurements, not demo sensor values.
9. Run the full React, API, telemetry, edge, cloud and staging CI suite after every structural UI change.

The screenshot is a visual design reference only, not proof of Vihanga features. The software remains receive-only for physical flight control; no ARM, TAKEOFF, RTL, LAND or mission upload is implied by the planning interface.
