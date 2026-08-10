# pytest example

Replaying a HIF fixture in a pytest suite, using the httpx transport.

```bash
PYTHONPATH=../../implementations/python/src pytest tests -q
```

Or, with the package installed:

```bash
pip install -e ../../implementations/python[httpx]
pytest tests -q
```

## What is here

| File | |
| --- | --- |
| [`src/payments.py`](./src/payments.py) | The code under test. It knows nothing about Spool. |
| [`tests/test_payments.py`](./tests/test_payments.py) | The tests. |
| [`fixtures/payments.hif.json`](./fixtures/payments.hif.json) | The fixture. |

## The three things worth reading

**A generated field, ignored once for the whole file.** `create_charge` sends a
fresh `uuid4()` as its idempotency key. Rather than patching `uuid.uuid4` or
threading a factory through the client, the fixture says so once:

```json
"defaults": { "match": { "body": { "json": { "ignore": ["/idempotencyKey"] } } } }
```

Every interaction in the file inherits it.

**A connection reset followed by a successful retry.** Two interactions share
the request `GET /v1/charges/ch_test_1`: the first is a `connection-reset`
fault, the second a 200. Document order does the sequencing (§7.5), so
`retrieve_charge`'s own `except httpx.TransportError` retry loop is what gets
tested — not a stub of it.

**A 402 as a domain error.** `declined-card` is an ordinary interaction with a
402 status. Error paths are not a special construct; they are just responses.

## The failure case

The last test requests USD instead of GBP and asserts that the report names
`/currency`. Run it and read the output — that is the difference between this
and "request did not match".
