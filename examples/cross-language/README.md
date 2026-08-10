# The same fixture, two languages

This is the example that justifies the format's existence.

[`fixtures/github-user.hif.json`](./fixtures/github-user.hif.json) is one file.
The Python test and the TypeScript test in this directory both replay it, and
both assert the same behaviour: a successful lookup, a 404, and a rate-limit
response followed by a successful retry.

Nothing is generated per-language. There is no Python cassette and no JS
cassette. There is a fixture.

## Run it

```bash
cd examples/cross-language && ./run.sh
```

Or one side at a time:

```bash
python -m pytest test_client.py -q
```

```bash
node --test client.test.mjs
```

## What the fixture demonstrates

| Feature | Where |
| --- | --- |
| Redacted `authorization` header that still replays | `get-octocat`, `{{redacted}}` |
| A placeholder for a value the client controls | `get-octocat`, `user-agent: {{any}}` |
| Header matching limited to the one header that matters | `defaults.match.headers` |
| An error response as an ordinary interaction | `get-missing-user`, 404 |
| Retry-after-failure without any special construct | `rate-limited-then-ok` then `repos-after-retry` |
| An interaction that may be replayed any number of times | `replay: { times: "unlimited" }` |
| An assertion that the fixture was actually exercised | `expect: { called: "atLeastOnce" }` |

The retry pair is worth a second look. Two interactions with the same recorded
request replay in document order (spec §7.5), so "first call is rate limited,
second succeeds" needs no sequencing feature — it falls out of the selection
algorithm. Most tools need a special API for this.

## Why the fixture looks the way it does

`defaults.match.headers` restricts header matching to `accept`. The default is
to compare no headers at all, which is right for most fixtures; here the API's
behaviour genuinely depends on `accept`, so it is compared, and nothing else is.
That means a `user-agent` change from a dependency upgrade cannot break these
tests.

The `authorization` value is `{{redacted}}`, written by the recorder. Under
spec §7.6 that matches any value, so the fixture replays whether or not a token
is present in the environment — and the token itself never reached disk.
