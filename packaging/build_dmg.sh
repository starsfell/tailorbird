#!/usr/bin/env bash
# Wrap dist/tailorbird.app into a DMG with an Applications shortcut so the
# recipient can drag-install. Uses macOS-native hdiutil; no brew dep.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

APP="$ROOT/dist/tailorbird.app"
[ -d "$APP" ] || { echo "✗ $APP not found, run build_app.sh first"; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" \
            "$APP/Contents/Info.plist" 2>/dev/null || echo 0.1.0)"
DMG="$ROOT/dist/tailorbird-${VERSION}.dmg"
STAGING="$ROOT/dist/dmg-staging"

rm -rf "$STAGING" "$DMG"
mkdir -p "$STAGING"

cp -R "$APP" "$STAGING/tailorbird.app"
ln -s /Applications "$STAGING/Applications"

# create_dmg with hdiutil. UDZO = compressed read-only.
hdiutil create \
  -volname "tailorbird ${VERSION}" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG"

rm -rf "$STAGING"

# Ad-hoc sign the DMG too so Gatekeeper sees something on first open.
codesign --force --sign - "$DMG"

ls -lh "$DMG"
echo "✓ $DMG"
