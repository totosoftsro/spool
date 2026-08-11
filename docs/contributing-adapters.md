# Contributing a client adapter

An adapter connects the pure core to a real HTTP client. Each one is small and
self-contained — the four shipped adapters (`fetch` and `node:http` in
TypeScript, `httpx` and `requests` in Python) run from roughly 170 to 310 lines —
which makes this one of the best-scoped ways to contribute.

## What is missing

| Ecosystem | Client | Notes |
| --- | --- | --- |
| Python | `aiohttp` | Async, no adapter yet. Probably the biggest remaining gap. |
| Node | `undici` Dispatcher | Would let `fetch` be intercepted through undici's own seam rather than by replacing the global. |
| Python | `urllib3` directly | Below `requests`; some libraries use it straight. |
| Browser | Service Worker | Would let HIF fixtures back browser tests, in MSW's territory. |

## What an adapter does

Four things, in this order:

1. Convert the client's request into a HIF request object.
2. Ask the player to select an interaction.
3. Convert the chosen response back into the client's response type.
4. Translate a fault into the error the client raises for that real condition.

Everything else — matching, explanation, redaction, play counts — is already
done. An adapter must not reimplement any of it.

## The shape

```ts
import { Player, deliverable, faultError } from '@spool/hif';

const player = new Player(fixture);

async function handle(clientRequest) {
  // 1. Convert to a HIF request.
  const request = {
    method: clientRequest.method.toUpperCase(),
    url: clientRequest.url,
    headers: toEntries(clientRequest.headers),   // [[name, value], ...]
    body: encodeBody(bodyBytes, contentType),
  };

  // 2. Select. Throws HifMatchError with the explanation already rendered.
  const play = player.select(request);
  await player.delay(play);                      // no-op unless latency is on

  // 3. Faults become the client's own error type.
  if (play.fault && play.fault.type !== 'partial-response') {
    throw asClientError(faultError(play.fault));
  }

  // 4. Deliver. `deliverable` handles §8.1 header rules for you.
  const out = deliverable(play.response, play.fault?.type === 'partial-response');
  return buildClientResponse(out.status, out.statusText, out.headers, out.body);
}
```

## Rules

### Use the extension seam, do not monkeypatch

Prefer whatever the client documents: an `httpx` Transport, a `requests`
HTTPAdapter, an undici Dispatcher. Replacing a global is a last resort — the
`fetch` adapter does it only because `globalThis.fetch` has no seam — and when
you do, the handle must expose `restore()`.

### Faults must raise the client's own error type

[§10](../specification/hif-1.0.md#10-fault-simulation) requires this, and it is
the point of the feature: application code with `except httpx.TransportError`
should catch the simulated failure the same way it catches a real one. If the
client has no faithful equivalent for a fault type, use the closest and document
the mapping in a comment.

### Never consume the caller's body

Request bodies are often one-shot streams. Clone before reading. The `fetch`
adapter clones the `Request`, and there is a test asserting `request.bodyUsed`
is still `false` afterwards.

### Do not touch matching or reporting

If you find yourself normalizing a URL, lowercasing a header, or building an
error message about a mismatch, stop — the core does all of that, and doing it
twice is how implementations drift.

### Optional dependencies stay optional

Import the client lazily so that installing the package does not install every
supported client. Both Python adapters do this, and raise a clear ImportError
with the right `pip install` command if the client is absent.

## Tests an adapter needs

Model them on `implementations/python/tests/test_adapters.py`. At minimum:

- replays a JSON response with correct status, headers and body
- matches a POST by its body
- delivers a 204 with no body
- delivers a binary body byte-for-byte
- raises the client's transport error for a fault
- an unmatched request raises `HifMatchError` and does **not** reach the network
- `assert_complete` / `assertComplete` verifies expectations
- the original client state is restored, if anything was replaced

If your adapter shares an ecosystem with an existing one, add a test asserting
both select the same interaction for the same logical request. A difference
there means one adapter is normalizing something the other is not — exactly the
class of bug that makes fixtures non-portable.

## Where to put it

| | |
| --- | --- |
| TypeScript | `implementations/typescript/src/adapters/<client>.ts`, exported via a subpath in `package.json` |
| Python | `implementations/python/src/spool/adapters/<client>_adapter.py`, with an optional-dependency extra in `pyproject.toml` |

Update the adapter table in the root README and in this file, and add a note to
`CHANGELOG.md`.

## Before you start

Open an issue saying which client you are targeting. Not for permission — to
avoid two people writing the same adapter, and so a maintainer can flag anything
awkward about that client's seam before you find it the hard way.
