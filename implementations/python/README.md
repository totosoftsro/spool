# spool-hif

Record and replay HTTP traffic using the portable [HIF](../../specification/hif-1.0.md)
fixture format. Deterministic matching, explained mismatches, redaction on by
default.

```bash
pip install spool-hif              # core and CLI
pip install 'spool-hif[httpx]'     # with the httpx transport
pip install 'spool-hif[requests]'  # with the requests adapter
```

- Python 3.9+
- **Zero required runtime dependencies** — adapters import their client lazily
- Conformance level: **Full** (HIF 1.0)

## Replay with httpx

```python
import httpx
from spool.adapters.httpx_adapter import SpoolReplayTransport

transport = SpoolReplayTransport(open("fixtures/users.hif.json").read())
with httpx.Client(transport=transport) as client:
    response = client.get("https://api.example.com/users/7")
    print(response.json())

transport.assert_complete()   # every `expect` in the fixture held
```

## Replay with requests

```python
import requests
from spool.adapters.requests_adapter import mount

session = requests.Session()
adapter = mount(session, open("fixtures/users.hif.json").read())

response = session.get("https://api.example.com/users/7")
adapter.assert_complete()
```

## Record

```python
import httpx
from spool.adapters.httpx_adapter import SpoolRecordTransport

transport = SpoolRecordTransport()
with httpx.Client(transport=transport) as client:
    exercise_your_code(client)

open("fixtures/users.hif.json", "w").write(transport.to_json())
print(transport.redaction_summary())   # never claims the fixture is safe
```

## Serving a fixture over HTTP

For code you cannot instrument — another process, a container, a language with
no adapter:

```python
from spool.serve import serve_fixture

with serve_fixture(fixture, port=0) as server:
    run_tests(server.url)
```

Or from the CLI, `spool serve`. See [docs/serving.md](../../docs/serving.md).

## Public API

Everything in `spool.__all__` is public and follows semantic versioning.
Adapters live under `spool.adapters` and are imported explicitly.

## A note on canonical JSON

RFC 8785 defines number serialization as ECMAScript `Number::toString`, which
Python's `repr` does not match: `100.0` versus `100`, `1e-07` versus `1e-7`,
`1e20` written in full versus not. `spool.canonical.es_number_to_string`
implements the ECMAScript algorithm directly, and every boundary case is pinned
by the conformance suite and cross-checked against a JavaScript engine.

This matters if you use `canonicalize()` for anything of your own: it produces
byte-identical output to JavaScript, which `json.dumps` does not.

## CLI

```bash
spool lint fixtures/*.hif.json
spool explain fixtures/users.hif.json request.json
```

Same commands and behaviour as the TypeScript CLI; the parity is checked in CI.
Full reference: [docs/cli.md](../../docs/cli.md).

## Development

```bash
pip install -e '.[dev]'
ruff check src tests
mypy
pytest -q                          # unit tests plus the shared conformance suite
pytest tests/test_conformance.py   # the shared suite only
```
