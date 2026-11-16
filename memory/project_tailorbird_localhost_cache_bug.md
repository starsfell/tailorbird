---
name: project-tailorbird-localhost-cache-bug
description: "Diagnosed but REVERTED: tailorbird's launcher/open scripts open 127.0.0.1:7891, which browsers cache as a separate origin from localhost:7891 — caused a deployed frontend change to look 'not updated' via the .app. Do NOT re-apply the localhost fix without the user explicitly asking again."
metadata:
  node_type: memory
  type: project
  originSessionId: c0ece4fb-6015-4f27-9def-a40d44d94271
  modified: 2026-09-10T10:11:03.822Z
---

Diagnosed 2026-09-10, then reverted the same day at the user's explicit request ("部署也不要localhost 你彻底给我还原回今天对话开始的样子"). `packaging/launcher.sh`, `scripts/start_prod.sh`, and `scripts/open_browser.sh` open `http://127.0.0.1:7891`. Browsers treat `127.0.0.1` and `localhost` as separate cache origins with separate disk caches, and a stale disk-cached copy of the frontend under the `127.0.0.1` origin survived a full redeploy, computer reboot, and manual hard-refresh — disk cache persists across reboot. Manually navigating to `localhost:7891` showed the correct up-to-date page the whole time, which was the tell.

**Current state: reverted.** All three scripts are back to `127.0.0.1` — do not change them to `localhost` again unless the user asks for it in a future session. The revert was part of a broader "undo everything from today" request that also reverted an unrelated CSS fix and a HomeView default-value change, so it's not fully clear the localhost switch itself was objected to on its own merits vs. just being swept up in the blanket revert — treat it as withdrawn either way.

**Why:** User reported a frontend default-value change (home screen AI-toggle default) wasn't showing up in the packaged app no matter what — tried hard refresh, full browser quit, computer restart. Root cause took real investigation to find: confirmed via `curl` that the server was serving the correct content, then noticed the working case (manual `localhost` navigation) used a different hostname than the broken case (app-launched `127.0.0.1`). Later the same session, the user asked to revert this along with everything else done that day.

**How to apply:** The underlying diagnosis (browser-origin cache split between `127.0.0.1`/`localhost`) is still valid technical knowledge — if a user reports "I redeployed tailorbird but the change isn't showing," it's still worth asking them to try the *other* hostname as a diagnostic step. But do not silently re-apply the launcher/script fix again — surface the finding and let the user decide, since they already walked it back once. See [[feedback_deploy_app_too]], [[project_tailorbird_deploy_modes]], and [[feedback_full_revert_means_deploy_too]].
