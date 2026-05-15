#!/usr/bin/env bash
# 停止 tailorbird 后端(7891)。
# 配合 start_prod.sh 的 detach 模型使用 —— .app 已经不再持有 uvicorn,
# Dock 上点 Quit 没用,要退服务跑这个。
set -e

PORT=7891
PIDS=$(lsof -ti :$PORT -sTCP:LISTEN 2>/dev/null || true)

if [ -z "$PIDS" ]; then
  echo "tailorbird 后端没在跑(端口 $PORT 空闲)"
  exit 0
fi

echo "kill: $PIDS"
kill $PIDS 2>/dev/null || true
sleep 1

STILL=$(lsof -ti :$PORT -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$STILL" ]; then
  echo "强杀: $STILL"
  kill -9 $STILL 2>/dev/null || true
fi

echo "done"
