# VIHANGA v0.20 — Local operator identities, sessions and aircraft permissions

This release adds **human operator authentication** to the local Vihanga API.
It is independent of the Pi device credential, cloud telemetry viewer tokens,
and the simulator-only pilot lease in `vihanga.control`. Signing in **does not
authorize ARM, LAND, RTL, mission uploads, parameter writes or motor tests**.

## Deployment compatibility

| Mode | Configuration | Behavior |
| --- | --- | --- |
| Existing development | No `VIHANGA_OPERATOR_AUTH` variable, or `legacy` | Existing loopback-only console remains accessible without login |
| Enforced local operators | `VIHANGA_OPERATOR_AUTH=required` | All `/api/v1` application endpoints and telemetry WebSockets require a valid session; public health, capabilities and login/status remain available |

For real operational environments the **required** mode must be explicitly
enabled. Legacy mode is not secure multi-operator authorization and must not
be exposed over LAN, Tailscale Serve, public reverse proxies or the Internet.

The API remains bound to `127.0.0.1:8010`. The browser uses its existing
same-origin Vite reverse proxy. No Oracle or Raspberry Pi deployment changes
are required.

## First-time Windows setup

Complete the existing Vihanga installation first, then provision operators
locally from the repository directory. The CLI accepts passwords through a
no-echo terminal prompt, never through an HTTP bootstrap endpoint or a
command-line argument.

```powershell
cd $env:USERPROFILE\vihanga
.\.venv\Scripts\python.exe -m vihanga.operator_auth --db data/vihanga-dev.sqlite3 enroll --user admin-one --role ADMIN
.\.venv\Scripts\python.exe -m vihanga.operator_auth --db data/vihanga-dev.sqlite3 enroll --user pilot-one --role PILOT --aircraft AH-HW-001
.\.venv\Scripts\python.exe -m vihanga.operator_auth --db data/vihanga-dev.sqlite3 enroll --user observer-one --role VIEWER --aircraft AH-HW-001
```

Then **close the old Vihanga API process** (do not reuse one started in legacy
mode), and start a new process:

```powershell
$env:VIHANGA_OPERATOR_AUTH = "required"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Vihanga-Standalone.ps1
```

Open `http://127.0.0.1:5173` and use the new operator login screen.
The login response sets an HTTP-only, SameSite=Strict session cookie; JavaScript
holds a separate CSRF token only in memory. No password or raw session token
is written to local storage.

Accounts:
- **ADMIN:** global aircraft access, registration, pilot-level local mutations,
  and audit log readback
- **PILOT:** only explicitly assigned aircraft; may create local mission drafts
  and configure/view receive-only telemetry for those aircraft
- **VIEWER:** only assigned aircraft; read-only access

Aircraft-specific REST telemetry, mission readback, fleet lists and streaming
WebSockets use the same aircraft scope checks. Cross-aircraft access is rejected
before the backend opens a receiver socket.

## Lifecycle and recovery

Sessions expire absolutely after 30 minutes; expired and revoked sessions are
rejected on every request. Log out revokes the server-side session. The
`revoke-sessions` local CLI action also invalidates all sessions for a user:

```powershell
.\.venv\Scripts\python.exe -m vihanga.operator_auth --db data/vihanga-dev.sqlite3 revoke-sessions --user pilot-one
```

Five failed password attempts temporarily lock that username for five minutes.
Passwords use salted scrypt; sessions use random secrets whose SHA-256 hashes
are stored in SQLite. Audit records retain actor, bounded action category,
aircraft ID, result and timestamp; they never contain passwords or tokens.

The SQLite database is local to one trusted Vihanga API instance. Multi-process
or remote operator deployment requires a coordinated identity/session backend,
a proper TLS termination architecture and additional cross-host testing. Local
development HTTP cookies deliberately lack the Secure attribute because the
supported origin is loopback HTTP; they must not be reused over plain remote HTTP.

### Safety boundaries

- The roles here authorize **local operations API access**, not vehicle-command
  authority. The simulator-only command lease must not be silently connected
  to the serial writer or cloud transport.
- The existing `VIHANGA_BENCH_READ_REQUESTS=1` flag remains a separate,
  propeller-free, DISARMED-state opt-in; operator role does not bypass it.
- Authentication does not make an Internet-dependent cloud connection
  resilient; direct TLS LAN telemetry remains a separate receive-only service.
- Device-to-broker credentials are managed separately. PR #22 is still a
  separate credential-expiry branch; do not conflate its tokens with human users.

## Verification gates

The automated suite must prove: account enrollment and role validation,
unknown/expired/revoked session rejection, CSRF protection, brute-force throttle,
same-aircraft isolation across REST and WebSocket, read-only viewer restrictions,
secret-free audit, and continued legacy loopback behavior.

A Windows-browser sign-in test and approved Pixhawk propeller-free hardware
acceptance remain separate. Production control writes are still disabled.
