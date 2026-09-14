#!/usr/bin/env sh
# Sets the app version across every manifest that carries one. The release
# workflow refuses to build when these disagree with the tag.
set -e

VERSION="$1"
if [ -z "$VERSION" ]; then
  echo "usage: scripts/set-version.sh <version>   e.g. 0.2.0" >&2
  exit 1
fi
case "$VERSION" in
  v*) echo "Pass the bare version, without the leading 'v'." >&2; exit 1 ;;
esac

npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

node -e '
  const fs = require("fs");
  const [file, version] = [process.argv[1], process.argv[2]];
  const conf = JSON.parse(fs.readFileSync(file, "utf8"));
  conf.version = version;
  fs.writeFileSync(file, JSON.stringify(conf, null, 2) + "\n");
' src-tauri/tauri.conf.json "$VERSION"

# Only the [package] version, which is the first `version =` in the file.
awk -v v="$VERSION" '
  !done && /^version = / { sub(/"[^"]*"/, "\"" v "\""); done = 1 }
  { print }
' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp
mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml

(cd src-tauri && cargo update --offline --package unshipped >/dev/null 2>&1) || true

echo "Set version $VERSION. Commit, then cut the release (in unshipped, or: gh release create v$VERSION --generate-notes)."
