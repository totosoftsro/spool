# The HIF conformance suite

Every implementation runs exactly the same cases. This directory is the contract.

The cases are plain JSON. Running them requires writing a small runner in your
language — roughly 100 lines — not porting a test framework. Two reference
runners exist, and they live with the implementations they belong to rather
than here, so that they run under each ecosystem's own test tooling:

- [`implementations/typescript/test/conformance.test.ts`](../implementations/typescript/test/conformance.test.ts)
- [`implementations/python/tests/test_conformance.py`](../implementations/python/tests/test_conformance.py)

```
conformance/
  manifest.json        the case index: id, level, file, kind
  cases/
    normalize/         §6.4  URL normalization and query decomposition
    canonical/         §12   RFC 8785 canonical JSON
    digest/            §14   hif-digest-1 request digests
    match/             §7    matching, including selection and placeholders
    select/            §7.5  play-count and ordering behaviour
    explain/           §13   mismatch reports and verified suggestions
    redact/            §9    redaction rules and entropy detection
    structural/        §11.3 documents that must be rejected
    version/           §11.2 forward and backward version handling
```

## Running

```bash
cd implementations/typescript && npm run conformance
```

```bash
cd implementations/python && python -m pytest tests/test_conformance.py
```

Both discover cases from `manifest.json`, so adding a case file plus a manifest
entry runs it in every implementation with no other change.

## Case kinds

Each case has a `kind` that determines how a runner executes it.

| `kind` | Input | Expected output |
| --- | --- | --- |
| `normalize` | `url` | `scheme`, `host`, `port`, `path`, `query`, `href` |
| `canonical` | `value` | `canonical` string |
| `lossy` | `text` | `lossy` array of `{literal, canonical}` |
| `digest` | `request` | `preimage` string and `digest` hex |
| `match` | `recorded`, `live`, `config` | `matches`, and optionally `reasons` |
| `select` | `fixture`, `requests` | `selected` array of refs or `"<unmatched>"` |
| `explain` | `fixture`, `live` | `candidates` (ref/score/total order) and `suggestions` |
| `redact` | `fixture`, `config` | `fixture` after redaction, `rules` |
| `entropy` | `subject`, `config` | `tokens` array |
| `structural` | `document` | `error: true` with `errorContains` when the message is checkable, or `error: false` for a legal document that a nearby rule must not reject |
| `version` | `document` | `accepted`, and `warns` when a warning is required |
| `regex` | `pattern`, `subjects` | `valid`, and `matches` per subject |
| `template` | `recorded`, `subjects` | `matches` per subject |

A runner that does not implement a level skips its cases and reports them as
skipped — it must not report them as passed. Declaring a conformance level you
have not run is the one thing that would make this format worse than the status
quo.

## Where the expected values come from

This matters, so it is documented per group rather than assumed.

| Group | How the expected values were established |
| --- | --- |
| `digest/` | SHA-256 values computed with `openssl dgst -sha256` over the pre-image string, independent of any HIF implementation. The pre-image itself is written out in each case so it can be re-hashed by hand. |
| `canonical/` | Number and string forms cross-checked against Node's `JSON.stringify` and Python's own float repr, which are independent implementations of the ECMAScript and shortest-round-trip rules RFC 8785 cites. Cases where the two disagree are the interesting ones and are included deliberately. |
| `normalize/` | Derived from RFC 3986 §5.2.4's own worked examples and from the normative step list in spec §6.4. |
| `entropy/` | Entropy values computed independently with a one-line Python expression over `collections.Counter`, not with the implementation's own function. |
| everything else | Written from the specification text, then checked against both implementations. A case that only one implementation passes is a bug in one of them, or an ambiguity in the spec — all three outcomes are worth finding. |

The general rule: **where a value could be produced by the code under test, it
was produced by something else instead.** `conformance/verify-vectors.sh`
re-derives the digest and base64 vectors using `openssl` and fails if they drift.

## The differential fuzzer

`cross-check.sh` compares a fixed set of outputs. [`fuzz.py`](./fuzz.py) attacks
the seams it does not reach: fixtures nobody thought to write a case for,
malformed input, protocol edge cases, and whether a server survives a request it
cannot answer.

```bash
python3 conformance/fuzz.py                 # hand-written corpus, quick
python3 conformance/fuzz.py --generated 200 # plus 200 seeded fixtures
python3 conformance/fuzz.py --seed 12345    # reproduce a specific run
python3 conformance/fuzz.py --skip-servers  # opens no sockets
```

**It is deterministic.** The seed is fixed unless you pass one, so CI cannot
flake and a failure is always reproducible with the command it prints. Generated
fixtures are assembled from values that have historically been where the
implementations disagree — control characters, boundary ports, unregistered
statuses, oversized headers — rather than from random bytes, which almost never
reach an interesting branch.

It also notices two things no output comparison can: a run that **hangs** (how
catastrophic regex backtracking presents) and a server that **exits** during the
run.

Findings so far, each now pinned by a conformance case: a port above 65535
loading in one implementation and failing in the other; a 204 carrying a body in
one and not the other; a differing reason phrase for an unregistered status; an
unquoted escape in a JSON-path error; a truncation ellipsis rendered `…` in one
and `...` in the other; and a fixture that terminated the whole `spool serve`
process.

When it finds something, fix the divergence **and add a conformance case**, so
the suite catches it next time rather than the fuzzer.

## Known intentional divergences

The project's rule is that any difference between implementations is a bug. There
is currently one deliberate exception, recorded here so nobody spends an afternoon
on it:

**The text of a malformed-JSON error.** A fixture that is not valid JSON is
rejected by both implementations with the same exit code and the same message
prefix, but the trailing detail comes from the host JSON parser:

```
ts: ... is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)
py: ... is not valid JSON: Expecting property name enclosed in double quotes: line 1 column 3 (char 2)
```

Making these identical would mean writing our own JSON parser, which is a large
amount of risk for a cosmetic gain — and the host parser's message is genuinely
more useful to somebody fixing a broken fixture than a normalised one would be.
`cross-check.sh` therefore does not compare this case.

Nothing else is exempt. If you find another difference, it is a bug.

## Adding a case

Good first contribution. Add a JSON file under the right group, add an entry to
`manifest.json`, and run both suites. If the two implementations disagree, say so
in the pull request — that is the most valuable kind of case there is.

Cases should be small and test one thing. A case that fails should tell you what
broke from its name alone.
