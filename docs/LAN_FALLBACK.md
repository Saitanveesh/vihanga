# VIHANGA v0.19 — Direct LAN telemetry recovery

This release introduces a second **real** flight-controller telemetry path which
can operate when the **Oracle cloud uplink is unavailable**. It is receive-only;
it does not support remote flight commands or automatic command failover.

## Architecture

```text
       Pixhawk MAVLink serial
                |
       Pi: single UART reader          (UART is NOT reopened for each cloud session)
                |
        validated MAVLink2 frames
             /          \
            v            v
    bounded cloud     authenticated LAN fan-out
    upload queue      WSS :8765 + independent viewer token
            |            |
      Oracle WSS          | same Wi-Fi / routed local LAN
            |            |
           GCS      GCS Direct Wi-Fi receiver
               \     /
             manual primary/backup
                |
        selected verified telemetry
```

The Pi keeps its UART open even while cloud reconnects. Neither route contains
an arbitrary incoming MAVLink-to-UART writer. Disconnecting the serial reader
invalidates both network streams; a recovered source must report fresh FC
HEARTBEAT and ATTITUDE before it becomes selectable.

## Security contract

- LAN listener **disabled by default**. Enabling requires a separate token
  (minimum 32 non-whitespace characters), a TLS certificate and its private key.
  Do not reuse the cloud device token or commit any secrets.
- The GCS accepts only `https://10.x.x.x:8765`,
  `https://172.16–31.x.x:8765`, or `https://192.168.x.x:8765`
  (up to TCP port 8775). Public IP addresses, hostnames, plaintext connections
  and URL credentials are rejected.
- The GCS backend must explicitly trust the Pi TLS certificate via
  `VIHANGA_LAN_CA_CERT`; TLS certificate hostname/IP validation remains enabled.
- LAN traffic is authenticated and encrypted. Only the local receiving GCS may
  hold the independent LAN viewer credential. Maximum 4 viewers; all viewer
  queues bounded. Incoming viewer payloads are disconnected, never forwarded.
- Bind the Pi LAN listener to its actual private IPv4 address, or to
  `0.0.0.0` **only if host firewall policy restricts the port to the ground
  station's private address**. Do not forward TCP 8765 through the router.

## Raspberry Pi provisioning (operator-approved only)

These are deployment instructions, not commands that have already been run.
Keep the existing working Pi service/configuration backed up before making
changes.

1. Identify the Pi private Wi-Fi address, for example `192.168.1.50`.
   The GCS must be able to reach it through the same LAN even without Internet.
2. Create a local TLS certificate whose **subjectAltName includes this exact
   IPv4 address**. For laboratory use, a private self-signed certificate is
   sufficient if the ground station explicitly trusts that exact certificate:

   ```bash
   sudo install -d -m 0700 /etc/vihanga/tls
   sudo openssl req -x509 -newkey rsa:3072 -nodes -days 180 \
     -keyout /etc/vihanga/tls/lan.key \
     -out /etc/vihanga/tls/lan.crt \
     -subj '/CN=192.168.1.50' \
     -addext 'subjectAltName=IP:192.168.1.50'
   sudo chmod 0600 /etc/vihanga/tls/lan.key
   ```

   Ensure the `vihanga` service account can read the certificate/key. Never
   transfer the private key to Windows; copy **only** `lan.crt` to the GCS.
3. Add these settings to the edge service environment:

   ```dotenv
   VIHANGA_EDGE_LAN_BIND=192.168.1.50
   VIHANGA_EDGE_LAN_PORT=8765
   VIHANGA_EDGE_LAN_VIEW_TOKEN=<separate securely generated token>
   VIHANGA_EDGE_LAN_CERT=/etc/vihanga/tls/lan.crt
   VIHANGA_EDGE_LAN_KEY=/etc/vihanga/tls/lan.key
   ```

   The existing edge WSS/cloud credentials remain unchanged. Verify the Pi can
   reach its serial device and that **one service owns the UART**.
4. Configure Pi firewall to allow TCP 8765 only from the ground station's LAN
   IP and deny access from other interfaces. Restart the edge service only
   during a supervised, disarmed, propeller-free maintenance window.

## Windows GCS provisioning

In the **same PowerShell environment that starts** the Vihanga API:

```powershell
$env:VIHANGA_LAN_CA_CERT = "C:\Users\saita\vihanga\config\pi-lan.crt"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Vihanga-Standalone.ps1
```

If the Vihanga API is already running, stop/restart that process so it inherits
the trust-bundle setting. The existing private Oracle connection may remain
primary. In the console select **Connections → Backup link → Direct Wi-Fi**.
Enter `https://192.168.1.50:8765`, the independent viewer token and the FC
MAVLink SYSID. After actual FC heartbeat and attitude become fresh, explicitly
select **Use backup** in Diagnostics.

No new command channel is opened. Existing RC control and onboard Pixhawk
failsafes remain independent of the GCS.

## Acceptance and unverified items

GitHub CI verifies an actual encrypted loopback WebSocket viewer, invalid-token
rejection, rejection of viewer payloads, a separate cloud/serial producer, and
local backend readback using a trusted temporary certificate.

**Not verified:** real Pi installation, actual power/ISP outage, RFC1918 Wi-Fi
reachability, production TLS certificate installation, 24h uptime, modem RF
quality, command-path authority, or real-world failover time.

Bench test with props removed, then manually disconnect Oracle **Internet only**
while keeping the local Wi-Fi router powered. The Pi should continue reading
UART and the Direct Wi-Fi receiver should continue displaying real FC
HEARTBEAT/ATTITUDE. Once Internet returns, restore the primary only after its
own data is independently fresh.

If the local Wi-Fi network itself is unavailable, this fallback also fails.
A separate telemetry radio/RC manual path is required for further redundancy.
