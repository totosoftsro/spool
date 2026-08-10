"""Loading, validating and serializing fixtures, per specification 2, 5 and 11.

Validation here produces ``HifStructuralError``, never a match failure. Keeping
the two apart is normative (section 11.3) and is the difference between "you
have a typo on line 12" and "request did not match".
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Set

from .body import validate_body
from .errors import HifStructuralError
from .placeholder import parse_placeholder
from .pointer import parse_path
from .regexsubset import compile_portable_regex
from .url import normalize_url

SUPPORTED_VERSION = "1.0"
_SUPPORTED_MAJOR = 1
_SUPPORTED_MINOR = 0

_ID_PATTERN = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_VERSION_PATTERN = re.compile(r"\A(\d+)\.(\d+)\Z")
_INLINE_REGEX = re.compile(r"\{\{regex:((?:[^}]|\}(?!\}))*)\}\}")

_KNOWN_METHODS = {"GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"}
_FAULT_TYPES = {
    "connection-refused",
    "connection-reset",
    "timeout",
    "dns-failure",
    "tls-error",
    "partial-response",
}


class LoadResult(NamedTuple):
    fixture: Dict[str, Any]
    warnings: List[str]


def parse_fixture(text: str, source: str = "<memory>") -> LoadResult:
    try:
        # Section 2: a BOM must not be emitted, but must be tolerated on read.
        document = json.loads(text.lstrip("﻿"))
    except ValueError as exc:
        raise HifStructuralError(f"{source} is not valid JSON: {exc}") from exc
    return validate_fixture(document, source)


def load_fixture(path: str) -> LoadResult:
    with open(path, encoding="utf-8") as handle:
        return parse_fixture(handle.read(), path)


def validate_fixture(document: Any, source: str = "<memory>") -> LoadResult:
    warnings: List[str] = []

    if not isinstance(document, dict):
        raise HifStructuralError(f"{source} must be a JSON object")

    version = document.get("hif")
    if not isinstance(version, str):
        raise HifStructuralError('Missing required member "hif"')
    match = _VERSION_PATTERN.match(version)
    if not match:
        raise HifStructuralError(f'Invalid "hif" version {version!r}; expected MAJOR.MINOR')
    major, minor = int(match.group(1)), int(match.group(2))
    if major != _SUPPORTED_MAJOR:
        raise HifStructuralError(
            f"Fixture declares HIF {version}, but this implementation supports "
            f"{_SUPPORTED_MAJOR}.x. Spec section 11.2 requires rejecting a differing major "
            "version rather than guessing."
        )
    if minor > _SUPPORTED_MINOR:
        warnings.append(
            f"Fixture declares HIF {version}; this implementation targets {SUPPORTED_VERSION}. "
            "Unrecognised members will be ignored (spec section 11.2)."
        )

    interactions = document.get("interactions")
    if not isinstance(interactions, list):
        raise HifStructuralError('Missing required array "interactions"')

    _warn_unknown(document, ("hif", "meta", "defaults", "interactions"), "", warnings)

    defaults = document.get("defaults")
    if defaults is not None:
        _require_object(defaults, "defaults")
        _warn_unknown(defaults, ("match", "replay"), "defaults", warnings)
        if "match" in defaults:
            _validate_match(defaults["match"], "defaults.match", warnings)
        if "replay" in defaults:
            _validate_replay(defaults["replay"], "defaults.replay", warnings)

    ids: Set[str] = set()
    for index, raw in enumerate(interactions):
        _validate_interaction(raw, index, ids, warnings)

    return LoadResult(document, warnings)


def _validate_interaction(raw: Any, index: int, ids: Set[str], warnings: List[str]) -> None:
    at = f"interactions[{index}]"
    if not isinstance(raw, dict):
        raise HifStructuralError("Interaction must be an object", at)

    _warn_unknown(
        raw,
        ("id", "request", "response", "match", "replay", "timing", "fault", "expect", "annotations"),
        at,
        warnings,
    )

    if "id" in raw:
        identifier = raw["id"]
        if not isinstance(identifier, str) or not _ID_PATTERN.match(identifier):
            raise HifStructuralError(
                f"Invalid id {identifier!r}; must match {_ID_PATTERN.pattern}", at
            )
        if identifier in ids:
            raise HifStructuralError(f"Duplicate interaction id {identifier!r}", at)
        ids.add(identifier)

    _validate_request(raw.get("request"), f"{at}.request", warnings)

    fault = raw.get("fault")
    has_fault = fault is not None
    has_response = "response" in raw and raw["response"] is not None

    if has_fault:
        _validate_fault(fault, f"{at}.fault", warnings)
    if has_response:
        _validate_response(raw["response"], f"{at}.response", warnings)

    fault_type = fault.get("type") if has_fault and isinstance(fault, dict) else None
    if not has_fault and not has_response:
        raise HifStructuralError('Interaction requires a "response" or a non-null "fault"', at)
    if has_fault and has_response and fault_type != "partial-response":
        raise HifStructuralError(
            f'Interaction has both a "response" and a "{fault_type}" fault; only fault type '
            '"partial-response" permits both',
            at,
        )
    if fault_type == "partial-response" and not has_response:
        raise HifStructuralError('Fault type "partial-response" requires a "response" to truncate', at)

    if "match" in raw:
        _validate_match(raw["match"], f"{at}.match", warnings)
    if "replay" in raw:
        _validate_replay(raw["replay"], f"{at}.replay", warnings)
    if "timing" in raw:
        _validate_timing(raw["timing"], f"{at}.timing", warnings)
    if "expect" in raw:
        _validate_expect(raw["expect"], f"{at}.expect", warnings)


def _validate_request(raw: Any, at: str, warnings: List[str]) -> None:
    if not isinstance(raw, dict):
        raise HifStructuralError("Request must be an object", at)
    _warn_unknown(raw, ("method", "url", "headers", "body"), at, warnings)

    method = raw.get("method")
    if not isinstance(method, str) or method == "":
        raise HifStructuralError('Request requires a non-empty string "method"', at)
    if method != method.upper() and method.upper() in _KNOWN_METHODS:
        # Section 6.1 requires linters to flag this: a lowercase known method
        # silently fails to match live traffic.
        warnings.append(
            f"{at}: method {method!r} is a known method stored in lowercase; spec section 6.1 "
            "requires uppercase and this will not match live requests."
        )

    url = raw.get("url")
    if not isinstance(url, str):
        raise HifStructuralError('Request requires a string "url"', at)
    normalize_url(url)
    if "#" in url:
        warnings.append(
            f"{at}: url contains a fragment, which spec section 6.2 says must not be stored; "
            "it will be ignored."
        )

    _validate_header_list(raw.get("headers"), f"{at}.headers")
    if "body" in raw and raw["body"] is not None:
        validate_body(raw["body"], f"{at}.body")
        _check_placeholders(raw["body"], f"{at}.body")


def _validate_response(raw: Any, at: str, warnings: List[str]) -> None:
    if not isinstance(raw, dict):
        raise HifStructuralError("Response must be an object", at)
    _warn_unknown(raw, ("status", "statusText", "headers", "body"), at, warnings)

    status = raw.get("status")
    if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
        raise HifStructuralError(f'Response "status" must be an integer in 100..599, got {status!r}', at)

    _validate_header_list(raw.get("headers"), f"{at}.headers")
    if "body" in raw and raw["body"] is not None:
        validate_body(raw["body"], f"{at}.body")


def _validate_header_list(raw: Any, at: str) -> None:
    if raw is None:
        return
    if not isinstance(raw, list):
        raise HifStructuralError("Headers must be an array of entries", at)
    for index, entry in enumerate(raw):
        where = f"{at}[{index}]"
        if not isinstance(entry, list) or len(entry) not in (2, 3):
            raise HifStructuralError(
                "Header entry must be [name, value] or [name, null, base64]", where
            )
        if not isinstance(entry[0], str):
            raise HifStructuralError("Header name must be a string", where)
        if len(entry) == 2 and not isinstance(entry[1], str):
            raise HifStructuralError("Header value must be a string", where)
        if len(entry) == 3 and (entry[1] is not None or not isinstance(entry[2], str)):
            raise HifStructuralError("A three-element header entry must be [name, null, base64]", where)


def _check_placeholders(body: Any, at: str) -> None:
    """Compile every inline regex so an invalid pattern is a load-time error."""
    if not isinstance(body, dict):
        return
    if body.get("encoding") == "json":
        _walk_json(body.get("json"), at)
    elif body.get("encoding") == "text" and isinstance(body.get("text"), str):
        for match in _INLINE_REGEX.finditer(body["text"]):
            try:
                compile_portable_regex(match.group(1))
            except HifStructuralError as exc:
                raise HifStructuralError(str(exc), at) from exc


def _walk_json(value: Any, at: str) -> None:
    if isinstance(value, str):
        placeholder = parse_placeholder(value)
        if placeholder is not None and placeholder.kind == "regex":
            try:
                compile_portable_regex(placeholder.detail)
            except HifStructuralError as exc:
                raise HifStructuralError(str(exc), at) from exc
    elif isinstance(value, list):
        for item in value:
            _walk_json(item, at)
    elif isinstance(value, dict):
        for item in value.values():
            _walk_json(item, at)


def _validate_match(raw: Any, at: str, warnings: List[str]) -> None:
    _require_object(raw, at)
    _warn_unknown(
        raw, ("method", "scheme", "host", "port", "path", "query", "headers", "body"), at, warnings
    )

    for name in ("method", "scheme", "host", "port", "path"):
        value = raw.get(name)
        if value is not None and value not in ("exact", "ignore"):
            raise HifStructuralError(f'match.{name} must be "exact" or "ignore", got {value!r}', at)

    query = raw.get("query")
    if query is not None:
        _require_object(query, f"{at}.query")
        _warn_unknown(query, ("mode", "ignore"), f"{at}.query", warnings)
        _require_enum(query.get("mode"), ("exact", "subset", "ignore"), f"{at}.query.mode")
        _require_string_list(query.get("ignore"), f"{at}.query.ignore")

    headers = raw.get("headers")
    if headers is not None:
        _require_object(headers, f"{at}.headers")
        _warn_unknown(headers, ("mode", "include", "ignore"), f"{at}.headers", warnings)
        _require_enum(headers.get("mode"), ("none", "listed", "all"), f"{at}.headers.mode")
        _require_string_list(headers.get("include"), f"{at}.headers.include")
        _require_string_list(headers.get("ignore"), f"{at}.headers.ignore")
        if headers.get("mode") == "listed" and not headers.get("include"):
            warnings.append(
                f'{at}.headers: mode is "listed" with an empty "include", so no header is compared.'
            )

    body = raw.get("body")
    if body is not None:
        _require_object(body, f"{at}.body")
        _warn_unknown(body, ("mode", "json"), f"{at}.body", warnings)
        _require_enum(body.get("mode"), ("auto", "exact", "json", "text", "ignore"), f"{at}.body.mode")
        json_config = body.get("json")
        if json_config is not None:
            _require_object(json_config, f"{at}.body.json")
            _warn_unknown(json_config, ("extra", "ignore"), f"{at}.body.json", warnings)
            _require_enum(json_config.get("extra"), ("reject", "allow"), f"{at}.body.json.extra")
            _require_string_list(json_config.get("ignore"), f"{at}.body.json.ignore")
            for path in json_config.get("ignore") or []:
                parse_path(path)


def _validate_replay(raw: Any, at: str, warnings: List[str]) -> None:
    _require_object(raw, at)
    _warn_unknown(raw, ("times",), at, warnings)
    times = raw.get("times")
    if times is None or times == "unlimited":
        return
    if isinstance(times, bool) or not isinstance(times, int) or times < 1:
        raise HifStructuralError(
            f'replay.times must be a positive integer or "unlimited", got {times!r}', at
        )


def _validate_timing(raw: Any, at: str, warnings: List[str]) -> None:
    _require_object(raw, at)
    _warn_unknown(raw, ("latencyMs", "recordedAt"), at, warnings)
    latency = raw.get("latencyMs")
    if latency is None:
        return
    if isinstance(latency, bool) or not isinstance(latency, (int, float)) or latency < 0:
        raise HifStructuralError("timing.latencyMs must be a number >= 0", at)


def _validate_fault(raw: Any, at: str, warnings: List[str]) -> None:
    _require_object(raw, at)
    _warn_unknown(raw, ("type", "afterMs", "message"), at, warnings)
    fault_type = raw.get("type")
    if fault_type not in _FAULT_TYPES:
        raise HifStructuralError(
            f"Unknown fault type {fault_type!r}; expected one of {', '.join(sorted(_FAULT_TYPES))}", at
        )
    after = raw.get("afterMs")
    if after is not None and (isinstance(after, bool) or not isinstance(after, (int, float)) or after < 0):
        raise HifStructuralError("fault.afterMs must be a number >= 0", at)


def _validate_expect(raw: Any, at: str, warnings: List[str]) -> None:
    _require_object(raw, at)
    _warn_unknown(raw, ("called",), at, warnings)
    called = raw.get("called")
    if called is None:
        return
    if isinstance(called, str):
        _require_enum(called, ("once", "atLeastOnce", "never", "any"), f"{at}.called")
        return
    _require_object(called, f"{at}.called")
    times = called.get("times")
    if isinstance(times, bool) or not isinstance(times, int) or times < 0:
        raise HifStructuralError("expect.called.times must be a non-negative integer", at)


def _require_object(raw: Any, at: str) -> None:
    if not isinstance(raw, dict):
        raise HifStructuralError("Expected an object", at)


def _require_enum(value: Any, allowed: Sequence[str], at: str) -> None:
    if value is not None and value not in allowed:
        rendered = ", ".join(repr(a) for a in allowed)
        raise HifStructuralError(f"Expected one of {rendered}, got {value!r}", at)


def _require_string_list(value: Any, at: str) -> None:
    if value is None:
        return
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise HifStructuralError("Expected an array of strings", at)


def _warn_unknown(obj: Dict[str, Any], known: Sequence[str], at: str, warnings: List[str]) -> None:
    """Section 2.1: unknown members are ignored, not rejected — but reported.

    The usual cause is a misspelled key in a ``match`` block that silently does
    nothing, which is exactly the kind of quiet failure HIF exists to remove.
    """
    prefix = f"{at}." if at else ""
    for key in obj:
        if key not in known:
            warnings.append(
                f"{prefix}{key}: unknown member, ignored. Did you mean one of {', '.join(known)}?"
            )


# ---------------------------------------------------------------------------


def play_limit(fixture: Dict[str, Any], interaction: Dict[str, Any]) -> Any:
    """Total play count for an interaction (section 5.2)."""
    replay = interaction.get("replay") or {}
    if "times" in replay:
        return replay["times"]
    defaults = (fixture.get("defaults") or {}).get("replay") or {}
    return defaults.get("times", 1)


def interaction_ref(interaction: Dict[str, Any], index: int) -> str:
    """Diagnostic reference for an interaction (section 5.1)."""
    return str(interaction.get("id") or f"interactions[{index}]")


_REQUEST_ORDER = ("method", "url", "headers", "body")
_RESPONSE_ORDER = ("status", "statusText", "headers", "body")
_INTERACTION_ORDER = (
    "id",
    "request",
    "response",
    "fault",
    "match",
    "replay",
    "timing",
    "expect",
    "annotations",
)


def serialize_fixture(fixture: Dict[str, Any]) -> str:
    """Serialize a fixture for storage.

    Two-space indentation with a trailing newline, because fixtures live in git
    and are read in pull requests. Member order follows the spec's presentation
    order rather than insertion order, so a re-record produces a minimal diff.
    """
    ordered: Dict[str, Any] = {"hif": fixture["hif"]}
    if fixture.get("meta"):
        ordered["meta"] = fixture["meta"]
    if fixture.get("defaults"):
        ordered["defaults"] = fixture["defaults"]
    ordered["interactions"] = [_order_interaction(i) for i in fixture.get("interactions", [])]
    return json.dumps(ordered, indent=2, ensure_ascii=False) + "\n"


def _order_interaction(interaction: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key in _INTERACTION_ORDER:
        if key not in interaction or interaction[key] is None:
            continue
        if key == "request":
            out[key] = _order_subset(interaction[key], _REQUEST_ORDER)
        elif key == "response":
            out[key] = _order_subset(interaction[key], _RESPONSE_ORDER)
        else:
            out[key] = interaction[key]
    return out


def _order_subset(obj: Dict[str, Any], order: Sequence[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key in order:
        value = obj.get(key)
        if value is None:
            continue
        if key == "headers" and not value:
            continue
        if key == "body" and isinstance(value, dict) and value.get("encoding") == "empty":
            continue
        out[key] = value
    for key, value in obj.items():
        if key not in out and key not in order:
            out[key] = value
    return out


def optional_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None
