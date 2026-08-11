# Matching

How Spool decides that a live request corresponds to a recorded one. The
normative rules are [§7](../specification/hif-1.0.md#7-matching); this explains
them and, more usefully, why the defaults are what they are.

## The defaults, in full

```json
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

A freshly recorded fixture replays under these without configuration. Two
choices in there are deliberate and worth understanding.

### Why headers default to being ignored

Clients send headers you do not control: `user-agent`, `accept-encoding`,
`connection`, `content-length` computed by the transport, tracing headers
injected by instrumentation. Comparing all of them produces fixtures that break
when an unrelated dependency is upgraded — which is precisely the flakiness this
format exists to remove.

So the default is to compare none, and you opt into the two or three that
actually affect the response:

```json
"match": { "headers": { "mode": "listed", "include": ["accept", "content-type"] } }
```

### Why unexpected body fields are rejected

The reverse reasoning. A request body is written by *your* code, so an
unexpected field usually means your code changed — which is exactly what the
test should catch. Silently accepting it would let a behaviour change pass.

When the extra field is genuinely irrelevant, `extra: "allow"` says so
explicitly, and `spool explain` will offer it when it verifies as a fix.

## Where configuration lives

Three layers, resolved in order:

1. Spec defaults (above)
2. `defaults.match` in the fixture
3. `match` on the individual interaction

Merging is **shallow per named sub-object** ([§4](../specification/hif-1.0.md#4-defaults)).
An interaction's `match.query` replaces `defaults.match.query` wholesale rather
than merging into it:

```json
{
  "defaults": { "match": { "query": { "mode": "subset", "ignore": ["ts"] } } },
  "interactions": [
    {
      "match": { "query": { "mode": "exact" } },
      "...": "this interaction's query.ignore is now [], not ['ts']"
    }
  ]
}
```

Deep merging would be friendlier in the easy case and much harder to reason
about in the hard one. With shallow merging, the effective configuration of any
interaction is readable from at most two places.

## URL

The URL is never compared as a string. It is decomposed into scheme, host, port,
path and query, each under its own rule, after the normalizations in
[§6.4](../specification/hif-1.0.md#64-url-normalization).

Both sides normalize, so these match:

| Recorded | Live | Why |
| --- | --- | --- |
| `https://API.example.com/a` | `https://api.example.com/a` | host lowercased |
| `https://x/a` | `https://x:443/a` | default port removed |
| `https://x/a%7Eb` | `https://x/a~b` | unreserved octet decoded |
| `https://x/a/b/../c` | `https://x/a/c` | dot segments resolved |
| `https://x/a?b=1#frag` | `https://x/a?b=1` | fragment dropped |

And these do **not**:

| Recorded | Live | Why |
| --- | --- | --- |
| `https://x/a%2Fb` | `https://x/a/b` | `%2F` is reserved; an encoded slash is not a separator |
| `https://x/a/` | `https://x/a` | trailing slashes are never added or removed |
| `https://x/a` | `http://x/a` | scheme is compared |

Normalization does exactly the listed steps and nothing else. In particular it
never sorts query parameters and never touches `+` in a path.

## Query

| Mode | Behaviour |
| --- | --- |
| `exact` | The multisets of `(name, value)` pairs must be equal. **Default.** |
| `subset` | Every recorded parameter must be present; extras are allowed. |
| `ignore` | Not compared. |

Multiset, not list: `?a=1&b=2` matches `?b=2&a=1`. Repetition counts, so
`?a=1&a=1` does not match `?a=1`.

A parameter written without `=` is distinct from one with an empty value:
`?flag` does not match `?flag=`. This trips people up, and it is deliberate —
some APIs treat them differently.

`ignore` removes names from **both** sides, which is the right tool for a
cache-buster or a timestamp:

```json
"match": { "query": { "ignore": ["_", "ts", "cacheBust"] } }
```

## Headers

| Mode | Behaviour |
| --- | --- |
| `none` | Not compared. **Default.** |
| `listed` | Only the names in `include`. |
| `all` | Every recorded name, except those in `ignore`. |

Under `all`, a live request may carry *additional* headers not in the recording;
those are not compared. `all` means "every header I recorded must still be
there", not "no header may ever be added". The stricter reading would make
fixtures break on transport upgrades for no benefit.

Repeated field names are compared as ordered lists, so two `set-cookie` values
in a different order do not match. Names are case-insensitive; values are
compared after stripping leading and trailing spaces and tabs.

## Body

| Mode | Behaviour |
| --- | --- |
| `auto` | `json` if the recorded body is JSON, else `exact`. **Default.** |
| `exact` | Byte-for-byte. |
| `json` | Structural, order-insensitive for object members. |
| `text` | Template matching with placeholders ([§7.4.3](../specification/hif-1.0.md#743-text)). |
| `ignore` | Not compared. |

Under `json`:

- Object members compare order-insensitively; **arrays are order-sensitive**,
  because they are ordered in JSON and treating them otherwise would let a
  genuinely different request match.
- Numbers compare by canonical value, so `1`, `1.0` and `1e0` are equal.
- `extra: "reject"` (default) fails on an unexpected member. `"allow"` ignores
  them recursively at every depth.
- A member present in the recording but missing from the live request **always**
  fails, under both settings. `extra` governs only the unexpected direction.

`json.ignore` drops paths from both sides before comparison, using the path
syntax below. A path that matches nothing is not an error, so a shared
`defaults.match` can list fields only some interactions have.

## JSON paths

RFC 6901 JSON Pointer plus `*` as a single-token wildcard:

```
/user/password          the password member of user
/items/*/token          the token member of every element of items
/*/secret               the secret member of every top-level member
```

`~0` is a literal `~`, `~1` a literal `/`, and `~2` a literal `*`.

## Placeholders

A recorded value can say "anything of this shape" instead of a fixed value.

| Placeholder | Matches |
| --- | --- |
| `{{any}}` | Anything, including `null` and composites |
| `{{any:string}}` `{{any:number}}` `{{any:boolean}}` `{{any:array}}` `{{any:object}}` | That JSON type |
| `{{any:uuid}}` | A UUID-shaped string |
| `{{any:iso8601}}` | An RFC 3339 date-time-shaped string |
| `{{regex:PATTERN}}` | A string fully matching PATTERN |
| `{{redacted}}` | Anything. Written by redaction. |

Usable in recorded header values, query values, JSON string values and text
bodies. They mean nothing in a response — a `{{any}}` in a response body is
delivered as those six characters.

**Recognition is narrow on purpose.** Outside a text body, a string is a
placeholder only if the *entire* string is one. `"id is {{any}}"` is a literal.
To write a literal `{{any}}` as an entire string, escape it: `"\\{{any}}"` in
JSON source.

`{{any:iso8601}}` validates shape only, not the calendar — `2026-02-31T00:00:00Z`
is accepted. Calendar validation would make matching depend on a date library
and is where implementations would drift.

### The regex subset

`{{regex:...}}` is anchored against the whole subject and restricted to a subset
that behaves identically in every language
([§7.6.2](../specification/hif-1.0.md#762-regex)). Allowed: literals and escapes,
character classes, `\d \D \w \W \s \S` (ASCII-defined), `.` (excluding only
U+000A), groups, alternation, and the quantifiers `? * +` and `{n,m}`.

Excluded and **rejected at load time**: non-capturing and named groups,
lookaround, backreferences, word boundaries, lazy and possessive quantifiers,
Unicode property escapes, and **any quantifier applied to a group**.

That last one is the safety rule rather than a portability rule. `(a+)+b` is
valid in every engine and never terminates against a run of `a` characters, so
`(ab)+` and `(a|aa)*` are rejected too — a quantified group is where exponential
backtracking comes from. `(cat|dog)s` is fine, because no quantifier follows the
group.

Two of these matter more than they look. JavaScript's `\s` matches Unicode
whitespace while Python's `re.ASCII` does not; and JavaScript's `.` excludes
`\r` while Python's does not. Both implementations rewrite the shorthands into
explicit ASCII classes rather than relying on host behaviour, so a pattern means
the same thing everywhere.

## Selection

When several interactions match, the **first in document order** wins, among
those with plays remaining ([§7.5](../specification/hif-1.0.md#75-selection-algorithm)).

Each interaction has a play count, `replay.times`, defaulting to 1. That single
rule gives you sequencing for free:

```json
"interactions": [
  { "id": "reset",   "request": { "method": "GET", "url": "https://x/job" },
    "fault": { "type": "connection-reset" } },
  { "id": "pending", "request": { "method": "GET", "url": "https://x/job" },
    "response": { "status": 200, "body": { "encoding": "json", "json": { "state": "pending" } } } },
  { "id": "done",    "request": { "method": "GET", "url": "https://x/job" },
    "response": { "status": 200, "body": { "encoding": "json", "json": { "state": "done" } } },
    "replay": { "times": "unlimited" } }
]
```

Fails, then reports pending, then reports done forever. No sequencing API, no
call-count matcher, no stateful mock.

Play counts are player state, not fixture state, and reset when you construct or
reset a player — so tests stay isolated.

### Running out

Calling an endpoint more times than you recorded is a distinct failure, and the
report says so rather than showing a confusing field-by-field diff:

```
    ✗ replay:   already played 1 of 1 times

      This interaction matches the request in every compared field,
      but its play count is exhausted.
```

## Debugging

```bash
spool explain fixtures/users.hif.json request.json --all
```

`--all` shows every candidate rather than only the closest. `SPOOL_EXPLAIN=all`
does the same for reports raised from inside a test run.
