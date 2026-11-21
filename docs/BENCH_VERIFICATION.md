# Bench verification

The Bench workspace compares station-managed primary and backup telemetry. Each receiver has its own status, heartbeat, attitude, last packet age, frame rate, and configured SYSID. A browser-managed USB receiver appears in a separate live card when connected. Choose **Server USB** in Connection settings to include a local serial receiver in a station capture.

## Record and review

1. Select the registered aircraft and open **Bench**. Check each configured receiver's transport and SYSID.
2. Select 30, 60, 120, or 300 seconds and start a capture. The station service takes one snapshot per second and can finish a capture after the console tab closes. Use **Stop capture** to finish early.
3. Open the saved capture. Compare live samples and packet-age p50, p95, and p99 by receiver. The playback slider reviews individual observations. Select a receiver change to jump straight to its recorded sample.
4. Export JSON for bench evidence. The export includes station timestamps, receiver states, and the active viewing source. It uses the station's reduced projection of the telemetry and excludes raw packets, positions, and connection settings.

Packet age measures how long ago the station received its most recent packet. Percentiles use the nearest-rank method and only include samples with fresh heartbeat and attitude. Keep the age sample count beside the percentiles when comparing receivers. One-second sampling can miss shorter transitions.

The single-process station records one aircraft at a time and keeps the latest 20 captures across all aircraft in its local SQLite database. Starting a new capture rotates the oldest entry when full. On restart, an unfinished capture becomes **Interrupted** and its saved samples stay available. The browser USB card is live-only.

## Upgrade plan

| Priority | Upgrade | Acceptance |
| --- | --- | --- |
| 1 | Receiver comparison, capture, playback, and export | Station records both receivers independently and displays outages and source changes in a saved report. |
| 2 | End-to-end link diagnostics | Track packet counts and last-seen time at Pi UART, cloud ingress, and the station viewer. A bench report can localize a no-data case to the relevant leg. |
| 3 | Physical primary and backup verification | On the intended Pixhawk, Pi, Oracle relay, and local serial hardware, record USB and cloud readings, receiver loss, recovery, and manual source selection. Compare the saved station evidence with upstream observations. |
| 4 | Operator access and credential lifecycle | Verify viewer and device roles, aircraft-scoped access, credential expiry, and credential rotation on the intended deployment. |
