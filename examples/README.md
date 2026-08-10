# Examples

All three are runnable and are exercised in CI, so they cannot rot.

| Example | Shows |
| --- | --- |
| [`cross-language/`](./cross-language/) | **Start here.** One fixture replayed from both Python and Node. The reason the format exists. |
| [`typescript-vitest/`](./typescript-vitest/) | Vitest, global `fetch`, placeholders for values that change every run, fault simulation. |
| [`python-pytest/`](./python-pytest/) | pytest, httpx, `defaults.match` to ignore a generated field, retry-after-failure. |
| [`serve-any-language/`](./serve-any-language/) | `spool serve` replayed by **curl** — no Spool library, no adapter. The proof that any language works. |

Every fixture here is validated by `spool lint` in CI. A broken example is worse
than no example.

## What each one deliberately demonstrates

**cross-language** — a redacted `authorization` header that still replays, a
placeholder for a client-controlled `user-agent`, header matching narrowed to
the one header that matters, an error response as an ordinary interaction, and
retry-after-rate-limit expressed purely through document order.

**typescript-vitest** — a client whose request body contains a fresh timestamp
and a fresh UUID on every call, matched with `{{any:iso8601}}` and
`{{any:uuid}}`; a simulated upstream timeout that exercises the client's own
catch block; and an unmatched request whose report names the differing query
parameter.

**python-pytest** — `defaults.match.body.json.ignore` dropping a generated
idempotency key, so the test does not have to patch `uuid.uuid4`; a 402 handled
as a domain error; and a connection reset followed by a successful retry.

**serve-any-language** — the same matching engine reached over a socket by a
client that knows nothing about Spool, including a POST that is correctly
rejected for having the wrong body, and a 551 carrying the full explanation.

## Running them

```bash
cd cross-language && ./run.sh
```

```bash
cd typescript-vitest && npm install && npm test
```

```bash
cd python-pytest && PYTHONPATH=../../implementations/python/src pytest tests -q
```

```bash
cd serve-any-language && ./run.sh
```

The examples resolve the implementations from this repository rather than from
published packages, so they work on a fresh clone.
