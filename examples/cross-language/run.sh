#!/usr/bin/env bash
# Run both sides of the cross-language example against the same fixture.
#
# Uses the in-repo implementations rather than published packages, so this works
# on a fresh clone with no install step beyond the two toolchains.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

TS="$ROOT/implementations/typescript"
PY="$ROOT/implementations/python"
PY_BIN="${SPOOL_PYTHON:-python3}"

echo "==> Python (httpx)"
PYTHONPATH="$PY/src" "$PY_BIN" -m pytest test_client.py -q

echo
echo "==> Node (fetch)"
if [[ ! -f "$TS/dist/index.js" ]]; then
  echo "Building the TypeScript package first..."
  (cd "$TS" && npm ci --silent && npm run build)
fi

# Resolve `@spool/hif` to the local build without a workspace or a publish step.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/node_modules/@spool"
ln -s "$TS" "$WORK/node_modules/@spool/hif"
cp client.test.mjs "$WORK/"
mkdir -p "$WORK/fixtures"
cp fixtures/*.hif.json "$WORK/fixtures/"

(cd "$WORK" && node --test client.test.mjs)

echo
echo "Both languages replayed the same fixture."
