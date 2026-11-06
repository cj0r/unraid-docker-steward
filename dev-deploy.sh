#!/bin/bash
# RAM-only test copy, run ON the Unraid server from the project folder
# (gone after a reboot). Undo with: ./dev-deploy.sh --remove
set -euo pipefail
cd "$(dirname "$0")"
NAME=docker.steward
DEST=/usr/local/emhttp/plugins/$NAME
if [ "${1:-}" = "--remove" ]; then
  rm -rf "$DEST" "/tmp/$NAME" /usr/local/bin/docker-steward-check /usr/local/bin/docker-steward-selftest
  echo "removed"; exit 0
fi
rm -rf "$DEST"
mkdir -p "$DEST"
cp -a src/usr/local/emhttp/plugins/$NAME/. "$DEST/"
install -m 755 src/usr/local/bin/* /usr/local/bin/
echo "deployed; open Docker > Docker Steward"
