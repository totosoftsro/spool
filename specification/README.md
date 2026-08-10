# The HIF specification

**HIF** — HTTP Interaction Fixture — is a JSON format for recorded HTTP traffic that
is meant to be *replayed*, not just archived.

| | |
| --- | --- |
| Current version | [**1.0**](./hif-1.0.md) |
| JSON Schema | [`schema/hif-1.0.schema.json`](./schema/hif-1.0.schema.json) |
| File extension | `.hif.json` |
| Media type | `application/vnd.hif+json` (provisional) |
| Conformance suite | [`../conformance/`](../conformance/) |

## Read this first if you are in a hurry

A fixture is a list of interactions. Each interaction is a request, a response, and
the rules for deciding whether some future request counts as "the same request".

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

That is a complete, valid fixture. Everything else in the spec is opt-in.

## The five things the spec exists to pin down

Anyone can invent a JSON shape for a request and a response. The parts that
actually differ between tools — and therefore the parts worth specifying — are:

1. **Matching** (§7). Which recorded interaction answers a given live request, and
   what counts as "close enough". Includes the selection algorithm, so repeated
   requests replay in a defined order.
2. **Normalization** (§6.4). Exactly which URL transformations happen before
   comparison, and which are forbidden. Without this, two implementations disagree
   about whether `https://X:443/a%2Fb` matches `https://x/a%2Fb`.
3. **Redaction** (§9). Default rule sets, the replacement value, and the entropy
   algorithm — specified so that two recorders redact the same tokens.
4. **Canonicalization** (§12, §14). RFC 8785 for JSON bodies, and a defined
   request digest, so byte-level comparisons agree across languages.
5. **Explanation** (§13). The structure and ordering of a mismatch report, and the
   rule that a suggested fix must be verified before it is shown.

## Using the spec without using Spool

The specification is written to be implementable on its own. It has no dependency
on the reference implementations, names no vendor, and requires no service.

If you are writing an implementation:

1. Read [`hif-1.0.md`](./hif-1.0.md) end to end. It is long but it is all
   load-bearing; the sections that look pedantic are the ones where existing tools
   quietly disagree with each other.
2. Start at conformance level **Core** (§15). Parse, validate, normalize, match,
   digest.
3. Run the [conformance suite](../conformance/). It is language-neutral JSON — you
   need to write a small runner, not port a test framework.
4. Open a PR adding yourself to [`../MAINTAINERS.md`](../MAINTAINERS.md) and to the
   implementations table in the root README.

Declaring a conformance level you have not tested is the one thing that would make
this format worse than the status quo, so please don't.

## Stability

HIF 1.0 is stable. The compatibility rules are normative and in §11:

- Additive changes go in `1.x`. A 1.0 reader can read a 1.1 fixture, ignoring what
  it does not recognise.
- A breaking change requires `2.0`, and readers must reject a major version they
  do not implement rather than guessing.

Changes to the specification are tracked in [`CHANGELOG.md`](./CHANGELOG.md) and
follow the process in [`../GOVERNANCE.md`](../GOVERNANCE.md).

## Known limitations

Stated plainly, because a spec that hides its edges is not useful:

- **`json` bodies lose byte fidelity.** Key order, whitespace, and exact numeric
  literals are not recoverable. Integers beyond 2^53 are corrupted. §12.3 requires
  implementations to detect and warn about this, and to prefer `text` — but if you
  need the original bytes, use `text` or `base64` deliberately.
- **Redaction is best-effort.** §9 says so in the normative text. Review fixtures
  before committing them.
- **No streaming.** A fixture holds complete bodies. Server-sent events and
  chunked streams can be recorded as their concatenated bytes, but the chunk
  boundaries and their timing are lost. Modelling streams properly is a candidate
  for 1.1.
- **HTTP only.** WebSockets and gRPC are out of scope for 1.0. gRPC-over-HTTP/2
  unary calls can be recorded as `base64` bodies, but nothing in the format
  understands them.
- **No stateful server modelling.** HIF replays recorded interactions; it does not
  simulate a server that computes responses. If your test needs "POST then GET
  returns what was posted", that is two recorded interactions, not a behaviour.
