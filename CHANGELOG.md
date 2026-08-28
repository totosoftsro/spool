# Changelog

This file covers the repository as a whole: the implementations and the tooling
around them. The fixture format has its own changelog at
[`specification/CHANGELOG.md`](./specification/CHANGELOG.md), because the format
and the code that reads it version independently
([GOVERNANCE.md](./GOVERNANCE.md#versioning)).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the implementations follow [semantic versioning](https://semver.org/).

## [0.1.0] — unreleased

### Added

- **`spool serve` and `spool proxy`** in both implementations. A fixture can now
  be replayed over a real socket by a client with no Spool library — Go, Rust,
  Java, a container, a shell script — using the same matching engine,
  explanations and redaction as the in-process adapters. Unmatched requests
  answer 551 with the full §13 report as the body. `serve --record` records
  through a reverse proxy. See [`docs/serving.md`](./docs/serving.md).
  - `proxy` deliberately refuses https via CONNECT rather than shipping a
    man-in-the-middle certificate authority; it explains why and points at
    `serve`, which needs no certificate.
- **`@spool/hif/node-http`**, an adapter for `node:http` / `node:https`. Covers
  axios, got, node-fetch v2 and superagent — anything not on global `fetch`. The
  response is a real `http.IncomingMessage`, and the axios path is exercised in
  the test suite rather than only claimed.
- **`spool import har`** in both implementations, per
  [Appendix B](./specification/hif-1.0.md#appendix-b--relationship-to-har).
  Reports exactly what the conversion dropped, skips cache hits, non-HTTP
  schemes and aborted entries with a reason for each, and redacts by default.
- `examples/serve-any-language/`, which replays a fixture using nothing but
  curl, so the "works from any language" claim is verified in CI rather than
  asserted in a README.
- **`conformance/fuzz.py`**, a differential fuzzer that runs adversarial and
  seeded inputs through both implementations and diffs stdout, stderr, exit codes
  and live server responses. It runs in CI with a fixed seed, so it is
  reproducible and cannot flake. Unlike the other checks it also notices a run
  that hangs and a server that exits — neither of which any output comparison
  sees. It found the port-range, 204-body and reason-phrase divergences listed
  below, and on its first run inside the repository found two more: an unquoted
  escape in a JSON-path error message, and a truncation ellipsis rendered `…` in
  TypeScript and `...` in Python. Both are fixed and pinned by conformance cases.

### Security

Found by a pre-release audit that treated fixtures as untrusted input, which is
what they are: they are committed to repositories, reviewed in pull requests,
converted from HAR captures and copied between projects.

- **HTTP response splitting via a fixture.** A header value or reason phrase
  containing CRLF was delivered verbatim by `spool serve` in Python, terminating
  the header block early and letting the fixture inject arbitrary headers and a
  response body of its own. Header names, header values and reason phrases are
  now validated when a fixture is *loaded* (spec §6.3.1), so every consumer —
  both servers and all four adapters — is protected at once, and the malformed
  fixture is reported with its location instead of reaching the wire.
- **A single request could terminate `spool serve` in TypeScript.** The same
  malformed reason phrase made Node throw from inside the error handler itself;
  the rejection was unhandled and the process exited, taking the whole test run
  with it. The handlers now cannot escape, and the error path is safe when a
  response has already begun.
- **Catastrophic regex backtracking was possible, and the security policy
  claimed it was not.** `{{regex:(a+)+b}}` against a run of 40 `a` characters
  never terminated in either implementation. The subject-length bound that
  `SECURITY.md` cited as protection is no protection at all at that size. A
  quantifier applied to a group is now rejected outright (spec §7.6.2), which
  removes the whole family, and the policy text has been corrected.
- **Unbounded request-body buffering** in both servers let any client hold the
  process's memory. Bodies beyond 32 MiB now get a 413.
- **`record_serve` accepted any URL scheme** in Python, and `urllib` honours
  `file://`, so a mistyped origin turned the recorder into a local-file reader.
  The origin is now validated as http or https.

### Fixed

- **`restore()` could leak an interceptor permanently.** Restoring handles out of
  order reinstated the outer adapter's patch and discarded the inner one, and
  every later install then captured the leak as its "original" — so a later test
  kept replaying an earlier fixture and *passed against the wrong data*. Both
  TypeScript adapters are now idempotent on restore and refuse to clobber a
  newer interceptor, turning a silent wrong-answer failure into an explicit
  error. The Python adapters were never affected: a transport and an HTTPAdapter
  are per-client objects, not process-wide state.
- **Five advisories in the development toolchain**, one critical, all in the
  vitest/vite/esbuild chain. Resolved by moving to vitest 4; `npm audit` now
  reports zero. The published package tree was and remains empty, so nothing
  shipped was affected.
- **204, 304 and 1xx responses carried a body** in Python when the fixture
  supplied one — a framing violation that a client on a keep-alive connection
  reads as the start of the next response. Node stripped it silently, so this was
  also a cross-language divergence. Both now apply the rule explicitly.
- **A port above 65535 was accepted by Python and rejected by TypeScript**, so
  the same fixture loaded in one language and failed in the other. The range is
  now normative (spec §6.4) and both reject it with the same message.
- Seven user-facing text divergences between the two implementations, found by
  extending `cross-check.sh` to compare `lint` output, HAR import output and
  live `serve` responses. Python's `repr` quoting (`'x'`) is replaced by JSON
  quoting (`"x"`) in every diagnostic; spec citations, the interaction-id
  pattern, enumerated value lists and the fault-type list now read identically
  in both. None of these were caught by the conformance suite, because none of
  them are behaviour the specification governs.

### Changed

- **Both packages now ship the Apache-2.0 licence text.** Neither did, which for
  an Apache-2.0 project is a distribution-terms problem, not a tidiness one.
- **The Python package ships a `py.typed` marker.** It advertised
  `Typing :: Typed` while giving consumers' type checkers nothing to read.
- **The docs said `npx spool`**, which asks npm for a package called `spool` —
  one that exists and belongs to someone else. All six occurrences now say
  `npx @spool/hif`, and the CLI reference explains why it matters.
- The README and getting-started guide now state plainly that the packages are
  not published yet, and give a from-source path that works today.
- `conformance/cross-check.sh` grew from 22 comparisons to 67, and now covers
  lint warnings, HAR conversion and real HTTP responses in addition to mismatch
  reports and digests.

### Also in 0.1.0

First release. Targets HIF 1.0 at conformance level **Full** in both
implementations.

### Specification

- HIF 1.0 published: document structure, matching, redaction, fault simulation,
  canonical JSON, mismatch explanation, request digest, and conformance levels.
  See [`specification/CHANGELOG.md`](./specification/CHANGELOG.md).

### `@spool/hif` (TypeScript) 0.1.0

- Core: fixture parsing and validation, URL and query normalization, body
  encodings, header handling, matching, selection, canonical JSON, and the
  `hif-digest-1` request digest.
- Mismatch explanation with ranked candidates and verified suggestions.
- Redaction with the default rule sets, configurable rules, and entropy
  detection.
- `Player`, `Recorder`, and a `fetch` adapter (`@spool/hif/fetch`) covering
  Node 18+, Deno and Bun.
- `spool` CLI: `lint`, `inspect`, `digest`, `scan`, `redact`, `explain`, `diff`.
- Zero runtime dependencies.

### `spool-hif` (Python) 0.1.0

- The same core, explanation engine, redaction and CLI.
- `httpx` transport and `requests` adapter, both optional dependencies imported
  lazily.
- Reimplements ECMAScript `Number::toString` so RFC 8785 canonical output
  matches JavaScript exactly, including the 1e20/1e21 and 1e-6/1e-7 boundaries
  and denormals.
- Python 3.9+. Zero required runtime dependencies.

### Conformance

- 207 language-neutral cases covering normalization, canonical JSON, digests,
  matching, selection, explanation, redaction, structural errors and version
  handling. Both implementations pass all of them.
- `conformance/verify-vectors.sh` re-derives every digest and base64 vector with
  `openssl`, so no expected value originates from the code under test.
- `conformance/cross-check.sh` compares the two implementations against each
  other, including byte-identical rendered mismatch reports.
- `conformance/fuzz.py` searches for divergences the cases do not cover, and runs
  in CI with a fixed seed.

Nothing has been tagged or published yet, so there are no release links here.
The release workflows tag each implementation separately — `typescript-v0.1.0`
and `python-v0.1.0` — and this section will link to those tags once they exist.
