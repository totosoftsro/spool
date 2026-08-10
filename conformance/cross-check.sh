#!/usr/bin/env bash
# Cross-implementation parity check.
#
# The conformance suite proves each implementation agrees with the *spec*. This
# script proves the two implementations agree with *each other* on the things
# the spec deliberately leaves to the implementation — chiefly the rendered
# mismatch report, which is not normative but which a developer reads in CI logs
# and should not vary by language.
#
# It also re-checks digests and canonical output through each CLI, so a
# divergence in either shows up as a diff rather than as two green suites.
#
#   ./cross-check.sh
#
# Requires: node (with implementations/typescript built), python3.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

TS_DIST="$ROOT/implementations/typescript/dist"
PY_SRC="$ROOT/implementations/python/src"
PY_BIN="${SPOOL_PYTHON:-python3}"

if [[ ! -f "$TS_DIST/cli.js" ]]; then
  echo "The TypeScript package is not built."
  echo "Run: (cd implementations/typescript && npm ci && npm run build)"
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail=0
checked=0

ts() { node "$TS_DIST/cli.js" "$@"; }
py() { PYTHONPATH="$PY_SRC" "$PY_BIN" -m spool.cli "$@"; }

compare() {
  local label="$1" a="$2" b="$3"
  checked=$((checked + 1))
  if ! diff -u "$a" "$b" > "$WORK/diff.txt"; then
    echo "DIVERGENCE: $label"
    sed 's/^/    /' "$WORK/diff.txt" | head -40
    echo
    fail=1
  fi
}

# --- explain output -------------------------------------------------------
# Rendered reports must be byte-identical. This is the output a developer reads
# when a test fails, and "it depends which language your service is in" would
# defeat the point of a shared explanation engine.

for case_file in cases/explain/*.json; do
  name=$(basename "$case_file" .json)

  if "$PY_BIN" - "$case_file" "$WORK" <<'PYEOF'
import json, sys, pathlib
case = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
work = pathlib.Path(sys.argv[2])
(work / "fixture.hif.json").write_text(json.dumps(case["fixture"]), encoding="utf-8")
(work / "request.json").write_text(json.dumps(case["live"]), encoding="utf-8")
# A case with pre-consumed plays cannot be reproduced through the CLI, which
# always starts from a fresh player; skip those rather than compare something
# different in each language.
sys.exit(3 if case.get("plays") else 0)
PYEOF
  then status=0; else status=$?; fi
  # Exit code 3 is the skip signal from the helper above, not a failure.
  if [[ $status -eq 3 ]]; then
    continue
  elif [[ $status -ne 0 ]]; then
    echo "helper failed for $case_file (exit $status)"
    fail=1
    continue
  fi

  set +e
  ts explain "$WORK/fixture.hif.json" "$WORK/request.json" --all > "$WORK/ts.txt" 2>&1
  py explain "$WORK/fixture.hif.json" "$WORK/request.json" --all > "$WORK/py.txt" 2>&1
  set -e
  compare "explain/$name rendered report" "$WORK/ts.txt" "$WORK/py.txt"
done

# --- digest, inspect and lint ---------------------------------------------

for case_file in cases/digest/*.json; do
  name=$(basename "$case_file" .json)
  "$PY_BIN" - "$case_file" "$WORK" <<'PYEOF'
import json, sys, pathlib
case = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
fixture = {
    "hif": "1.0",
    "interactions": [{"request": case["request"], "response": {"status": 200}}],
}
(pathlib.Path(sys.argv[2]) / "fixture.hif.json").write_text(json.dumps(fixture), encoding="utf-8")
PYEOF
  ts digest "$WORK/fixture.hif.json" > "$WORK/ts.txt"
  py digest "$WORK/fixture.hif.json" > "$WORK/py.txt"
  compare "digest/$name" "$WORK/ts.txt" "$WORK/py.txt"
done

# --- redaction ------------------------------------------------------------
# `spool redact` rewrites a whole fixture; the serialized output must be
# byte-identical, which also pins member ordering and indentation.

for case_file in cases/redact/*.json; do
  name=$(basename "$case_file" .json)
  if "$PY_BIN" - "$case_file" "$WORK" <<'PYEOF'
import json, sys, pathlib
case = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if case["kind"] != "redact":
    sys.exit(3)
(pathlib.Path(sys.argv[2]) / "fixture.hif.json").write_text(
    json.dumps(case["fixture"]), encoding="utf-8"
)
PYEOF
  then status=0; else status=$?; fi
  # Exit code 3 is the skip signal for non-redact cases in this directory.
  [[ $status -eq 3 ]] && continue

  ts redact "$WORK/fixture.hif.json" -o "$WORK/ts.json" 2> /dev/null
  py redact "$WORK/fixture.hif.json" -o "$WORK/py.json" 2> /dev/null
  compare "redact/$name serialized output" "$WORK/ts.json" "$WORK/py.json"
done

# --- lint output ------------------------------------------------------------
# Warning text is user-facing and must be identical. This section exists because
# a spec-section citation was once rendered "§6.1" in one implementation and
# "section 6.1" in the other, which nothing else would have caught.

for case_file in cases/structural/*.json cases/version/*.json; do
  name=$(basename "$case_file" .json)
  if "$PY_BIN" - "$case_file" "$WORK" <<'PYEOF'
import json, sys, pathlib
case = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
(pathlib.Path(sys.argv[2]) / "fixture.hif.json").write_text(
    json.dumps(case["document"]), encoding="utf-8"
)
PYEOF
  then :; else echo "helper failed for $case_file"; fail=1; continue; fi

  set +e
  ts lint "$WORK/fixture.hif.json" > "$WORK/ts.txt" 2>&1
  py lint "$WORK/fixture.hif.json" > "$WORK/py.txt" 2>&1
  set -e
  # Paths appear in the output; both read the same file, so no normalisation is
  # needed beyond stripping the temporary directory.
  compare "lint/$name output" "$WORK/ts.txt" "$WORK/py.txt"
done

# --- HAR import ---------------------------------------------------------------
# The converted fixture must be byte-identical apart from the recorder name,
# which each implementation is supposed to set to itself.

if [[ -f fixtures/sample.har ]]; then
  ts import har fixtures/sample.har -o "$WORK/ts.json" 2> "$WORK/ts.log"
  py import har fixtures/sample.har -o "$WORK/py.json" 2> "$WORK/py.log"
  sed 's/spool-typescript/spool-IMPL/' "$WORK/ts.json" > "$WORK/ts.norm"
  sed 's/spool-python/spool-IMPL/' "$WORK/py.json" > "$WORK/py.norm"
  compare "import har converted fixture" "$WORK/ts.norm" "$WORK/py.norm"

  sed 's/spool-typescript/spool-IMPL/' "$WORK/ts.log" > "$WORK/ts.lognorm"
  sed 's/spool-python/spool-IMPL/' "$WORK/py.log" > "$WORK/py.lognorm"
  compare "import har report" "$WORK/ts.lognorm" "$WORK/py.lognorm"
fi

# --- serve ---------------------------------------------------------------------
# Both servers must answer the same request identically, including the 551
# mismatch body. This is the surface that languages without an adapter use, so a
# divergence here is a divergence for every one of them.

serve_probe() {
  local impl="$1" port="$2" out="$3"
  if [[ "$impl" == "ts" ]]; then
    node "$TS_DIST/cli.js" serve fixtures/serve.hif.json --port "$port" > /dev/null 2>&1 &
  else
    PYTHONPATH="$PY_SRC" "$PY_BIN" -m spool.cli serve fixtures/serve.hif.json --port "$port" \
      > /dev/null 2>&1 &
  fi
  local pid=$!
  # Poll a path the fixture does not contain: any HTTP answer means the server
  # is up, and unlike a recorded path it consumes no play count. Probing with a
  # recorded request would deplete it before the real comparison runs.
  for _ in $(seq 1 100); do
    if curl -sS -o /dev/null "http://127.0.0.1:$port/__spool_ready__" 2>/dev/null; then break; fi
    sleep 0.1
  done
  {
    echo "--- matched"
    # Header names are case-insensitive in HTTP and the two servers capitalise
    # differently; the comparison is about values, so names are lowercased.
    # BSD awk is used rather than sed, which has no portable \L.
    curl -sS -D - "http://127.0.0.1:$port/v1/users/7" \
      | awk '{ if (match($0, /^[A-Za-z-]+:/)) print tolower(substr($0,1,RLENGTH)) substr($0,RLENGTH+1); else print }' \
      | grep -viE '^(date|connection|keep-alive|server|content-length):'
    echo "--- unmatched"
    curl -sS -o - -w '\nstatus=%{http_code}\n' "http://127.0.0.1:$port/v1/nope"
  } > "$out" 2>&1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

if [[ -f fixtures/serve.hif.json ]] && command -v curl > /dev/null; then
  serve_probe ts 18081 "$WORK/ts.txt"
  serve_probe py 18082 "$WORK/py.txt"
  compare "serve responses" "$WORK/ts.txt" "$WORK/py.txt"
fi

# --- CLI surface ----------------------------------------------------------
# The two CLIs must offer the same commands. Comparing the Usage block catches
# a command added to one implementation and not the other.

ts --help | sed -n '/^Usage:/,/^Options:/p' > "$WORK/ts.txt"
py --help | sed -n '/^Usage:/,/^Options:/p' > "$WORK/py.txt"
compare "CLI command surface" "$WORK/ts.txt" "$WORK/py.txt"

echo
if [[ $fail -eq 0 ]]; then
  echo "ok: $checked comparison(s), the two implementations agree"
else
  echo "The implementations disagree. Either one has a bug, or the specification"
  echo "is ambiguous where they diverged — both are worth a conformance case."
  exit 1
fi
