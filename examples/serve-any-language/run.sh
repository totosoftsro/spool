#!/usr/bin/env bash
# Replay a HIF fixture from a client that knows nothing about Spool.
#
# The "client" here is curl, chosen because it is the least Spool-aware HTTP
# client imaginable. Anything that can set a base URL — Go, Rust, Java, a shell
# script, a container — works the same way.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
TS="$ROOT/implementations/typescript"

if [[ ! -f "$TS/dist/cli.js" ]]; then
  echo "Building the TypeScript package first..."
  (cd "$TS" && npm ci --silent && npm run build)
fi

PORT=${PORT:-18099}

node "$TS/dist/cli.js" serve api.hif.json --port "$PORT" 2> serve.log &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; rm -f serve.log' EXIT

# Wait for the port. Probing an unrecorded path avoids consuming a play count.
for _ in $(seq 1 100); do
  curl -sS -o /dev/null "http://127.0.0.1:$PORT/__ready__" 2>/dev/null && break
  sleep 0.1
done

BASE="http://127.0.0.1:$PORT"
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label: expected [$expected], got [$actual]"
    fail=1
  fi
}

echo "Replaying api.hif.json through curl at $BASE"

check "GET returns the recorded body" \
  '{"id":7,"name":"Ada"}' \
  "$(curl -sS "$BASE/v1/users/7")"

check "GET returns the recorded content type" \
  'application/json' \
  "$(curl -sS -o /dev/null -w '%{content_type}' "$BASE/v1/users/7")"

check "POST is matched by its body" \
  '201' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' -d '{"name":"Grace"}' "$BASE/v1/users")"

check "a POST with the wrong body does not match" \
  '551' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' -d '{"name":"Nobody"}' "$BASE/v1/users")"

check "binary bodies survive byte for byte" \
  '89504e470d0a1a0a' \
  "$(curl -sS "$BASE/v1/logo.png" | od -An -tx1 | tr -d ' \n')"

check "an unrecorded request answers 551" \
  '551' \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/nope")"

check "the 551 body carries the explanation" \
  'REQUEST MISMATCH' \
  "$(curl -sS "$BASE/v1/nope" | head -1)"

echo
if [[ $fail -eq 0 ]]; then
  echo "All checks passed using nothing but curl."
else
  echo "Some checks failed."
  exit 1
fi
