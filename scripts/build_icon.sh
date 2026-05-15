#!/usr/bin/env bash
# 从 assets/AppIcon.svg 生成 tailorbird.app 的 .icns。
# 关键点:qlmanage 会把 SVG 透明区域填白,所以渲染完用 PIL 加 alpha mask
# 抠出 824×824(rx=185)的 tile 区域,其它做透明。规范见 Apple macOS icon grid。
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets/AppIcon.svg"
APP="$ROOT/tailorbird.app"
PYBIN="/opt/homebrew/Caskroom/miniconda/base/envs/tailorbird/bin/python"
WORK="/tmp/tailorbird_icon"

[ -f "$SRC" ] || { echo "找不到 $SRC" >&2; exit 1; }
[ -x "$PYBIN" ] || { echo "找不到 tailorbird Python: $PYBIN" >&2; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK/AppIcon.iconset"

echo "▶ qlmanage 渲染 1024×1024..."
qlmanage -t -s 1024 -o "$WORK" "$SRC" >/dev/null 2>&1
RAW="$WORK/$(basename "$SRC").png"
[ -f "$RAW" ] || { echo "qlmanage 渲染失败" >&2; exit 1; }

echo "▶ PIL 加 alpha mask(扣掉 tile 外的白边)..."
"$PYBIN" - "$RAW" "$WORK/icon_1024.png" <<'PY'
import sys
from PIL import Image, ImageDraw
src_path, out_path = sys.argv[1], sys.argv[2]
W, TILE, RX = 1024, 824, 185
PAD = (W - TILE) // 2  # 100
img = Image.open(src_path).convert("RGBA")
if img.size != (W, W):
    img = img.resize((W, W), Image.LANCZOS)
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    (PAD, PAD, PAD + TILE - 1, PAD + TILE - 1),
    radius=RX, fill=255,
)
img.putalpha(mask)
img.save(out_path)
PY

echo "▶ sips 生成所有尺寸..."
gen() {
  sips -z "$2" "$2" "$WORK/icon_1024.png" --out "$WORK/AppIcon.iconset/$1" >/dev/null
}
gen icon_16x16.png       16
gen icon_16x16@2x.png    32
gen icon_32x32.png       32
gen icon_32x32@2x.png    64
gen icon_128x128.png     128
gen icon_128x128@2x.png  256
gen icon_256x256.png     256
gen icon_256x256@2x.png  512
gen icon_512x512.png     512
gen icon_512x512@2x.png  1024

echo "▶ iconutil 打包 .icns..."
iconutil -c icns "$WORK/AppIcon.iconset" -o "$WORK/AppIcon.icns"

install_icon() {
  local target="$1"
  [ -d "$target" ] || return 0
  echo "▶ 安装到 $target/Contents/Resources/AppIcon.icns"
  cp "$WORK/AppIcon.icns" "$target/Contents/Resources/AppIcon.icns"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target"
}

install_icon "$APP"
install_icon "/Applications/tailorbird.app"

echo "▶ 清 icon cache + 重启 Dock/Finder"
# 用户级 icon 缓存清掉,iconservicesd 重启时会重建
rm -rf "$HOME/Library/Caches/com.apple.iconservices.store" 2>/dev/null || true
killall iconservicesd 2>/dev/null || true
killall Dock Finder 2>/dev/null || true

echo "✓ 完成。"
