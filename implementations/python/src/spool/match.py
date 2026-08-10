"""Request matching, per specification section 7.

Everything here is a pure function of (recorded request, live request, resolved
config). No clock, no environment, no iteration over unordered containers
without an explicit sort. That is what section 7 means by deterministic, and it
is what makes the conformance suite meaningful.

The matcher always evaluates every compared field, even after one has failed,
because the mismatch report (section 13) needs the full picture to rank
candidates and to avoid reporting one difference at a time.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any, Dict, List, Optional, Sequence

from .body import (
    NormalizedHeader,
    body_bytes,
    body_json,
    body_json_missing,
    body_text,
    contains_name,
    names_of,
    normalize_headers,
    or_empty,
    values_for,
)
from .placeholder import (
    parse_placeholder,
    parse_text_template,
    satisfies_json,
    satisfies_string,
    string_matches,
    text_matches_template,
    unescape_literal,
)
from .pointer import format_path, omit_paths
from .url import QueryParam, decode_query, normalize_url

_UNSET = object()


@dataclass
class NormalizedRequest:
    method: str
    scheme: str
    host: str
    port: Optional[int]
    path: str
    query: List[QueryParam]
    headers: List[NormalizedHeader]
    body: Dict[str, Any]
    url: str


@dataclass
class FieldResult:
    field: str
    ok: bool
    reason: Optional[str] = None
    path: Optional[str] = None
    expected: Any = _UNSET
    actual: Any = _UNSET
    details: List[FieldResult] = dataclass_field(default_factory=list)

    def has_expected(self) -> bool:
        return self.expected is not _UNSET

    def has_actual(self) -> bool:
        return self.actual is not _UNSET


# ---------------------------------------------------------------------------
# Configuration (section 7.1)
# ---------------------------------------------------------------------------


def default_match_config() -> Dict[str, Any]:
    """Section 7.1 defaults, spelled out."""
    return {
        "method": "exact",
        "scheme": "exact",
        "host": "exact",
        "port": "exact",
        "path": "exact",
        "query": {"mode": "exact", "ignore": []},
        "headers": {"mode": "none", "include": [], "ignore": []},
        "body": {"mode": "auto", "json": {"extra": "reject", "ignore": []}},
    }


def resolve_match_config(
    fixture_defaults: Optional[Dict[str, Any]] = None,
    interaction: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Section 4: merging is shallow per named sub-object.

    ``defaults.match.query`` is replaced wholesale by ``interaction.match.query``,
    not deep merged, so the effective configuration of an interaction is readable
    from at most two places.
    """
    config = default_match_config()

    def layer(source: Optional[Dict[str, Any]]) -> None:
        if not source:
            return
        for name in ("method", "scheme", "host", "port", "path"):
            if source.get(name):
                config[name] = source[name]
        if "query" in source and source["query"] is not None:
            query = source["query"]
            config["query"] = {"mode": query.get("mode", "exact"), "ignore": list(query.get("ignore", []))}
        if "headers" in source and source["headers"] is not None:
            headers = source["headers"]
            config["headers"] = {
                "mode": headers.get("mode", "none"),
                "include": list(headers.get("include", [])),
                "ignore": list(headers.get("ignore", [])),
            }
        if "body" in source and source["body"] is not None:
            body = source["body"]
            json_config = body.get("json") or {}
            config["body"] = {
                "mode": body.get("mode", "auto"),
                "json": {
                    "extra": json_config.get("extra", "reject"),
                    "ignore": list(json_config.get("ignore", [])),
                },
            }

    layer(fixture_defaults)
    layer(interaction)
    return config


# ---------------------------------------------------------------------------


def normalize_request(request: Dict[str, Any]) -> NormalizedRequest:
    """Turn a stored or live request into the shape section 7 compares."""
    url = normalize_url(request["url"])
    return NormalizedRequest(
        method=request["method"],
        scheme=url.scheme,
        host=url.host,
        port=url.port,
        path=url.path,
        query=decode_query(url.raw_query),
        headers=normalize_headers(request.get("headers")),
        body=or_empty(request.get("body")),
        url=url.href,
    )


def match_request(
    recorded: NormalizedRequest, live: NormalizedRequest, config: Dict[str, Any]
) -> List[FieldResult]:
    """Evaluate the match predicate, one FieldResult per compared field."""
    results: List[FieldResult] = []

    for name in ("method", "scheme", "host", "port", "path"):
        if config[name] == "exact":
            results.append(_scalar(name, getattr(recorded, name), getattr(live, name)))

    if config["query"]["mode"] != "ignore":
        results.append(_match_query(recorded.query, live.query, config))
    if config["headers"]["mode"] != "none":
        results.append(_match_headers(recorded.headers, live.headers, config))
    if config["body"]["mode"] != "ignore":
        results.append(_match_body(recorded.body, live.body, config))

    return results


def is_match(results: Sequence[FieldResult]) -> bool:
    return all(r.ok for r in results)


def _scalar(name: str, expected: Any, actual: Any) -> FieldResult:
    if expected == actual:
        return FieldResult(name, True, expected=expected, actual=actual)
    return FieldResult(name, False, reason="value-differs", expected=expected, actual=actual)


# ---------------------------------------------------------------------------
# Query (section 7.3)
# ---------------------------------------------------------------------------


def _param_key(param: QueryParam) -> str:
    return f"{param.name} <valueless>" if param.valueless else f"{param.name} ={param.value}"


def _match_query(
    recorded_raw: List[QueryParam], live_raw: List[QueryParam], config: Dict[str, Any]
) -> FieldResult:
    ignore = set(config["query"]["ignore"])
    recorded = [p for p in recorded_raw if p.name not in ignore]
    live = [p for p in live_raw if p.name not in ignore]

    # Recorded parameters may carry placeholders, so they cannot all go through
    # multiset comparison. Literals are compared as a multiset; placeholders are
    # satisfied against a remaining live parameter of the same name.
    literals = [p for p in recorded if parse_placeholder(p.value) is None]
    placeholders = [p for p in recorded if parse_placeholder(p.value) is not None]

    remaining: Dict[str, int] = {}
    for param in live:
        key = _param_key(param)
        remaining[key] = remaining.get(key, 0) + 1

    details: List[FieldResult] = []

    for param in literals:
        key = _param_key(param._replace(value=unescape_literal(param.value)))
        if remaining.get(key, 0) > 0:
            remaining[key] -= 1
            continue
        same_name = [p for p in live if p.name == param.name]
        if same_name:
            details.append(
                FieldResult(
                    "query",
                    False,
                    reason="query.value-differs",
                    path=param.name,
                    expected=param.value,
                    actual=", ".join(p.value for p in same_name),
                )
            )
        else:
            details.append(
                FieldResult(
                    "query", False, reason="query.missing-param", path=param.name, expected=param.value
                )
            )

    for param in placeholders:
        placeholder = parse_placeholder(param.value)
        assert placeholder is not None
        candidate = next(
            (p for p in live if p.name == param.name and remaining.get(_param_key(p), 0) > 0), None
        )
        if candidate is None:
            details.append(
                FieldResult(
                    "query", False, reason="query.missing-param", path=param.name, expected=param.value
                )
            )
        elif satisfies_string(placeholder, candidate.value):
            remaining[_param_key(candidate)] -= 1
        else:
            details.append(
                FieldResult(
                    "query",
                    False,
                    reason="query.value-differs",
                    path=param.name,
                    expected=param.value,
                    actual=candidate.value,
                )
            )

    if config["query"]["mode"] == "exact":
        # Report leftover live parameters in live-request order, never in dict
        # iteration order, so the report is deterministic.
        leftover = dict(remaining)
        for param in live:
            key = _param_key(param)
            if leftover.get(key, 0) > 0:
                leftover[key] -= 1
                details.append(
                    FieldResult(
                        "query",
                        False,
                        reason="query.unexpected-param",
                        path=param.name,
                        actual=param.value,
                    )
                )

    if not details:
        return FieldResult("query", True)
    first = details[0]
    return FieldResult(
        "query", False, first.reason, first.path, first.expected, first.actual, details
    )


# ---------------------------------------------------------------------------
# Headers (section 7.2)
# ---------------------------------------------------------------------------


def _match_headers(
    recorded: List[NormalizedHeader], live: List[NormalizedHeader], config: Dict[str, Any]
) -> FieldResult:
    details: List[FieldResult] = []
    headers_config = config["headers"]

    if headers_config["mode"] == "listed":
        names = [n.lower() for n in headers_config["include"]]
    else:
        names = [n for n in names_of(recorded) if not contains_name(headers_config["ignore"], n)]

    for name in names:
        expected = values_for(recorded, name)
        actual = values_for(live, name)

        if not expected and not actual:
            continue
        if not expected:
            details.append(
                FieldResult("headers", False, "header.unexpected", name, actual=", ".join(actual))
            )
            continue
        if not actual:
            details.append(
                FieldResult("headers", False, "header.missing", name, expected=", ".join(expected))
            )
            continue
        if len(expected) != len(actual):
            details.append(
                FieldResult(
                    "headers", False, "header.count-differs", name, len(expected), len(actual)
                )
            )
            continue
        for want, got in zip(expected, actual):
            if not string_matches(want, got):
                details.append(FieldResult("headers", False, "header.value-differs", name, want, got))

    if not details:
        return FieldResult("headers", True)
    first = details[0]
    return FieldResult(
        "headers", False, first.reason, first.path, first.expected, first.actual, details
    )


# ---------------------------------------------------------------------------
# Body (section 7.4)
# ---------------------------------------------------------------------------


def _effective_body_mode(recorded: Dict[str, Any], config: Dict[str, Any]) -> str:
    mode = config["body"]["mode"]
    if mode == "auto":
        return "json" if recorded.get("encoding") == "json" else "exact"
    return str(mode)


def _match_body(recorded: Dict[str, Any], live: Dict[str, Any], config: Dict[str, Any]) -> FieldResult:
    mode = _effective_body_mode(recorded, config)

    if mode == "exact":
        a = body_bytes(recorded)
        b = body_bytes(live)
        if a == b:
            return FieldResult("body", True)
        if (len(a) == 0) != (len(b) == 0):
            return FieldResult(
                "body",
                False,
                "body.encoding-differs",
                expected=_describe(recorded),
                actual=_describe(live),
            )
        return FieldResult("body", False, "body.bytes-differ", expected=_preview(a), actual=_preview(b))

    if mode == "text":
        expected_text = body_text(recorded)
        actual_text = body_text(live)
        if expected_text is None or actual_text is None:
            return FieldResult(
                "body", False, "body.not-text", expected=_describe(recorded), actual=_describe(live)
            )
        if text_matches_template(parse_text_template(expected_text), actual_text):
            return FieldResult("body", True)
        return FieldResult("body", False, "body.text-differs", expected=expected_text, actual=actual_text)

    expected_json = body_json(recorded)
    if body_json_missing(expected_json):
        return FieldResult("body", False, "body.not-json", expected=_describe(recorded))
    actual_json = body_json(live)
    if body_json_missing(actual_json):
        return FieldResult("body", False, "body.not-json", actual=_describe(live))

    ignore = config["body"]["json"]["ignore"]
    if ignore:
        expected_json = omit_paths(expected_json, ignore)
        actual_json = omit_paths(actual_json, ignore)

    details: List[FieldResult] = []
    _compare_json(expected_json, actual_json, [], config["body"]["json"]["extra"] == "allow", details)

    if not details:
        return FieldResult("body", True)
    first = details[0]
    return FieldResult("body", False, first.reason, first.path, first.expected, first.actual, details)


def _compare_json(
    expected: Any, actual: Any, path: List[str], allow_extra: bool, out: List[FieldResult]
) -> None:
    """Section 7.4.2 structural comparison.

    Collects every difference rather than stopping at the first, because "you
    have three unexpected fields" beats three consecutive one-field test runs.
    Object members are visited in sorted order so the report does not depend on
    insertion order.
    """
    at = format_path(path)

    if isinstance(expected, str):
        placeholder = parse_placeholder(expected)
        if placeholder is not None:
            if not satisfies_json(placeholder, actual):
                out.append(
                    FieldResult("body", False, "json.placeholder-unsatisfied", at, expected, actual)
                )
            return
        literal = unescape_literal(expected)
        if not isinstance(actual, str):
            out.append(FieldResult("body", False, "json.type-differs", at, literal, actual))
        elif literal != actual:
            out.append(FieldResult("body", False, "json.value-differs", at, literal, actual))
        return

    if expected is None or isinstance(expected, (bool, int, float)):
        if _type_name(expected) != _type_name(actual):
            out.append(FieldResult("body", False, "json.type-differs", at, expected, actual))
        elif expected != actual:
            out.append(FieldResult("body", False, "json.value-differs", at, expected, actual))
        return

    if isinstance(expected, list):
        if not isinstance(actual, list):
            out.append(FieldResult("body", False, "json.type-differs", at, "<array>", actual))
            return
        if len(expected) != len(actual):
            out.append(
                FieldResult("body", False, "json.array-length-differs", at, len(expected), len(actual))
            )
            return
        # Section 7.4.2: arrays are order-sensitive.
        for index, item in enumerate(expected):
            _compare_json(item, actual[index], path + [str(index)], allow_extra, out)
        return

    if not isinstance(actual, dict):
        out.append(FieldResult("body", False, "json.type-differs", at, "<object>", actual))
        return

    for key in sorted(expected.keys()):
        if key not in actual:
            out.append(
                FieldResult("body", False, "json.missing-member", format_path(path + [key]), expected[key])
            )
            continue
        _compare_json(expected[key], actual[key], path + [key], allow_extra, out)

    if not allow_extra:
        for key in sorted(actual.keys()):
            if key not in expected:
                out.append(
                    FieldResult(
                        "body",
                        False,
                        "json.unexpected-member",
                        format_path(path + [key]),
                        actual=actual[key],
                    )
                )


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _describe(body: Dict[str, Any]) -> str:
    encoding = body.get("encoding")
    if encoding == "empty":
        return "<empty body>"
    if encoding == "text":
        return f"<text, {len(body['text'])} chars>"
    if encoding == "json":
        return "<json>"
    return f"<binary, {len(body.get('base64', '')) * 3 // 4} bytes>"


def _preview(data: bytes) -> str:
    text = data[:256].decode("utf-8", errors="replace")
    return text + (f"... ({len(data)} bytes total)" if len(data) > 256 else "")
