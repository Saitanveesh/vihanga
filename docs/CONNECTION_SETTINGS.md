# VIHANGA Connection Settings Panel

The operator console has one **Connection settings** panel opened from the
top-bar **Connections** control or from the LINK workspace. The panel manages
registered-aircraft **telemetry receiving links**, not vehicle flight commands.

The panel presents the primary and backup receiver states separately and
offers six implemented transport modes:

| Method | Connection detail | Actual backend behavior |
| --- | --- | --- |
| Serial / USB | COM port and baud rate | Local flight-controller serial read receiver |
| UDP | Local 127.0.0.1 port | Loopback-only UDP telemetry listener |
| TCP | Local 127.0.0.1 port | Loopback-only TCP telemetry client |
| Direct Wi-Fi | Pi RFC1918 HTTPS address, viewer token | TLS-verified, local-network telemetry |
| Vihanga Cloud | Approved HTTPS broker origin, scoped viewer token | Authenticated cloud broker viewer |
| Private relay | Approved HTTPS relay origin, username/password | Private relay telemetry client |

## Operator behavior

- Select a registered aircraft, then **Connections**.
- Choose **Primary** or **Backup**, then a transport.
- Enter the fields appropriate to that transport and choose **Connect**.
- The primary connection stays independent of an optional backup.
- Backup requires a preconfigured primary and a distinct backend transport
  class. Switching the monitoring source is **manual**, and only possible
  when the target stream has independently fresh FC telemetry.
- If a receiver is configured, first disconnect/remove it before replacing
  its settings. The form cannot silently replace an existing serial owner.
- The panel is scrollable and responsive, with a persistent bottom action
  row on laptop and mobile screens.
- Connection failures are shown inside the panel so operators retain their
  entered nonsecret settings while troubleshooting.

Only the connection origin and private-relay username are optionally stored
in browser local storage. The viewer token and password remain in React memory
and are cleared when the panel closes. No login or command identity is granted
by choosing a telemetry transport.

## Constraints

The UI **does not** extend the backend: UDP/TCP are loopback-only; Direct
Wi-Fi requires the independent private LAN Pi TLS listener and its trusted CA;
cloud origins require approved hosts; the FC SYSID must be 1–254. Commands
(ARM/LAND/RTL/missions/calibration) remain disabled on all receiver paths.

The panel's status cards reflect reported backend telemetry. A successful
connection request is **not** evidence of fresh heartbeat/attitude, and no
automatic flight-control failover is implied.

Automated UI tests cover protocol selection, field constraints, primary/
backup interlocks, source selection, connection errors and screen closing.
Actual Windows browser acceptance and Pi/Oracle connectivity remain separate.
