"""Body and header handling, per specification 6.3, 6.5 and 6.6."""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence, Tuple

from .canonical import canonicalize, find_lossy_numbers
from .errors import HifStructuralError

EMPTY_BODY: Dict[str, Any] = {"encoding": "empty"}

_BASE64 = re.compile(r"\A[A-Za-z0-9+/]*={0,2}\Z")


def or_empty(body: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Section 6.5: an absent body and ``{"encoding": "empty"}`` are the same."""
    return EMPTY_BODY if body is None else body


def decode_base64(text: str, at: Optional[str] = None) -> bytes:
    if not _BASE64.match(text) or len(text) % 4 != 0:
        raise HifStructuralError(
            "Invalid base64: the standard RFC 4648 section 4 alphabet with padding is "
            "required, and whitespace is not permitted",
            at,
        )
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HifStructuralError(f"Invalid base64: {exc}", at) from exc


def encode_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def body_bytes(body: Dict[str, Any]) -> bytes:
    """Reduce a body to its bytes, as section 7.4.1 requires for exact comparison."""
    encoding = body.get("encoding")
    if encoding == "empty":
        return b""
    if encoding == "text":
        return str(body["text"]).encode("utf-8")
    if encoding == "json":
        return canonicalize(body["json"]).encode("utf-8")
    if encoding == "base64":
        return decode_base64(str(body["base64"]))
    raise HifStructuralError(f"Unknown body encoding {encoding!r}")


def body_text(body: Dict[str, Any]) -> Optional[str]:
    """Reduce a body to text, or None when it has no text form (section 7.4.3)."""
    encoding = body.get("encoding")
    if encoding == "empty":
        return ""
    if encoding == "text":
        return str(body["text"])
    if encoding == "json":
        return canonicalize(body["json"])
    if encoding == "base64":
        return decode_utf8_strict(decode_base64(str(body["base64"])))
    raise HifStructuralError(f"Unknown body encoding {encoding!r}")


_MISSING = object()


def body_json(body: Dict[str, Any]) -> Any:
    """Reduce a body to a JSON value, or the sentinel when it does not parse."""
    if body.get("encoding") == "json":
        return body["json"]
    text = body_text(body)
    if text is None or text.strip() == "":
        return _MISSING
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return _MISSING


def body_json_missing(value: Any) -> bool:
    return value is _MISSING


def decode_utf8_strict(data: bytes) -> Optional[str]:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def is_json_media_type(content_type: Optional[str]) -> bool:
    """Section 6.5.1 step 2: ``application/json`` or any subtype ending ``+json``."""
    if not content_type:
        return False
    media_type = content_type.split(";")[0].strip().lower()
    return media_type == "application/json" or media_type.endswith("+json")


def encode_body(
    data: bytes,
    content_type: Optional[str] = None,
    preserve_bytes: bool = False,
    on_warning: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Section 6.5.1: choose an encoding for raw body bytes.

    The procedure is normative and ordered. Step 2 is deliberately conservative:
    a body that claims to be JSON but does not parse is stored as text, so the
    fixture preserves what was on the wire rather than failing to record.
    """
    if not data:
        return {"encoding": "empty", "contentType": content_type} if content_type else dict(EMPTY_BODY)

    text = decode_utf8_strict(data)

    if text is not None and not preserve_bytes and is_json_media_type(content_type):
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = _MISSING  # falls through to the text branch, per step 2
        if parsed is not _MISSING:
            lossy = find_lossy_numbers(text)
            if lossy:
                # Section 12.3: warn and fall back to text rather than silently
                # corrupting a 64-bit identifier.
                if on_warning:
                    detail = ", ".join(f"{n.literal} would become {n.canonical}" for n in lossy)
                    on_warning(
                        f"Body stored as text instead of json: {len(lossy)} number literal(s) do not "
                        f"survive an IEEE 754 round trip ({detail}). See spec section 12.3."
                    )
            else:
                return _with_content_type({"encoding": "json", "json": parsed}, content_type)

    if text is not None and "\x00" not in text:
        return _with_content_type({"encoding": "text", "text": text}, content_type)

    return _with_content_type({"encoding": "base64", "base64": encode_base64(data)}, content_type)


def _with_content_type(body: Dict[str, Any], content_type: Optional[str]) -> Dict[str, Any]:
    if content_type:
        body["contentType"] = content_type
    return body


def validate_body(body: Any, at: str) -> Dict[str, Any]:
    """Structural validation of a body object (section 11.3)."""
    if not isinstance(body, dict):
        raise HifStructuralError("Body must be an object", at)
    encoding = body.get("encoding")
    if encoding == "empty":
        return body
    if encoding == "text":
        if not isinstance(body.get("text"), str):
            raise HifStructuralError('Body with encoding "text" requires a string "text"', at)
        return body
    if encoding == "json":
        if "json" not in body:
            raise HifStructuralError('Body with encoding "json" requires a "json" member', at)
        return body
    if encoding == "base64":
        if not isinstance(body.get("base64"), str):
            raise HifStructuralError('Body with encoding "base64" requires a string "base64"', at)
        decode_base64(body["base64"], at)
        return body
    if encoding is None:
        raise HifStructuralError('Body requires an "encoding" member', at)
    raise HifStructuralError(
        f"Unknown body encoding {encoding!r}; expected empty, text, json or base64", at
    )


# ---------------------------------------------------------------------------
# Headers (sections 6.3, 6.6)
# ---------------------------------------------------------------------------


class NormalizedHeader(NamedTuple):
    name: str
    value: str
    binary: bool


_OWS = " \t"


def strip_ows(value: str) -> str:
    """RFC 9110 optional whitespace: SP and HTAB only."""
    return value.strip(_OWS)


def normalize_headers(entries: Optional[Sequence[Sequence[Any]]]) -> List[NormalizedHeader]:
    if not entries:
        return []
    out: List[NormalizedHeader] = []
    for index, entry in enumerate(entries):
        out.append(_normalize_entry(entry, f"headers[{index}]"))
    return out


def _normalize_entry(entry: Sequence[Any], at: str) -> NormalizedHeader:
    if not isinstance(entry, (list, tuple)) or len(entry) < 2:
        raise HifStructuralError("Header entry must be [name, value] or [name, null, base64]", at)
    name = entry[0]
    if not isinstance(name, str):
        raise HifStructuralError("Header name must be a string", at)

    if entry[1] is None:
        if len(entry) < 3 or not isinstance(entry[2], str):
            raise HifStructuralError(
                "A three-element header entry requires a base64 string as its third element", at
            )
        data = decode_base64(entry[2], at)
        return NormalizedHeader(name.lower(), data.decode("utf-8", errors="replace"), True)

    if not isinstance(entry[1], str):
        raise HifStructuralError("Header value must be a string or null", at)
    return NormalizedHeader(name.lower(), strip_ows(entry[1]), False)


def to_entries(headers: Sequence[Tuple[str, str]]) -> List[List[str]]:
    """Build storable entries from live header data."""
    return [[name.lower(), strip_ows(value)] for name, value in headers]


def to_entry_from_bytes(name: str, value_bytes: bytes) -> List[Any]:
    """Build a storable entry, using the section 6.6 form for non-UTF-8 values."""
    text = decode_utf8_strict(value_bytes)
    if text is None:
        return [name.lower(), None, encode_base64(value_bytes)]
    return [name.lower(), strip_ows(text)]


def values_for(headers: Sequence[NormalizedHeader], name: str) -> List[str]:
    """All values for a field name, in order. Section 7.2 compares these lists."""
    lower = name.lower()
    return [h.value for h in headers if h.name == lower]


def names_of(headers: Sequence[NormalizedHeader]) -> List[str]:
    """The distinct field names present, in first-appearance order."""
    seen = set()
    out: List[str] = []
    for header in headers:
        if header.name not in seen:
            seen.add(header.name)
            out.append(header.name)
    return out


def contains_name(names: Sequence[str], name: str) -> bool:
    lower = name.lower()
    return any(n.lower() == lower for n in names)
