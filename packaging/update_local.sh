#!/usr/bin/env bash
# 原地更新已安装的 /Applications/tailorbird.app。
#
# 用 rsync 把新构建的内容覆盖进现有 bundle —— 保留同一个 bundle 路径、
# CFBundleIdentifier 和图标文件,所以 macOS 视为同一个 app:
# 不需要卸载重装,Dock 图标 / Launchpad 位置 / 图标本身都不变。
#
# 前置: 先跑 build_app.sh 生成 dist/tailorbird.app。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/dist/tailorbird.app"
DEST="/Applications/tailorbird.app"

[ -d "$SRC" ] || { echo "✗ 未找到新构建 $SRC,请先跑 packaging/build_app.sh"; exit 1; }

# 1) 退出正在运行的后端,避免覆盖正在使用的二进制。
pkill -f 'tailorbird-backend' 2>/dev/null || true
osascript -e 'tell application "tailorbird" to quit' 2>/dev/null || true
sleep 1

if [ ! -d "$DEST" ]; then
  echo "▶ 首次安装: 拷贝到 $DEST"
  ditto "$SRC" "$DEST"
else
  echo "▶ 原地更新 $DEST (保留 bundle 标识/图标/Dock 位置)"
  # 尾部斜杠 = 同步内容到现有 bundle 目录本身(目录 inode 不变);
  # --delete 清掉新版已移除的旧文件。AppIcon.icns 字节相同时不会被改写。
  rsync -a --delete "$SRC/" "$DEST/"
fi

# 2) 重新 ad-hoc 签名,保证替换后整体签名自洽。
codesign --force --sign - --timestamp=none --options runtime \
  --entitlements "$HERE/entitlements.plist" "$DEST" >/dev/null 2>&1 \
  || codesign --force --sign - "$DEST" >/dev/null 2>&1 || true

# 3) 轻量提示 Launch Services 刷新(同 bundleid+图标一般不需要,保险起见)。
touch "$DEST"

echo "✓ 已原地更新 $DEST —— 图标 / Dock 位置不变,无需重新拖入。"
