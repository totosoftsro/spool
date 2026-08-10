# Design decisions

Why things are the way they are, including the trade-offs that were accepted
rather than solved. If you are about to propose a change, the reasoning against
it may already be here — or you may find that the reasoning no longer holds,
which is equally useful.

## Why a specification at all

The obvious alternative was to write one very good library and skip the
document. That is what almost every existing tool did, and the result is fifteen
mutually unreadable cassette formats.

Writing the format down first has three concrete effects:

1. **It forces the ambiguities into the open.** Does `?flag` match `?flag=`? Is
   `%2F` decoded before comparing paths? Every existing tool answered these, but
   none of them wrote the answer down, so no two agree.
2. **It makes a second implementation cheap and a third plausible.** The Python
   port was written from the document, and passed all 189 conformance cases on
   the first run — which is evidence about the document, not about the code.
3. **It outlives the code.** Implementations get abandoned. A specification with
   a conformance suite can be picked up again.

The cost is real: the spec is long, and every behaviour change now takes four
edits instead of one.

## Why fixtures are a specification, not a log

HAR records what happened. HIF records what should happen *and how to recognise
it* — matching rules, tolerated variance, and redactions live in the document.

This is the central design choice, and it is why HIF is not "HAR with extras".
A log tells you a request occurred; a fixture has to answer "is this new request
the same request?", and that question has no answer without policy. Tools built
on HAR all invent that policy privately, which is precisely the fragmentation
being addressed.

## Why headers default to being ignored

Comparing all headers by default sounds safer and is worse. Clients send headers
you do not control — `user-agent`, `accept-encoding`, `content-length`, tracing
headers injected by instrumentation — and comparing them produces fixtures that
break when an unrelated dependency is upgraded.

That failure mode is exactly the flakiness this format exists to remove. So the
default compares nothing, and `mode: "listed"` lets you name the two or three
headers that genuinely affect the response.

The reverse choice was made for request bodies, where unexpected fields are
rejected by default — because a request body is written by *your* code, so an
unexpected field usually means your code changed, which is what the test should
catch.

## Why `extra: "allow"` is recursive but `missing` is never allowed

`extra` governs one direction only. A member you recorded but the client no
longer sends is always a failure; a member the client added is configurable.

The asymmetry matches how the failures differ in practice. Dropping a field is
almost always a regression. Adding one is often a harmless new feature — and
when it is not, `reject` is still the default.

## Why arrays are order-sensitive

JSON arrays are ordered. Comparing them as multisets would let a genuinely
different request match, and the cases where order truly does not matter are
better handled by ignoring the path.

## Why selection is "first match in document order, minus depleted"

This one rule buys sequencing, retries, and polling without any additional
concept. Two interactions with the same request replay in order; `times:
"unlimited"` makes one answer forever.

Most tools add a separate API for this — call-count matchers, `.once()`,
stateful mocks. The alternative here is a rule that fits in a sentence, and a
retry test that reads as data.

The cost: you cannot express "match whichever is most specific". Explicit
document order is easier to reason about than a specificity heuristic, and much
easier to specify precisely.

## Why placeholders are only recognised as whole strings

`"id is {{any}}"` is a literal. Only `"{{any}}"` is a placeholder.

Substring recognition would mean any recorded body containing `{{` becomes
magic — including bodies that legitimately carry template syntax, which is
common in API payloads. Narrow recognition plus an escape (`"\\{{any}}"`) makes
the rule stateable in one sentence and impossible to trip over by accident.

Text bodies are the exception, because a template is the entire point there.

## Why the regex subset excludes so much

`{{regex:...}}` could have accepted whatever the host engine accepts. It does
not, for two reasons.

**Engines disagree.** JavaScript's `\s` matches Unicode whitespace; Python's
under `re.ASCII` does not. JavaScript's `.` excludes `\r`, U+2028 and U+2029;
Python's excludes only `\n`. A pattern using either would mean different things
in different languages — silently.

Rather than document the divergence, both implementations rewrite `\d`, `\w`,
`\s` and `.` into explicit ASCII character classes before compiling.

**Backtracking.** Lookaround and backreferences enable patterns that hang. The
subset excludes them, bounds subject length, and rejects an excluded construct
at load time rather than at match time — so a bad pattern is a fixture error,
not a mysterious test hang.

The cost is that some legitimate patterns are unavailable. Given the alternative
is patterns that quietly mean different things in different languages, that is
an easy trade.

## Why RFC 8785 for canonical JSON

Deterministic byte-level comparison needs a canonical form, and inventing one
would have been a mistake when an RFC exists with implementations in eight-plus
languages.

The cost lands on Python, where `repr` disagrees with ECMAScript
`Number::toString` in several places: `100.0` versus `100`, `1e-07` versus
`1e-7`, `1e20` written in full versus not. The Python implementation reproduces
the ECMAScript algorithm directly rather than papering over it, and the
conformance suite pins every boundary case.

## Why `json` bodies lose byte fidelity, and why that is acceptable

Storing a body as parsed JSON makes fixtures reviewable and enables field-level
matching. It costs the original bytes: key order, whitespace, and exact numeric
literals are not recoverable, and integers beyond 2^53 are corrupted.

Rather than hide this, [§12.3](../specification/hif-1.0.md#123-numbers) requires
implementations to *detect* it: a recorder that sees a number literal which will
not survive an IEEE 754 round trip warns and stores the body as text instead. A
64-bit ID from an API is therefore preserved, not silently truncated.

The escape hatch is `preserveBytes`, which stores everything as text or base64.

## Why redaction runs at record time only

Redaction is a write-time transformation. A fixture on disk is already redacted;
nothing is re-applied on read.

The alternative — carrying rules in the fixture and applying them on load —
would mean the raw secret is still in the file, protected only by every reader
honouring the rules. That is not redaction, it is a request.

`spool redact` exists for fixtures that arrived from elsewhere, and is explicitly
a repair tool.

## Why the replacement value is `{{redacted}}` and not `***`

Because `{{redacted}}` matches anything under the placeholder rules. A redacted
`authorization` header therefore still matches whatever the live client sends,
so replay works with or without a real token in the environment.

`***` would break the very request it protects, and teams would respond by
turning redaction off.

## Why suggestions must be verified

An explanation engine that guesses is worse than one that stays silent. A
plausible wrong suggestion sends someone down a false path, and the whole point
of the feature is to stop wasting that time.

So every suggestion is applied, re-matched, and only shown if it actually works.
When nothing works, the report says no single change explains the mismatch and
offers nothing.

This is enforced in the conformance suite on *every* explain case, not only
where a case asserts it.

## Why the mismatch report shows what matched

Six ticks and one cross locates the problem instantly. The cross alone leaves
you wondering whether you have the right endpoint, the right host, or the right
fixture. The extra lines cost nothing and remove a whole class of confusion.

## Why both implementations produce byte-identical reports

The rendering is explicitly non-normative — and held to byte-identical output
anyway, by a CI check.

A polyglot team should not learn two failure formats. And in practice, the
discipline finds real bugs: forcing the two renderers to agree surfaced a
divergence in how `null` versus absent values were displayed.

## Why zero runtime dependencies

A test-support library sits in the dependency tree of everything that uses it.
Each dependency it carries is a supply-chain surface, a version conflict, and an
install-time cost that every consumer pays.

Both implementations have none. Adapters import their client lazily, so
installing `spool-hif` does not install `httpx`.

## Why the CLIs must not drift

Two implementations with subtly different `spool lint` behaviour would be worse
than one implementation, because people would learn one and be wrong about the
other. `conformance/cross-check.sh` compares the command surfaces in CI.

## What was deliberately left out of 1.0

- **Streaming.** Server-sent events and chunked responses can be recorded as
  concatenated bytes; chunk boundaries and timing are lost. Doing this properly
  means modelling time in the format, which needs more thought than 1.0 got.
- **WebSockets and gRPC.** Different enough to deserve their own treatment
  rather than a bolted-on encoding.
- **Stateful server simulation.** HIF replays recorded interactions; it does not
  compute responses. "POST then GET returns what was posted" is two
  interactions, not a behaviour. Adding a rules engine would make the format
  much larger and much harder to implement twice.
- **A record/replay proxy.** Would make Spool usable from languages with no
  adapter on day one, and is on the roadmap — but shipping the claim before the
  code would have been dishonest, so the README says it does not exist yet.
- **Contract testing.** A different problem with good existing tools. HIF
  fixtures can feed one; the negotiation protocol is out of scope.
