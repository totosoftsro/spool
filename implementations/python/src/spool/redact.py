"""Redaction, per specification section 9.

Read this before relying on it:

    **Redaction reduces exposure. It does not guarantee removal.**

Rule-based and entropy-based detection both have false negatives. Nothing here
may claim otherwise, and nothing it prints should let a reader conclude that a
fixture is safe to publish without being read. That is not defensive
boilerplate: a recorder that says "sanitized" is actively worse than one that
says nothing, because it stops people from looking.
"""

from __future__ import annotations

import copy
import math
import re
from collections import Counter
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import quote, unquote_plus

from .canonical import canonicalize
from .pointer import replace_paths
from .regexsubset import CompiledPattern, compile_portable_regex

#: Section 9.2. Under section 7.6 this matches anything, so replay still works.
REDACTED = "{{redacted}}"

DEFAULT_HEADERS: Tuple[str, ...] = (
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "www-authenticate",
    "proxy-authenticate",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-amz-security-token",
    "x-csrf-token",
    "x-xsrf-token",
)

DEFAULT_QUERY_PARAMS: Tuple[str, ...] = (
    "access_token",
    "api_key",
    "apikey",
    "auth",
    "code",
    "id_token",
    "password",
    "refresh_token",
    "secret",
    "session",
    "signature",
    "sig",
    "token",
)

DEFAULT_JSON_FIELDS: Tuple[str, ...] = (
    "access_token",
    "api_key",
    "apikey",
    "authorization",
    "client_secret",
    "credentials",
    "id_token",
    "password",
    "passwd",
    "private_key",
    "refresh_token",
    "secret",
    "session_token",
    "token",
)


@dataclass
class EntropyConfig:
    #: Section 9.4 defaults to on for header and query values.
    headers_and_query: bool = True
    #: Section 9.4 defaults to off for text bodies: prose produces false positives.
    text_bodies: bool = False
    min_length: int = 24
    max_length: int = 512
    min_bits: float = 3.5


@dataclass
class RedactionConfig:
    headers: Sequence[str] = ()
    query_params: Sequence[str] = ()
    json_fields: Sequence[str] = ()
    json_paths: Sequence[str] = ()
    patterns: Sequence[Dict[str, str]] = ()
    entropy: Optional[EntropyConfig] = dataclass_field(default_factory=EntropyConfig)
    #: Replace the defaults instead of extending them. Off by default.
    replace_defaults: bool = False


@dataclass
class _Resolved:
    headers: Set[str]
    query_params: Set[str]
    json_fields: Set[str]
    json_paths: List[str]
    patterns: List[Tuple[str, CompiledPattern]]
    entropy: Optional[EntropyConfig]


def _resolve(config: Optional[RedactionConfig]) -> _Resolved:
    config = config or RedactionConfig()
    if config.replace_defaults:
        base_headers: Tuple[str, ...] = ()
        base_query: Tuple[str, ...] = ()
        base_fields: Tuple[str, ...] = ()
    else:
        base_headers, base_query, base_fields = DEFAULT_HEADERS, DEFAULT_QUERY_PARAMS, DEFAULT_JSON_FIELDS

    return _Resolved(
        headers={h.lower() for h in (*base_headers, *config.headers)},
        query_params={q.lower() for q in (*base_query, *config.query_params)},
        json_fields={f.lower() for f in (*base_fields, *config.json_fields)},
        json_paths=list(config.json_paths),
        patterns=[(p["name"], compile_portable_regex(p["regex"])) for p in config.patterns],
        entropy=config.entropy,
    )


# ---------------------------------------------------------------------------
# Entropy (section 9.4)
# ---------------------------------------------------------------------------

#: Section 9.4 step 1. `=` is not in the splitting alphabet — otherwise
#: `key=AKIAIOSFODNN7EXAMPLE` would be a single token and every `name=value`
#: pair would be glued to its name — but a token absorbs any `=` immediately
#: following it, which is base64 padding.
_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9+/_-]+=*")
_CREDENTIAL_SHAPED = re.compile(r"\A[A-Za-z0-9+/=_-]+\Z")
_HAS_DIGIT = re.compile(r"[0-9]")
_HAS_LETTER = re.compile(r"[A-Za-z]")


def shannon_entropy(token: str) -> float:
    """Section 9.4 step 4: Shannon entropy in bits per character."""
    if not token:
        return 0.0
    counts = Counter(token)
    length = len(token)
    bits = 0.0
    # Sorted so that floating-point summation order is identical everywhere.
    for ch in sorted(counts):
        p = counts[ch] / length
        bits -= p * math.log2(p)
    return bits


def entropy_tokens(subject: str, config: Optional[EntropyConfig] = None) -> List[str]:
    """Section 9.4 steps 1-5. Returns tokens that qualify as suspected credentials."""
    config = config or EntropyConfig()
    hits: List[str] = []
    for match in _TOKEN_PATTERN.finditer(subject):
        token = match.group(0)
        if not config.min_length <= len(token) <= config.max_length:
            continue
        if not _CREDENTIAL_SHAPED.match(token):
            continue
        if not _HAS_DIGIT.search(token) or not _HAS_LETTER.search(token):
            continue
        if shannon_entropy(token) >= config.min_bits:
            hits.append(token)
    return hits


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------


@dataclass
class RedactionResult:
    fixture: Dict[str, Any]
    rules: List[str]
    findings: List[str]


def redact_fixture(fixture: Dict[str, Any], config: Optional[RedactionConfig] = None) -> RedactionResult:
    """Redact an entire fixture (section 9.7).

    Normally section 9 runs during recording so secrets never reach disk. This
    entry point exists for fixtures that arrived from elsewhere: converted from
    HAR, hand-written, or recorded before a rule was added.
    """
    resolved = _resolve(config)
    rules: Set[str] = set()
    findings: List[str] = []

    interactions = []
    for index, interaction in enumerate(fixture.get("interactions", [])):
        updated = dict(interaction)
        updated["request"] = redact_request(
            interaction["request"], resolved, rules, findings, f"interactions[{index}].request"
        )
        if interaction.get("response") is not None:
            updated["response"] = redact_response(
                interaction["response"], resolved, rules, findings, f"interactions[{index}].response"
            )
        interactions.append(updated)

    out = dict(fixture)
    meta = dict(fixture.get("meta") or {})
    meta["redaction"] = {"applied": bool(rules), "rules": sorted(rules)}
    out["meta"] = meta
    out["interactions"] = interactions

    return RedactionResult(out, sorted(rules), findings)


def redact_request(
    request: Dict[str, Any],
    config: Any = None,
    rules: Optional[Set[str]] = None,
    findings: Optional[List[str]] = None,
    at: str = "request",
) -> Dict[str, Any]:
    resolved = config if isinstance(config, _Resolved) else _resolve(config)
    rules = rules if rules is not None else set()
    findings = findings if findings is not None else []

    out = dict(request)
    out["url"] = _redact_url(request["url"], resolved, rules, findings, at)
    if request.get("headers"):
        out["headers"] = _redact_headers(request["headers"], resolved, rules, findings, at)
    if request.get("body"):
        out["body"] = _redact_body(request["body"], resolved, rules, findings, f"{at}.body")
    return out


def redact_response(
    response: Dict[str, Any],
    config: Any = None,
    rules: Optional[Set[str]] = None,
    findings: Optional[List[str]] = None,
    at: str = "response",
) -> Dict[str, Any]:
    resolved = config if isinstance(config, _Resolved) else _resolve(config)
    rules = rules if rules is not None else set()
    findings = findings if findings is not None else []

    out = dict(response)
    if response.get("headers"):
        out["headers"] = _redact_headers(response["headers"], resolved, rules, findings, at)
    if response.get("body"):
        out["body"] = _redact_body(response["body"], resolved, rules, findings, f"{at}.body")
    return out


def _redact_headers(
    headers: Sequence[Sequence[Any]], r: _Resolved, rules: Set[str], findings: List[str], at: str
) -> List[List[Any]]:
    out: List[List[Any]] = []
    for entry in headers:
        name = str(entry[0]).lower()
        if name in r.headers:
            rules.add("headers")
            findings.append(f'{at}: header "{name}" redacted by name rule')
            out.append([name, REDACTED])
            continue
        # A three-element (non-UTF-8) value is left alone: pattern and entropy
        # rules are defined over text, and guessing at bytes would be unsound.
        if len(entry) == 3 or entry[1] is None:
            out.append(list(entry))
            continue

        value = str(entry[1])
        patterned = _apply_patterns(value, r, rules, findings, f'{at}: header "{name}"')
        final = _apply_entropy(
            patterned,
            r,
            rules,
            findings,
            f'{at}: header "{name}"',
            bool(r.entropy and r.entropy.headers_and_query),
        )
        out.append([name, final] if final != value else list(entry))
    return out


def _redact_url(url: str, r: _Resolved, rules: Set[str], findings: List[str], at: str) -> str:
    if "?" not in url:
        return url
    base, _, query = url.partition("?")
    query = query.split("#", 1)[0]

    parts: List[str] = []
    for segment in query.split("&"):
        if segment == "" or "=" not in segment:
            parts.append(segment)
            continue
        raw_name, _, raw_value = segment.partition("=")
        name = unquote_plus(raw_name).lower()

        if name in r.query_params:
            rules.add("queryParams")
            findings.append(f'{at}: query parameter "{name}" redacted by name rule')
            parts.append(f"{raw_name}={quote(REDACTED, safe='')}")
            continue

        value = unquote_plus(raw_value)
        patterned = _apply_patterns(value, r, rules, findings, f'{at}: query "{name}"')
        final = _apply_entropy(
            patterned,
            r,
            rules,
            findings,
            f'{at}: query "{name}"',
            bool(r.entropy and r.entropy.headers_and_query),
        )
        parts.append(segment if final == value else f"{raw_name}={quote(final, safe='')}")

    return base + "?" + "&".join(parts)


def _redact_body(
    body: Dict[str, Any], r: _Resolved, rules: Set[str], findings: List[str], at: str
) -> Dict[str, Any]:
    encoding = body.get("encoding")
    if encoding in ("empty", "base64"):
        return body

    if encoding == "json":
        value = body["json"]
        changed = False

        if r.json_paths:
            value, hits = replace_paths(value, r.json_paths, REDACTED)
            if hits:
                rules.add("jsonPaths")
                findings.append(f"{at}: {hits} value(s) redacted by path rule")
                changed = True

        value, field_changed = _redact_json_fields(value, r, rules, findings, at)
        changed = changed or field_changed

        if not changed:
            return body
        out = dict(body)
        out["json"] = value
        out["redacted"] = True
        return out

    text = str(body["text"])
    patterned = _apply_patterns(text, r, rules, findings, at)
    final = _apply_entropy(
        patterned, r, rules, findings, at, bool(r.entropy and r.entropy.text_bodies)
    )
    if final == text:
        return body
    out = dict(body)
    out["text"] = final
    out["redacted"] = True
    return out


def _redact_json_fields(
    value: Any, r: _Resolved, rules: Set[str], findings: List[str], at: str
) -> Tuple[Any, bool]:
    changed = False

    def walk(node: Any) -> Any:
        nonlocal changed
        if isinstance(node, list):
            return [walk(item) for item in node]
        if isinstance(node, dict):
            out: Dict[str, Any] = {}
            for key, item in node.items():
                if key.lower() in r.json_fields:
                    rules.add("jsonFields")
                    findings.append(f'{at}: member "{key}" redacted by field-name rule')
                    # Section 9.2: the member keeps its name and receives the
                    # string placeholder, whatever its original type was.
                    out[key] = REDACTED
                    changed = True
                else:
                    out[key] = walk(item)
            return out
        if isinstance(node, str):
            patterned = _apply_patterns(node, r, rules, findings, at)
            if patterned != node:
                changed = True
                return patterned
        return node

    return walk(copy.deepcopy(value)), changed


def _apply_patterns(subject: str, r: _Resolved, rules: Set[str], findings: List[str], at: str) -> str:
    out = subject
    for name, compiled in r.patterns:
        # The section 7.6.2 subset is anchored, so patterns are applied per
        # whitespace-delimited token rather than as a global search-and-replace.
        # This keeps pattern semantics identical to placeholder matching.
        tokens = re.split(r"(\s+)", out)
        hit = False
        replaced = []
        for token in tokens:
            if token.strip() == "":
                replaced.append(token)
            elif compiled.test(token):
                hit = True
                replaced.append(REDACTED)
            else:
                replaced.append(token)
        if hit:
            rules.add("patterns")
            findings.append(f'{at}: matched pattern "{name}"')
            out = "".join(replaced)
    return out


def _apply_entropy(
    subject: str, r: _Resolved, rules: Set[str], findings: List[str], at: str, enabled: bool
) -> str:
    if not enabled or r.entropy is None:
        return subject
    hits = entropy_tokens(subject, r.entropy)
    if not hits:
        return subject
    rules.add("entropy")
    out = subject
    for token in hits:
        bits = shannon_entropy(token)
        findings.append(f"{at}: suspected credential (entropy {bits:.2f} bits/char), redacted")
        out = out.replace(token, REDACTED)
    return out


# ---------------------------------------------------------------------------
# Scanning (section 9.7)
# ---------------------------------------------------------------------------


@dataclass
class ScanFinding:
    location: str
    rule: str
    #: Always phrased as a suspicion. Section 9.7 forbids asserting that a value
    #: *is* a secret.
    note: str


def scan_fixture(fixture: Dict[str, Any], config: Optional[RedactionConfig] = None) -> List[ScanFinding]:
    """Report suspected secrets without modifying the fixture.

    An empty result means the rules found nothing, not that the fixture is
    clean, and the CLI prints exactly that.
    """
    r = _resolve(config)
    findings: List[ScanFinding] = []

    for index, interaction in enumerate(fixture.get("interactions", [])):
        request = interaction.get("request") or {}
        response = interaction.get("response") or {}
        _scan_headers(request.get("headers"), r, f"interactions[{index}].request", findings)
        _scan_headers(response.get("headers"), r, f"interactions[{index}].response", findings)
        _scan_body(request.get("body"), r, f"interactions[{index}].request.body", findings)
        _scan_body(response.get("body"), r, f"interactions[{index}].response.body", findings)

    return findings


def _scan_headers(
    headers: Optional[Sequence[Sequence[Any]]], r: _Resolved, at: str, out: List[ScanFinding]
) -> None:
    for entry in headers or []:
        name = str(entry[0]).lower()
        if len(entry) == 3 or entry[1] is None:
            continue
        value = str(entry[1])
        if value == REDACTED:
            continue
        if name in r.headers:
            out.append(
                ScanFinding(
                    f'{at}.headers["{name}"]',
                    "headers",
                    "header commonly carries a credential and is not redacted",
                )
            )
            continue
        if r.entropy and r.entropy.headers_and_query:
            for token in entropy_tokens(value, r.entropy):
                out.append(
                    ScanFinding(
                        f'{at}.headers["{name}"]',
                        "entropy",
                        f"value looks credential-like ({shannon_entropy(token):.2f} bits/char)",
                    )
                )


def _scan_body(
    body: Optional[Dict[str, Any]], r: _Resolved, at: str, out: List[ScanFinding]
) -> None:
    if not body:
        return
    encoding = body.get("encoding")
    if encoding == "json":
        _walk_json_for_scan(body["json"], [], r, at, out)
        if r.entropy and r.entropy.text_bodies:
            for token in entropy_tokens(canonicalize(body["json"]), r.entropy):
                out.append(
                    ScanFinding(
                        at,
                        "entropy",
                        f"body contains a credential-like token "
                        f"({shannon_entropy(token):.2f} bits/char)",
                    )
                )
    elif encoding == "text" and r.entropy and r.entropy.text_bodies:
        for token in entropy_tokens(str(body["text"]), r.entropy):
            out.append(
                ScanFinding(
                    at,
                    "entropy",
                    f"body contains a credential-like token ({shannon_entropy(token):.2f} bits/char)",
                )
            )


def _walk_json_for_scan(
    node: Any, path: List[str], r: _Resolved, at: str, out: List[ScanFinding]
) -> None:
    if isinstance(node, list):
        for index, item in enumerate(node):
            _walk_json_for_scan(item, path + [str(index)], r, at, out)
        return
    if not isinstance(node, dict):
        return
    for key in sorted(node):
        value = node[key]
        if key.lower() in r.json_fields and value != REDACTED:
            location = "/".join(path + [key])
            out.append(
                ScanFinding(
                    f"{at}/{location}",
                    "jsonFields",
                    "member name commonly carries a credential and is not redacted",
                )
            )
        _walk_json_for_scan(value, path + [key], r, at, out)
