# Migrating from other tools

You do not have to migrate everything. Spool works alongside whatever you use
now — start with one test file.

## From VCR / VCR.py / go-vcr / Betamax

The mental model transfers directly: a cassette is a fixture, an HTTP
interaction is an interaction. What changes is that the fixture is specified, so
it is portable and so its matching rules are written down.

| VCR concept | HIF equivalent |
| --- | --- |
| Cassette | Fixture (`.hif.json`) |
| `record: :once` / `:none` / `:new_episodes` | Not in the format. Recording mode is a recorder option, not fixture data. |
| `match_requests_on: [:method, :uri]` | `match` — but far more granular; see [matching.md](./matching.md) |
| `allow_playback_repeats` | `replay: { "times": "unlimited" }` |
| `filter_sensitive_data` | Redaction, on by default; see [redaction.md](./redaction.md) |
| ERB / dynamic cassettes | Placeholders (`{{any:uuid}}`, `{{regex:...}}`) |
| Serialized as YAML | JSON, so it is diffable and has one parser everywhere |

There is no automated converter, because VCR's YAML shape differs per port and
per version. In practice re-recording is faster and more reliable than
conversion — and it verifies the upstream API still behaves as the old cassette
claims.

**The thing to be aware of:** VCR's default matches on method and URI only.
HIF's default also compares the request body, which is usually what you want and
is occasionally a surprise. If a migrated fixture fails on a body difference,
`spool explain` will show you the field and offer the verified fix.

## From nock

nock is an API, not a format — assertions live in code. Moving to Spool means
moving that description into data.

```js
// nock
nock('https://api.example.com')
  .post('/users', { name: 'Ada' })
  .reply(201, { id: 7 });
```

```json
{
  "hif": "1.0",
  "interactions": [
    {
      "request": {
        "method": "POST",
        "url": "https://api.example.com/users",
        "body": { "encoding": "json", "json": { "name": "Ada" } }
      },
      "response": {
        "status": 201,
        "headers": [["content-type", "application/json"]],
        "body": { "encoding": "json", "json": { "id": 7 } }
      },
      "expect": { "called": "once" }
    }
  ]
}
```

| nock | HIF |
| --- | --- |
| `.times(n)` | `replay: { "times": n }` |
| `.persist()` | `replay: { "times": "unlimited" }` |
| `scope.done()` | `expect: { "called": "once" }` plus `assertComplete()` |
| `.replyWithError()` | `fault: { "type": "connection-reset" }` |
| `.delay(ms)` | `timing: { "latencyMs": ms }`, honoured only when latency simulation is enabled |
| A function matcher | A placeholder, or `match.body.json.ignore` |

**Note:** nock intercepts `http.ClientRequest`, so it covers axios and got.
Spool's TypeScript adapter currently covers global `fetch` only. If your code
uses axios on Node, the adapter you need does not exist yet — see
[contributing-adapters.md](./contributing-adapters.md). Better to know that now
than after the migration.

## From MSW

MSW's strength is running the same handlers in Node and the browser. Spool does
not do browser interception, so it is not a replacement for that use.

Where it does help is the part MSW's own documentation calls out as hard: when
interception succeeds but no handler matches, MSW may produce no message at all.
A HIF fixture in that situation tells you which recorded interaction nearly
matched and what differed.

The two can coexist: MSW for browser and hand-written handlers, HIF fixtures for
recorded server-side integration tests.

## From HAR files

HAR is close enough to convert, and lossy in both directions
([Appendix B](../specification/hif-1.0.md#appendix-b--relationship-to-har)).

| Converts cleanly | Lost going HAR to HIF |
| --- | --- |
| `entries[].request` / `.response` | `pages`, `cache`, `serverIPAddress`, `connection` |
| `time` becomes `timing.latencyMs` | the detailed `timings` breakdown |
| Base64 content | — |
| Cookie objects, flattened into header fields | cookie attributes not present in the header |

Two things to do by hand after converting:

1. **Set matching rules.** HAR has no notion of them, so a conversion gets the
   §7.1 defaults. A browser-captured HAR usually needs
   `headers: { mode: "none" }` (the default) and often `query.ignore` for
   cache-busting parameters.
2. **Run redaction.** HAR does no redaction, and a browser HAR is full of
   cookies and auth headers. `spool redact converted.hif.json` is the minimum;
   reading the file is better.

A `spool import har` command is a
[good first issue](../CONTRIBUTING.md#good-first-issues). It must report what it
dropped.

## From hand-rolled mocks

If you currently return canned dictionaries from a stubbed client, the win is
not the fixture format — it is that you stop testing your stub. A recorded
fixture is what the API actually said, and `spool diff` against a fresh
recording tells you when that stops being true.

Start with the test that has the most elaborate stub. That is usually the one
where the stub has drifted furthest from reality.

## Running both during migration

Nothing conflicts. Adapters are per-client, and the `fetch` adapter restores the
previous global on `restore()`. Migrate one file at a time and keep the rest as
it is.
