# Contributing a language implementation

The specification is written to be implementable from the document alone, and
the conformance suite tells you when you are done. This is the highest-value
contribution to the project.

Go, Rust, Java, C#, Ruby, PHP, Swift, Elixir — all wanted.

## You do not have to implement everything

Conformance has levels ([§15](../specification/hif-1.0.md#15-conformance))
precisely so a partial implementation can be honest:

| Level | What it covers |
| --- | --- |
| **Core** | Parse, validate, normalize, match, digest (§2–8, §11, §12, §14) |
| **Explain** | Core plus mismatch reports (§13) |
| **Redact** | Core plus redaction (§9) |
| **Full** | All of the above plus fault simulation (§10) |

Core alone is genuinely useful and is a reasonable first release. What is not
acceptable is claiming a level you have not run.

## Suggested order

Roughly the order of the dependency graph, and each step is testable against the
conformance suite before you move on.

1. **Canonical JSON** (§12) — cases in `conformance/cases/canonical/`.
   Usually the fiddliest part. RFC 8785 defines number serialization as
   ECMAScript `Number::toString`, which most languages' float formatter does not
   match. See the Python implementation's `canonical.py` for a worked example;
   the boundaries that bite are 1e20/1e21, 1e-6/1e-7, `-0`, and denormals.

   Object member ordering is by **UTF-16 code unit**, not code point. These
   differ for astral characters. Encode to UTF-16 and compare, do not use your
   language's default string sort unless you have checked what it does.

2. **URL normalization** (§6.4) — `conformance/cases/normalize/`.
   Do not delegate to your language's URL type. Every URL library normalizes a
   slightly different set of things; §6.4 lists exactly which steps happen and
   forbids the rest.

3. **Body and header handling** (§6.3, §6.5, §6.6) — the tagged-union body and
   the ordered header pairs. Do not use a map for headers.

4. **Matching** (§7) — `conformance/cases/match/`, the largest group.

5. **Selection** (§7.5) — `conformance/cases/select/`.

6. **Digest** (§14) — `conformance/cases/digest/`. Each case includes the
   pre-image string, so you can debug the construction separately from the hash.

7. **Structural validation** (§11.3) — `conformance/cases/structural/`.
   Keep structural errors and match failures as distinct types.

8. Then **explain** (§13), **redaction** (§9), **faults** (§10) as you want them.

## Writing the runner

The conformance suite is language-neutral JSON. You write a small runner —
roughly 100 lines — that reads `manifest.json`, dispatches on each case's `kind`,
and asserts. Two references:

- `implementations/typescript/test/conformance.test.ts`
- `implementations/python/tests/test_conformance.py`

Case kinds and their input/output shapes are tabulated in
[`conformance/README.md`](../conformance/README.md).

Skip the levels you have not implemented, and **report them as skipped, not
passed**.

## Traps that have already caught someone

- **Regex shorthands.** `\d`, `\w`, `\s` are ASCII-defined by §7.6.2, and `.`
  excludes only U+000A. Most engines disagree with at least one of those.
  Rewrite the shorthands into explicit character classes rather than trusting a
  flag; both existing implementations do exactly this.
- **Lazy-quantifier detection.** You cannot pre-scan for `??` to reject lazy
  quantifiers: `\??` is an allowed optional literal question mark. Validation
  has to happen in the same pass as parsing, where escape context is known.
- **Valueless query parameters.** `?flag` and `?flag=` are different. A
  key-value map loses this.
- **Repeated headers.** `set-cookie` appears more than once. A map loses this
  too, and it is a real bug in several existing tools.
- **Absent versus empty body.** They are the same thing (§6.5). If your types
  distinguish them, normalize early.
- **Report ordering.** Candidate ranking must be a total order — score, then
  total, then index. If your sort is not stable, the tie-break on index makes it
  deterministic anyway; rely on that rather than on your sort's stability.
- **Float summation in entropy.** Sum over sorted characters, so two
  implementations produce bit-identical results.

## Verify against something other than yourself

Where behaviour is checkable by an independent tool, check it that way. Digest
vectors are verified with `openssl` rather than with any implementation, and
`conformance/verify-vectors.sh` re-derives them.

If you implement canonical JSON, cross-check your number formatting against a
JavaScript engine — `node -e 'console.log(JSON.stringify(1e21))'` — rather than
against your own output. That is how the Python implementation was validated,
and it caught formatting differences that no amount of self-consistent testing
would have.

## Repository layout

```
implementations/<language>/
  README.md              install, quick start, conformance level, adapters
  <package manifest>
  src/ or lib/
  tests/
```

Add a CI job to `.github/workflows/ci.yml` running your tests and the
conformance suite. Once you have two implementations agreeing, consider adding
your CLI to `conformance/cross-check.sh`.

## Publishing

Publish to your ecosystem's registry under a name you control. The project does
not require implementations to live in this repository — an out-of-tree
implementation that passes conformance is a first-class implementation, and will
be listed in the README as such.

In-tree has advantages: CI catches spec changes for you, and cross-checking is
automatic. Either is fine.

## Before you start

Open an issue saying which language you are taking on, so two people do not
write the same port. Ask about anything in the specification that is unclear —
if it is unclear to you it is a specification bug, and reporting it is a
contribution in itself.
