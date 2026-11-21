#!/usr/bin/env bash
# Update the loopback console and keep the previous build available for rollback.
set -Eeuo pipefail
repo="$HOME/vihanga-staging"
service=vihanga-api.service
url=http://127.0.0.1:8010
commit=$1
baseline=c588bf3e165a0bdf1670011b6a9b86c8ad082105
backend_path=backend/vihanga/app.py

[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Specify the complete release commit." >&2; exit 2; }
[[ "$(systemctl show "$service" -p WorkingDirectory --value)" == "$repo" ]] ||
  { echo "The VIHANGA service uses a different checkout." >&2; exit 2; }
pid=$(systemctl show "$service" -p MainPID --value)
[[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo "The VIHANGA API is stopped." >&2; exit 2; }
live=$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^VIHANGA_CONSOLE_DIST=//p')
[[ "$live" == /* && -f "$live/index.html" && -d "$live/assets" ]] ||
  { echo "Cannot locate the active console directory." >&2; exit 2; }

# Serialize deployments that run this script.
exec 9>"$live/.vihanga-release.lock"
flock -n 9 || { echo "A VIHANGA update is already running." >&2; exit 2; }

build=$(mktemp -d)
index_next=
api_next=
index_changed=0
api_changed=0
confirmed=0

finish() {
  result=$?
  trap - EXIT
  if (( ! confirmed )); then
    if (( index_changed )); then
      install -m 644 "$build/previous.html" "$index_next"
      mv -f "$index_next" "$live/index.html"
    fi
    if (( api_changed )); then
      install -m 644 "$build/previous.py" "$api_next"
      mv -f "$api_next" "$repo/$backend_path"
      sudo systemctl restart "$service" || true
    fi
    if (( index_changed || api_changed )); then
      echo "Verification failed. The previous release was restored." >&2
    fi
  fi
  [[ -z "$index_next" ]] || rm -f -- "$index_next"
  [[ -z "$api_next" ]] || rm -f -- "$api_next"
  rm -rf -- "$build"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$repo" archive "$commit" console "$backend_path" | tar -x -C "$build"
git -C "$repo" show "$baseline:$backend_path" > "$build/baseline.py"
if ! cmp -s "$repo/$backend_path" "$build/$backend_path" &&
   ! cmp -s "$repo/$backend_path" "$build/baseline.py"; then
  echo "The running API source has diverged. Its source and console were left in place." >&2
  exit 2
fi
python3 -m py_compile "$build/$backend_path"
npm --prefix "$build/console" ci --cache "$build/npm-cache" --no-audit --no-fund
npm --prefix "$build/console" run build

dist="$build/console/dist"
entry=$(sed -nE 's/.*src="(\/assets\/[^"]+\.js)".*/\1/p' "$dist/index.html")
[[ -n "$entry" && -f "$dist$entry" ]] || { echo "The compiled entry asset is missing." >&2; exit 2; }
cp -p "$live/index.html" "$build/previous.html"
cp -a "$dist/assets/." "$live/assets/"

if ! cmp -s "$repo/$backend_path" "$build/$backend_path"; then
  sudo -v
  cp -p "$repo/$backend_path" "$build/previous.py"
  api_next=$(mktemp "$repo/$backend_path.next.XXXXXX")
  install -m 644 "$build/$backend_path" "$api_next"
  api_changed=1
  mv -f "$api_next" "$repo/$backend_path"
  sudo systemctl restart "$service"
fi

if ! cmp -s "$live/index.html" "$dist/index.html"; then
  index_next=$(mktemp "$live/.index.next.XXXXXX")
  install -m 644 "$dist/index.html" "$index_next"
  index_changed=1
  mv -f "$index_next" "$live/index.html"
fi

curl --retry 6 --retry-connrefused --retry-delay 1 --max-time 5 -fsS "$url/" |
  cmp -s - "$dist/index.html"
headers=$(curl -fsS --max-time 8 -D - -o /dev/null -H 'Accept-Encoding: gzip' "$url$entry")
grep -qi '^content-encoding: gzip' <<<"$headers"
grep -qi '^cache-control: .*immutable' <<<"$headers"
confirmed=1

if (( index_changed )); then
  install -m 644 "$build/previous.html" "$index_next"
  mv -f "$index_next" "$live/.console-rollback.html"
fi

# Keep the active and previous bundle graphs. Ignore custom and nested files.
python3 - "$live" <<'PY'
import re
import sys
from pathlib import Path

dist = Path(sys.argv[1])
rollback = dist / ".console-rollback.html"
if not rollback.is_file():
    print("Asset cleanup skipped until a rollback build is recorded.")
    raise SystemExit(0)

assets = dist / "assets"
pattern = re.compile(r".+-[A-Za-z0-9_-]{8,}\.(?:m?js|css)")
files = {p.name: p for p in assets.iterdir()
         if p.is_file() and not p.is_symlink() and pattern.fullmatch(p.name)}
active = set()
pending = []
for document in (dist / "index.html", rollback):
    html = document.read_text(encoding="utf-8")
    names = set(re.findall(r"""["']/assets/([^"']+)""", html))
    if not names or not names.issubset(files):
        print("Asset cleanup skipped because a console build could not be fully identified.")
        raise SystemExit(0)
    pending.extend(names)
while pending:
    name = pending.pop()
    if name in active:
        continue
    active.add(name)
    source = files[name].read_text(encoding="utf-8")
    pending.extend(candidate for candidate in files if candidate not in active and candidate in source)

old_files = [p for name, p in files.items() if name not in active]
size = sum(p.stat().st_size for p in old_files)
for p in old_files:
    p.unlink()
print(f"Removed {len(old_files)} obsolete assets ({size:,} bytes).")
PY
echo "VIHANGA updated to $commit with compressed, cached assets."
