# Changelog

This file covers the repository as a whole: the implementations and the tooling
around them. The fixture format has its own changelog at
[`specification/CHANGELOG.md`](./specification/CHANGELOG.md), because the format
and the code that reads it version independently
([GOVERNANCE.md](./GOVERNANCE.md#versioning)).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the implementations follow [semantic versioning](https://semver.org/).

## [Unreleased]

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

### Fixed

- Seven user-facing text divergences between the two implementations, found by
  extending `cross-check.sh` to compare `lint` output, HAR import output and
  live `serve` responses. Python's `repr` quoting (`'x'`) is replaced by JSON
  quoting (`"x"`) in every diagnostic; spec citations, the interaction-id
  pattern, enumerated value lists and the fault-type list now read identically
  in both. None of these were caught by the conformance suite, because none of
  them are behaviour the specification governs.

### Changed

- `conformance/cross-check.sh` grew from 22 comparisons to 55, and now covers
  lint warnings, HAR conversion and real HTTP responses in addition to mismatch
  reports and digests.

## [0.1.0] — 2026-08-10

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

- 189 language-neutral cases covering normalization, canonical JSON, digests,
  matching, selection, explanation, redaction, structural errors and version
  handling. Both implementations pass all of them.
- `conformance/verify-vectors.sh` re-derives every digest and base64 vector with
  `openssl`, so no expected value originates from the code under test.
- `conformance/cross-check.sh` compares the two implementations against each
  other, including byte-identical rendered mismatch reports.

[Unreleased]: https://github.com/totosoftsro/spool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/totosoftsro/spool/releases/tag/v0.1.0
