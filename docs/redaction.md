# Redaction

> **Redaction reduces exposure. It does not guarantee removal.**
>
> Rule-based and entropy-based detection both have false negatives. Read fixtures
> before you commit them. Nothing in Spool will ever tell you a fixture is clean,
> and you should distrust any tool that does — a confident-sounding report is
> what stops people from looking.

Normative rules: [§9](../specification/hif-1.0.md#9-redaction).

## When it runs

At **record time**, before anything is written. A fixture on disk is already
redacted; nothing is re-applied on read. That ordering is the whole point: a
credential that never reaches disk cannot be committed by accident.

Redaction is on by default. Turning it off takes an explicit `redact: false`,
and the recorder's summary then says so in capitals.

## What is caught by default

**Header names** (case-insensitive, request and response):
`authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
`www-authenticate`, `proxy-authenticate`, `x-api-key`, `api-key`,
`x-auth-token`, `x-amz-security-token`, `x-csrf-token`, `x-xsrf-token`.

**Query parameter names**: `access_token`, `api_key`, `apikey`, `auth`, `code`,
`id_token`, `password`, `refresh_token`, `secret`, `session`, `signature`,
`sig`, `token`.

**JSON member names, at any depth**: `access_token`, `api_key`, `apiKey`,
`authorization`, `client_secret`, `credentials`, `id_token`, `password`,
`passwd`, `private_key`, `refresh_token`, `secret`, `session_token`, `token`.

**Entropy detection** on header and query values (on by default there, off for
text bodies).

These lists are in the specification rather than in each implementation, so two
recorders produce comparable fixtures.

## What is not caught

Be concrete about this, because the gaps are where the damage happens:

- **A credential in a bespoke header.** `X-Acme-Session` is not on any list.
- **A token in a URL path segment.** `/v1/reset/9f8e7d…` looks like a path.
- **Personal data in a response body.** A customer's name, email or address is
  not a credential by name or by shape, and no heuristic finds it reliably.
- **A low-entropy secret.** `password123` passes every entropy check.
- **A credential split across fields**, or one encoded inside a larger blob.
- **Anything in a binary body.** Base64 bodies are left untouched: pattern and
  entropy rules are defined over text, and guessing at bytes would be unsound.

## The replacement value

A redacted value becomes the string `{{redacted}}`, which under
[§7.6](../specification/hif-1.0.md#76-placeholders) matches anything.

Three properties follow, and all three are deliberate:

1. The redaction is **visible in review** — a diff shows it.
2. It is **machine-detectable** — `spool scan` can tell "already redacted" from
   "no secret here".
3. It **does not break replay** of the request it appears in. A redacted
   `authorization` header still matches whatever the live client sends, so your
   tests work with or without a token in the environment.

A redacted JSON member keeps its name and receives the string `"{{redacted}}"`
whatever its original type was. Preserving the original type would leak its
shape for no benefit.

## Configuring it

**TypeScript:**

```ts
installRecord({
  redact: {
    headers: ['x-acme-session'],
    queryParams: ['sessionId'],
    jsonFields: ['ssn'],
    jsonPaths: ['/customers/*/emailAddress'],
    patterns: [{ name: 'aws-access-key', regex: 'AKIA[A-Z0-9]{16}' }],
    entropy: { textBodies: true, minBits: 3.8 },
  },
});
```

**Python:**

```python
from spool import EntropyConfig, RedactionConfig
from spool.adapters.httpx_adapter import SpoolRecordTransport
from spool.player import Recorder

config = RedactionConfig(
    headers=["x-acme-session"],
    query_params=["sessionId"],
    json_fields=["ssn"],
    json_paths=["/customers/*/emailAddress"],
    patterns=[{"name": "aws-access-key", "regex": "AKIA[A-Z0-9]{16}"}],
    entropy=EntropyConfig(text_bodies=True, min_bits=3.8),
)
transport = SpoolRecordTransport(Recorder(redact=config))
```

Custom rules **extend** the defaults. Pass `replaceDefaults` / `replace_defaults`
to start from nothing, which you should almost never want.

`patterns` use the same portable regex subset as `{{regex:...}}`
([§7.6.2](../specification/hif-1.0.md#762-regex)), so a pattern behaves
identically in both implementations.

## Entropy detection

Catches credentials no rule names. It is a heuristic with false positives and
false negatives in both directions, and the algorithm is specified
([§9.4](../specification/hif-1.0.md#94-entropy-detection)) so that two recorders
redact the same tokens.

1. Split on characters outside `[A-Za-z0-9+/_-]`, then absorb trailing `=`
   padding.
2. Discard tokens shorter than 24 or longer than 512 characters.
3. Discard tokens that are not credential-shaped: base64 alphabet plus `-` and
   `_`, with at least one digit *and* at least one letter.
4. Compute Shannon entropy in bits per character.
5. Redact at or above 3.5 bits per character.

Step 1 excludes `=` from the splitting alphabet deliberately. If `=` split
nothing, `key=AKIAIOSFODNN7EXAMPLE` would be one token and every `name=value`
pair in a query string would be glued to its name — changing both the entropy
figure and what gets replaced. A conformance case pins this.

**Defaults: on for header and query values, off for text bodies.** A prose or
HTML body produces false positives that silently corrupt a fixture; a header
value that looks like a credential almost always is one.

## Checking an existing fixture

Fixtures arrive from elsewhere — converted from HAR, hand-written, recorded
before a rule was added.

```bash
spool scan fixtures/                  # report suspicions, change nothing
spool redact fixtures/old.hif.json -o fixtures/old.hif.json
```

`scan` reports *suspicions*, never confirmations, and when it finds nothing it
says exactly what that does and does not mean:

```
No rule matched.

This is not a guarantee. Rule- and entropy-based detection have false
negatives; review the fixture before publishing it.
```

Findings are informational: `scan` exits 0 either way. Use `--json` with your
own policy if you want a CI gate.

## Practical advice

- **Record against staging, not production.** Redaction is a safety net, not a
  substitute for not capturing real customer data.
- **Read the diff.** A fixture is JSON in a pull request. This is the single
  most effective control and it costs thirty seconds.
- **Add `spool scan` to CI** as an informational step, so new fixtures get a
  second look.
- **Rotate anything that leaks.** Removing the commit is not sufficient.
- **Check `meta.redaction`** in a fixture you did not record. `applied: false`
  means no rule fired, which is not the same as "no secrets".
