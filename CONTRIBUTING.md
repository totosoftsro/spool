# Contributing to Spool

Thanks for considering it. This document covers what the project needs, how to
run everything locally, and what a good pull request looks like here.

## The short version

```bash
git clone https://github.com/spool-hif/spool.git
cd spool

# TypeScript
cd implementations/typescript && npm ci && npm test && cd ../..

# Python
cd implementations/python && pip install -e '.[dev]' && pytest && cd ../..

# Both implementations against each other
(cd implementations/typescript && npm run build)
./conformance/cross-check.sh
```

If all three pass, you have a working development environment.

## What this project most needs

Listed roughly in order of value, which is not the same as order of difficulty.

### 1. Conformance cases that make the implementations disagree

The single most valuable contribution. If you can write a `conformance/cases/`
entry that TypeScript and Python answer differently, you have found either a bug
or an ambiguity in the specification, and both are worth fixing.

Start with [`conformance/README.md`](./conformance/README.md). A case is a small
JSON file plus a line in `manifest.json`. No code required.

Areas that are thin and would benefit from adversarial cases: percent-encoding
edge cases in URLs, UTF-16 versus code-point ordering in canonical JSON, text
templates with adjacent placeholders, and the regex subset.

### 2. A client adapter

The core is a pure function; adapters connect it to a real HTTP client. Each one
is small and self-contained. See
[`docs/contributing-adapters.md`](./docs/contributing-adapters.md).

Known gaps: Node's `http`/`https` modules (which would cover axios, got and
node-fetch v2), `aiohttp`, and `urllib3` directly.

### 3. A language implementation

Go, Rust, Java, C#, Ruby, PHP. The specification is written to be implementable
from the document alone, and the conformance suite tells you when you are done.
See [`docs/contributing-implementations.md`](./docs/contributing-implementations.md).

You do not have to implement everything. Conformance has levels
([§15](./specification/hif-1.0.md#15-conformance)) precisely so that a partial
implementation can be honest about what it supports.

### 4. Redaction rules

The default rule sets in [§9.1](./specification/hif-1.0.md#91-the-default-rule-set)
are a starting point, not a complete list of every credential-carrying header or
field name in the world. Additions need a short justification: which service
uses it, and why a false positive would be unlikely.

### 5. Documentation and examples

Especially: a migration guide from a tool we have not covered, or a worked
example against an API shape we have not shown.

## Good first issues

These are genuinely useful, not busywork:

- Add conformance cases for a section of the spec you find under-tested.
- Add a fixture example for an API shape not covered in `examples/`.
- Add a `--format json` output to a CLI command that lacks it, in **both**
  implementations (the CLIs must not drift).
- Write a converter from a HAR file to HIF, per
  [Appendix B](./specification/hif-1.0.md#appendix-b--relationship-to-har).
  It must report what it dropped.
- Improve a mismatch report's wording for one specific reason code.
- Add a redaction rule with a justification.

## Ground rules for changes

### Both implementations move together

The CLIs and the core behaviour must not diverge. A pull request that adds a
command, a match mode, or a reason code to one implementation and not the other
will be asked to do both, or to split the behaviour behind the conformance
levels. `conformance/cross-check.sh` enforces the visible parts of this in CI.

If you can only write one language, say so in the pull request — a maintainer or
another contributor can pair on the other side. That is a much better outcome
than a silent divergence.

### Specification changes need more than code

Changing behaviour described in `specification/hif-1.0.md` means:

1. Updating the normative text, with the reasoning.
2. Adding or updating conformance cases.
3. Updating both implementations.
4. A note in `specification/CHANGELOG.md`.

Additive changes go in a `1.x`; anything that changes the meaning of an existing
member requires a `2.0` and a strong argument. See
[GOVERNANCE.md](./GOVERNANCE.md).

### Determinism is not negotiable

Matching, selection and reporting must be pure functions of their inputs. No
clock, no environment variables, no iteration over an unordered container
without an explicit sort, no dependence on hash seeds. If a change makes output
depend on any of those, it will be rejected even if all tests pass — because the
tests passing is exactly what you would expect from a non-determinism that
manifests one run in fifty.

### Never overstate what redaction does

Any change touching [§9](./specification/hif-1.0.md#9-redaction) must preserve
the honesty of the output. No message may say "sanitized", "safe", "clean" or
"no secrets found" without the accompanying statement that detection has false
negatives. This is not pedantry: a confident-sounding tool stops people from
reviewing their fixtures, and that is worse than no tool at all.

### Dependencies

Both implementations have zero required runtime dependencies, and that is a
feature — a test-support library that drags in a dependency tree is a liability.
Adding one needs a strong case. Optional, lazily imported dependencies for
adapters (as with `httpx` and `requests`) are fine.

## Style

- Match the surrounding code. Both implementations are formatted and linted in
  CI; run `npm run typecheck` and `ruff check` before pushing.
- Comments explain *why*, not *what*. The existing code is a reasonable guide:
  where a decision looks odd, there is a comment saying what would go wrong
  otherwise.
- Section references to the specification (`§7.4.2`, `section 7.4.2`) in code
  comments are load-bearing. Keep them accurate when the spec moves.

## Pull requests

- One logical change per pull request.
- Explain the reasoning, not just the diff. If a conformance case changed, say
  what the old behaviour was and why it was wrong.
- Tests are expected for behaviour changes. Conformance cases are expected for
  spec-visible behaviour changes.
- Draft pull requests are welcome for anything you want feedback on early.

## Reporting bugs

A good bug report for this project usually contains a fixture and a request.
Both are just JSON, so you can normally paste a minimal reproduction directly:

```bash
spool explain your-fixture.hif.json '{"method":"GET","url":"https://..."}'
```

Include the output, and which implementation and version you are using.

For anything security-sensitive, see [SECURITY.md](./SECURITY.md) instead — do
not open a public issue.

## Licence of contributions

By contributing you agree that your contributions are licensed under
[Apache-2.0](./LICENSE), and that contributions to `specification/` are
additionally licensed under [CC BY 4.0](./specification/LICENSE). There is no
CLA.
