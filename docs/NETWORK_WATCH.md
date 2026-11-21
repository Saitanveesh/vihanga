# VIHANGA communications watch — browser + aircraft telemetry

The operator console displays an always-visible, compact **LINK MONITOR**
at the bottom-right of the map. Clicking the strip expands measured
information and a bounded recent status-change log.

| Indicator | Measurement source | What it does **not** mean |
| --- | --- | --- |
| GCS | Timed HTTPS request from browser to `/api/v1/health` every five seconds | Not a Wi-Fi RSSI value, Internet bandwidth, Oracle-to-Pi RTT, or command ACK latency |
| UAV | Receiver state, fresh FC HEARTBEAT/ATTITUDE and age of last MAVLink frame | Not proof of flight-control command authority |
| Local/remote RSSI | Uncalibrated raw `RADIO_STATUS` MAVLink fields, if actually received | Not dBm and never converted to a 0–100% signal indicator |
| Radio receive errors | Raw `RADIO_STATUS.rxerrors` when reported | Not per-second loss rate, not a GCS ISP packet-loss measurement |
| Backup receiver | Backend reported standby status | No automatic source takeover |

## Status rules

- Browser/API check: a successful health reply reports measured request time;
  greater than 1,000 ms is an advisory slow-response warning; an unavailable
  or timed-out API is offline. The four-second timeout is deliberately bounded.
- Aircraft receiver is live only when the backend reports a connected transport,
  fresh verified HEARTBEAT and ATTITUDE. Delayed frames, missing FC data and
  receiver disconnections are distinguished.
- An aircraft that was **already healthy** and transitions to stale or offline
  produces an event. Restoration produces an event. An aircraft that was never
  connected is not reported as a new outage.
- A limited number of events remain visible until cleared locally. No command
  is sent, no aircraft state is invented and no credentials are stored.
- GCS API response time is a transport check. For actual client Wi-Fi RSSI a
  separately authorized native OS telemetry source would be necessary.
- Browser tab throttling and network conditions can delay checks; treat this
  as a monitoring aid rather than a safety-critical loss-of-link detector.

## Flight-command UX

The large `Flight command path locked` warning was removed from the control
workspace. Diagnostic read requests are presented first, and non-operational
flight-changing functions remain visibly pending verified command integration.
This is a presentation change only; no ARM, LAND, RTL, mission upload, servo,
motor or parameter-write transport has been unlocked.

## Oracle staging deployment (existing 1 GB E2 Micro)

The current Oracle staging VM already serves the statically built console
through Nginx on `127.0.0.1:5173` and FastAPI on `127.0.0.1:8010`,
with Tailscale HTTPS on `:8444`. Existing relay ports 8000/8765 remain
untouched. After merging this PR and verifying memory/disk headroom, apply:

```bash
cd ~/vihanga-staging
git pull --ff-only origin main

# Build only the frontend; do not install a permanent Node.js preview server.
cd console
npm run build
cd ..

sudo cp -a console/dist/. /var/www/vihanga-staging/
curl -fsS http://127.0.0.1:5173/ >/dev/null
curl -fsS http://127.0.0.1:5173/api/v1/health
```

Do not modify the existing Tailscale 443/8443 routes, the Pi agent, or
the working Oracle telemetry relay. On small VMs, frontend compilation can
consume significant memory; take care not to evict the aircraft relay.

## Validation

React component tests check actual HTTP health polling, honest units,
missing radio fields, stale FC data, state-loss transitions and restoration.
On-screen validation on Oracle/Tailscale and physical radio loss testing
remain necessary. This monitor does not replace Pixhawk failsafes or RC link
monitoring.
