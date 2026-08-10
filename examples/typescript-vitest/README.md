# Vitest example

Replaying a HIF fixture in a Vitest suite, using the global `fetch` adapter.

```bash
npm install
npm test
```

## What is here

| File | |
| --- | --- |
| [`src/weather.ts`](./src/weather.ts) | The code under test. It knows nothing about Spool. |
| [`weather.test.ts`](./weather.test.ts) | The tests. |
| [`fixtures/weather.hif.json`](./fixtures/weather.hif.json) | The fixture. |

## The three things worth reading

**A body that changes on every call.** `submitReading` puts a fresh
`new Date().toISOString()` and a fresh `crypto.randomUUID()` in its request
body. A literal recording would never match twice. The fixture records them as
`{{any:iso8601}}` and `{{any:uuid}}`, so the test does not have to freeze the
clock or inject a UUID factory — the production code path runs exactly as it
would in production.

**A simulated timeout.** The `upstream-down` interaction has
`fault: { "type": "timeout" }` instead of a response, so `fetch` rejects the way
it would against a dead upstream. That exercises `forecastOrNull`'s own catch
block, which is normally hard to reach without a fault-injection proxy.

**A redacted key that still works.** The API key was redacted at record time, so
the fixture contains `{{redacted}}`, which matches anything. The test passes
`'whatever-you-like'` as the key and replay works — no secret in the repository,
no test-only configuration.

## The failure case

The last test asks for a different city and asserts on the report. Run it and
look at the output: it names the query parameter that differs rather than saying
the request did not match.
