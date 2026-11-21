# VIHANGA 2026-11-21 — RC visibility and operator UX

## Root cause of the missing handheld radio report

VIHANGA originally only projected `RADIO_STATUS` (a MAVLink telemetry modem
status) and FC `SYS_STATUS` flags. It did **not** decode MAVLink
`RC_CHANNELS`, and **both** the Pi edge `VALID_MESSAGES` allowlist and
the Oracle broker `ACCEPTED_TYPES` allowlist excluded `RC_CHANNELS`.

Consequently, even with FlySky iA6B paired to Pixhawk, real RC channel data
could be discarded before reaching the GCS.

This change:

1. Adds verified `RC_CHANNELS` and `RC_CHANNELS_RAW` to edge/broker
   allowlists without admitting any actuation packet or changing SYSID/
   component validation.
2. Projects live FC RC samples with five-second data freshness and reports
   `rc_channels_fresh`, `rc_channel_count`, `rc_input_status`,
   `rc_rssi_raw`, and `rc_message_type`.
3. Displays RC pilot input independently from a backup *GCS telemetry link*
   in the LINK drawer, quick flight ribbon, and Network Watch.
4. Preserves unknown RSSI (MAVLink 255) as unavailable rather than
   inventing a percentage or signal quality. An RC_CHANNELS message only
   proves that the FC sent channel samples; it does not certify RC failsafe
   state, transmitter pairing, valid pilot authority or future reachability.

### Operational prerequisites

- Pixhawk must actually emit `RC_CHANNELS` or `RC_CHANNELS_RAW` to its
  MAVLink UART connection, and Pi must forward the frame.
- Both the Pi edge service **and** Oracle cloud broker must be updated, as
  well as the Oracle standalone GCS API and static React console.
- No RC message despite a powered radio does not prove a broken receiver:
  first check Mission Planner's RC calibration / input monitor locally, then
  inspect the MAVLink message list and stream-rate settings.
- `SYS_STATUS.rc_receiver` is an FC sensor health report, not a substitute
  for measured RC RSSI.
- Radio pilot control continues independently from the cloud GCS. A
  standby receiver in connection settings is an alternative telemetry
  transport, *not* a duplicate of a FlySky receiver.

### Verify after deployment (read-only)

1. Check FC RC input locally in Mission Planner before changing hardware.
2. Check Pi/Oracle service health and that the broker reports actual
   `message_counts.RC_CHANNELS` (or `RC_CHANNELS_RAW`) increasing.
3. On Oracle GCS use Link → Links & sensors → RC pilot receiver. Expect
   `FC CHANNELS RECEIVED` only if fresh validated channel samples arrive.
4. Confirm FC heartbeat, attitude, backup transport and operator sessions
   remain independent when removing the RC stream.

## UI and map

- Original SVG wing/bird emblem and near-black graphite/naval-blue palette.
- Link monitor reduced to a 246-pixel strip and 290-pixel expanded panel
  with bounded scroll; no full-screen overlay.
- Waypoint labels use actual zoom-aware pixel separation while retaining
  every route point and polyline. Selected waypoint gets label priority.
- Above-fold controls: Undo last, Clear waypoints, Clear boundary, Reset.
  The first clears only the displayed waypoint route. The second clears
  polygon vertices. Reset clears local draft geometry and planner defaults,
  but does not delete stored mission records.
- Removed duplicate ribbon on FLIGHT and redundant lower Undo/Clear buttons.
- Connection Settings opens on the current primary receiver status instead
  of jumping automatically to standby just because primary is connected.

## Oracle and Pi deployment constraints

This PR changes the source repository and CI, not the running infrastructure.
The working 1 GB Oracle E2 Micro and Pi service must be updated independently.
Before doing any deployment, record the actual units, venv paths, and cloud
identity configuration. Do not assume a service unit name or overwrite
secrets. Deploy the updated Pi edge and cloud broker before evaluating
whether RC channels reach the standalone API.

No flight-control command route is enabled, bypassed, or represented as working.
