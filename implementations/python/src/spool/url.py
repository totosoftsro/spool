"""URL normalization and query decomposition, per specification 6.4 and 6.4.1.

The steps are normative and exhaustive. This does not simply defer to
``urllib.parse``: that library performs a slightly different set of
normalizations than WHATWG URL does, and the whole point of section 6.4 is that
every implementation performs exactly the same ones.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from .errors import HifStructuralError

DEFAULT_PORTS = {"http": 80, "https": 443}

_UNRESERVED = re.compile(r"[A-Za-z0-9\-._~]")
_HEX = re.compile(r"^[0-9A-Fa-f]{2}$")
_URL = re.compile(r"^(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*)://(?P<rest>.*)$", re.DOTALL)


class QueryParam(NamedTuple):
    name: str
    value: str
    valueless: bool

    def as_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "value": self.value, "valueless": self.valueless}


class ParsedUrl(NamedTuple):
    scheme: str
    host: str
    port: Optional[int]
    path: str
    raw_query: str
    href: str


def normalize_url(url: str) -> ParsedUrl:
    match = _URL.match(url)
    if not match:
        raise HifStructuralError(f"Not an absolute URL: {url!r}")

    scheme = match.group("scheme").lower()
    if scheme not in DEFAULT_PORTS:
        raise HifStructuralError(f"Unsupported URL scheme {scheme!r}; HIF 1.0 covers http and https")

    rest = match.group("rest")
    authority, path_and_more = _split_authority(rest)
    host, port = _split_host_port(authority, scheme, url)

    raw_path, raw_query = _split_path_query(path_and_more)
    path = _normalize_path(raw_path)

    netloc = host if port is None else f"{host}:{port}"
    href = f"{scheme}://{netloc}{path}" + (f"?{raw_query}" if raw_query else "")
    return ParsedUrl(scheme, host, port, path, raw_query, href)


def _split_authority(rest: str) -> Tuple[str, str]:
    for index, ch in enumerate(rest):
        if ch in "/?#":
            return rest[:index], rest[index:]
    return rest, ""


def _split_host_port(authority: str, scheme: str, url: str) -> Tuple[str, Optional[int]]:
    # Userinfo is not part of the compared request identity and is stripped;
    # credentials in a URL would otherwise land in a fixture unredacted.
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]

    if authority.startswith("["):  # IPv6 literal
        close = authority.find("]")
        if close == -1:
            raise HifStructuralError(f"Malformed IPv6 authority in {url!r}")
        host = authority[: close + 1]
        remainder = authority[close + 1 :]
        port_text = remainder[1:] if remainder.startswith(":") else ""
    elif ":" in authority:
        host, _, port_text = authority.partition(":")
    else:
        host, port_text = authority, ""

    host = _to_a_label(host.lower())

    if port_text == "":
        return host, None
    if not port_text.isdigit():
        raise HifStructuralError(f"Malformed port in {url!r}")
    port = int(port_text)
    return host, (None if port == DEFAULT_PORTS[scheme] else port)


def _to_a_label(host: str) -> str:
    """Step 2: an internationalized host is stored in A-label (Punycode) form."""
    if host.isascii():
        return host
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError:
        # An un-encodable host is left as-is rather than rejected: recording
        # should not fail on traffic that a client managed to send.
        return host


def _split_path_query(text: str) -> Tuple[str, str]:
    fragment = text.find("#")
    if fragment != -1:
        text = text[:fragment]  # step 8
    question = text.find("?")
    if question == -1:
        return text, ""
    return text[:question], text[question + 1 :]


def _normalize_path(raw_path: str) -> str:
    path = raw_path or "/"  # step 4
    path = rewrite_percent_encoding(path)  # steps 5 and 6
    path = remove_dot_segments(path)  # step 7
    return path or "/"


def rewrite_percent_encoding(text: str) -> str:
    """Steps 5 and 6, applied together in one pass.

    A triplet whose octet is an RFC 3986 unreserved character is decoded; every
    other triplet has its hex digits uppercased. A stray ``%`` is left alone
    rather than treated as an error, because it appears in real URLs and
    rejecting it would make recording fail on traffic that works.
    """
    out: List[str] = []
    i = 0
    length = len(text)
    while i < length:
        if text[i] != "%" or i + 2 >= length or not _HEX.match(text[i + 1 : i + 3]):
            out.append(text[i])
            i += 1
            continue
        hex_digits = text[i + 1 : i + 3]
        code = int(hex_digits, 16)
        ch = chr(code)
        if code < 0x80 and _UNRESERVED.match(ch):
            out.append(ch)
        else:
            out.append("%" + hex_digits.upper())
        i += 3
    return "".join(out)


def remove_dot_segments(path: str) -> str:
    """RFC 3986 section 5.2.4, transcribed directly."""
    output: List[str] = []
    remaining = path
    while remaining:
        if remaining.startswith("../"):
            remaining = remaining[3:]
        elif remaining.startswith("./"):
            remaining = remaining[2:]
        elif remaining.startswith("/./"):
            remaining = "/" + remaining[3:]
        elif remaining == "/.":
            remaining = "/"
        elif remaining.startswith("/../"):
            remaining = "/" + remaining[4:]
            if output:
                output.pop()
        elif remaining == "/..":
            remaining = "/"
            if output:
                output.pop()
        elif remaining in (".", ".."):
            remaining = ""
        else:
            next_slash = remaining.find("/", 1)
            if next_slash == -1:
                output.append(remaining)
                remaining = ""
            else:
                output.append(remaining[:next_slash])
                remaining = remaining[next_slash:]
    return "".join(output)


def decode_query(raw_query: str) -> List[QueryParam]:
    """Section 6.4.1, transcribed step by step."""
    if not raw_query:
        return []
    params: List[QueryParam] = []
    for segment in raw_query.split("&"):
        if segment == "":
            continue  # step 2
        if "=" not in segment:  # step 3
            params.append(QueryParam(_decode_component(segment), "", True))
        else:
            name, _, value = segment.partition("=")
            params.append(QueryParam(_decode_component(name), _decode_component(value), False))
    return params


def _decode_component(text: str) -> str:
    """Steps 4 and 5: ``+`` to space, percent-decode, UTF-8 with U+FFFD."""
    plussed = text.replace("+", " ")
    out = bytearray()
    i = 0
    length = len(plussed)
    while i < length:
        if plussed[i] == "%" and i + 2 < length and _HEX.match(plussed[i + 1 : i + 3]):
            out.append(int(plussed[i + 1 : i + 3], 16))
            i += 3
        else:
            out.extend(plussed[i].encode("utf-8"))
            i += 1
    return out.decode("utf-8", errors="replace")


def encode_query(params: List[QueryParam]) -> str:
    """Re-encode a decoded parameter list. Used by the digest (section 14)."""
    parts = []
    for param in params:
        if param.valueless:
            parts.append(_encode_component(param.name))
        else:
            parts.append(f"{_encode_component(param.name)}={_encode_component(param.value)}")
    return "&".join(parts)


def _encode_component(text: str) -> str:
    out: List[str] = []
    for byte in text.encode("utf-8"):
        ch = chr(byte)
        if byte < 0x80 and _UNRESERVED.match(ch):
            out.append(ch)
        else:
            out.append(f"%{byte:02X}")
    return "".join(out)
