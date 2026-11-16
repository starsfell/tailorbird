---
name: feedback-full-revert-means-deploy-too
description: "When the user says 'revert everything back to how it was' for tailorbird, that means source AND a redeploy to the running .app — a source-only revert leaves the stale broken build still running."
metadata:
  node_type: memory
  type: feedback
  originSessionId: c0ece4fb-6015-4f27-9def-a40d44d94271
  modified: 2026-09-10T10:11:15.463Z
---

When the user asks to fully undo a set of changes made during the session ("彻底给我还原回今天对话开始的样子"), reverting the source files is not enough — the packaged `.app` the user actually runs needs the same 4-step redeploy ([[feedback_deploy_app_too]]) applied to the reverted code, otherwise they keep seeing the broken/unwanted version live even though the repo looks clean.

**Why:** In one session, three unrelated changes accumulated (HomeView AI-toggle default, a Compare.jsx/styles.css flex-wrap CSS fix, and a launcher.sh `localhost` vs `127.0.0.1` fix — see [[project_tailorbird_localhost_cache_bug]]). Each was deployed individually as it landed. When the CSS fix turned out to cause a different layout problem (header wrapping to two lines) that the user found worse, they didn't want to debug further — they asked to nuke all three changes back to session start in one shot, source and running app both.

**How to apply:** Treat "revert/undo everything" as: (1) reverse every source edit made this session, precisely — diff-check the affected files show zero delta if a known-good baseline exists; (2) then run the same full deploy flow as any other change, so the running `.app`/server matches. Don't stop at the source revert and assume that's sufficient. Also: when multiple independent fixes stack up in one session and one of them turns out unwanted, be ready for the user to want *all* of them gone rather than surgically removing just the bad one — don't push back or ask "which parts", just do the full revert as asked, and only flag afterward via memory if a diagnosis (not the code change) is worth keeping for later.
