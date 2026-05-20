#!/usr/bin/env bash
# tailorbird.app launcher script.
#
# Lives at .app/Contents/MacOS/tailorbird. Sets up env, spawns the PyInstaller-
# built backend into the background, waits until it answers, then opens the
# browser and exits. Quick exit + detached backend = Finder doesn't keep the
# .app marked "running", so clicking the icon again re-opens the browser.
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_CONTENTS="$(cd "$HERE/.." && pwd)"
RES="$APP_CONTENTS/Resources"
PORT=7891

# Per-user writable data lives outside the read-only .app bundle.
DATA_DIR="${TAILORBIRD_DATA_DIR:-$HOME/Library/Application Support/tailorbird}"
mkdir -p "$DATA_DIR"
LOG="$DATA_DIR/tailorbird.log"

# If the backend is already up (user clicked the icon a second time), just
# bounce the browser and exit.
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT" || true
  exit 0
fi

# Hand bundled paths to the backend via env. config.py reads these.
export TAILORBIRD_RESOURCES_DIR="$RES"
export TAILORBIRD_DATA_DIR="$DATA_DIR"
export TAILORBIRD_FRONTEND_DIST="$RES/frontend_dist"
export TAILORBIRD_PORT="$PORT"

BACKEND="$RES/backend/tailorbird-backend"
if [ ! -x "$BACKEND" ]; then
  echo "[$(date)] backend binary not found at $BACKEND" >> "$LOG"
  /usr/bin/osascript -e 'display alert "tailorbird" message "Backend binary is missing from the app bundle."'
  exit 1
fi

# Detach the backend so the .app process tree exits cleanly.
nohup "$BACKEND" >>"$LOG" 2>&1 &
disown

# Wait up to ~30s for /api/health.
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    open "http://127.0.0.1:$PORT" || true
    exit 0
  fi
  sleep 0.5
done

/usr/bin/osascript -e "display alert \"tailorbird\" message \"Backend did not start within 30s. See $LOG.\""
exit 1
