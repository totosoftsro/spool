# HTTP Interaction Fixture (HIF), version 1.0

**Status:** Stable
**Spec version:** `1.0`
**File extension:** `.hif.json`
**Media type (provisional):** `application/vnd.hif+json`

---

## 1. Introduction

A **HIF fixture** is a JSON document that describes a set of HTTP interactions —
a request paired with the response that should be produced for it — together with
the rules for deciding whether a live request corresponds to a recorded one.

HIF exists because recorded HTTP traffic is routinely trapped in one language's
tooling. Every mainstream ecosystem has at least one record/replay library, and
their storage formats are mutually unreadable. HIF is an attempt to describe the
artifact once, precisely enough that independent implementations agree.

### 1.1 Design goals

1. **A fixture is a specification, not a dump.** HIF describes *how a request is
   matched*, not merely *what was once observed*. Matching rules, tolerated
   variance, and redactions are part of the document.
2. **Determinism.** Given the same fixture and the same sequence of requests, every
   conforming implementation MUST select the same interactions in the same order,
   or report the same failure.
3. **Byte-exactness where it matters.** Bodies round-trip without loss, including
   binary bodies and non-UTF-8 text.
4. **Human-reviewable.** Fixtures are reviewed in pull requests. They are JSON,
   with plain-text bodies stored as plain text wherever possible.
5. **Safe by default.** Recording HTTP traffic captures credentials. The format
   has first-class redaction, and conforming recorders redact common credential
   carriers unless explicitly told not to.

### 1.2 What HIF is not

HIF does not describe an API (use OpenAPI), does not describe a consumer/provider
contract negotiation protocol (use Pact), and does not describe browser page-load
timing (that is what HAR was for). HIF describes the interactions a test needs to
replay, and the rules for replaying them.

### 1.3 Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY, and
OPTIONAL are to be interpreted as described in [RFC 2119] and [RFC 8174].

- **Fixture** — one HIF document.
- **Interaction** — one request/response pair within a fixture.
- **Recorder** — software that produces a fixture from live traffic.
- **Player** — software that serves responses from a fixture.
- **Candidate** — an interaction considered during matching.
- **Live request** — the request made by code under test during replay.
- **Recorded request** — the `request` object stored in an interaction.

---

## 2. Document structure

```jsonc
{
  "hif": "1.0",
  "meta":     { /* §3  */ },
  "defaults": { /* §4  */ },
  "interactions": [ /* §5 */ ]
}
```

| Field          | Type   | Required | Description                          |
| -------------- | ------ | -------- | ------------------------------------ |
| `hif`          | string | yes      | Spec version, §11                    |
| `meta`         | object | no       | Provenance metadata, §3              |
| `defaults`     | object | no       | Fixture-wide defaults, §4            |
| `interactions` | array  | yes      | Ordered list of interactions, §5     |

A fixture MUST be a JSON object. The document MUST be encoded as UTF-8. A byte
order mark MUST NOT be emitted, and MUST be tolerated by readers.

`interactions` MAY be empty. Document order is significant (§7.5).

### 2.1 Unknown fields

Readers MUST ignore unknown members of known objects rather than rejecting the
document (§11.2). Linters SHOULD report unknown members as warnings, because the
most common cause is a misspelled key in a `match` or `redact` block.

---

## 3. `meta`

Purely informational. No member of `meta` affects matching or replay.

```jsonc
{
  "name": "users-api",
  "description": "Fixtures for the user CRUD flows",
  "createdAt": "2026-08-10T09:41:12Z",
  "recorder": { "name": "spool-python", "version": "0.1.0" },
  "redaction": { "applied": true, "rules": ["headers", "entropy"] },
  "tags": ["integration", "users"]
}
```

| Field         | Type   | Notes                                                        |
| ------------- | ------ | ------------------------------------------------------------ |
| `name`        | string | Short identifier                                              |
| `description` | string | Free text                                                     |
| `createdAt`   | string | RFC 3339 timestamp                                            |
| `recorder`    | object | `{ name, version }` of the producing software                 |
| `redaction`   | object | `{ applied: boolean, rules: string[] }`, see §9.6             |
| `tags`        | array  | Strings                                                       |

`meta.createdAt` SHOULD be omitted by recorders operating in reproducible-build
mode, because a changing timestamp produces spurious diffs on re-record.

---

## 4. `defaults`

Fixture-wide defaults applied to every interaction that does not override them.

```jsonc
{
  "match":  { /* §7 */ },
  "replay": { /* §5.2 */ }
}
```

Merging is **shallow per named sub-object**: `defaults.match.query` is replaced
wholesale by `interaction.match.query` if the latter is present; it is not deep
merged. This keeps the effective configuration of an interaction determinable by
reading at most two places.

`redact` is deliberately **not** part of `defaults`. Redaction is a record-time
transformation (§9); a fixture on disk is already redacted, so carrying the rules
in the document would imply they are re-applied on read. Recorder configuration
lives outside the fixture.

---

## 5. Interaction object

```jsonc
{
  "id": "create-user",
  "request":  { /* §6 */ },
  "response": { /* §8 */ },
  "match":    { /* §7 */ },
  "replay":   { "times": 1 },
  "timing":   { "latencyMs": 143 },
  "fault":    null,
  "expect":   { "called": "once" },
  "annotations": { "source": "manual" }
}
```

| Field         | Type           | Required | Description                        |
| ------------- | -------------- | -------- | ---------------------------------- |
| `id`          | string         | no       | Unique within the fixture, §5.1    |
| `request`     | object         | yes      | §6                                 |
| `response`    | object         | cond.    | Required unless `fault` is present |
| `match`       | object         | no       | §7                                 |
| `replay`      | object         | no       | §5.2                               |
| `timing`      | object         | no       | §5.3                               |
| `fault`       | object or null | no       | §10                                |
| `expect`      | object         | no       | §5.4                               |
| `annotations` | object         | no       | Free-form, ignored by players       |

An interaction MUST contain a `response`, a non-null `fault`, or both. Containing
neither is a structural error (§11.3). Containing both is valid only for
`fault.type` of `partial-response` (§10); for every other fault type, containing
both is a structural error.

### 5.1 `id`

If present, `id` MUST be unique within the fixture and MUST match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Implementations MUST use `id` in diagnostics
when available, falling back to `interactions[<index>]`.

### 5.2 `replay`

```jsonc
{ "times": 1 }
```

| Field   | Type              | Default | Description                              |
| ------- | ----------------- | ------- | ---------------------------------------- |
| `times` | integer or string | `1`     | Play count, or the string `"unlimited"`  |

`times` MUST be a positive integer or the exact string `"unlimited"`. See §7.5 for
how play counts affect selection.

### 5.3 `timing`

```jsonc
{ "latencyMs": 143, "recordedAt": "2026-08-10T09:41:12.881Z" }
```

| Field        | Type   | Description                                                     |
| ------------ | ------ | --------------------------------------------------------------- |
| `latencyMs`  | number | Wall-clock ms from request start to response completion, ≥ 0     |
| `recordedAt` | string | RFC 3339 timestamp of the original request                       |

Players MUST NOT delay by default. A player MAY offer latency simulation; when
enabled it SHOULD sleep for `latencyMs` before delivering the response. Latency
simulation MUST be opt-in, because sleeping by default would make test suites
slower for no correctness benefit.

`timing` never affects matching.

### 5.4 `expect`

Assertions verified when the caller asks the player to verify completion
(commonly at test teardown). `expect` never affects matching.

```jsonc
{ "called": "once" }
```

`called` MUST be one of:

| Value           | Passes when the interaction was played |
| --------------- | -------------------------------------- |
| `"once"`        | exactly 1 time                         |
| `"atLeastOnce"` | ≥ 1 time                               |
| `"never"`       | 0 times                                |
| `"any"`         | always (explicit no-op)                |

An object form `{ "called": { "times": 3 } }` asserts an exact count.

---

## 6. Request object

```jsonc
{
  "method": "POST",
  "url": "https://api.example.com/v1/users?page=2&sort=name",
  "headers": [["content-type", "application/json"], ["accept", "*/*"]],
  "body": { "encoding": "json", "json": { "name": "Ada" } }
}
```

| Field     | Type   | Required | Description                    |
| --------- | ------ | -------- | ------------------------------ |
| `method`  | string | yes      | §6.1                           |
| `url`     | string | yes      | §6.2                           |
| `headers` | array  | no       | §6.3, defaults to `[]`         |
| `body`    | object | no       | §6.5, defaults to empty body   |

### 6.1 `method`

An HTTP method token. Recorders MUST store it uppercased for the methods defined
in [RFC 9110] (`GET`, `HEAD`, `POST`, `PUT`, `DELETE`, `CONNECT`, `OPTIONS`,
`TRACE`, `PATCH`). Extension methods MUST be stored verbatim. Comparison is
case-sensitive after this normalization, so a recorder that fails to uppercase
`get` produces a fixture that does not match live `GET` requests. Linters MUST
flag a lowercase form of a known method.

### 6.2 `url`

An absolute URL with an `http` or `https` scheme. The stored form MUST be the URL
after the normalizations in §6.4. It MUST include the query string if one was
present, and MUST NOT include a fragment.

Matching never compares `url` as an opaque string. It is decomposed into scheme,
host, port, path, and query, each compared under its own rule (§7). The full `url`
is stored anyway because it is what a human reads first.

### 6.3 `headers`

An **ordered array of two-element arrays** — `[name, value]` — not an object.

```jsonc
[["set-cookie", "a=1"], ["set-cookie", "b=2"], ["accept", "*/*"]]
```

This representation is required because HTTP permits repeated header field names
and JSON objects cannot express them. Recorders MUST NOT collapse repeated fields
into one entry, and MUST NOT reorder fields.

- Field names MUST be stored lowercased. Comparison is case-insensitive per
  [RFC 9110], and lowercasing at write time makes fixtures diff-stable.
- Field values MUST be stored with leading and trailing optional whitespace (OWS)
  stripped, and otherwise verbatim.
- A field value that is not valid UTF-8 MUST be handled per §6.6.

#### 6.3.1 Permitted characters

A field name MUST be a [RFC 9110] `token`: one or more characters from

```
! # $ % & ' * + - . ^ _ ` | ~ 0-9 A-Z a-z
```

A field value MUST NOT contain any of CR (U+000D), LF (U+000A) or NUL (U+0000),
and MUST NOT contain any other C0 control character except HTAB (U+0009).

A reason phrase (`response.statusText`, §8) is subject to the same restriction as
a field value.

Readers MUST reject a violation as a structural error (§11.3). This is a security
requirement, not a stylistic one: a player that delivers a field value containing
CRLF terminates the header block early, so a fixture can inject arbitrary
additional headers and a body of its own choosing into the response — an HTTP
response-splitting attack carried in a data file. Because fixtures are committed
to repositories, reviewed in pull requests, converted from HAR files and copied
between projects, they must be treated as untrusted input, and the check has to
happen when the document is read rather than being left to each delivery path.

### 6.4 URL normalization

Recorders MUST apply exactly these normalizations before storing a URL, and
players MUST apply exactly these normalizations to a live request URL before
comparing. Applying them at both ends is what makes cross-implementation matching
stable.

1. Scheme is lowercased.
2. Host is lowercased. An internationalized host MUST be stored in A-label
   (Punycode) form.
3. A port equal to the scheme default (80 for `http`, 443 for `https`) is removed.
   Any other port is retained. A port MUST be an integer in 1..65535; anything
   else is a structural error (§11.3). Without this bound the two reference
   implementations disagreed, because one URL library rejected `:99999` and the
   other accepted it.
4. An empty path becomes `/`.
5. Percent-encoding triplets are uppercased (`%2f` → `%2F`).
6. Percent-encoded octets that correspond to [RFC 3986] unreserved characters
   (`A–Z a–z 0–9 - . _ ~`) are decoded.
7. Dot segments (`.` and `..`) in the path are resolved per [RFC 3986] §5.2.4.
8. The fragment, if any, is removed.

Normalization MUST NOT do anything else. In particular it MUST NOT sort query
parameters, MUST NOT remove empty query parameters, MUST NOT add or remove a
trailing slash, and MUST NOT decode `+` in the path.

### 6.4.1 Query decomposition

The query string is decomposed for matching as follows, and this procedure is
normative:

1. Take the substring after the first `?`, if present. If absent, the parameter
   list is empty.
2. Split on `&`. An empty segment produces no parameter.
3. For each segment, split on the **first** `=`. The part before is the name; the
   part after is the value. A segment with no `=` yields that segment as the name
   and an empty-string value, and is recorded as *valueless* (§7.3).
4. In both name and value, replace `+` with a space, then percent-decode.
5. Decoded bytes are interpreted as UTF-8. Invalid sequences are replaced with
   U+FFFD for comparison purposes only; the stored `url` retains the original
   bytes.

The result is an ordered list of `(name, value)` pairs. Order is preserved because
some APIs are order-sensitive, but the default query match mode ignores order
(§7.3).

### 6.5 Body object

A body is a tagged union discriminated by `encoding`.

| `encoding` | Payload field | Meaning                                        |
| ---------- | ------------- | ---------------------------------------------- |
| `"empty"`  | —             | No body                                        |
| `"text"`   | `text`        | UTF-8 text, stored literally                   |
| `"json"`   | `json`        | Parsed JSON value                              |
| `"base64"` | `base64`      | Arbitrary bytes, [RFC 4648] §4 base64          |

```jsonc
{ "encoding": "empty" }
{ "encoding": "text",   "text": "hello\n" }
{ "encoding": "json",   "json": { "a": 1 } }
{ "encoding": "base64", "base64": "3q2+7w==" }
```

An absent `body` member is equivalent to `{ "encoding": "empty" }`. Implementations
MUST treat the two as identical for matching and MUST NOT distinguish them.

Optional members on any body object:

| Field         | Type    | Description                                              |
| ------------- | ------- | -------------------------------------------------------- |
| `contentType` | string  | The `Content-Type` observed, for tooling convenience      |
| `redacted`    | boolean | True if §9 modified this body; see §9.5                   |

#### 6.5.1 Choosing an encoding

Recorders MUST choose the encoding by this procedure, in order:

1. Zero-length body → `empty`.
2. Body bytes are valid UTF-8 **and** the media type is a JSON media type — that
   is, the type/subtype is `application/json`, or the subtype ends in `+json` —
   **and** the bytes parse as JSON → `json`.
3. Body bytes are valid UTF-8 and contain no U+0000 → `text`.
4. Otherwise → `base64`.

Step 2 is deliberately conservative: a body that claims to be JSON but does not
parse is stored as `text`, so the fixture preserves what was actually on the wire
rather than failing to record.

#### 6.5.2 `json` fidelity

Storing JSON parsed rather than as a string makes fixtures reviewable and enables
field-level matching (§7.4). It costs exactly one thing: the original byte
sequence, including key order, insignificant whitespace, and the precise numeric
literal form, is not recoverable.

Therefore:

- A player replaying a `json` **response** body MUST serialize it using the
  canonical JSON serialization of §12. Two implementations therefore produce
  byte-identical response bodies.
- A recorder MUST use `base64` or `text` instead of `json` when the caller has
  requested byte-exact preservation, and SHOULD do so automatically when the body
  contains a number that does not survive a parse/serialize round trip (§12.3).

#### 6.5.3 `base64`

`base64` MUST use the standard alphabet of [RFC 4648] §4 with `=` padding. The
URL-safe alphabet MUST NOT be used. Readers MUST reject base64 containing
whitespace, line breaks, or characters outside the alphabet.

### 6.6 Non-UTF-8 header values

If a header field value is not valid UTF-8, the entry MUST be stored as a
three-element array `[name, null, base64Value]`, where the third element is the
base64 of the raw field-value bytes. Readers MUST accept both the two- and
three-element forms. Recorders SHOULD avoid emitting the three-element form when
the value is valid UTF-8, so that ordinary fixtures stay readable.

---

## 7. Matching

Matching answers one question: *does this live request correspond to this recorded
request?* It is a pure function of the live request, the recorded request, and the
effective `match` configuration. It MUST NOT depend on wall-clock time, host
environment, iteration order of unordered containers, or any state other than the
play counts described in §7.5.

### 7.1 The `match` object and its defaults

```jsonc
{
  "method": "exact",
  "scheme": "exact",
  "host":   "exact",
  "port":   "exact",
  "path":   "exact",
  "query":   { "mode": "exact", "ignore": [] },
  "headers": { "mode": "none",  "include": [], "ignore": [] },
  "body":    { "mode": "auto",  "json": { "extra": "reject", "ignore": [] } }
}
```

Every member is optional; the values above are the defaults when neither the
interaction nor `defaults.match` supplies one. The defaults are chosen so that a
freshly recorded fixture replays without configuration, and so that a request that
matches is genuinely the same request — with the deliberate exception of headers,
which default to being ignored (§7.2 explains why).

`method`, `scheme`, `host`, `port`, and `path` each take `"exact"` or `"ignore"`.

Comparison uses the normalized forms of §6.4. `port` compares the effective port
after default-port removal, so `https://x/` and `https://x:443/` compare equal.

### 7.2 Headers

| `mode`     | Behaviour                                                            |
| ---------- | -------------------------------------------------------------------- |
| `"none"`   | Headers are not compared. **Default.**                                |
| `"listed"` | Only the field names in `include` are compared.                       |
| `"all"`    | All recorded fields are compared, except names in `ignore`.           |

Headers default to `none` because clients add headers the test does not control —
`user-agent`, `accept-encoding`, `connection`, tracing headers injected by
instrumentation, `content-length` computed by the transport. A default of `all`
produces fixtures that break when an unrelated dependency is upgraded, which is
precisely the flakiness this format exists to remove. Teams that need header
matching opt into `listed` with the two or three fields they actually care about.

Comparison rules:

- Field names in `include` and `ignore` are compared case-insensitively.
- For a name being compared, all recorded values and all live values for that name
  are collected **in order**, and the two ordered lists MUST be equal.
- Under `"listed"`, a name in `include` that is absent from both sides matches. A
  name present on exactly one side does not match.
- Under `"all"`, a live request MAY carry additional field names not present in the
  recorded request; those are not compared. This is intentional and matches how
  `"all"` is understood in practice — it means "every header I recorded must still
  be there," not "no header may ever be added."
- Values are compared byte-for-byte after the OWS stripping of §6.3, with the
  exception of placeholders (§7.6).

### 7.3 Query

| `mode`     | Behaviour                                                                |
| ---------- | ------------------------------------------------------------------------ |
| `"exact"`  | The multisets of `(name, value)` pairs MUST be equal. **Default.**        |
| `"subset"` | Every recorded pair MUST be present in the live request; extras allowed.  |
| `"ignore"` | Query is not compared.                                                    |

`ignore` lists parameter *names* removed from **both** sides before comparison.
Names are compared case-sensitively, because query parameter names are
case-sensitive.

Comparison is over multisets, not ordered lists, so `?a=1&b=2` matches `?b=2&a=1`.
Repetition is significant: `?a=1&a=1` does not match `?a=1`.

A *valueless* parameter (§6.4.1 step 3) is distinct from one with an empty value:
`?flag` does not match `?flag=`.

### 7.4 Body

| `mode`     | Behaviour                                                                    |
| ---------- | ---------------------------------------------------------------------------- |
| `"auto"`   | `json` if the recorded body encoding is `json`, else `exact`. **Default.**    |
| `"exact"`  | Byte-for-byte equality of the decoded body bytes.                             |
| `"json"`   | Structural JSON comparison, §7.4.2.                                           |
| `"text"`   | Text comparison with placeholder support, §7.4.3.                             |
| `"ignore"` | Body is not compared.                                                         |

#### 7.4.1 `exact`

Both bodies are reduced to bytes — `empty` → zero bytes, `text` → its UTF-8
encoding, `json` → its canonical serialization (§12), `base64` → the decoded bytes
— and compared for byte equality.

#### 7.4.2 `json`

Both sides MUST parse as JSON; if the live body does not parse, the match fails
with reason `body.not-json`. Comparison is structural:

- Objects: members are compared by name, order-insensitively.
- Arrays: compared element-wise, order-**sensitively**. Arrays are ordered in JSON
  and treating them otherwise would let a genuinely different request match.
- Numbers: compared by their canonical form (§12.3). `1`, `1.0`, and `1e0` are
  equal.
- Strings: compared by Unicode code point sequence, after placeholder expansion
  (§7.6).
- `null`, `true`, `false`: compared by identity.

Two knobs:

`json.extra` — what to do about object members present in the live body but absent
in the recorded body:

| Value      | Behaviour                                                    |
| ---------- | ------------------------------------------------------------ |
| `"reject"` | An unexpected member fails the match. **Default.**            |
| `"allow"`  | Unexpected members are ignored, recursively, at every depth.  |

A member present in the recorded body but absent from the live body always fails
the match, under both settings. `extra` governs only the unexpected direction.

`json.ignore` — a list of **JSON paths** (§7.7) removed from both sides before
comparison. Removal is by path; a path that matches nothing is not an error, so
that a shared `defaults.match` can list fields that only some interactions have.

#### 7.4.3 `text`

Both bodies are reduced to text (`base64` bodies fail with `body.not-text`).
The recorded text is treated as a template: it is split on placeholder occurrences
(§7.6), and the live text MUST consist of the literal segments in order, with
arbitrary content between them.

Matching is anchored at both ends and uses **leftmost-shortest** resolution for
each gap: literal segments are located in order, each at the earliest position at
or after the end of the previous segment. This is a single left-to-right scan with
no backtracking, so it is deterministic and linear. A template of pure literal text
with no placeholders therefore degenerates to exact string equality.

### 7.5 Selection algorithm

Given a live request R and a fixture F, a player MUST select an interaction by:

1. Let `C` be the list of interactions in F, in document order, **excluding** those
   whose remaining play count is zero. An interaction with `times: n` starts with
   `n` remaining plays and `"unlimited"` never depletes.
2. Evaluate the match predicate of §7.1–7.4 for each element of `C`, in order.
3. If one or more match, select the **first** in document order. Decrement its
   remaining play count (unless unlimited). Return its response or fault.
4. If none match, the request is **unmatched**. The player MUST NOT perform a live
   request unless explicitly configured to do so, and MUST report the failure using
   the explanation of §13.

Consequences worth stating explicitly:

- Two identical recorded requests with `times: 1` each replay once, in the order
  they appear. This is how a polling loop that returns `pending` then `complete` is
  expressed, and it works without any special "sequence" construct.
- Selection depends on play counts, which are player state, not fixture state. A
  fixture is immutable during replay.
- Play counts MUST be reset when a player is reset or a new player is constructed,
  so that test isolation is preserved.

### 7.6 Placeholders

A placeholder marks a position whose value is not fixed. Placeholders MAY appear
in a **recorded** header value, query parameter value, JSON string value, or text
body. They have no meaning in a live request, and no meaning anywhere in a
`response` object.

A string is a placeholder **only if the entire string** is of the form `{{…}}` and
names a defined placeholder. A string that merely contains `{{…}}` is a literal,
except within a `text` body template (§7.4.3), where occurrences anywhere in the
string are recognized.

| Placeholder            | Matches                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `{{any}}`              | Any value, including `null` and composite values                |
| `{{any:string}}`       | Any JSON string                                                 |
| `{{any:number}}`       | Any JSON number                                                 |
| `{{any:boolean}}`      | `true` or `false`                                               |
| `{{any:array}}`        | Any JSON array                                                  |
| `{{any:object}}`       | Any JSON object                                                 |
| `{{any:uuid}}`         | A string matching the UUID form below                           |
| `{{any:iso8601}}`      | A string matching the RFC 3339 date-time form below             |
| `{{regex:PATTERN}}`    | A string fully matching PATTERN, §7.6.2                         |
| `{{redacted}}`         | Any value; written by redaction, §9                             |

In a header value, query value, or text body, only string-shaped placeholders are
meaningful; `{{any}}` there matches any string, and `{{any:number}}` matches a
string whose content is a JSON number literal.

UUID form: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`.

ISO 8601 form: an RFC 3339 `date-time`, i.e.
`^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$`.
Implementations MUST validate the shape only, not the calendar; `2026-02-31T00:00:00Z`
is accepted. Calendar validation would make matching depend on a date library and
is not worth the divergence risk.

#### 7.6.1 Escaping

A literal string that would otherwise be read as a placeholder is escaped by
prefixing a backslash: `"\\{{any}}"` in JSON source, i.e. the character sequence
`\{{any}}`, denotes the literal text `{{any}}`. The escape is recognized only at
position 0 of the string, and only when followed by `{{`. Everywhere else a
backslash is an ordinary character.

#### 7.6.2 `{{regex:…}}`

PATTERN is everything between `{{regex:` and the final `}}` of the string. It MUST
be interpreted as an anchored match against the entire subject.

To keep behaviour identical across languages, PATTERN MUST use only this subset:

- literal characters, with `\` escaping any of `\ . ^ $ | ? * + ( ) [ ] { } / -`
- the C0 mnemonics `\t \n \r \f \v`
- character classes `[...]` including ranges and a leading `^` negation
- the shorthands `\d \D \w \W \s \S`, defined over ASCII only:
  `\d` is `[0-9]`, `\w` is `[A-Za-z0-9_]`, `\s` is `[ \t\n\r\f\v]`, and the
  uppercase forms are their complements. Inside a character class, only the
  lowercase forms may be used; `[\D]` MUST be rejected, because its expansion is
  ambiguous and engines disagree.
- `.` matching any character except U+000A
- grouping `( … )` and alternation `|`
- the quantifiers `? * +` and the counted forms `{n}`, `{n,}`, `{n,m}`

Non-capturing groups, backreferences, lookaround, named groups, inline flags,
possessive and lazy quantifiers, and Unicode property escapes MUST NOT be used.
Implementations MUST reject a pattern using an excluded construct with a structural
error rather than silently accepting host-regex behaviour, because that is exactly
where two implementations would diverge. Matching is case-sensitive.

**A quantifier MUST NOT be applied to a group.** `(ab)+`, `(a+)+` and `(a|aa)*`
are all rejected; `(cat|dog)s` is accepted, because no quantifier follows the
group.

This is the rule that keeps the subset safe rather than merely portable. A
quantified group whose body can match the same input in more than one way causes
exponential backtracking in every backtracking engine — the classic
`(a+)+b` against a run of `a` characters never terminates in practice. Detecting
ambiguity in general is hard; forbidding a quantifier on a group is a check an
implementation can perform in one pass, and it removes the whole family. The cost
is that a safe pattern like `(ab)+` must be written another way or moved into a
`{{regex:...}}`-free comparison.

Bounding the subject length is *not* sufficient protection and MUST NOT be relied
on alone: exponential backtracking on a 40-character subject already exceeds any
practical time limit. Implementations MUST additionally bound subject length to at
most 8192 characters, and MUST return a structural error rather than truncating.

### 7.7 JSON paths

`json.ignore` and the JSON-field redaction rules of §9.3 use a small path syntax.
It is [RFC 6901] JSON Pointer with one addition: the token `*` matches any single
member name or any single array index.

```
/user/password          the "password" member of the "user" member of the root
/items/*/token          the "token" member of every element of "items"
/*/secret               the "secret" member of every top-level member
```

Escaping follows RFC 6901: `~0` is `~`, `~1` is `/`. A literal `*` member name is
written `~2`. (RFC 6901 does not define `~2`; HIF reserves it for this purpose and
readers MUST reject any other `~` escape.)

A path MUST begin with `/`. The empty string, meaning the whole document in RFC
6901, is not a valid path here.

---

## 8. Response object

```jsonc
{
  "status": 201,
  "statusText": "Created",
  "headers": [["content-type", "application/json"]],
  "body": { "encoding": "json", "json": { "id": 7 } }
}
```

| Field        | Type    | Required | Description                              |
| ------------ | ------- | -------- | ---------------------------------------- |
| `status`     | integer | yes      | 100–599                                  |
| `statusText` | string  | no       | Reason phrase; informational only, §6.3.1 |
| `headers`    | array   | no       | Same representation as §6.3              |
| `body`       | object  | no       | Same representation as §6.5              |

Players MUST deliver `status` and `headers` as recorded. Placeholders have no
meaning in a response and MUST be delivered as literal text; a `{{any}}` in a
response body is the six characters, not a wildcard.

### 8.1 Content-Length and Transfer-Encoding

A recorded `content-length` header MAY disagree with the actual body length, for
instance after redaction changed the body. Players MUST recompute
`content-length` from the delivered body when they deliver that header at all, and
MUST drop `transfer-encoding` and `content-encoding` unless they deliver bytes
that are genuinely so encoded. Recorders SHOULD store decoded bodies and drop
`content-encoding`, so that a fixture shows what the application saw.

### 8.2 Redirects

A redirect is an ordinary interaction with a 3xx status and a `location` header.
HIF does not model redirect chains as a special construct: a chain is two or more
interactions, and the client under test follows them exactly as it would in
production, matching each in turn. Players MUST NOT follow redirects themselves.

---

## 9. Redaction

Recorded traffic contains credentials. Redaction is a **record-time
transformation**: the recorder rewrites values before the fixture is written, so
secrets never reach disk in the first place.

> **Redaction reduces exposure. It does not guarantee removal.**
> Rule-based and entropy-based detection both have false negatives, and no
> conforming implementation may claim otherwise. Fixtures MUST still be reviewed
> before they are committed, and a fixture recorded against a production system
> should be treated as sensitive regardless of what redaction reported.

### 9.1 The default rule set

A conforming recorder MUST apply these by default, and MUST require an explicit
opt-out to disable them:

**Header field names** (case-insensitive, request and response):
`authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
`www-authenticate`, `proxy-authenticate`, `x-api-key`, `api-key`,
`x-auth-token`, `x-amz-security-token`, `x-csrf-token`, `x-xsrf-token`.

**Query parameter names** (case-insensitive): `access_token`, `api_key`, `apikey`,
`auth`, `code`, `id_token`, `password`, `refresh_token`, `secret`, `session`,
`signature`, `sig`, `token`.

**JSON member names** at any depth (case-insensitive): `access_token`, `api_key`,
`apiKey`, `authorization`, `client_secret`, `credentials`, `id_token`, `password`,
`passwd`, `private_key`, `refresh_token`, `secret`, `session_token`, `token`.

The lists are part of the specification so that two recorders produce comparable
fixtures. Implementations MUST make them extensible and MUST make each entry
removable.

### 9.2 Value replacement

A redacted value is replaced by the placeholder string `{{redacted}}`, which under
§7.6 matches any value. This has three properties worth naming: the redaction is
visible in review, it is machine-detectable, and it does not break replay of the
request it appears in.

A redacted JSON member keeps its member name and receives the **string**
`"{{redacted}}"` as its value, whatever the original type was. Preserving the
original type would leak its shape for little benefit.

### 9.3 Configurable rules

| Rule           | Applies to                                                        |
| -------------- | ----------------------------------------------------------------- |
| `headers`      | Header field names, exact match, case-insensitive                  |
| `queryParams`  | Query parameter names, exact match, case-insensitive               |
| `jsonPaths`    | JSON paths per §7.7, in request and response JSON bodies           |
| `jsonFields`   | JSON member names at any depth, case-insensitive                   |
| `patterns`     | Named regexes applied to text bodies and to header/query values    |
| `entropy`      | §9.4                                                               |

`patterns` entries are `{ "name": string, "regex": string }` and use the regex
subset of §7.6.2. Each match is replaced in place by `{{redacted}}`.

### 9.4 Entropy detection

Entropy detection catches credentials no rule names. It is heuristic and produces
both false positives and false negatives.

A conforming implementation that offers it MUST use this algorithm, so that two
recorders redact the same tokens:

1. Split the subject into candidate tokens on characters outside
   `[A-Za-z0-9+/_-]`, then extend each token rightwards over any immediately
   following `=` characters, which are base64 padding.

   `=` is deliberately *not* in the splitting alphabet even though it is part of
   base64. If it were, `key=AKIAIOSFODNN7EXAMPLE` would be one token rather than
   two, and every `name=value` pair in a query string or form body would be
   glued to its name — changing both the entropy calculation and what gets
   replaced.

2. Discard tokens shorter than `minLength` (default 24) or longer than 512.
3. Discard tokens that are not "credential-shaped": a token qualifies only if it
   consists solely of characters from the base64 alphabet plus `-` and `_`, and
   contains at least one digit and at least one letter.
4. Compute Shannon entropy over the token's characters, in bits per character:
   `H = -Σ p(c) · log2 p(c)`, where `p(c)` is the frequency of character `c`
   divided by the token length.
5. Redact the token if `H ≥ minBits` (default 3.5).

Entropy detection MUST default to **off** for text bodies and **on** for header
and query values, because a prose or HTML body produces false positives that
silently corrupt a fixture, whereas a header value that looks like a credential
almost always is one.

### 9.5 Marking

Any body object modified by redaction MUST carry `"redacted": true` (§6.5). This
is how `spool lint` distinguishes "no secrets found" from "secrets removed".

### 9.6 Reporting

A recorder MUST record what it did in `meta.redaction`:

```jsonc
{ "applied": true, "rules": ["headers", "queryParams", "jsonFields", "entropy"] }
```

`rules` lists the rule categories that produced at least one replacement. A
recorder MUST NOT write `"applied": true` if redaction was disabled, and MUST NOT
imply completeness anywhere in its output.

### 9.7 Scanning after the fact

Redaction runs at record time, but fixtures arrive from elsewhere — converted from
HAR, hand-written, or recorded by an older version. Conforming tooling SHOULD
provide a scanner that applies §9.1 and §9.4 to an existing fixture and reports
findings as warnings. The scanner MUST report findings as *suspected*, never as
confirmed secrets.

---

## 10. Fault simulation

An interaction with a non-null `fault` and no `response` instructs the player to
fail the request at the transport layer instead of answering it.

```jsonc
{ "type": "connection-reset", "afterMs": 0, "message": "simulated reset" }
```

| Field     | Type   | Required | Description                                   |
| --------- | ------ | -------- | --------------------------------------------- |
| `type`    | string | yes      | One of the types below                        |
| `afterMs` | number | no       | Delay before failing, default 0               |
| `message` | string | no       | Human-readable detail for the raised error    |

| `type`               | Player behaviour                                                     |
| -------------------- | -------------------------------------------------------------------- |
| `connection-refused` | Fail as if the TCP connection was refused                             |
| `connection-reset`   | Fail as if the peer reset the connection mid-exchange                 |
| `timeout`            | Fail as if the request timed out                                      |
| `dns-failure`        | Fail as if the hostname did not resolve                               |
| `tls-error`          | Fail as if the TLS handshake failed                                   |
| `partial-response`   | Deliver `response` headers, then truncate the body                    |

`partial-response` is the one type that requires a `response`; for it, both
`response` and `fault` MUST be present. It exists because "server hung up halfway
through the body" is a real failure mode that a client's retry logic must handle,
and no other type reproduces it.

Implementations MUST raise the error their ecosystem's HTTP client raises for the
corresponding real condition, so that application code catching a connection error
catches this one. Where no faithful equivalent exists, the implementation MUST
document what it raises instead. `afterMs`, like `timing.latencyMs`, is only
honoured when latency simulation is enabled.

---

## 11. Versioning and compatibility

### 11.1 Version numbering

`hif` is `MAJOR.MINOR`. There is no patch component: a change either alters how a
document is interpreted or it does not.

- **MINOR** increments add optional members or add values to an existing
  enumeration in a way that a 1.0 reader can ignore without misreading the
  document.
- **MAJOR** increments change the meaning of existing members, remove members, or
  make a previously optional member required.

### 11.2 Reader requirements

A reader implementing version `1.m` MUST:

- Accept any document with `hif` of `"1.n"` for `n ≤ m`.
- Accept a document with `hif` of `"1.n"` for `n > m`, ignoring members it does not
  know, and SHOULD emit a warning naming the version difference.
- **Reject** a document whose major version differs, with a structural error. It
  MUST NOT attempt partial interpretation.
- Reject a `hif` value that is not two dot-separated non-negative integers.

The forward-compatibility rule is what makes the format extensible without a flag
day: a 1.0 player can replay a 1.1 fixture, and will simply not honour whatever
1.1 added. Since every MINOR addition is optional by definition, the interactions
still replay.

### 11.3 Errors

Two error classes, which implementations MUST keep distinct:

**Structural errors** — the document is not a valid fixture. Malformed JSON, a
missing required member, a wrong type, an unknown major version, both `response`
and `fault`, invalid base64, a duplicate `id`, a header name or value or reason
phrase violating §6.3.1, a port outside 1..65535, a regex outside the §7.6.2
subset. Loading MUST fail.

**Match failures** — the document is valid, but no interaction corresponds to a
live request. Replay MUST fail with the explanation of §13.

Conflating them produces the failure mode this format is trying to fix: a typo in
a fixture that surfaces as "request did not match".

---

## 12. Canonical JSON serialization

Used for `exact` body comparison of `json` bodies (§7.4.1), for delivering `json`
response bodies (§6.5.2), and for the digest of §14.

HIF canonical JSON is [RFC 8785] (JSON Canonicalization Scheme), with no
modifications. Rather than restate it, the requirements that matter here:

### 12.1 Members
Object members are sorted by the UTF-16 code unit sequence of their names.
Duplicate member names cannot occur, since the input is a parsed JSON value.

### 12.2 Strings
Serialized per RFC 8785 §3.2.2.2: the control characters and `"` and `\` use the
short escapes where JSON defines them, other C0 controls use `\u00XX` lowercase
hex, and every other code point is emitted literally as UTF-8.

### 12.3 Numbers
Serialized per RFC 8785 §3.2.2.3, which is ECMAScript `Number::toString` applied
to the IEEE 754 double value. Consequences to be aware of:

- Integers up to 2^53 are exact. Beyond that, precision is lost — `10000000000000001`
  canonicalizes to `10000000000000000`.
- `-0` canonicalizes to `0`.
- `NaN` and infinities cannot appear, since they are not JSON.

An implementation MUST detect the lossy case: if re-parsing the canonical form of a
number does not yield the same double, and the original literal differs from the
canonical form, that is a **round-trip loss**. Recorders MUST warn on round-trip
loss and SHOULD store the body as `text` instead (§6.5.2). This is the honest
handling of a real limitation: a 64-bit integer ID from an API cannot be stored in
a `json` body without corruption, and the format says so rather than silently
truncating.

---

## 13. Mismatch explanation

When no interaction matches, an implementation MUST be able to produce a
**mismatch report**. The report is a data structure; rendering is up to the
implementation, but the data and the ordering are specified so that two
implementations explain the same failure the same way.

### 13.1 Structure

```jsonc
{
  "request": { /* the normalized live request */ },
  "candidates": [
    {
      "ref": "create-user",
      "index": 2,
      "score": 5,
      "total": 6,
      "fields": [
        { "field": "method", "ok": true,  "expected": "POST", "actual": "POST" },
        { "field": "body",   "ok": false, "reason": "json.unexpected-member",
          "path": "/role", "expected": null, "actual": "admin" }
      ]
    }
  ],
  "suggestions": [ /* §13.4 */ ]
}
```

### 13.2 Scoring and ordering

`score` is the number of compared fields that matched; `total` is the number
compared. Compared fields are exactly those not set to `ignore`, plus `body` when
its mode is not `ignore`. Candidates MUST be ordered by:

1. `score` descending,
2. then `total` descending,
3. then `index` ascending.

This is a total order over candidates and therefore deterministic. Ties broken by
index mean the report never depends on hash iteration order.

Implementations MUST report at least the highest-ranked candidate and SHOULD make
the full list available. An empty fixture yields zero candidates, and the report
MUST say so rather than emitting an empty explanation.

### 13.3 Field reasons

`reason` MUST be one of these stable identifiers. They are part of the spec so
that tooling can act on them.

| Reason                        | Meaning                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `value-differs`               | Scalar comparison failed                                  |
| `query.missing-param`         | Recorded parameter absent from the live request           |
| `query.unexpected-param`      | Live parameter absent from the recorded request           |
| `query.value-differs`         | Same name, different value                                |
| `header.missing`              | Recorded field absent from the live request               |
| `header.unexpected`           | Live field absent from the recorded request               |
| `header.value-differs`        | Same name, different value                                |
| `header.count-differs`        | Different number of repetitions of one name               |
| `body.encoding-differs`       | One side has a body, the other does not                   |
| `body.not-json`               | `json` mode, live body is not parseable JSON              |
| `body.not-text`               | `text` mode, live body is binary                          |
| `body.bytes-differ`           | `exact` mode, bytes differ                                |
| `body.text-differs`           | `text` mode, template did not match                       |
| `json.missing-member`         | Recorded member absent from the live body                 |
| `json.unexpected-member`      | Live member absent from the recorded body, `extra: reject`|
| `json.type-differs`           | Same path, different JSON type                            |
| `json.value-differs`          | Same path, same type, different value                     |
| `json.array-length-differs`   | Arrays of different length at a path                      |
| `json.placeholder-unsatisfied`| A placeholder's constraint was not met                    |
| `depleted`                    | Would have matched, but its play count is exhausted       |
| `fault-only`                  | Informational: candidate produces a fault, not a response |

`depleted` deserves note. A candidate excluded by §7.5 step 1 is not evaluated for
selection, but a report MUST still evaluate it and mark it `depleted` if it would
otherwise have matched — "you called this endpoint three times but recorded it
twice" is the actual cause, and hiding it produces a baffling report.

### 13.4 Suggestions

A suggestion proposes a change that would make the highest-ranked candidate match.

```jsonc
{
  "kind": "match-config",
  "target": "interactions[2].match.body.json.extra",
  "value": "allow",
  "description": "Allow unexpected members in the request body",
  "verified": true
}
```

**A suggestion MUST NOT be emitted unless the implementation has verified it.**
Verification means: apply the proposed change to a copy of the effective
configuration, re-run the match against the same live request, and observe that it
now matches. `verified` MUST be `true`; the field exists so that the guarantee is
visible in the data, not so that unverified suggestions can be flagged.

If no single proposed change makes the candidate match, the implementation MUST
emit no suggestions and MUST say that no single change explains the mismatch. It
MUST NOT speculate about the cause. An explanation engine that guesses is worse
than one that stays silent, because a wrong suggestion sends a developer down a
false path — and the whole reason this section exists is that "request did not
match" already wastes that time.

Implementations MUST attempt at least these candidate changes, and MUST evaluate
them in this order so that reports are stable:

1. `match.body.json.extra` → `"allow"`
2. `match.body.json.ignore` → add the differing path
3. `match.query.ignore` → add the differing parameter name
4. `match.headers.ignore` → add the differing field name
5. `match.<field>` → `"ignore"`, for each of `method`, `scheme`, `host`, `port`,
   `path`, in that order
6. `match.body.mode` → `"ignore"`

Suggestions MUST be capped at the first three that verify.

---

## 14. Fixture digest

A stable identifier for a recorded request, used for deduplication, cache keys,
and stable interaction ids. It is **not** used for matching.

`hif-digest-1` of a request is the lowercase hex SHA-256 of the UTF-8 encoding of
the canonical JSON (§12) of this value:

```jsonc
{
  "b": <body>,
  "h": [[name, value], ...],
  "m": <method>,
  "u": <normalized url>
}
```

where:

- `m` is the method as stored (§6.1).
- `u` is the normalized URL (§6.4), with query parameters **sorted** by
  `(name, value)` using UTF-16 code unit ordering, and re-encoded.
- `h` is the header list, lowercased, sorted by `(name, value)` using UTF-16 code
  unit ordering. Repeated names produce repeated entries.
- `b` is the body: `null` for `empty`, the string for `text`, the parsed value for
  `json`, and `{"base64": "..."}` for `base64`.

Member names are single letters so that RFC 8785's name sort produces the order
shown, which makes the serialization easy to verify by hand.

Test vectors are in `conformance/cases/digest/`, and their expected values are
verified against `openssl dgst -sha256` rather than against any HIF
implementation.

---

## 15. Conformance

An implementation is **conforming** if it passes every case in `conformance/` at
its declared level.

| Level        | Requirement                                                            |
| ------------ | ---------------------------------------------------------------------- |
| **Core**     | §2–§8, §11, §12, §14. Parse, validate, normalize, match, digest.        |
| **Explain**  | Core, plus §13.                                                        |
| **Redact**   | Core, plus §9.                                                         |
| **Full**     | All of the above, plus §10.                                            |

The levels exist so that a partial implementation can be honest about what it
supports. A new language port that implements matching but not redaction is useful
and should be able to say precisely that.

Implementations MUST NOT describe themselves as conforming without passing the
suite, and the suite version passed SHOULD be stated.

---

## Appendix A — Complete example

```json
{
  "hif": "1.0",
  "meta": {
    "name": "users-api",
    "recorder": { "name": "spool-python", "version": "0.1.0" },
    "redaction": { "applied": true, "rules": ["headers"] }
  },
  "defaults": {
    "match": { "headers": { "mode": "none" } }
  },
  "interactions": [
    {
      "id": "create-user",
      "request": {
        "method": "POST",
        "url": "https://api.example.com/v1/users",
        "headers": [
          ["authorization", "{{redacted}}"],
          ["content-type", "application/json"]
        ],
        "body": {
          "encoding": "json",
          "json": { "name": "Ada", "email": "{{any:string}}" }
        }
      },
      "response": {
        "status": 201,
        "statusText": "Created",
        "headers": [["content-type", "application/json"]],
        "body": {
          "encoding": "json",
          "json": { "id": 7, "name": "Ada", "createdAt": "2026-08-10T09:41:12Z" }
        }
      },
      "match": {
        "body": { "mode": "json", "json": { "extra": "reject" } }
      },
      "timing": { "latencyMs": 143 },
      "expect": { "called": "once" }
    },
    {
      "id": "get-user-flaky",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/v1/users/7"
      },
      "fault": { "type": "connection-reset", "message": "simulated reset" },
      "replay": { "times": 1 }
    },
    {
      "id": "get-user",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/v1/users/7"
      },
      "response": {
        "status": 200,
        "headers": [["content-type", "application/json"]],
        "body": { "encoding": "json", "json": { "id": 7, "name": "Ada" } }
      },
      "replay": { "times": "unlimited" }
    }
  ]
}
```

The second and third interactions together express "the first GET fails, retries
succeed" — the retry test that is awkward to write in most existing tools, and
which falls out of §7.5 selection with no special construct.

---

## Appendix B — Relationship to HAR

HAR ([HTTP Archive] 1.2) is the closest existing format. The W3C draft is marked
"DO NOT USE … abandoned", and its data model is a browser network *log*: it
records what happened, with rich page-load timing, and defines nothing about
matching, redaction, dynamic values, or fault injection. Tools that replay HAR
therefore each invent a private layer on top, which is the fragmentation HIF is
trying to end.

Conversion is nonetheless useful, and lossy in both directions:

| HAR → HIF                                                  | HIF → HAR                                       |
| ---------------------------------------------------------- | ----------------------------------------------- |
| `entries[].request/response` map cleanly                    | Interactions map to entries                     |
| `time`/`timings` collapse to `timing.latencyMs`             | `timings` cannot be reconstructed               |
| `pages`, `cache`, `serverIPAddress`, `connection` are lost  | —                                               |
| Matching rules must be supplied; defaults of §7.1 are used  | `match` has no representation and is dropped    |
| Cookie objects are flattened into header fields             | Header fields are not re-split into cookies     |
| Redaction is not applied by HAR; §9 SHOULD be run on import | `{{redacted}}` survives as literal text          |

A converter MUST report what it dropped. `spool import har` does.

---

## References

- [RFC 2119] / [RFC 8174] — Requirement keywords
- [RFC 3986] — URI Generic Syntax
- [RFC 3339] — Date and Time on the Internet
- [RFC 4648] — Base16, Base32, Base64 Encodings
- [RFC 6901] — JavaScript Object Notation (JSON) Pointer
- [RFC 8785] — JSON Canonicalization Scheme (JCS)
- [RFC 9110] — HTTP Semantics

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174
[RFC 3986]: https://www.rfc-editor.org/rfc/rfc3986
[RFC 3339]: https://www.rfc-editor.org/rfc/rfc3339
[RFC 4648]: https://www.rfc-editor.org/rfc/rfc4648
[RFC 6901]: https://www.rfc-editor.org/rfc/rfc6901
[RFC 8785]: https://www.rfc-editor.org/rfc/rfc8785
[RFC 9110]: https://www.rfc-editor.org/rfc/rfc9110
[HTTP Archive]: http://www.softwareishard.com/blog/har-12-spec/
