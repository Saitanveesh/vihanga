# Vihanga station deployment

The ground station serves the compiled React console, operations API and telemetry WebSocket on a single loopback origin. The existing private cloud broker remains a separate telemetry service.

## Windows

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Vihanga-Standalone.ps1
```

On the first run the launcher prepares the Python environment and builds the console. Subsequent launches can reuse the compiled bundle and virtual environment. The launcher opens an Edge app window when Edge is installed. The console is at [127.0.0.1:8010](http://127.0.0.1:8010/). It shows startup checks for the operations API, aircraft directory and mission storage.

| Flag | Behavior |
| --- | --- |
| `-Rebuild` | Refresh dependencies and compile the console after pulling an update. Stop the existing station before rebuilding. |
| `-SkipInstall` | Launch from an existing build and Python environment. |
| `-NoOpen` | Perform readiness checks without opening a browser. |
| `-Dev` | Run the separate Vite development console on port 5173. |
| `-ApiOnly` | Run the operations API on port 8010 without launching the console. |

The launcher reports the API PID and writes diagnostics to `data/launcher-logs/`. If port 8010 has a previously launched API-only process, stop that instance before launching the production station. The station reuses the aircraft and draft records in `data/vihanga-dev.sqlite3`.

## Ubuntu

Run from the repository root using Python 3.12 or newer and Node.js 20 or newer:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e ./backend
npm --prefix console ci --no-audit --no-fund
npm --prefix console run build
VIHANGA_CONSOLE_DIST="$PWD/console/dist" \
  .venv/bin/python -m uvicorn vihanga.app:app --host 127.0.0.1 --port 8010 --no-access-log
```

Open [127.0.0.1:8010](http://127.0.0.1:8010/) from the same computer. Once the bundle is available, the station runtime requires Python and the backend dependencies.

## Operator checks

- Confirm the startup panel reports the API, aircraft and drafts independently. Retry a failed check from the startup panel or, after opening the workspace, from the toolbar.
- Confirm a connected receiver provides current values for the instruments and that stale readings clear when the stream stops. The trends show samples from the selected aircraft and receiver, with gaps where data was unavailable. The export contains UTC sample times and measured values.
- Select **Offline** when online satellite or street tiles are unavailable. Route and track geometry remains visible when WebGL is supported.
- Verify the primary and backup links with the intended physical receivers and cloud connection before using the station for field telemetry. The station provides read-only telemetry and draft planning.
