# Using HIF from any language

Two commands turn a fixture into something any HTTP client can talk to, with no
Spool library in your language:

| Command | What the client does | Use when |
| --- | --- | --- |
| `spool serve` | Points its base URL at the server | Almost always. Handles https origins. |
| `spool proxy` | Sets `HTTP_PROXY` | The fixture spans several origins, and the traffic is plain http. |

Matching, mismatch explanations and redaction are the same engine as the
in-process adapters. Nothing is reimplemented for the server path — the
conformance suite and `cross-check.sh` cover both.

## serve

```bash
spool serve fixtures/users.hif.json
```

```
spool serving 3 interaction(s) at http://127.0.0.1:8080
Requests are matched as if sent to https://api.example.com

  export API_BASE_URL=http://127.0.0.1:8080
```

Your client speaks plain HTTP to localhost; the fixture still describes the
original `https://api.example.com` origin. That mapping is the whole trick, and
it is why no TLS interception is needed.

### The origin

An incoming request arrives as `GET /v1/users/7` with no scheme or host, so the
server has to decide what that means before it can match. It maps the path onto
an **origin**:

- If every interaction in the fixture shares one origin, that one is used.
- Otherwise `serve` refuses to guess and asks for `--origin`.

```bash
spool serve fixtures/mixed.hif.json --origin https://api.example.com
```

Refusing to guess matters: silently picking the first origin would make requests
meant for a second host match the wrong recordings.

### Several fixtures at once

```bash
spool serve fixtures/users.hif.json fixtures/orders.hif.json
```

Interactions are concatenated in file order, and §7.5 selection then works
across the whole set exactly as it does within one file.

### Options

| Option | |
| --- | --- |
| `--port <n>` | Default 8080. `--port 0` picks a free port, which is what you want in CI. |
| `--origin <url>` | Required when the fixture spans origins. |
| `--latency` | Honour `timing.latencyMs`. Off by default. |

## proxy

```bash
spool proxy fixtures/users.hif.json
export HTTP_PROXY=http://127.0.0.1:8080
```

A client configured with a proxy sends the **full URL** on the request line, so
no origin mapping is needed and multi-origin fixtures work.

### https does not work through the proxy, deliberately

`spool proxy` answers a CONNECT request with 501 and an explanation.

Intercepting a TLS tunnel means generating a certificate for the target host and
persuading your client to trust the certificate authority that signed it.
Installing a MITM CA on a developer machine — or worse, in CI — is a bigger
security decision than a test tool should make for you, so Spool does not offer
it at all rather than offering it with a warning.

Use `spool serve` for https origins. It has no such problem, because the client
never negotiates TLS in the first place.

## What an unmatched request looks like

**HTTP 551**, with the §13 explanation as the response body and
`x-spool-error: no-matching-interaction` as a header.

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v1/nope
551
```

551 is outside the registered status range on purpose. A recorded API might
itself return 404 or 500, so a Spool failure must not be confusable with an
application response — a test asserting `status == 404` should never pass
because the fixture was missing an interaction.

Faults (§10) have no HTTP representation, so the server closes the connection
instead. Your client sees the socket error it would see for a real failure.

## Recording through the server

```bash
spool serve --record fixtures/api.hif.json --origin https://api.example.com
```

Requests are forwarded upstream, the responses are recorded, and the client gets
the real answer. Press Ctrl+C to write the fixture.

Redaction runs before anything is written, exactly as with in-process recording
(§9). `--no-redact` disables it and says so in capitals.

This is a reverse proxy, so it needs `--origin`. Recording through a *forward*
proxy is not supported, for the CONNECT reason above.

## In CI

```bash
spool serve fixtures/api.hif.json --port 8080 &
SPOOL=$!
trap 'kill $SPOOL' EXIT

API_BASE_URL=http://127.0.0.1:8080 go test ./...
```

Two things worth doing:

- **Use `--port 0` and read the port from the output** if jobs run in parallel
  on one machine, so they cannot collide.
- **Fail the build on a 551.** Most test suites will do this for you, since a
  551 is not a status any client treats as success. If yours swallows it, assert
  on the `x-spool-error` header.

## Calling it from code

Both implementations expose the servers as an API, which is usually nicer than
shelling out from an integration test:

```ts
import { serveFixture } from '@spool/hif';

const server = await serveFixture(fixture, { port: 0 });
try {
  await runYourTests(server.url);
} finally {
  await server.close();
}
```

```python
from spool.serve import serve_fixture

with serve_fixture(fixture, port=0) as server:
    run_your_tests(server.url)
```

`port: 0` binds a free port and reports it, which removes the whole class of
port-collision flakiness from parallel test runs.

## Which to use

Reach for an in-process adapter when your language has one — it is faster, needs
no port, and gives you `assertComplete()` and typed errors directly. Reach for
`serve` when it does not, or when the code under test is a separate process, a
container, or something you cannot instrument at all.
