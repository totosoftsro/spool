# Repository-level checks

Tests that belong to the repository as a whole rather than to one
implementation. Per-implementation tests live in
`implementations/*/test*/`, and the shared cases live in
[`../conformance/`](../conformance/).

| Check | What it does |
| --- | --- |
| [`check_spec_references.py`](./check_spec_references.py) | Verifies that every specification section cited anywhere in the repository actually exists. |

## Why the spec-reference check exists

Code comments, docs and error messages cite the specification by section number
(`§7.4.2`). Those citations are how a reader gets from an implementation detail
to the rule it implements, and they are the first thing to rot when a section is
renumbered — silently, because nothing else would notice.

```bash
python3 tests/check_spec_references.py
```

It currently checks over 500 citations. RFC citations (`RFC 3986 §5.2.4`) are
excluded, since those refer to other documents' section numbering.

## The other repository-level checks

These live next to what they verify rather than here, because they are run
directly in development as well as in CI:

- [`../conformance/verify-vectors.sh`](../conformance/verify-vectors.sh) —
  re-derives every digest and base64 test vector using `openssl`, so no expected
  value can originate from the code under test.
- [`../conformance/cross-check.sh`](../conformance/cross-check.sh) — compares the
  two implementations against each other, including byte-identical rendered
  mismatch reports and matching CLI command surfaces.
