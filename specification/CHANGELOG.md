# HIF specification changelog

Versioning follows §11 of the specification: `MAJOR.MINOR`, no patch component.
Additive changes increment MINOR; anything that changes the meaning of an existing
member increments MAJOR.

Editorial changes — typo fixes, clarified wording that does not change behaviour —
do not increment the version. They are listed here under "Editorial" so that
implementers can see what moved.

## 1.0 — initial release

First stable version. Defines:

- Document structure, `meta`, `defaults` (§2–§4)
- Interaction object, play counts, timing, expectations (§5)
- Request object, URL normalization, query decomposition, body encodings,
  non-UTF-8 header values (§6)
- Matching: scalar fields, headers, query, body, the selection algorithm,
  placeholders, JSON paths (§7)
- Response object, `content-length` handling, redirects (§8)
- Redaction: default rule sets, replacement value, configurable rules, the
  entropy algorithm, marking and reporting (§9)
- Fault simulation (§10)
- Versioning, reader requirements, the structural-error / match-failure
  distinction (§11)
- Canonical JSON via RFC 8785, including round-trip loss detection (§12)
- Mismatch explanation: report structure, deterministic ordering, stable reason
  identifiers, the verified-suggestions rule (§13)
- The `hif-digest-1` request digest (§14)
- Conformance levels (§15)
