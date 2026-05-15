#!/usr/bin/env bash
# tailorbird 生产模式:单端口 7891,前端由 FastAPI 托管。
# 启动器立即退出,uvicorn detach 到后台 —— 这样 macOS 不会把 .app
# 标记为运行中,再点图标能可靠地重新打开浏览器。
# 退出后端用 scripts/quit_prod.sh。
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=7891
PYBIN="/opt/homebrew/Caskroom/miniconda/base/envs/tailorbird/bin/python"
LOG="/tmp/tailorbird.log"

# 从 Finder 双击 .app 启动时不会加载 .zshrc，PATH 里没有 brew 的 npm/node。
# 显式把 homebrew 路径加上，否则前端 rebuild 会失败。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ ! -x "$PYBIN" ]; then
  echo "未找到 tailorbird conda 环境的 Python: $PYBIN" >&2
  exit 1
fi

DIST_INDEX="$ROOT/frontend/dist/index.html"
need_build=true
if [ -f "$DIST_INDEX" ]; then
  if ! find "$ROOT/frontend/src" \
            "$ROOT/frontend/index.html" \
            "$ROOT/frontend/package.json" \
            "$ROOT/frontend/vite.config.js" \
            -newer "$DIST_INDEX" 2>/dev/null | grep -q .; then
    need_build=false
  fi
fi

if [ "$need_build" = true ]; then
  echo "▶ 前端源码有变化,重新 build..." | tee -a "$LOG"
  cd "$ROOT/frontend"
  [ ! -d node_modules ] && npm install >>"$LOG" 2>&1
  npm run build >>"$LOG" 2>&1
fi

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  "$ROOT/scripts/open_browser.sh" "http://127.0.0.1:$PORT"
  exit 0
fi

cd "$ROOT/backend"
nohup env PYTHONPATH="$ROOT/backend" "$PYBIN" -m uvicorn app.main:app \
  --host 127.0.0.1 --port "$PORT" \
  >>"$LOG" 2>&1 &
disown

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    "$ROOT/scripts/open_browser.sh" "http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.5
done

echo "后端 30 秒内没起来,查看日志: $LOG" >&2
exit 1
