# Independent Vihanga staging deployment (non-actuating)

This procedure installs the new, independent, receive-only Vihanga Cloud broker.
It does not enable aircraft flight control and has not been performed on the
current Oracle instance. Do not replace a proven system before acceptance.

## Host and credentials

Use Ubuntu 24.04+, Docker Engine and Docker Compose. Broker secrets must not
be stored in Git. Generate separate random device and viewer tokens of at
least 32 random bytes, then configure only their SHA-256 digests in the
VIHANGA_CLOUD_AIRCRAFT_JSON environment variable.

An individual token must authorize one aircraft and one role. The Pi receives
only its device token; GCS operators receive only a viewer credential.

## Staging instance

Copy the cloud/.env.example file to cloud/.env on the staging machine and
replace the example digests with actual per-aircraft SHA-256 values.

    cd cloud
    chmod 600 .env
    docker compose -f compose.staging.yml config --quiet
    docker compose -f compose.staging.yml up -d --build
    curl --fail http://127.0.0.1:8750/health

The cloud container binds to all addresses only INSIDE the container;
Docker publishes the service ONLY at 127.0.0.1:8750 on the host. TLS is
terminated by a separate approved reverse proxy or private Tailscale gateway.
Never expose raw port 8750 to the public internet. This staging app has not
passed an independent security audit, and its static viewer tokens are not
production operator authentication.

## Edge unit on Raspberry Pi

Install the edge Python package in a virtual environment. The sample
systemd service expects /etc/vihanga/edge.env with restrictive permissions
and a group permitting access to the Pixhawk UART. The configured WSS URL
must end with /ws/v1/device/AIR-001 (replace the ID as appropriate).

Ensure no other service has the Pi UART open before starting this agent.
Configure the lockfile as /run/vihanga/serial.lock (systemd RuntimeDirectory).
This lock is advisory, not proof that every other process cooperates.
Confirm the 3.3 V Pi UART wiring/ground/baud and power isolation.

The edge agent forwards validated FC-origin MAVLink2 binary frames to the
cloud. It neither accepts nor performs flight-control commands.

## GCS client

In the new Vihanga Console, register the aircraft and choose Connect ->
Vihanga Cloud. Enter the reviewed private HTTPS relay origin and the
viewer token. A LIVE status requires genuine fresh FC HEARTBEAT and ATTITUDE.
No GPS position is plotted without a fresh valid GPS fix.

## Acceptance and operations

A release requires real device identity checks, malformed CRC and foreign
SYSID rejection, packet freshness, 24-hour telemetry soak, Pi/cloud restarts,
loss and reconnect testing, camera streaming under concurrent load, and
multiple concurrently live aircraft. Benchmark p50/p95/p99 latency and
resource usage rather than assuming a small VM supports twelve aircraft.

Operator OIDC/MFA, short-lived authorizations, key rotation, durable event
storage, validated command downlink and flight-safety qualification remain
separate deliverables.

The previous hardware-verified Pi/Oracle relay must remain untouched until
this independent staging stack passes physical acceptance.

### Broker credential expiry and rotation

The existing JSON array format remains supported. To require expiration, wrap
the aircraft array as `{"version": 2, "aircraft": [...]}` and add integer
`device_expires_at` and `viewer_expires_at` fields to each aircraft entry. Both
are UTC Unix seconds. Expired credentials are rejected on connect. Established
sessions are closed at expiration and their slot or queue is released.

To rotate or revoke a credential in staging, generate an independent random
replacement, update only its stored SHA-256 digest and expiry, restart the broker,
and update authorized clients through the existing secret-distribution channel.
Restart disconnects all broker sessions. Setting one role's expiry to a past
timestamp disables that role without changing the other role's configured token.
Keep a protected copy of the previous configuration for rollback only when its
credentials are still trusted. This version uses restart-based configuration
changes and has no operator login endpoint or overlapping-key rotation window.
