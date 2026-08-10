# Getting started

Two paths: write a fixture by hand (fastest way to understand the format), or
record one from real traffic.

## Install

```bash
npm install --save-dev @spool/hif
```

```bash
pip install spool-hif
```

Neither package has required runtime dependencies. The Python adapters import
`httpx` or `requests` lazily, so you only need the client you actually use.

## Path 1: write a fixture by hand (2 minutes)

Create `fixtures/users.hif.json`:

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

Check it:

```bash
npx spool lint fixtures/users.hif.json
```

Use it. **TypeScript:**

```ts
import { installReplay } from '@spool/hif/fetch';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';

let spool: ReturnType<typeof installReplay>;

beforeEach(() => {
  spool = installReplay(readFileSync('fixtures/users.hif.json', 'utf8'));
});
afterEach(() => spool.restore());

test('fetches a user', async () => {
  const response = await fetch('https://api.example.com/users/7');
  expect(await response.json()).toEqual({ id: 7, name: 'Ada' });
});
```

**Python:**

```python
import httpx, pytest
from spool.adapters.httpx_adapter import SpoolReplayTransport

@pytest.fixture
def client():
    transport = SpoolReplayTransport(open("fixtures/users.hif.json").read())
    with httpx.Client(transport=transport) as http:
        yield http

def test_fetches_a_user(client):
    response = client.get("https://api.example.com/users/7")
    assert response.json() == {"id": 7, "name": "Ada"}
```

That is the whole loop. Your application code is untouched — no injected client,
no test-only branch, no interface extracted purely to enable mocking.

## Path 2: record from real traffic

**TypeScript:**

```ts
import { installRecord } from '@spool/hif/fetch';
import { writeFileSync } from 'node:fs';

const spool = installRecord({ name: 'users-api' });
try {
  await exerciseYourCode();
} finally {
  writeFileSync('fixtures/users.hif.json', spool.toJSON());
  console.error(spool.redactionSummary());
  spool.restore();
}
```

**Python:**

```python
import httpx
from spool.adapters.httpx_adapter import SpoolRecordTransport

transport = SpoolRecordTransport()
with httpx.Client(transport=transport) as http:
    exercise_your_code(http)

open("fixtures/users.hif.json", "w").write(transport.to_json())
print(transport.redaction_summary())
```

Redaction runs before anything is written. **Read the fixture before you commit
it** — see [redaction.md](./redaction.md) for what is and is not caught.

## Making a fixture survive contact with reality

A freshly recorded fixture usually replays as-is. Three things commonly need
adjusting.

### A value that changes every run

A timestamp or a request id makes the body different on every call. Replace the
recorded value with a placeholder:

```json
"body": {
  "encoding": "json",
  "json": { "name": "Ada", "requestId": "{{any:uuid}}", "at": "{{any:iso8601}}" }
}
```

Or drop the field from comparison entirely:

```json
"match": { "body": { "json": { "ignore": ["/requestId"] } } }
```

Put it in `defaults.match` to apply it to every interaction in the file.

### The client sends more than you recorded

```json
"match": { "body": { "json": { "extra": "allow" } } }
```

When this is the fix, `spool explain` will tell you so and print exactly that
line — see [explain.md](./explain.md).

### The same endpoint called more than once

Two interactions with the same request replay in document order:

```json
"interactions": [
  { "id": "pending", "request": { ... }, "response": { "status": 202 } },
  { "id": "done",    "request": { ... }, "response": { "status": 200 } }
]
```

Or let one answer any number of times:

```json
"replay": { "times": "unlimited" }
```

## When a request does not match

Do not guess. Ask:

```bash
npx spool explain fixtures/users.hif.json '{"method":"GET","url":"https://api.example.com/users/8"}'
```

You get the closest recorded interaction, which fields matched, the exact path
that differed, and any fix that has been verified to work.

## Next

- [matching.md](./matching.md) — every knob, and the defaults' reasoning
- [redaction.md](./redaction.md) — read before recording against anything real
- [examples/](../examples/) — runnable Vitest, pytest, and cross-language suites
