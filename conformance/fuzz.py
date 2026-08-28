#!/usr/bin/env python3
"""Differential fuzzer: run adversarial inputs through both implementations and diff.

The conformance suite proves each implementation agrees with the *specification*.
`cross-check.sh` proves the two agree with each other on a fixed set of outputs.
This tool attacks the seams neither covers: awkward fixtures nobody thought to
write a case for, and the failure paths — malformed input, protocol edge cases,
and whether a server survives a request it cannot answer.

It is the tool that found, in its first runs:

  * a port above 65535 loading in one implementation and failing in the other;
  * a 204 response carrying a body in one implementation and not the other;
  * a reason phrase differing for an unregistered status code;
  * a fixture that terminated the whole `spool serve` process.

Two modes, both deterministic:

  corpus     A hand-written set of adversarial inputs. Runs by default.
  generated  Fixtures assembled from values that have historically been where
             implementations disagree, using a seeded PRNG. The seed is fixed
             unless given, so a failure is always reproducible and CI never
             flakes.

Usage:

    python3 conformance/fuzz.py                    # corpus only, quick
    python3 conformance/fuzz.py --generated 200    # plus 200 seeded fixtures
    python3 conformance/fuzz.py --seed 12345       # reproduce a specific run
    python3 conformance/fuzz.py --skip-servers     # no sockets, CLI only

Exit code 0 when the implementations agree, 1 when they do not.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import random
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
TS_CLI = ROOT / "implementations" / "typescript" / "dist" / "cli.js"
PY_SRC = ROOT / "implementations" / "python" / "src"

# Characters that are named rather than embedded, so this file stays readable and
# survives copy-paste through tools that mangle control characters.
CR, LF, NUL, HTAB = "\r", "\n", "\x00", "\t"
BOM = "﻿"
REPLACEMENT = "�"
NBSP = " "
LINE_SEP, PARA_SEP = " ", " "


# ---------------------------------------------------------------------------
# Known intentional divergences
# ---------------------------------------------------------------------------

#: Differences that are deliberate, each with the reason. Anything not listed
#: here is a bug — that is the project's rule, and this is the only exemption
#: list. Adding to it needs a reason a reviewer would accept.
KNOWN_DIVERGENCES: List[Tuple[str, Callable[[str, str], bool]]] = [
    (
        "the host JSON parser's message for malformed JSON. Normalising it would mean "
        "writing our own parser, and the host message is more useful to somebody fixing "
        "a broken fixture. See conformance/README.md.",
        lambda ts, py: "is not valid JSON" in ts and "is not valid JSON" in py,
    ),
]


def is_known(ts_text: str, py_text: str) -> Optional[str]:
    for reason, predicate in KNOWN_DIVERGENCES:
        if predicate(ts_text, py_text):
            return reason
    return None


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------


def req(**overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {"method": "GET", "url": "https://api.test/a"}
    base.update(overrides)
    return base


def fx(interactions: List[Dict[str, Any]], **top: Any) -> Dict[str, Any]:
    doc: Dict[str, Any] = {"hif": "1.0", "interactions": interactions}
    doc.update(top)
    return doc


def ok(request: Optional[Dict[str, Any]] = None, **extra: Any) -> Dict[str, Any]:
    return {"request": request or req(), "response": {"status": 200}, **extra}


def corpus() -> Dict[str, str]:
    """Adversarial fixtures, as raw JSON text keyed by name.

    Grouped by what they attack. New entries are welcome: a case that makes the
    implementations disagree is the most valuable contribution to this project.
    """
    cases: Dict[str, Any] = {
        # --- Unicode and encoding --------------------------------------------
        "unicode-idn-host": fx([ok(req(url="https://bücher.test/a"))]),
        "unicode-path": fx([ok(req(url="https://x.test/é中"))]),
        "unicode-header-value": fx([ok(req(headers=[["x-note", "é中\U0001f600"]]))]),
        "unicode-body": fx([ok(req(body={"encoding": "json", "json": {"s": "\U0001f600"}}))]),
        "astral-key-order": fx([
            ok(req(body={"encoding": "json", "json": {"\U0001f600": 1, REPLACEMENT: 2}}))
        ]),
        "combining-vs-precomposed": fx([
            ok(req(body={"encoding": "json", "json": {"é": 1, "é": 2}}))
        ]),
        "htab-in-header": fx([ok(req(headers=[["x-a", "a" + HTAB + "b"]]))]),
        "nbsp-and-separators": fx([ok(req(headers=[["x-a", NBSP + LINE_SEP + PARA_SEP]]))]),

        # --- URLs --------------------------------------------------------------
        "url-userinfo": fx([ok(req(url="https://user:pass@x.test/a"))]),
        "url-ipv6": fx([ok(req(url="https://[::1]:8443/a"))]),
        "url-ipv6-default-port": fx([ok(req(url="https://[::1]/a"))]),
        "url-empty-query": fx([ok(req(url="https://x.test/a?"))]),
        "url-no-path": fx([ok(req(url="https://x.test"))]),
        "url-double-slash-path": fx([ok(req(url="https://x.test//a//b"))]),
        "url-dot-segments-above-root": fx([ok(req(url="https://x.test/../../etc/passwd"))]),
        "url-encoded-dot-segments": fx([ok(req(url="https://x.test/%2e%2e/%2e%2e/x"))]),
        "url-encoded-slash": fx([ok(req(url="https://x.test/a%2Fb"))]),
        "url-uppercase-scheme": fx([ok(req(url="HTTPS://X.TEST/A"))]),
        "url-port-max": fx([ok(req(url="https://x.test:65535/a"))]),
        "url-port-above-max": fx([ok(req(url="https://x.test:99999/a"))]),
        "url-port-zero": fx([ok(req(url="https://x.test:0/a"))]),
        "url-port-default-explicit": fx([ok(req(url="https://x.test:443/a"))]),
        "url-trailing-dot-host": fx([ok(req(url="https://x.test./a"))]),
        "url-plus-in-query": fx([ok(req(url="https://x.test/a?q=a+b"))]),
        "url-semicolon-query": fx([ok(req(url="https://x.test/a?a=1;b=2"))]),
        "url-repeated-query-key": fx([ok(req(url="https://x.test/a?k=1&k=2&k=1"))]),
        "url-valueless-query": fx([ok(req(url="https://x.test/a?flag&other="))]),
        "url-fragment": fx([ok(req(url="https://x.test/a#frag"))]),
        "url-percent-not-a-triplet": fx([ok(req(url="https://x.test/100%25/a%zz"))]),

        # --- Headers -----------------------------------------------------------
        "header-duplicates": fx([ok(req(headers=[["x", "1"], ["x", "2"], ["X", "3"]]))]),
        "header-empty-value": fx([ok(req(headers=[["x", ""]]))]),
        "header-ows": fx([ok(req(headers=[["x", "  v  "]]))]),
        "header-binary-value": fx([ok(req(headers=[["x", None, "/w=="]]))]),
        "header-large-value": fx([ok(req(headers=[["x", "v" * 20000]]))]),
        "header-many": fx([ok(req(headers=[["x-" + str(n), str(n)] for n in range(300)]))]),
        "header-token-punctuation": fx([ok(req(headers=[["x-a_b.c!#$%&'*+^`|~1", "v"]]))]),
        "header-name-with-space": fx([ok(req(headers=[["x bad", "v"]]))]),
        "header-value-cr": fx([ok(req(headers=[["x-a", "v" + CR + "evil: 1"]]))]),
        "header-value-lf": fx([ok(req(headers=[["x-a", "v" + LF + "evil: 1"]]))]),
        "header-value-nul": fx([ok(req(headers=[["x-a", "a" + NUL + "b"]]))]),

        # --- Status and response ------------------------------------------------
        "status-100": fx([{"request": req(), "response": {"status": 100}}]),
        "status-204-with-body": fx([
            {"request": req(), "response": {"status": 204, "body": {"encoding": "text", "text": "x"}}}
        ]),
        "status-304-with-body": fx([
            {"request": req(), "response": {"status": 304, "body": {"encoding": "text", "text": "x"}}}
        ]),
        "status-599": fx([{"request": req(), "response": {"status": 599}}]),
        "status-below-range": fx([{"request": req(), "response": {"status": 99}}]),
        "status-above-range": fx([{"request": req(), "response": {"status": 600}}]),
        "reason-phrase-cr": fx([
            {"request": req(), "response": {"status": 200, "statusText": "OK" + CR + "evil: 1"}}
        ]),

        # --- Bodies ---------------------------------------------------------------
        "body-empty-explicit": fx([ok(req(body={"encoding": "empty"}))]),
        "body-base64-padding": fx([ok(req(body={"encoding": "base64", "base64": "YQ=="}))]),
        "body-base64-invalid": fx([ok(req(body={"encoding": "base64", "base64": "!!!"}))]),
        "body-base64-whitespace": fx([ok(req(body={"encoding": "base64", "base64": "3q2+ 7w=="}))]),
        "body-json-deep": fx([
            ok(req(body={"encoding": "json", "json": json.loads("[" * 40 + "]" * 40)}))
        ]),
        "body-json-bignum": fx([ok(req(body={"encoding": "json", "json": {"id": 9007199254740993}}))]),
        "body-json-negative-zero": fx([ok(req(body={"encoding": "json", "json": {"z": -0.0}}))]),
        "body-json-exponents": fx([
            ok(req(body={"encoding": "json", "json": {"a": 1e21, "b": 1e20, "c": 1e-7}}))
        ]),
        "body-text-nul": fx([ok(req(body={"encoding": "text", "text": "a" + NUL + "b"}))]),

        # --- Placeholders ------------------------------------------------------------
        "placeholder-escaped": fx([ok(req(body={"encoding": "json", "json": {"v": "\\{{any}}"}}))]),
        "placeholder-unknown": fx([ok(req(body={"encoding": "json", "json": {"v": "{{nope}}"}}))]),
        "placeholder-regex-counted": fx([
            ok(req(body={"encoding": "json", "json": {"v": "{{regex:a{2,3}}}"}}))
        ]),
        "placeholder-regex-quantified-group": fx([
            ok(req(body={"encoding": "json", "json": {"v": "{{regex:(a+)+b}}"}}))
        ]),
        "placeholder-regex-lookahead": fx([
            ok(req(body={"encoding": "json", "json": {"v": "{{regex:a(?=b)}}"}}))
        ]),
        "placeholder-in-query": fx([ok(req(url="https://x.test/a?n=%7B%7Bany%7D%7D"))]),

        # --- Structure -----------------------------------------------------------------
        "empty-interactions": fx([]),
        "unknown-top-member": fx([ok()], somethingElse={"a": 1}),
        "unknown-match-member": fx([
            {"request": req(), "response": {"status": 200}, "match": {"quary": {}}}
        ]),
        "times-unlimited": fx([
            {"request": req(), "response": {"status": 200}, "replay": {"times": "unlimited"}}
        ]),
        "times-zero": fx([{"request": req(), "response": {"status": 200}, "replay": {"times": 0}}]),
        "expect-object-form": fx([
            {"request": req(), "response": {"status": 200}, "expect": {"called": {"times": 3}}}
        ]),
        "fault-and-response": fx([
            {"request": req(), "response": {"status": 200}, "fault": {"type": "timeout"}}
        ]),
        "partial-response-fault": fx([
            {"request": req(), "response": {"status": 200}, "fault": {"type": "partial-response"}}
        ]),
        "fault-unknown-type": fx([{"request": req(), "fault": {"type": "meteor-strike"}}]),
        "duplicate-ids": fx([
            {"id": "a", "request": req(), "response": {"status": 200}},
            {"id": "a", "request": req(), "response": {"status": 200}},
        ]),
        "id-with-space": fx([{"id": "has space", "request": req(), "response": {"status": 200}}]),
        "forward-minor-version": {"hif": "1.9", "interactions": [ok()], "futureMember": True},
        "major-version-ahead": {"hif": "2.0", "interactions": []},
        "malformed-version": {"hif": "1", "interactions": []},
        "json-path-no-slash": fx([
            {"request": req(), "response": {"status": 200},
             "match": {"body": {"json": {"ignore": ["nope"]}}}}
        ]),
        "json-path-bad-escape": fx([
            {"request": req(), "response": {"status": 200},
             "match": {"body": {"json": {"ignore": ["/a~9b"]}}}}
        ]),
        "annotations-arbitrary": fx([
            {"request": req(), "response": {"status": 200}, "annotations": {"x": [1, {"y": None}]}}
        ]),
        "lowercase-method": fx([{"request": req(method="get"), "response": {"status": 200}}]),
        "extension-method": fx([{"request": req(method="PROPFIND"), "response": {"status": 200}}]),
    }

    text = {name: json.dumps(value, ensure_ascii=False) for name, value in cases.items()}

    # Inputs only expressible as raw text.
    text["raw-duplicate-json-keys"] = (
        '{"hif":"1.0","hif":"1.0","interactions":[{"request":{"method":"GET",'
        '"url":"https://x.test/a"},"response":{"status":200}}]}'
    )
    text["raw-bom-prefixed"] = BOM + text["empty-interactions"]
    text["raw-trailing-whitespace"] = text["empty-interactions"] + "\n\n\n"
    text["raw-not-json"] = "{ this is not json"
    text["raw-array-root"] = "[]"
    text["raw-null-root"] = "null"
    text["raw-empty-file"] = ""
    text["raw-deep-nesting"] = (
        '{"hif":"1.0","interactions":[{"request":{"method":"GET","url":"https://x.test/a",'
        '"body":{"encoding":"json","json":' + "[" * 200 + "]" * 200 + '}},"response":{"status":200}}]}'
    )
    return text


# ---------------------------------------------------------------------------
# Seeded generation
# ---------------------------------------------------------------------------

#: Values that have historically been where implementations disagree. Generation
#: samples from these rather than from random bytes: random bytes almost never
#: reach an interesting branch, whereas these do.
INTERESTING_STRINGS = [
    "", " ", HTAB, CR, LF, NUL, BOM, REPLACEMENT, NBSP, LINE_SEP,
    "\U0001f600", "é", "中", "a" * 5000,
    "{{any}}", "\\{{any}}", "{{regex:(a+)+b}}", "%2F", "+", ";", "&", "=", "../", "..%2f",
]
INTERESTING_URLS = [
    "https://x.test/a", "https://x.test:0/a", "https://x.test:65535/a",
    "https://x.test:99999/a", "https://[::1]/a", "https://user:pw@x.test/a",
    "https://x.test/a?k=1&k=1", "https://x.test/a?flag", "https://x.test//a",
    "https://x.test/%2e%2e/x", "HTTPS://X.TEST/A", "http://x.test/a", "ftp://x.test/a",
    "/relative", "https://x.test/a#f", "https://x.test/" + "a" * 3000,
]
INTERESTING_STATUS = [99, 100, 101, 199, 200, 204, 304, 400, 500, 599, 600, 0, -1]
INTERESTING_BODIES: List[Any] = [
    {"encoding": "empty"},
    {"encoding": "text", "text": "x"},
    {"encoding": "text", "text": "a" + NUL + "b"},
    {"encoding": "json", "json": {"a": 1}},
    {"encoding": "json", "json": [1, [2, [3]]]},
    {"encoding": "json", "json": {"n": 9007199254740993}},
    {"encoding": "base64", "base64": "3q2+7w=="},
    {"encoding": "base64", "base64": "!!!"},
    {"encoding": "hex", "hex": "ff"},
]
INTERESTING_HEADER_NAMES = ["x-a", "X-A", "x bad", "content-type", "", ":authority", "x" * 500]


def generate(rng: random.Random, count: int) -> Dict[str, str]:
    """Build `count` fixtures by sampling the interesting values above."""
    out: Dict[str, str] = {}
    for index in range(count):
        interactions = []
        for _ in range(rng.randint(0, 3)):
            request: Dict[str, Any] = {
                "method": rng.choice(["GET", "POST", "PUT", "get", "PROPFIND", ""]),
                "url": rng.choice(INTERESTING_URLS),
            }
            if rng.random() < 0.6:
                request["headers"] = [
                    [rng.choice(INTERESTING_HEADER_NAMES), rng.choice(INTERESTING_STRINGS)]
                    for _ in range(rng.randint(1, 3))
                ]
            if rng.random() < 0.6:
                request["body"] = rng.choice(INTERESTING_BODIES)

            interaction: Dict[str, Any] = {"request": request}
            if rng.random() < 0.85:
                response: Dict[str, Any] = {"status": rng.choice(INTERESTING_STATUS)}
                if rng.random() < 0.4:
                    response["statusText"] = rng.choice(INTERESTING_STRINGS)
                if rng.random() < 0.4:
                    response["headers"] = [["x-b", rng.choice(INTERESTING_STRINGS)]]
                if rng.random() < 0.4:
                    response["body"] = rng.choice(INTERESTING_BODIES)
                interaction["response"] = response
            if rng.random() < 0.2:
                interaction["fault"] = {
                    "type": rng.choice(
                        ["timeout", "connection-reset", "partial-response", "meteor-strike"]
                    )
                }
            if rng.random() < 0.3:
                interaction["replay"] = {"times": rng.choice([1, 2, 0, "unlimited", "many"])}
            interactions.append(interaction)

        doc: Dict[str, Any] = {
            "hif": rng.choice(["1.0", "1.0", "1.0", "1.9", "2.0", "1"]),
            "interactions": interactions,
        }
        out["generated-%04d" % index] = json.dumps(doc, ensure_ascii=False)
    return out


# ---------------------------------------------------------------------------
# Running the two implementations
# ---------------------------------------------------------------------------


class Runner:
    def __init__(self, python_bin: str) -> None:
        self.python_bin = python_bin
        self.env = dict(os.environ, PYTHONPATH=str(PY_SRC))

    def ts(self, args: List[str], timeout: float = 60) -> "subprocess.CompletedProcess[str]":
        return subprocess.run(
            ["node", str(TS_CLI), *args], capture_output=True, text=True, timeout=timeout
        )

    def py(self, args: List[str], timeout: float = 60) -> "subprocess.CompletedProcess[str]":
        return subprocess.run(
            [self.python_bin, "-m", "spool.cli", *args],
            capture_output=True, text=True, timeout=timeout, env=self.env,
        )


def describe_difference(ts_text: str, py_text: str) -> str:
    """Describe where two outputs diverge, centred on the first differing character.

    Showing a fixed-length prefix is not good enough: the first real difference is
    routinely thousands of characters in, behind a long recorded value, and a
    prefix then shows two identical-looking excerpts. This reports the offset and
    a window around it, which is what a reader actually needs.
    """
    limit = min(len(ts_text), len(py_text))
    for index in range(limit):
        if ts_text[index] != py_text[index]:
            start = max(0, index - 60)
            end = index + 60
            return (
                "differs at character %d\n      ts: %r\n      py: %r"
                % (index, ts_text[start:end], py_text[start:end])
            )

    # One is a prefix of the other.
    longer, name = (ts_text, "ts") if len(ts_text) > len(py_text) else (py_text, "py")
    return (
        "identical for %d characters, then %s continues\n      extra: %r"
        % (limit, name, longer[limit:limit + 120])
    )


class Report:
    def __init__(self, verbose: bool) -> None:
        self.checks = 0
        self.divergences: List[str] = []
        self.exempted = 0
        self.verbose = verbose

    def compare(
        self,
        label: str,
        command: str,
        ts: "subprocess.CompletedProcess[str]",
        py: "subprocess.CompletedProcess[str]",
    ) -> None:
        self.checks += 1
        problems = []
        if ts.returncode != py.returncode:
            problems.append("exit code: ts=%s py=%s" % (ts.returncode, py.returncode))
        if ts.stdout != py.stdout:
            problems.append("stdout " + describe_difference(ts.stdout, py.stdout))
        if ts.stderr != py.stderr:
            problems.append("stderr " + describe_difference(ts.stderr, py.stderr))
        if not problems:
            return

        reason = is_known(ts.stdout + ts.stderr, py.stdout + py.stderr)
        if reason:
            self.exempted += 1
            if self.verbose:
                print("  exempt %s [%s] — %s" % (label, command, reason[:70]))
            return

        self.divergences.append("%s [%s]" % (label, command))
        print("  DIFF   %s [%s]" % (label, command))
        for problem in problems:
            print("      " + problem)

    def note(self, label: str, message: str) -> None:
        self.checks += 1
        self.divergences.append(label)
        print("  DIFF   " + label)
        print("      " + message)


def run_cli_differential(runner: Runner, inputs: Dict[str, str], report: Report) -> None:
    """Compare `lint`, `digest` and `explain` for every input."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="spool-fuzz-"))
    live = tmp / "live.json"
    live.write_text(
        json.dumps({"method": "GET", "url": "https://api.test/DIFFERENT"}), encoding="utf-8"
    )

    for name, text in sorted(inputs.items()):
        path = tmp / (name + ".hif.json")
        path.write_text(text, encoding="utf-8")
        for command, args in (
            ("lint", ["lint", str(path)]),
            ("digest", ["digest", str(path)]),
            ("explain", ["explain", str(path), str(live)]),
        ):
            try:
                ts_result = runner.ts(args)
                py_result = runner.py(args)
            except subprocess.TimeoutExpired as exc:
                # A hang is the most serious outcome here: it is how catastrophic
                # regex backtracking presents, and no output comparison sees it.
                report.note(
                    "%s [%s]" % (name, command),
                    "timed out after %ss — a hang, not a mismatch" % exc.timeout,
                )
                continue
            report.compare(name, command, ts_result, py_result)


# ---------------------------------------------------------------------------
# Server differential
# ---------------------------------------------------------------------------

SERVER_FIXTURE: Dict[str, Any] = {
    "hif": "1.0",
    "interactions": [
        {"id": "n204", "request": {"method": "GET", "url": "https://x.test/n204"},
         "response": {"status": 204, "body": {"encoding": "text", "text": "SHOULD-NOT-APPEAR"}},
         "replay": {"times": "unlimited"}},
        {"id": "n304", "request": {"method": "GET", "url": "https://x.test/n304"},
         "response": {"status": 304, "body": {"encoding": "text", "text": "SHOULD-NOT-APPEAR"}},
         "replay": {"times": "unlimited"}},
        {"id": "n100", "request": {"method": "GET", "url": "https://x.test/n100"},
         "response": {"status": 100}, "replay": {"times": "unlimited"}},
        {"id": "n599", "request": {"method": "GET", "url": "https://x.test/n599"},
         "response": {"status": 599}, "replay": {"times": "unlimited"}},
        {"id": "dup", "request": {"method": "GET", "url": "https://x.test/dup"},
         "response": {"status": 200, "headers": [["set-cookie", "a=1"], ["set-cookie", "b=2"]]},
         "replay": {"times": "unlimited"}},
        {"id": "big", "request": {"method": "GET", "url": "https://x.test/big"},
         "response": {"status": 200, "headers": [["x-big", "v" * 20000]]},
         "replay": {"times": "unlimited"}},
        {"id": "utf8", "request": {"method": "GET", "url": "https://x.test/utf8"},
         "response": {"status": 200, "headers": [["x-note", "café"]]},
         "replay": {"times": "unlimited"}},
        {"id": "empty", "request": {"method": "GET", "url": "https://x.test/empty"},
         "response": {"status": 200}, "replay": {"times": "unlimited"}},
        {"id": "bin", "request": {"method": "GET", "url": "https://x.test/bin"},
         "response": {"status": 200, "body": {"encoding": "base64", "base64": "AAECgP8="}},
         "replay": {"times": "unlimited"}},
        {"id": "fault", "request": {"method": "GET", "url": "https://x.test/fault"},
         "fault": {"type": "connection-reset"}, "replay": {"times": "unlimited"}},
    ],
}

SERVER_PATHS = [
    "n204", "n304", "n100", "n599", "dup", "big", "utf8", "empty", "bin",
    "fault", "missing", "..%2f..%2fetc", "a?q=1&q=2",
]


def raw_request(port: int, path: str) -> bytes:
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=8)
        sock.sendall(
            ("GET /%s HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n" % path).encode()
        )
        chunks = []
        while True:
            data = sock.recv(65536)
            if not data:
                break
            chunks.append(data)
        sock.close()
        return b"".join(chunks)
    except Exception as exc:  # noqa: BLE001 - a dropped connection is a valid outcome here
        return ("<%s>" % type(exc).__name__).encode()


def summarise(data: bytes) -> str:
    """Status line, header names and body — the parts that must agree.

    Hop-by-hop and server-identifying headers are excluded: they are artefacts of
    two different HTTP stacks, not anything the fixture describes.
    """
    if data.startswith(b"<"):
        return data.decode()
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode("utf-8", "replace").split("\r\n")
    status = lines[0] if lines else ""
    ignored = {"date", "connection", "keep-alive", "server", "transfer-encoding", "content-length"}
    names = sorted(
        line.split(":", 1)[0].lower()
        for line in lines[1:]
        if ":" in line and line.split(":", 1)[0].lower() not in ignored
    )
    return "%s | headers=%s | body=%r" % (status, names, body[:120])


def wait_for_port(port: int, deadline: float = 20.0) -> bool:
    """Poll a path the fixture does not contain.

    Probing a recorded path would consume its play count before the comparison
    runs, which silently changes what is being tested.
    """
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if not raw_request(port, "__spool_ready__").startswith(b"<"):
            return True
        time.sleep(0.1)
    return False


def run_server_differential(python_bin: str, report: Report) -> None:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="spool-fuzz-serve-"))
    fixture = tmp / "serve.hif.json"
    fixture.write_text(json.dumps(SERVER_FIXTURE), encoding="utf-8")

    ts_port, py_port = 18411, 18412
    ts_proc = subprocess.Popen(
        ["node", str(TS_CLI), "serve", str(fixture), "--port", str(ts_port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    py_proc = subprocess.Popen(
        [python_bin, "-m", "spool.cli", "serve", str(fixture), "--port", str(py_port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        env=dict(os.environ, PYTHONPATH=str(PY_SRC)),
    )

    try:
        for name, port in (("typescript", ts_port), ("python", py_port)):
            if not wait_for_port(port):
                report.note("serve/" + name, "server did not start within 20s")
                return

        for path in SERVER_PATHS:
            report.checks += 1
            ts_out = summarise(raw_request(ts_port, path))
            py_out = summarise(raw_request(py_port, path))
            if ts_out != py_out:
                report.divergences.append("serve /" + path)
                print("  DIFF   serve /%s" % path)
                print("      ts: " + ts_out[:200])
                print("      py: " + py_out[:200])

        # A server that dies on a request it cannot answer is worse than one that
        # answers differently, and no output comparison above would notice.
        for proc, name in ((ts_proc, "typescript"), (py_proc, "python")):
            if proc.poll() is not None:
                stderr = (proc.stderr.read() or b"")[-400:] if proc.stderr else b""
                report.note("serve/" + name, "server exited during the run — %r" % stderr)
    finally:
        for proc in (ts_proc, py_proc):
            proc.kill()
            proc.wait(timeout=5)


# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--generated", type=int, default=0, metavar="N",
                        help="also run N seeded generated fixtures (default 0)")
    parser.add_argument("--seed", type=int, default=20260810,
                        help="PRNG seed; fixed by default so runs are reproducible")
    parser.add_argument("--skip-servers", action="store_true",
                        help="skip the server differential (opens no sockets)")
    parser.add_argument("--python", default=sys.executable,
                        help="python interpreter that can import spool")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="also report exempted divergences")
    args = parser.parse_args()

    if not TS_CLI.exists():
        print("The TypeScript package is not built.")
        print("Run: (cd implementations/typescript && npm ci && npm run build)")
        return 2

    inputs = corpus()
    if args.generated:
        inputs.update(generate(random.Random(args.seed), args.generated))

    print("spool differential fuzzer — %d input(s), seed %d" % (len(inputs), args.seed))
    print()

    report = Report(verbose=args.verbose)
    run_cli_differential(Runner(args.python), inputs, report)
    if not args.skip_servers:
        run_server_differential(args.python, report)

    print()
    if not report.divergences:
        exempt = ", %d known divergence(s) exempted" % report.exempted if report.exempted else ""
        print("ok: %d comparison(s), the implementations agree%s" % (report.checks, exempt))
        return 0

    print("%d divergence(s) across %d comparison(s):" % (len(report.divergences), report.checks))
    for name in report.divergences:
        print("  - " + name)
    print()
    print("Any difference that is not deliberate is a bug, in one implementation or in")
    print("the specification. Reproduce with:")
    generated = " --generated %d" % args.generated if args.generated else ""
    print("    python3 conformance/fuzz.py --seed %d%s" % (args.seed, generated))
    print()
    print("Then add a conformance case pinning the correct behaviour, so the suite")
    print("catches it next time rather than the fuzzer.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
