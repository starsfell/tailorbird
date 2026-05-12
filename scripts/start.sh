#!/usr/bin/env bash
# tailorbird 一键启动: 后端 + 前端 + 自动开浏览器
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
PORT_BACKEND=7891
PORT_FRONTEND=5173

PYBIN="/opt/homebrew/Caskroom/miniconda/base/envs/tailorbird/bin/python"
if [ ! -x "$PYBIN" ]; then
  echo "未找到 tailorbird conda 环境的 Python: $PYBIN" >&2
  exit 1
fi

if lsof -nP -iTCP:$PORT_BACKEND -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT_BACKEND 已被占用,可能后端已在运行。"
else
  echo "▶ 启动后端 (port $PORT_BACKEND)"
  cd "$BACKEND"
  PYTHONPATH="$BACKEND" nohup "$PYBIN" -m uvicorn app.main:app --host 127.0.0.1 --port $PORT_BACKEND \
    > "$ROOT/data/backend.log" 2>&1 &
  echo "  后端 PID: $!  日志: $ROOT/data/backend.log"
fi

cd "$FRONTEND"
if [ ! -d node_modules ]; then
  echo "▶ 首次运行: 安装前端依赖"
  npm install
fi

# 等待后端就绪
echo -n "▶ 等待后端就绪"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT_BACKEND/api/health" >/dev/null 2>&1; then
    echo " ✓"; break
  fi
  echo -n "."
  sleep 0.5
done

echo "▶ 启动前端 (port $PORT_FRONTEND)"
(sleep 2 && open "http://127.0.0.1:$PORT_FRONTEND") &
exec npm run dev
