#!/usr/bin/env sh
# Copies the release bundle into /Applications and launches it.
set -e

APP_NAME="unshipped.app"
SRC="src-tauri/target/release/bundle/macos/$APP_NAME"
DEST="/Applications/$APP_NAME"

if [ ! -d "$SRC" ]; then
  echo "No bundle at $SRC — run 'npm run bundle' first." >&2
  exit 1
fi

rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "Installed $DEST"
open "$DEST"
