---
name: feedback-deploy-app-too
description: "Every deploy, even a \"light\" one, must also update the packaged /Applications/tailorbird.app AND git-commit + push the change — not just the source-mode server on 7891."
metadata:
  node_type: memory
  type: feedback
  originSessionId: a02a6071-970b-4780-83d0-5cc063c96adb
  modified: 2026-08-31T03:47:39.642Z
---

When the user asks for a "小部署" (light/quick deploy) of tailorbird, don't stop at running the source-mode server (`scripts/start_prod.sh`, single port 7891 serving `frontend/dist` directly). Also run the full packaging flow so `/Applications/tailorbird.app` (the Dock icon) reflects the same change:

```
cd frontend && npm run build && cd ..
conda run -n tailorbird pyinstaller packaging/tailorbird.spec --distpath dist --workpath build -y
./packaging/build_app.sh
./packaging/update_local.sh
```

**Why:** The user corrected me after I deployed only the source-mode server and called it done, then had to point out the Dock app is what they actually use day to day and it wasn't updated. Their words: "你自己都更新 以后小部署都要更新 桌面app这种都要的".

**How to apply:** Any time you deploy a change to this project going forward (frontend or backend), treat "deploy" as including the packaged .app update by default — run all 4 packaging steps, not just start_prod.sh — unless the user explicitly says to skip it or only wants the dev/source server checked. Note: PyInstaller freeze step takes a few minutes; that's expected, not a reason to skip it. See [[project_tailorbird_deploy_modes]] for the distinction between the two deploy modes.

**Also git commit (added 2026-10-20):** every deploy now includes a git commit of the deployed changes on main, without asking first. User: "以后默认小部署都要git提交". Match the existing commit style (Chinese "功能:/修复:" prefix summary + bullet body). Then `git push origin main` too (updated same day: "以后也都要推送远程") — push is part of every deploy by default.
