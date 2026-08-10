## What this changes

<!-- The reasoning, not just the diff. If behaviour changed, say what the old
     behaviour was and why it was wrong. -->

## Type of change

- [ ] Bug fix
- [ ] New feature in an implementation
- [ ] Specification change (see the extra requirements below)
- [ ] Conformance case
- [ ] Documentation
- [ ] Build, CI or tooling

## Both implementations

The CLIs and core behaviour must not drift apart.

- [ ] This does not change behaviour visible to both implementations
- [ ] Changed in both TypeScript and Python
- [ ] Changed in one; I cannot write the other and would like help
      <!-- Say so plainly — it is a much better outcome than a silent divergence. -->

## Specification changes only

- [ ] Normative text updated in `specification/hif-1.0.md`, with reasoning
- [ ] Conformance cases added or updated
- [ ] Every implementation updated at the affected conformance level
- [ ] Entry added to `specification/CHANGELOG.md`
- [ ] Compatibility stated: additive (`1.x`) or breaking (`2.0`)

## Checks

- [ ] `npm test` passes in `implementations/typescript`
- [ ] `pytest` passes in `implementations/python`
- [ ] `./conformance/cross-check.sh` passes
- [ ] Tests added for the changed behaviour
- [ ] No new runtime dependency, or a justification below

## Determinism

Matching, selection and reporting must be pure functions of their inputs.

- [ ] No clock, environment, hash-order or other ambient state was introduced
      into matching, selection or reporting

## Redaction wording

If this touches redaction (§9):

- [ ] No output claims a fixture is "safe", "clean" or "sanitized" without
      stating that detection has false negatives
