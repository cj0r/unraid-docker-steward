#!/bin/bash
# Build the plugin package: ./build.sh [version]   (default: version in the .plg)
# Output: archive/<name>-<version>-noarch-1.txz, and the .plg is stamped with version + md5.
set -euo pipefail
cd "$(dirname "$0")"
NAME=docker.steward
PLG=plugin/$NAME.plg
VERSION=${1:-$(sed -n 's/.*<!ENTITY version *"\([^"]*\)".*/\1/p' "$PLG")}
PKG=$NAME-$VERSION-noarch-1.txz

chmod 755 src/usr/local/bin/*
mkdir -p archive
rm -f "archive/$PKG"
if [ -f /etc/slackware-version ]; then
  (cd src && makepkg -l y -c y "../archive/$PKG" >/dev/null)
else
  # Not on Slackware/Unraid: a plain tar.xz is what installpkg unpacks anyway.
  tar -C src --owner=0 --group=0 --sort=name -cJf "archive/$PKG" .
fi
MD5=$(md5sum "archive/$PKG" | cut -d' ' -f1)
SHA=$(sha256sum "archive/$PKG" | cut -d' ' -f1)
sed -i -e "s|<!ENTITY version *\"[^\"]*\">|<!ENTITY version   \"$VERSION\">|" \
       -e "s|<!ENTITY md5 *\"[^\"]*\">|<!ENTITY md5       \"$MD5\">|" \
       -e "s|<!ENTITY sha256 *\"[^\"]*\">|<!ENTITY sha256    \"$SHA\">|" "$PLG"
echo "built archive/$PKG"; echo "md5 $MD5"
echo "tested on Unraid: $(python3 -c 'import json;print(", ".join(json.load(open("src/usr/local/emhttp/plugins/docker.steward/compat.json"))["tested"]))')"
echo "(after an Unraid upgrade run ./tests/smoke.sh <host> --record, and mention the version in the .plg CHANGES)"
