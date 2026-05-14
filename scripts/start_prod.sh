#!/usr/bin/env bash
# tailorbird 生产模式:单端口 7891,前端由 FastAPI 托管。
# 若 frontend/src 比 frontend/dist 新会自动重新 build。
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=7891
PYBIN="/opt/homebrew/Caskroom/miniconda/base/envs/tailorbird/bin/python"

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
  echo "▶ 前端源码有变化,重新 build..."
  cd "$ROOT/frontend"
  [ ! -d node_modules ] && npm install
  npm run build
fi

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用,直接打开浏览器。"
  open "http://127.0.0.1:$PORT"
  exit 0
fi

(
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      open "http://127.0.0.1:$PORT"
      exit 0
    fi
    sleep 0.5
  done
) &

cd "$ROOT/backend"
exec env PYTHONPATH="$ROOT/backend" "$PYBIN" -m uvicorn app.main:app \
  --host 127.0.0.1 --port "$PORT"
