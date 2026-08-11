# Spool

**Record HTTP traffic once. Replay it from any language.**

Spool is a toolkit for HTTP record/replay in tests, built around **HIF** — a
portable fixture format that is specified independently of any implementation.
A fixture recorded from Python replays from TypeScript, byte for byte, because
the fixture is a specification rather than one library's internal state.

```bash
npm install --save-dev @spool/hif      # TypeScript / JavaScript
pip install spool-hif                  # Python
```

> **Not published yet.** These package names are reserved for the first release
> but nothing is on npm or PyPI, so the two commands above will fail today. Until
> then, use it from a clone — see [Install from source](#install-from-source).

---

## Why this exists

Every ecosystem has rebuilt HTTP record/replay independently: VCR in Ruby lists
ports in fifteen languages, and Node has nock, MSW and Polly.JS. None of their
fixture formats can read each other's files — VCR.py's own documentation states
that it does not aim to match Ruby VCR's format. The one candidate standard,
HAR, is a browser *network log*: its W3C draft is marked "DO NOT USE … has been
abandoned", and it defines nothing about request matching, redaction, dynamic
values or fault injection, so every tool that adopts it invents a private layer
on top.

Spool takes the other approach: [specify the artifact first](./specification/hif-1.0.md),
then implement it more than once, and hold both implementations to
[the same conformance suite](./conformance/).

## The part you will notice first

Every record/replay tool eventually tells you "request did not match". Spool
tells you which one nearly matched, what differed, and what would fix it:

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

That last line is a guarantee, not a figure of speech. A suggestion is only
printed after the engine has applied it, re-run the matcher and observed the
request match. When no single change explains the failure, Spool says so and
suggests nothing — [§13.4](./specification/hif-1.0.md#134-suggestions) forbids
guessing, because a wrong lead costs more time than silence.

## Five-minute start

**TypeScript**

```ts
import { installReplay } from '@spool/hif/fetch';
import { readFileSync } from 'node:fs';

const spool = installReplay(readFileSync('fixtures/users.hif.json', 'utf8'));
try {
  const user = await getUser(7);        // your code, unchanged
  expect(user.name).toBe('Ada');
  spool.assertComplete();               // every `expect` in the fixture held
} finally {
  spool.restore();
}
```

**Python**

```python
import httpx
from spool.adapters.httpx_adapter import SpoolReplayTransport

transport = SpoolReplayTransport(open("fixtures/users.hif.json").read())
client = httpx.Client(transport=transport)

user = get_user(client, 7)              # your code, unchanged
assert user["name"] == "Ada"
transport.assert_complete()
```

A fixture is readable JSON, and you can write one by hand in under a minute:

```json
{
  "hif": "1.0",
  "interactions": [
    {
      "request": { "method": "GET", "url": "https://api.example.com/users/7" },
      "response": {
        "status": 200,
        "headers": [["content-type", "application/json"]],
        "body": { "encoding": "json", "json": { "id": 7, "name": "Ada" } }
      }
    }
  ]
}
```

That is a complete, valid fixture. Everything else in the format is opt-in.

## Using it from a language with no library

You do not need an adapter, or even a Spool package in your language. Serve the
fixture as a plain HTTP origin and point your client's base URL at it:

```bash
npx @spool/hif serve fixtures/users.hif.json
#  spool serving 3 interaction(s) at http://127.0.0.1:8080
#  Requests are matched as if sent to https://api.example.com
#
#    export API_BASE_URL=http://127.0.0.1:8080
```

Every request is matched by the same engine, with the same rules. An unmatched
request answers **551** with the full explanation in the body, so a Go, Rust or
Java test gets the same diagnosis as a TypeScript one.

`spool proxy` does the same over `HTTP_PROXY` for plain-HTTP traffic, which also
handles fixtures spanning several origins. It deliberately does **not** serve
https through a CONNECT tunnel: that needs a man-in-the-middle certificate
authority, which is not something a test tool should install on your machine.
`serve` covers https origins without one.

## What you get beyond "it replays"

| | |
| --- | --- |
| **Explained mismatches** | Ranked candidates, the exact differing path, verified fixes. [§13](./specification/hif-1.0.md#13-mismatch-explanation) |
| **Redaction on by default** | Auth headers, cookies, credential-shaped query and JSON fields, plus optional entropy detection — applied before anything reaches disk. [§9](./specification/hif-1.0.md#9-redaction) |
| **Dynamic values** | `{{any:uuid}}`, `{{any:iso8601}}`, `{{regex:...}}` so a fresh timestamp or request id does not break a fixture. [§7.6](./specification/hif-1.0.md#76-placeholders) |
| **Fault and latency simulation** | Connection resets, timeouts, DNS failures, truncated bodies — raised as your client's own error type. [§10](./specification/hif-1.0.md#10-fault-simulation) |
| **Retry testing for free** | Two interactions with the same request replay in order, so "fails then succeeds" needs no special API. [§7.5](./specification/hif-1.0.md#75-selection-algorithm) |
| **Deterministic by construction** | No clock, no environment, no unordered iteration anywhere in matching or reporting. |
| **Byte-exact bodies** | Binary via base64, non-UTF-8 header values, and a warning when a large integer would not survive a JSON round trip. [§12.3](./specification/hif-1.0.md#123-numbers) |
| **Local only** | No service, no account, no telemetry. Fixtures are files in your repository. |

## Repository layout

| Path | What is in it |
| --- | --- |
| [`specification/`](./specification/) | The HIF 1.0 specification and JSON Schema. Independently implementable. |
| [`implementations/typescript/`](./implementations/typescript/) | `@spool/hif` — core, `fetch` and `node:http` adapters, CLI with `serve`/`proxy`. Zero runtime dependencies. |
| [`implementations/python/`](./implementations/python/) | `spool-hif` — core, `httpx` and `requests` adapters, CLI with `serve`/`proxy`. Zero required runtime dependencies. |
| [`conformance/`](./conformance/) | Language-neutral test cases every implementation must pass, plus a cross-implementation parity check. |
| [`examples/`](./examples/) | Runnable Vitest, pytest, and one-fixture-two-languages examples. |
| [`docs/`](./docs/) | Guides, and the reasoning behind the design decisions. |

## Implementations

| Language | Package | Conformance level | Adapters |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `@spool/hif` | Full | global `fetch`, `node:http` / `node:https` (axios, got, node-fetch v2, superagent) |
| Python | `spool-hif` | Full | `httpx`, `requests` |
| Any other language | — | — | `spool serve` / `spool proxy`, no library needed |

Conformance levels are defined in [§15](./specification/hif-1.0.md#15-conformance)
and are asserted by the suite, not declared on trust. Ports to Go, Rust, Java and
others are welcome — [start here](./docs/contributing-implementations.md).

## The CLI

Both packages ship the same `spool` command.

```bash
spool lint fixtures/*.hif.json        # validate, and flag suspicious configuration
spool inspect fixtures/users.hif.json # what is in this fixture?
spool scan fixtures/                  # report suspected secrets
spool redact fixtures/old.hif.json    # apply redaction to an existing fixture
spool explain fixtures/users.hif.json request.json
spool diff before.hif.json after.hif.json
spool import har capture.har          # convert a browser HAR, reporting what it drops
spool serve fixtures/users.hif.json   # replay over HTTP, for any language
spool proxy fixtures/users.hif.json   # replay via HTTP_PROXY
```

## Honest limitations

- **Redaction reduces exposure; it does not guarantee removal.** Rule- and
  entropy-based detection have false negatives. Review fixtures before
  committing them. Nothing in Spool will ever tell you a fixture is "clean".
- **JSON bodies lose byte fidelity.** Key order, whitespace and exact numeric
  literals are not recoverable, and integers beyond 2^53 are corrupted. Spool
  detects that case and warns, but if you need the original bytes, record with
  `preserveBytes`.
- **No streaming.** Server-sent events and chunked responses can be recorded as
  their concatenated bytes; chunk boundaries and their timing are lost.
- **HTTP only.** WebSockets and gRPC are out of scope for 1.0.

## Install from source

Until the packages are published this is the only way to use Spool, and it is
also how you would work on it.

```bash
git clone https://github.com/totosoftsro/spool.git
cd spool

# TypeScript: build once, then depend on the directory
(cd implementations/typescript && npm ci && npm run build)
npm install --save-dev /path/to/spool/implementations/typescript

# Python
pip install -e /path/to/spool/implementations/python[httpx]
```

The CLI runs from the build without installing anything:

```bash
node /path/to/spool/implementations/typescript/dist/cli.js lint fixtures/*.hif.json
```

[`examples/`](./examples/) resolves the implementations this way, so every example
runs on a fresh clone with no registry access.

## Contributing

Good first issues are listed in [CONTRIBUTING.md](./CONTRIBUTING.md), and the
most valuable ones are not code: a conformance case that makes two
implementations disagree is worth more than a feature.

- [Contributing guide](./CONTRIBUTING.md)
- [Adding a client adapter](./docs/contributing-adapters.md)
- [Adding a language implementation](./docs/contributing-implementations.md)
- [Governance](./GOVERNANCE.md) · [Security policy](./SECURITY.md) · [Code of conduct](./CODE_OF_CONDUCT.md)

## Licence

[Apache-2.0](./LICENSE). The specification is published under
[CC BY 4.0](./specification/LICENSE) so it can be implemented and quoted freely,
including in projects that are not Apache-licensed.
