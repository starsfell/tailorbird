#!/usr/bin/env bash
# Assemble a self-contained tailorbird.app from PyInstaller output + frontend
# dist + model weights + icon + launcher script. Ad-hoc codesigns the result.
#
# Run from anywhere; paths resolve from this script's location.
# Prereq: PyInstaller has already produced dist/tailorbird-backend/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

BACKEND_BUILD="$ROOT/dist/tailorbird-backend"
FRONTEND_DIST="$ROOT/frontend/dist"
MODELS_SRC="$ROOT/data/models"
ICON_SRC="$ROOT/assets/AppIcon.icns"

APP="$ROOT/dist/tailorbird.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

# --- Sanity checks ---
[ -d "$BACKEND_BUILD" ] || { echo "✗ PyInstaller output missing: $BACKEND_BUILD"; exit 1; }
[ -d "$FRONTEND_DIST" ] || { echo "✗ frontend dist missing: $FRONTEND_DIST"; exit 1; }
[ -d "$MODELS_SRC" ]    || { echo "✗ models dir missing: $MODELS_SRC"; exit 1; }
[ -f "$ICON_SRC" ]      || { echo "✗ icon missing: $ICON_SRC"; exit 1; }

# Models we expect to find. Bail if any is missing.
for m in yolo11l-seg.pt cub200_keypoint_resnet50_slim.pth \
         cfanet_iaa_ava_res50-3cd62bb3.pth superFlier_efficientnet.pth; do
  [ -f "$MODELS_SRC/$m" ] || { echo "✗ missing model: $m"; exit 1; }
done

echo "▶ assembling $APP"
rm -rf "$APP"
mkdir -p "$MACOS" "$RES"

# --- Backend binary tree ---
# Lives under Resources/ because Contents/MacOS/ is meant for Mach-O executables
# only; codesign rejects .dist-info dirs and other non-bundle structure under
# MacOS/, even without --deep.
cp -R "$BACKEND_BUILD" "$RES/backend"

# --- Launcher shell script (Info.plist's CFBundleExecutable) ---
cp "$HERE/launcher.sh" "$MACOS/tailorbird"
chmod +x "$MACOS/tailorbird"

# --- Info.plist ---
cp "$HERE/Info.plist" "$CONTENTS/Info.plist"

# --- Resources: icon, frontend, models ---
cp "$ICON_SRC" "$RES/AppIcon.icns"
cp -R "$FRONTEND_DIST" "$RES/frontend_dist"
mkdir -p "$RES/models"
cp "$MODELS_SRC/"*.pt "$MODELS_SRC/"*.pth "$RES/models/"

# --- Ad-hoc codesign every binary, deep + entitlements ---
# Order matters: sign nested binaries first, then the .app last.
echo "▶ ad-hoc codesign"

ENT="$HERE/entitlements.plist"

# Sign every Mach-O inside (PyInstaller dumps a lot of .dylib/.so).
# `find` + `file` filters to actual binaries; codesign on text files would
# fail and stop the script.
# Sign every Mach-O binary inside the backend tree. We can't rely on
# extension alone (.so files come from many packages, some are universal
# binaries with arch slices, some PyInstaller-stripped). `file` filters to
# real Mach-O. Skip --deep / .dist-info / shell scripts.
signed=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    codesign --force --sign - --timestamp=none \
      --options runtime --entitlements "$ENT" \
      "$f" >/dev/null 2>&1 || true
    signed=$((signed + 1))
  fi
done < <(find "$RES/backend" -type f -print0)
echo "  signed $signed Mach-O files in backend tree"

# Sign the backend entry binary explicitly (overrides anything from the loop).
codesign --force --sign - --timestamp=none \
  --options runtime --entitlements "$ENT" \
  "$RES/backend/tailorbird-backend"

# Seal the .app — no --deep (we already walked everything ourselves; --deep
# trips over .dist-info dirs and the shell launcher).
codesign --force --sign - --timestamp=none \
  --options runtime --entitlements "$ENT" \
  "$APP"

echo "▶ verifying"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -5 || true

du -sh "$APP"
echo "✓ built $APP"
