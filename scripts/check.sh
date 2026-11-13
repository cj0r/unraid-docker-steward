#!/bin/bash
# Pre-release checks: syntax, plg, package checksums, changelog. Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
P=src/usr/local/emhttp/plugins/docker.steward
PLG=plugin/docker.steward.plg
fail() { echo "FAIL: $*" >&2; exit 1; }

if command -v php >/dev/null; then
  for f in $(find src -name '*.php') src/usr/local/bin/*; do php -l "$f" >/dev/null || fail "php syntax: $f"; done
else echo "skip: php not installed"; fi
node --check $P/js/app.js || fail "js syntax"
python3 -c "import json,xml.dom.minidom as m; json.load(open('$P/compat.json')); m.parse('$PLG')" || fail "plg / xml / json not well-formed"

ver=$(sed -n 's/.*<!ENTITY version *"\([^"]*\)".*/\1/p' "$PLG")
md5=$(sed -n 's/.*<!ENTITY md5 *"\([^"]*\)".*/\1/p' "$PLG")
sha=$(sed -n 's/.*<!ENTITY sha256 *"\([^"]*\)".*/\1/p' "$PLG")
pkg=archive/docker.steward-$ver-noarch-1.txz
[ -f "$pkg" ] || fail "missing $pkg (run ./build.sh)"
[ "$(md5sum "$pkg" | cut -d' ' -f1)" = "$md5" ] || fail "md5 in plg does not match $pkg"
[ "$(sha256sum "$pkg" | cut -d' ' -f1)" = "$sha" ] || fail "sha256 in plg does not match $pkg"
n=$(ls archive/*.txz | wc -l); [ "$n" -ge 1 ] && [ "$n" -le 2 ] || fail "archive/ must hold the current package and at most the previous one"
grep -q "^## $ver\$" CHANGELOG.md || fail "CHANGELOG.md has no '## $ver' section"
grep -q "^###$ver\$" "$PLG" || fail "plg <CHANGES> has no '###$ver' entry"
grep -q "\"$(python3 -c "import json;print(json.load(open('$P/compat.json'))['tested'][-1])")\"" $P/compat.json || fail "compat.json tested list empty"
[ -f .dev/ca/docker-steward.xml ] && { python3 -c "import xml.dom.minidom as m; m.parse('.dev/ca/docker-steward.xml')" || fail "CA template not well-formed"; }
echo "OK: $ver"
