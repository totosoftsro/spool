# Changelog

This file covers the repository as a whole: the implementations and the tooling
around them. The fixture format has its own changelog at
[`specification/CHANGELOG.md`](./specification/CHANGELOG.md), because the format
and the code that reads it version independently
([GOVERNANCE.md](./GOVERNANCE.md#versioning)).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the implementations follow [semantic versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/spool-hif/spool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/spool-hif/spool/releases/tag/v0.1.0
