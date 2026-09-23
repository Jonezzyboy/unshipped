#!/usr/bin/env sh
# Builds a shareable DMG from the release .app.
# Tauri's bundled bundle_dmg.sh is bypassed: it relies on hdiutil -srcfolder,
# which mounts under /Volumes, and writes there fail here with EBUSY. Mounting
# at an explicit mountpoint and copying in by hand avoids /Volumes entirely.
set -e

APP_NAME="Unshipped.app"
VOL_NAME="Unshipped"
# The download keeps the lower-case token the cask and the tap are named for.
DMG_NAME="unshipped"
APP="src-tauri/target/release/bundle/macos/$APP_NAME"
OUT_DIR="src-tauri/target/release/bundle/dmg"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
DMG="$OUT_DIR/${DMG_NAME}_${VERSION}_$(uname -m).dmg"

if [ ! -d "$APP" ]; then
  echo "No bundle at $APP — run 'npm run bundle' first." >&2
  exit 1
fi

WORK=$(mktemp -d)
MNT="$WORK/mnt"
RW="$WORK/rw.dmg"
cleanup() {
  hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

SIZE_MB=$(( $(du -sm "$APP" | cut -f1) + 50 ))

hdiutil create -volname "$VOL_NAME" -size "${SIZE_MB}m" -fs HFS+ -quiet "$RW"
hdiutil attach "$RW" -mountpoint "$MNT" -nobrowse -noverify -noautoopen -quiet

ditto "$APP" "$MNT/$APP_NAME"
ln -s /Applications "$MNT/Applications"

hdiutil detach "$MNT" -quiet

mkdir -p "$OUT_DIR"
rm -f "$DMG"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" -quiet

echo "Built $DMG"
