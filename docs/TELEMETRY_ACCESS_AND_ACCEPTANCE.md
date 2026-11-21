# Telemetry diagnostics and station access

## Read the telemetry path

On **Bench**, a Vihanga Cloud receiver shows three separate observations. The Pi reports UART bytes, accepted frames, rejected input and uplink counts. The broker reports validated ingress, packet age and viewer drops. The station reports projected packet counts and age for its own receiver. Bench captures save these observations for playback and JSON export.

Packet ages use each service's monotonic clock. The display accounts for elapsed time since the diagnostic report. It identifies evidence gaps such as a connected Pi with no fresh validated UART frames, relay ingress going stale, or fresh relay packets with a stale station viewer. Reports older than six seconds disappear. These observations can locate the first stale leg, while intermittent faults can require a longer capture.

The Pi negotiates diagnostic support with the independent broker. Older Pi or broker builds can continue forwarding MAVLink. The legacy Oracle relay and direct LAN receivers show station-level evidence. Upgrade the independent broker and Pi together to obtain upstream evidence. Route `GET /api/v1/diagnostics/{vehicle_id}` through the same private TLS gateway as the broker WebSockets and forward the viewer Authorization header.

## Enable operator sign-in

1. On the station host, generate a salted password verifier for each account using the station Python environment and `python -m vihanga.station_auth`. Enter the password at the hidden prompts.
2. Save a private JSON file with `version` set to `1` and an `operators` array. Each account has `username`, `role`, `aircraft` (an array of vehicle IDs), and the generated `salt` and `password_scrypt` fields. Include an `admin` account. An `operator` can manage telemetry links and drafts for their assigned aircraft. A `viewer` can read assigned aircraft data. Administrators can manage the fleet.
3. Set `VIHANGA_STATION_OPERATORS_FILE` to the file path in the station launch environment and restart the local station. `VIHANGA_STATION_SESSION_SECONDS` defaults to 3600 and accepts 60–43200 seconds. Sign-in uses an HTTP-only session cookie on the loopback station. Sessions expire server-side and logout closes active telemetry sockets. Restart the station after replacing a verifier or changing grants to revoke all existing local sessions.

Station sign-in is opt-in. The unconfigured station uses the local workstation mode. Keep the station bound to loopback.

## Broker credentials and rotation

The broker accepts its original environment configuration for compatibility. To enable expiring credentials and live rotation, set `VIHANGA_CLOUD_CREDENTIALS_FILE` to a private JSON file with this layout:

```json
{
  "version": 2,
  "aircraft": [
    {
      "vehicle_id": "AH-HW-001",
      "system_id": 1,
      "organization": "lab",
      "device_credentials": [{"sha256": "<64 lowercase hex characters>", "expires_at": 1900000000}],
      "viewer_credentials": [{"sha256": "<64 lowercase hex characters>", "expires_at": 1900000000}]
    }
  ]
}
```

Generate independent tokens with at least 32 random bytes. Configure only the SHA-256 digests and UTC Unix expiration times in the file. Distribute the raw device token to the Pi and the raw viewer token to the station through their existing private configuration channels. Assign each token to one aircraft and one role.

Docker staging can mount this file with `docker compose -f cloud/compose.staging.yml -f cloud/compose.credentials.yml up -d --build`. Put the file at `cloud/.vihanga-secrets/aircraft.json` and grant container UID 65534 read access. Keep the directory private. Mounting the directory allows atomic file replacement.

For rotation, add a new digest with an overlap period, atomically replace the file, and confirm the replacement token works. Update the client, then remove the old digest in another atomic replacement. To revoke immediately, remove the relevant digest. Active sockets recheck their role and expiry, and the broker rereads the file at most once per second. Invalid or missing replacements deny configured credentials until a valid file returns. Changing the aircraft roster, organization, or SYSID requires a broker restart. The legacy Oracle relay and direct LAN service use their existing credential mechanisms.

## Physical acceptance on the Windows station

Start with both cloud primary and Server USB backup showing fresh heartbeat and attitude for the same SYSID. The Windows station must enumerate COM6 and the backup must actually use it. Use the propeller-free, disarmed bench configuration for the test.

```powershell
powershell.exe -NoProfile -File .\scripts\Test-Vihanga-BenchLinks.ps1 -AircraftId AH-HW-001 -Port COM6 -Seconds 120
```

In protected mode add `-Credential (Get-Credential)`. To save a second copy of the capture and verdict, pass `-ReportPath .\bench-acceptance.json`. The script observes an initial healthy pair, primary loss, manual backup selection, primary recovery, and manual primary restore in order. Changing the network and selecting receivers are operator actions. A missing port, a missing state, or a timed-out capture does not pass.
