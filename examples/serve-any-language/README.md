# Replaying from a language with no Spool library

The client here is **curl**, chosen because it is the least Spool-aware HTTP
client imaginable. It has no adapter, no plugin, and no knowledge of HIF. It
just sets a base URL.

```bash
./run.sh
```

```
Replaying api.hif.json through curl at http://127.0.0.1:18099
  ok   GET returns the recorded body
  ok   GET returns the recorded content type
  ok   POST is matched by its body
  ok   a POST with the wrong body does not match
  ok   binary bodies survive byte for byte
  ok   an unrecorded request answers 551
  ok   the 551 body carries the explanation

All checks passed using nothing but curl.
```

Anything that can point at a base URL works the same way: Go, Rust, Java, Ruby,
PHP, a shell script, a service in a container.

## How it works

```bash
spool serve api.hif.json --port 18099
export API_BASE_URL=http://127.0.0.1:18099
```

The fixture records `https://api.example.com/...`. The client talks plain HTTP
to localhost. `serve` maps one onto the other, which is why no TLS interception
and no certificate authority are involved. Full guide:
[docs/serving.md](../../docs/serving.md).

Matching is the same engine as the in-process adapters — same rules, same
defaults, same explanations. Note the fourth check: a POST with the wrong body
is **not** matched, so body matching is genuinely happening rather than the
server answering on path alone.

## The failure case

An unrecorded request comes back as **551** with the full mismatch explanation
in the body:

```bash
curl -s http://127.0.0.1:18099/v1/nope
```

```
REQUEST MISMATCH

  GET https://api.example.com/v1/nope

  Closest candidate: get-user  (6/7 fields matched)
  ...
```

551 is deliberately outside the registered status range: a recorded API might
itself return 404 or 500, and a test asserting on those must never pass because
the fixture was missing an interaction.

## The one thing to notice in the fixture

Every interaction the demo calls more than once sets:

```json
"replay": { "times": "unlimited" }
```

Play counts default to 1 (§7.5). That is right for a test asserting an endpoint
is called exactly once, and wrong for a server that a readiness probe and
several test cases all hit. When writing a fixture for `serve`, be explicit.
