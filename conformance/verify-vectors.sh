#!/usr/bin/env bash
# Re-derive the digest and base64 conformance vectors using openssl.
#
# The point of this script is independence: the expected SHA-256 in every
# digest case is produced by openssl, not by any HIF implementation. If someone
# "fixes" a failing conformance case by pasting in whatever their code printed,
# this script fails and says so.
#
#   ./verify-vectors.sh          check the committed vectors
#   ./verify-vectors.sh --write  recompute and write them
#
# Requires: openssl, python3 (for JSON field access only, not for hashing).

set -euo pipefail

cd "$(dirname "$0")"

WRITE=0
[[ "${1:-}" == "--write" ]] && WRITE=1

fail=0
checked=0

for file in cases/digest/*.json; do
  preimage=$(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f)["preimage"], end="")
' "$file")

  expected=$(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f).get("digest") or "", end="")
' "$file")

  # The hash comes from openssl. Nothing in this pipeline touches HIF code.
  actual=$(printf '%s' "$preimage" | openssl dgst -sha256 -r | cut -d' ' -f1)

  if [[ $WRITE -eq 1 ]]; then
    python3 -c '
import json, sys
path, digest = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    doc = json.load(f)
doc["digest"] = digest
with open(path, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
' "$file" "$actual"
    echo "wrote  $file  $actual"
  elif [[ "$expected" != "$actual" ]]; then
    echo "MISMATCH $file"
    echo "  pre-image: $preimage"
    echo "  committed: ${expected:-<none>}"
    echo "  openssl:   $actual"
    fail=1
  fi
  checked=$((checked + 1))
done

# Base64 vectors used across the suite, checked against the base64 CLI.
check_b64() {
  local text="$1" expected="$2"
  local actual
  actual=$(printf '%s' "$text" | openssl base64 -A)
  if [[ "$actual" != "$expected" ]]; then
    echo "MISMATCH base64 of '$text': expected $expected, openssl says $actual"
    fail=1
  fi
  checked=$((checked + 1))
}

check_b64 "hello" "aGVsbG8="
check_b64 "" ""
check_b64 "a" "YQ=="
check_b64 "ab" "YWI="
check_b64 "abc" "YWJj"

# 0xDEADBEEF, used as the binary body throughout the suite.
deadbeef=$(printf '\xde\xad\xbe\xef' | openssl base64 -A)
if [[ "$deadbeef" != "3q2+7w==" ]]; then
  echo "MISMATCH base64 of 0xDEADBEEF: expected 3q2+7w==, openssl says $deadbeef"
  fail=1
fi
checked=$((checked + 1))

# The PNG signature prefix used in the examples.
png=$(printf '\x89\x50\x4e\x47\x0d\x0a\x1a\x0a' | openssl base64 -A)
if [[ "$png" != "iVBORw0KGgo=" ]]; then
  echo "MISMATCH base64 of the PNG signature: expected iVBORw0KGgo=, openssl says $png"
  fail=1
fi
checked=$((checked + 1))

if [[ $fail -eq 0 ]]; then
  echo "ok: $checked vector(s) verified against openssl"
else
  echo
  echo "A mismatch here means either the pre-image construction in spec §14 changed,"
  echo "or an expected value was pasted in from an implementation instead of derived."
  exit 1
fi
