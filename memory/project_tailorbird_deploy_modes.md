---
name: project-tailorbird-deploy-modes
description: "tailorbird has two distinct runtime deploy paths on port 7891 — packaged .app vs source-mode server — and they don't auto-sync."
metadata:
  node_type: memory
  type: project
  originSessionId: a02a6071-970b-4780-83d0-5cc063c96adb
  modified: 2026-08-31T03:47:53.137Z
---

tailorbird (this repo, "birdye") ships as a hand-rolled macOS .app (PyInstaller-frozen backend + prebuilt frontend static files, no Tauri/Electron). Two ways it can be running on `127.0.0.1:7891`, and they are backed by completely separate files:

1. **Packaged prod**: `/Applications/tailorbird.app` — launched from Dock. Runs `Contents/Resources/backend/tailorbird-backend` (frozen binary) and serves `Contents/Resources/frontend_dist` (baked in at package time). `TAILORBIRD_FRONTEND_DIST`/`TAILORBIRD_RESOURCES_DIR` env vars point here. Dock → Quit does NOT stop the backend (by design, so re-clicking the icon reliably refocuses the browser instead of relaunching); use `scripts/quit_prod.sh` to actually kill it.
2. **Source-mode prod**: `scripts/start_prod.sh` — runs `uvicorn app.main:app` from the repo directly via the `tailorbird` conda env, serving `frontend/dist` (rebuilt automatically if repo frontend source is newer than the existing `dist/index.html`). This is what's meant by "小部署" (light deploy).

**Why this matters:** Since both bind the same port 7891, whichever started first wins — `start_prod.sh` silently no-ops (just opens a browser tab) if something is already listening on 7891, even if that something is the stale packaged app. Editing frontend/backend source and re-running `start_prod.sh` does NOT update the packaged `.app` — see [[feedback_deploy_app_too]] for the full 4-step flow needed to actually update `/Applications/tailorbird.app`, and don't skip that step going forward.

**How to apply:** Before deploying, check what's actually listening on 7891 (`lsof -tiTCP:7891 -sTCP:LISTEN` → `ps -p <pid> -o command`) to know whether you're looking at the packaged app or a source run — don't assume from README description alone.
