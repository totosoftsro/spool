"""The ``hif-digest-1`` request digest, per specification section 14.

Used for deduplication, cache keys and stable interaction ids. Never used for
matching: two requests with the same digest are the same request, but two
requests that *match* need not have the same digest, because matching tolerates
variance by design.

The expected values in ``conformance/cases/digest/`` are verified against
``openssl dgst -sha256``, not against this code.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List

from .body import normalize_headers
from .canonical import canonicalize
from .url import QueryParam, decode_query, encode_query, normalize_url


def digest_preimage(request: Dict[str, Any]) -> Dict[str, Any]:
    """Build the value that gets canonicalized and hashed (section 14).

    Exposed separately from :func:`digest_request` so a failing conformance case
    can be debugged by looking at the pre-image rather than guessing at a hash.
    """
    url = normalize_url(request["url"])

    # Section 14: query parameters sorted by (name, value), UTF-16 code unit order.
    params: List[QueryParam] = sorted(decode_query(url.raw_query), key=_param_sort_key)
    netloc = url.host if url.port is None else f"{url.host}:{url.port}"
    query = encode_query(params)
    normalized_url = f"{url.scheme}://{netloc}{url.path}" + (f"?{query}" if query else "")

    # Section 14: headers lowercased and sorted by (name, value); repeats repeat.
    headers = sorted(
        ([h.name, h.value] for h in normalize_headers(request.get("headers"))),
        key=lambda pair: (_utf16_key(pair[0]), _utf16_key(pair[1])),
    )

    body = request.get("body")
    encoding = (body or {}).get("encoding")
    if not body or encoding == "empty":
        payload: Any = None
    elif encoding == "text":
        payload = body["text"]
    elif encoding == "json":
        payload = body["json"]
    else:
        payload = {"base64": body["base64"]}

    # Single-letter member names so RFC 8785's name sort produces b, h, m, u in
    # that order, which makes the pre-image readable by hand.
    return {"b": payload, "h": headers, "m": request["method"], "u": normalized_url}


def digest_request(request: Dict[str, Any]) -> str:
    """The lowercase hex SHA-256 of the canonical pre-image."""
    preimage = canonicalize(digest_preimage(request))
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()


def _param_sort_key(param: QueryParam) -> Any:
    return (_utf16_key(param.name), _utf16_key(param.value))


def _utf16_key(text: str) -> Any:
    """UTF-16 code unit ordering, matching RFC 8785 and JavaScript string sort."""
    encoded = text.encode("utf-16-be", errors="surrogatepass")
    return tuple(int.from_bytes(encoded[i : i + 2], "big") for i in range(0, len(encoded), 2))
