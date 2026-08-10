# Explained mismatches

The feature the project exists for. Normative rules:
[§13](../specification/hif-1.0.md#13-mismatch-explanation).

## The problem

Every record/replay tool eventually produces some variant of "request did not
match". MSW's own debugging runbook documents that when interception succeeds
but matching fails there may be *no message at all*, and advises you to
"carefully examine the request printed in the previous debugging step and find
any typos".

That is a bad place to leave someone. The tool knows exactly which recorded
interaction nearly matched and exactly which byte differed; it just does not say.

## What Spool prints instead

```
REQUEST MISMATCH

  POST https://api.example.com/api/users

  Closest candidate: create-user  (6/7 fields matched)

    ✓ method:   POST
    ✓ scheme:   https
    ✓ host:     api.example.com
    ✓ port:     (scheme default)
    ✓ path:     /api/users
    ✓ query:
    ✗ body:     json.unexpected-member
      at /role
        expected  (absent)
        received  admin
        unexpected

  1 other candidate checked. Set SPOOL_EXPLAIN=all to see them.

  Suggested action
    Allow unexpected members in the request body:
      interactions[1].match.body.json.extra = "allow"
    Ignore the request-body field /role:
      interactions[1].match.body.json.ignore = ["/role"]

  Each suggestion was verified: applying it makes this request match.
```

Showing what *matched* is as important as showing what did not. Six ticks and
one cross locates the problem in a glance; the cross alone leaves you wondering
whether you have the right endpoint at all.

## The rule that makes it trustworthy

**A suggestion is never printed unless it has been verified.**

Verification is not a heuristic. For each candidate change, the engine:

1. applies it to a copy of the effective match configuration,
2. re-runs the matcher against the same live request,
3. and only emits the suggestion if the request now matches.

So "Each suggestion was verified" is a claim you can check, and the conformance
suite checks it on every explain case in both implementations — not only where a
case happens to assert it.

When nothing verifies, Spool says so and suggests nothing:

```
  No single configuration change makes the closest candidate match,
  so no fix is suggested. Re-record the fixture, or compare the
  differences above by hand.
```

This is the harder discipline and the more useful behaviour. A plausible-looking
wrong suggestion costs more time than silence, because you follow it.

## Ranking

Candidates are ordered by score descending, then total descending, then document
index ascending ([§13.2](../specification/hif-1.0.md#132-scoring-and-ordering)).
Score is the number of compared fields that matched; total is the number
compared. Fields set to `ignore` are not counted either way.

The final tie-break on index is what makes the report reproducible. Without it,
two equally-close candidates could swap places between runs depending on hash
iteration order, and a test that prints the report would be flaky.

## Depletion

A candidate that matches perfectly but has no plays left is reported as depleted
rather than as an ordinary mismatch:

```
    ✗ replay:   already played 1 of 1 times

      This interaction matches the request in every compared field,
      but its play count is exhausted. Either the code under test
      makes more calls than were recorded, or the fixture needs
      "replay": { "times": 2 } or "unlimited".
```

"You called this three times but recorded it twice" is the actual cause. Showing
it as a field-by-field diff — every field matching, no explanation — is baffling,
and it is what most tools do.

No suggestion is offered here, because no configuration change fixes it. The
fixture needs another recording or a higher play count.

## Reason codes

Every difference carries a stable identifier from
[§13.3](../specification/hif-1.0.md#133-field-reasons), so tooling can act on
them:

| Group | Codes |
| --- | --- |
| Scalar | `value-differs` |
| Query | `query.missing-param`, `query.unexpected-param`, `query.value-differs` |
| Headers | `header.missing`, `header.unexpected`, `header.value-differs`, `header.count-differs` |
| Body | `body.encoding-differs`, `body.not-json`, `body.not-text`, `body.bytes-differ`, `body.text-differs` |
| JSON | `json.missing-member`, `json.unexpected-member`, `json.type-differs`, `json.value-differs`, `json.array-length-differs`, `json.placeholder-unsatisfied` |
| Other | `depleted`, `fault-only` |

These are part of the specification, not implementation detail, so a CI
annotation or an editor plugin can rely on them.

## Using it

From a shell:

```bash
spool explain fixtures/users.hif.json request.json
spool explain fixtures/users.hif.json request.json --all --color
spool explain fixtures/users.hif.json '{"method":"GET","url":"https://x/y"}' --json
```

Exit code 1 when the request does not match, 0 when it does.

From code, without consuming a play:

```ts
const report = player.explainRequest(request);
console.log(renderMismatch(report, { all: true }));
```

```python
report = player.explain_request(request)
print(render_mismatch(report, all_candidates=True))
```

The report is a plain data structure with a specified shape, so you can build
your own presentation — a CI annotation, an editor hover — on top of it.

## Both implementations print the same bytes

The report *structure* is normative; the rendering is not. But the two
implementations are held to byte-identical output anyway, by
`conformance/cross-check.sh` in CI.

A polyglot team should not have to learn two failure formats, and "it depends
which language your service is in" would undercut the point of a shared
explanation engine.
