# VIHANGA v0.18 — Flight operator workspace and USB bench requests

This release starts the complete ground-station command interface while keeping
physical flight actuation **disabled**. It does not claim end-to-end cloud flight
control or internet-independent aircraft control.

## Operator surface

The **CONTROL** workspace lists actual GCS operations by type:

| Group | Planned functions | Current execution status |
|---|---|---|
| Flight | ARM, DISARM, TAKEOFF, LAND, RTL, Hold/Brake, pause/resume, RC override | Locked; authenticated command transport not installed |
| Navigation | Flight modes, guided target, set home, target speed, fence | Locked |
| Missions | Upload, download, read onboard mission summary, clear, start | Only non-actuating mission-count request (USB bench opt-in); full download and all changes locked |
| Parameters | Request individual parameter or parameter list, write | Reads only on an approved local USB serial bench session; writes locked |
| Diagnostics | FC version, system, GPS1/GPS2, EKF, RC, battery, home, flight state | Non-actuating USB bench requests |
| Calibration | Accelerometer, compass, radio, ESC, motors, servo, FC restart | Locked |
| Logs | Recorded flight log listings | Planned; currently locked |

The control UI displays **LOCKED**, never an ARM/LAND button that pretends a
command succeeded. A rendered button is not evidence of an available transport.

## Physical propeller-free bench procedure

1. Remove all propellers and keep the aircraft mechanically secured.
   Verify batteries, power distribution and emergency disconnection are safe.
2. Use a direct **USB** or dedicated UART serial connection between the
   Windows GCS and an unarmed Pixhawk. Only one application may own the port.
3. In a new PowerShell process before starting the local backend,
   set `$env:VIHANGA_BENCH_READ_REQUESTS = '1'`.
   Do **not** set this on the Oracle VM or Raspberry Pi flight deployment.
4. Start the standalone GCS using the repository startup script. Connect to
   the Pixhawk using Connections → Primary → Serial/USB and verify the actual
   FC HEARTBEAT and ATTITUDE. Bench read requests remain locked unless a
   fresh FC HEARTBEAT explicitly reports **DISARMED**.
5. Select CONTROL → Diagnostics. Request FC version, RC, GPS or system status.
   The API returns `SERIAL_WRITE_COMPLETED` after the serial owner writes an
   allowlisted MAVLink read request. Observe the subsequent actual MAVLink
   response or an unavailable value; do not interpret a write as an FC ACK.
6. In CONTROL → Parameters request `GPS_TYPE` or the parameter list. Inspect
   actual `PARAM_VALUE` responses via Refresh view. No parameter changes occur.
7. Alternatively, after all the checks above, run a non-actuating read
   preflight from a second PowerShell terminal (only after propellers are
   physically removed):

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Vihanga-BenchRead.ps1 -Query FC_VERSION -AircraftId AH-HW-001 -PropellersRemoved
   ```

8. To disable bench requests, close the GCS, remove that environment variable
   and restart. Default configuration never enables them.

## Engineering limits

* Local USB read requests are **not** cloud full duplex. They do not reach
  the Pi edge agent, legacy Oracle relay or the independent cloud broker.
* No Flight Mode, ARM, TAKEOFF, RTL, LAND, mission-start, parameter write,
  motor test or servo output is enabled. These require separate authority,
  safety and hardware acceptance before physical execution.
* Parameter readback is bounded to at most 1,500 unique names per connection.
  A new receiver discards the previous connection epoch's cached values.
* The queue is bounded to 8 request messages with a 250 ms minimum interval;
  no arbitrary caller-provided MAVLink packet is accepted.
* The browser request endpoint requires an explicit custom bench header and
  rejects cross-site Origin/Sec-Fetch-Site. This is CSRF hardening, **not**
  operator authentication.
* The user's decision to skip SITL is honored. Automated protocol and fake
  serial regression tests remain mandatory; propeller-free hardware acceptance
  comes after the tests. Physical flight must not be attempted with this build.

## Required follow-on work

**A.** Authenticated pilot/operator sessions, aircraft-scoped roles, expiring
authority lease, durable audit log, separate view and command identities

**B.** Single-owner Pi UART duplex gateway with independently authenticated
device and operator channels, bounded sequenced command queue, FC ACK and
post-command observed-state reconciliation

**C.** Safe recovery paths: cloud relay, direct authenticated local network,
independent telemetry-radio link and RC manual precedence; no automatic
replay of in-flight commands after reconnect

**D.** Bench-only physical integration tests with props removed: command
refusal, identity isolation, FC ACKs, parameter round trips, mission readback,
manual source changes, link outages and onboard failsafe response

**E.** Only after the above, separately authorized physical command
qualification for flight modes, ARM/DISARM, mission upload/execution and
other aircraft-changing operations

The existing v0.17 receive-only Oracle/Pi camera and telemetry services remain
unchanged by this release.
