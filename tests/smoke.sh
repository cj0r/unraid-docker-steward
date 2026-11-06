#!/bin/bash
# After an Unraid upgrade: ./tests/smoke.sh <host> [--record] [container-to-check]
#   Runs the on-server selftest over ssh (read-only). With --record and a pass, adds the running Unraid
#   version to "tested" in compat.json, ready for the next release.
set -euo pipefail
cd "$(dirname "$0")/.."
host=${1:?usage: smoke.sh <host> [--record] [container]}; shift
record=0; [ "${1:-}" = "--record" ] && { record=1; shift; }
if [ -n "${1:-}" ]; then
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || { echo "invalid container name: $1"; exit 2; }
  check="--check $1"
else check=""; fi
out=$(ssh "$host" "docker-steward-selftest $check") && rc=0 || rc=$?
echo "$out"
[ $rc -eq 0 ] || { echo "SMOKE TEST FAILED (exit $rc)"; exit $rc; }
if [ $record -eq 1 ]; then
  ver=$(echo "$out" | sed -n 's/^Unraid version : //p')
  f=src/usr/local/emhttp/plugins/docker.steward/compat.json
  python3 - "$f" "$ver" <<'PY'
import json, sys
f, v = sys.argv[1:3]
d = json.load(open(f))
if v and v != 'unknown' and v not in d['tested']:
    d['tested'].append(v); d['tested'].sort(key=lambda x: [int(p) if p.isdigit() else 0 for p in x.split('.')])
    json.dump(d, open(f, 'w'), indent=2); open(f, 'a').write('\n'); print('recorded', v)
else: print('already recorded or unknown version:', v)
PY
fi
echo "SMOKE TEST PASSED"
