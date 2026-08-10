# FAQ

### Do I have to care about the cross-language part?

No. Most people will use one language, and the value there is explained
mismatches, redaction on by default, and fixtures that are readable JSON in a
pull request. Portability is a consequence of specifying the format rather than
a feature you have to want.

If you do run a polyglot codebase, one recorded fixture serving a Python service
and its TypeScript client is a genuine simplification.

### Is this a mock server?

It can be one, but that is not the default mode. Normally Spool plugs into your
HTTP client inside your test process — no server, no port.

When you want a server, `spool serve` turns a fixture into an HTTP origin and
`spool proxy` replays over `HTTP_PROXY`. That is how you use HIF from a language
with no library: point your client's base URL at it. Matching, explanations and
redaction are the same engine either way.

### Does it need a service or an account?

No. No service, no account, no telemetry, no network calls of its own. Fixtures
are files in your repository.

### What is the difference from VCR?

VCR is a library with a serialization format; HIF is a format with libraries.
Practically: fixtures are portable, the matching rules are written down and
identical across implementations, mismatches are explained, and redaction is on
by default.

If VCR works for you in a single-language codebase, it works. This is not an
argument that you must switch.

### Why JSON rather than YAML?

Fixtures are diffed in pull requests and parsed by many languages. JSON has one
parser everywhere and no ambiguity about types; YAML has several parsers with
subtly different behaviour and a well-known collection of surprises. Readability
is close enough once the file is formatted.

### Can I edit a fixture by hand?

Yes, that is an intended workflow. Run `spool lint` afterwards — it catches typos
in `match` blocks that would otherwise be silently ignored (§2.1) and surface
much later as a confusing mismatch.

### My request stopped matching after a dependency upgrade.

Almost certainly a header. Check whether the fixture uses
`headers: { mode: "all" }` — the default is to compare no headers precisely
because clients add them. Run `spool explain` and it will name the header.

### How do I test retry logic?

Two interactions with the same recorded request. The first has a `fault`, the
second a response. Section 7.5 selects them in document order, so the first call
fails at the transport layer and the retry succeeds. No special API. There is a
worked example in [`examples/cross-language`](../examples/cross-language/).

### How do I handle a timestamp or UUID that changes every run?

A placeholder in the recorded value — `{{any:iso8601}}`, `{{any:uuid}}` — or
`match.body.json.ignore` to drop the field. Placeholders are better when you
still want to assert the *shape*.

### Can I use this with axios / got / node-fetch v2?

Yes. Those clients use Node's `http` module rather than global `fetch`, so use
the `node:http` adapter:

```ts
import { installNodeHttpReplay } from '@spool/hif/node-http';
const spool = installNodeHttpReplay(fixtureText);
```

Prefer `@spool/hif/fetch` when your code uses global `fetch` — it hooks a
documented seam, whereas the `node:http` adapter has to replace the module
functions, since Node offers no interception hook.

On Python, both `httpx` and `requests` are covered.

### Is redaction enough to make a fixture safe to publish?

No, and no tool can promise that. Redaction catches common credential carriers
by name and shape. It will miss a token in a bespoke header, a secret in a URL
path segment, and any personal data in a response body. Read fixtures before
committing them. See [redaction.md](./redaction.md).

### `spool scan` found nothing. Is my fixture clean?

It means no rule matched. The command says exactly that, and it is not the same
statement.

### Are large integers safe in a JSON body?

Not in a `json` body — JSON numbers are IEEE 754 doubles, so integers beyond
2^53 lose precision. Spool detects this at record time, warns, and stores the
body as text instead, so the value is preserved. If you are hand-writing a
fixture with a large ID, use a string or a `text` body.

### Does replay simulate the original latency?

Only if you ask. `timing.latencyMs` is recorded but ignored unless you enable
latency simulation, because sleeping by default would slow every test suite for
no correctness benefit. Turn it on with a `latencyScale` when you want to
exercise timeout handling.

### Can two tests share a fixture?

Yes, and play counts reset per player. Construct a player (or install an adapter)
per test — the examples do it in `beforeEach` / a pytest fixture — and the tests
stay isolated.

### What happens if a request is not in the fixture?

It fails with an explained mismatch. It never falls through to the network. That
is deliberate: a test that silently hits a real API is worse than one that fails.

### Will HIF 1.0 fixtures still work in five years?

That is the intent, and the compatibility rules are normative
([§11](../specification/hif-1.0.md#11-versioning-and-compatibility)). A reader
must accept any `1.x` fixture and ignore what it does not recognise. Breaking
that requires a 2.0, and a 2.0 requires a migration story.

### How do I know an implementation actually conforms?

It runs the shared suite in CI. Levels are asserted by the suite, not declared
in a README. An implementation may not advertise a level it does not pass, and
the cross-check job additionally verifies that the implementations agree with
each other.

### How do I use this from Go, Rust, Java or anything else?

`spool serve fixtures/api.hif.json`, then point your client's base URL at the
address it prints. No library in your language is required, and unmatched
requests come back as a 551 whose body is the full explanation.

If your fixture spans several origins, use `spool proxy` and set `HTTP_PROXY`
instead — the client then sends the full URL, so no origin mapping is needed.

### Why will `spool proxy` not handle https?

Because intercepting a CONNECT tunnel requires generating a TLS certificate and
persuading your client to trust it. Installing a man-in-the-middle certificate
authority on a developer machine or in CI is a bigger security decision than a
test tool should make on your behalf.

`spool serve` handles https origins without one: your client speaks plain HTTP
to localhost while the fixture still describes the original https origin, so
nothing about the recording changes.

### Can I import my existing HAR files?

`spool import har capture.har`. It reports exactly what it dropped — HAR carries
page records, cache entries and per-phase timings that HIF has no equivalent for
— and it redacts by default, because a browser HAR is full of cookies and auth
headers.

You will usually want to add `query.ignore` for cache-busting parameters
afterwards, since HAR carries no matching rules at all.

### Something in the specification is unclear.

That is a specification bug. Please open an issue. Ambiguity in the document is
the main thing that would make independent implementations diverge, and finding
it is one of the most useful contributions available.
