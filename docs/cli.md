# CLI reference

Both packages ship the same `spool` command with the same behaviour. Adding a
command to one implementation and not the other is treated as a divergence, and
`conformance/cross-check.sh` compares the two command surfaces in CI.

```bash
npx @spool/hif --help        # from @spool/hif
python -m spool.cli --help   # from spool-hif, or just `spool` if it is on PATH
```

**Use `npx @spool/hif`, not `npx spool`.** The binary inside the package is named
`spool`, but `npx spool` asks npm for a *package* called `spool` — which exists
and belongs to somebody else. Naming the package explicitly is the difference
between running this tool and running a stranger's.

Once the package is a dependency of your project, the `spool` binary is on the
local path and `npm exec spool` or a `package.json` script works as expected.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | A fixture is invalid, a request did not match, or `diff` found changes |
| 2 | Usage error |

Codes are stable and safe to script against.

## Global options

| Option | Effect |
| --- | --- |
| `-o, --output <path>` | Write output to a file instead of stdout |
| `--json` | Machine-readable output, where the command supports it |
| `--all` | Show every candidate in `explain` output |
| `--color` | Force ANSI colour. Off by default, which is what CI logs want |
| `-h, --help` / `-v, --version` | |

---

## `spool lint <fixture...>`

Validate fixtures. Structural errors fail; suspicious-but-legal configuration is
reported as a warning.

```bash
spool lint fixtures/*.hif.json
spool lint fixtures/*.hif.json --json
```

Warnings catch the mistakes that would otherwise show up much later as a
mysterious mismatch:

- an unknown member in a `match` block — usually a typo, and silently ignored
  under [§2.1](../specification/hif-1.0.md#21-unknown-fields)
- a known method stored in lowercase, which will never match live traffic
- `headers.mode: "listed"` with an empty `include`, which compares nothing
- a fixture declaring a newer minor spec version than this implementation knows

Exits 1 if any fixture is invalid. Warnings alone do not fail it.

**In CI**, run this over every fixture in the repository. It is fast and it
catches a hand-edited fixture before it produces a confusing test failure.

## `spool inspect <fixture>`

Summarise a fixture: what it contains, what was redacted, and what each
interaction does.

```
fixtures/github-user.hif.json
  HIF 1.0, 4 interaction(s)
  name: github-user
  recorder: spool-python 0.1.0
  redaction: applied (headers)

  get-octocat
    GET https://api.github.com/users/octocat
    -> 200, 81 byte body, plays unlimited
```

`--json` prints the parsed fixture, which is useful for piping into `jq`.

## `spool digest <fixture>`

Print the `hif-digest-1` of each recorded request
([§14](../specification/hif-1.0.md#14-fixture-digest)).

```
17ff2b4107ca6021410afa60043354650b3bb2a3f2e23cf8a244c78807b0b575  get-octocat
```

Useful for deduplication and cache keys. It is *not* used for matching: two
requests with the same digest are the same request, but two requests that match
need not share a digest, because matching tolerates variance by design.

## `spool scan <fixture...>`

Report suspected secrets. Changes nothing.

```bash
spool scan fixtures/
spool scan fixtures/ --json
```

Always exits 0 — it reports, it does not gate. Combine `--json` with your own
policy if you want a build to fail.

When it finds nothing it says what that does and does not mean:

```
No rule matched.

This is not a guarantee. Rule- and entropy-based detection have false
negatives; review the fixture before publishing it.
```

## `spool redact <fixture> [-o out]`

Apply redaction rules to an existing fixture — one converted from HAR,
hand-written, or recorded before a rule was added.

```bash
spool redact fixtures/old.hif.json -o fixtures/old.hif.json
```

The rewritten fixture goes to stdout or `-o`; the summary goes to stderr, so
redirecting stdout does not lose the warning. Redaction is idempotent: running
it twice changes nothing the second time.

Prefer redacting at record time. This command is for fixtures you did not
record.

## `spool explain <fixture> <request>`

Explain why a request does not match. See [explain.md](./explain.md).

```bash
spool explain fixtures/users.hif.json request.json
spool explain fixtures/users.hif.json '{"method":"GET","url":"https://api.example.com/users/8"}'
spool explain fixtures/users.hif.json request.json --all --color
spool explain fixtures/users.hif.json request.json --json
```

The request argument is a JSON file path, or inline JSON if it starts with `{`.

Exits 1 when the request does not match, 0 when it does — so it works as an
assertion in a script.

Note that this starts from a fresh player with no plays consumed, so it cannot
reproduce a depletion failure that depends on earlier calls in a test. For that,
use `player.explainRequest()` from inside the test.

## `spool diff <a> <b>`

Compare two fixtures interaction by interaction, matching them up by request
digest.

```bash
spool diff fixtures/users.hif.json fixtures/users.new.hif.json
```

```
~ [1] request differs
    before.hif.json: POST https://api.example.com/v1/users
    after.hif.json:  POST https://api.example.com/v2/users
~ [2] response differs for https://api.example.com/v1/users/7
```

Exits 1 when there are changes, which makes it usable as a re-record gate:
record into a temporary file, diff against the committed one, and fail the build
if the upstream API has moved.

## `spool import har <file> [-o out]`

Convert a browser HAR capture into a fixture, per
[Appendix B](../specification/hif-1.0.md#appendix-b--relationship-to-har).

```bash
spool import har capture.har -o fixtures/api.hif.json
```

The fixture goes to stdout or `-o`. A report of **what the conversion dropped**
goes to stderr, and it is not optional decoration — HAR carries page records,
cache entries, connection details and per-phase timings that HIF has no
equivalent for, and a converter that hid that would be lying about fidelity.

Entries are skipped, with a reason, when they were served from the browser
cache, use a non-HTTP scheme, or have status 0 because the request was aborted.

**Redaction runs by default.** A browser HAR is full of cookies and
`authorization` headers, and importing one unredacted into a repository is the
mistake this command exists to prevent. `--no-redact` opts out and says so.

Two things you will usually want afterwards: `query.ignore` for cache-busting
parameters, and a read of the file.

## `spool serve <fixture...>`

Serve a fixture as an HTTP origin, so any language can replay it with no Spool
library. Full guide: [serving.md](./serving.md).

```bash
spool serve fixtures/api.hif.json
spool serve fixtures/api.hif.json --port 0 --origin https://api.example.com
spool serve --record fixtures/new.hif.json --origin https://api.example.com
```

Unmatched requests answer **551** with the full explanation as the body.

| Option | |
| --- | --- |
| `--port <n>` | Default 8080. `--port 0` picks a free port. |
| `--origin <url>` | Required when the fixture spans more than one origin. |
| `--record <path>` | Forward to `--origin`, record, write on Ctrl+C. |
| `--no-redact` | Disable redaction while recording. |
| `--latency` | Honour `timing.latencyMs`. |

## `spool proxy <fixture...>`

Replay over `HTTP_PROXY`. The client sends the full URL, so multi-origin
fixtures work without an `--origin`.

```bash
spool proxy fixtures/api.hif.json
export HTTP_PROXY=http://127.0.0.1:8080
```

https through CONNECT is deliberately unsupported, and the proxy says why when
asked. Use `serve` for https origins.

## Recipes

**Validate every fixture in CI**

```bash
spool lint $(find . -name '*.hif.json' -not -path './node_modules/*')
```

**Detect upstream drift on a schedule**

```bash
# Re-record against the real API, then compare with what is committed.
spool diff fixtures/api.hif.json /tmp/api.fresh.hif.json || \
  echo "The upstream API has changed since this fixture was recorded."
```

**Replay for a service in a language with no adapter**

```bash
spool serve fixtures/api.hif.json --port 0 &
# ... read the printed port, run your test suite against it ...
```

**Convert a browser capture and review it**

```bash
spool import har capture.har -o fixtures/api.hif.json   # report goes to stderr
spool inspect fixtures/api.hif.json
spool scan fixtures/api.hif.json
```

**Scan before publishing**

```bash
spool scan fixtures/ --json | jq -e 'length == 0' \
  || echo "Review these before publishing."
```
