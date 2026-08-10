"""HAR to HIF conversion, per specification Appendix B.

HAR is a browser network *log*. HIF is a replay specification. The conversion is
therefore lossy in both directions, and the honest thing to do is to say exactly
what was dropped rather than produce a fixture that looks complete.

Every conversion returns a ``notes`` list. ``spool import har`` prints it, and
nothing here silently discards data.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any, Dict, List, Optional, Tuple

from ._text import q
from .body import encode_body
from .errors import HifStructuralError
from .fixture import SUPPORTED_VERSION


@dataclass
class HarImportOptions:
    #: Keep only entries whose URL contains this, case-insensitively.
    filter: Optional[str] = None
    #: Drop entries served from the browser cache.
    skip_cached: bool = True
    #: Record ``timing.latencyMs`` from HAR's ``time``.
    keep_timing: bool = True
    #: Store bodies as text/base64 rather than parsed JSON.
    preserve_bytes: bool = False


@dataclass
class HarImportResult:
    fixture: Dict[str, Any]
    #: What was dropped or changed. Never empty for a real-world HAR.
    notes: List[str] = dataclass_field(default_factory=list)
    #: Entries that produced no interaction, and why.
    skipped: List[Dict[str, str]] = dataclass_field(default_factory=list)


def import_har(document: Any, options: Optional[HarImportOptions] = None) -> HarImportResult:
    """Convert a HAR 1.2 document into a HIF fixture.

    The result is deliberately *not* redacted here. HAR files are full of
    cookies and auth headers, and the caller decides whether to redact, so that
    the decision is visible at the call site rather than buried in a converter.
    ``spool import har`` redacts by default and says so.
    """
    options = options or HarImportOptions()
    notes: List[str] = []
    skipped: List[Dict[str, str]] = []

    if not isinstance(document, dict):
        raise HifStructuralError("HAR document must be a JSON object")
    log = document.get("log")
    if not isinstance(log, dict):
        raise HifStructuralError('HAR document must have a "log" member')

    version = log.get("version")
    if isinstance(version, str) and version != "1.2":
        notes.append(
            f"HAR version is {version}; this converter targets 1.2 and may not read every member."
        )

    entries = log.get("entries")
    if not isinstance(entries, list):
        raise HifStructuralError('HAR log must have an "entries" array')

    pages = log.get("pages")
    if isinstance(pages, list) and pages:
        notes.append(f"Dropped {len(pages)} page record(s): HIF has no page concept.")
    if log.get("browser"):
        notes.append('Dropped "browser": HIF has no equivalent.')
    if log.get("creator"):
        notes.append('Dropped "creator": recorded as meta.recorder instead.')

    interactions: List[Dict[str, Any]] = []
    dropped_timings = 0
    dropped_cache = 0
    dropped_connection = 0
    cookies_flattened = 0
    content_encoding_dropped = 0

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            skipped.append({"url": f"entries[{index}]", "reason": "not an object"})
            continue

        request = entry.get("request")
        response = entry.get("response")
        url = request.get("url") if isinstance(request, dict) else None
        url = url if isinstance(url, str) else f"entries[{index}]"

        if not isinstance(request, dict) or not isinstance(response, dict):
            skipped.append({"url": url, "reason": "entry has no request or no response"})
            continue

        if options.filter and options.filter.lower() not in url.lower():
            skipped.append({"url": url, "reason": f"does not match filter {q(options.filter)}"})
            continue

        status = response.get("status")
        status = status if isinstance(status, int) and not isinstance(status, bool) else 0
        if status == 0:
            skipped.append(
                {"url": url, "reason": "response status is 0 (request failed or was aborted)"}
            )
            continue
        if options.skip_cached and _is_cache_hit(entry):
            skipped.append(
                {"url": url, "reason": "served from the browser cache, so it was never on the wire"}
            )
            continue

        scheme = url.split(":", 1)[0].lower()
        if scheme not in ("http", "https"):
            skipped.append({"url": url, "reason": f"scheme {scheme} is out of scope for HIF 1.0"})
            continue

        if entry.get("timings"):
            dropped_timings += 1
        if entry.get("cache"):
            dropped_cache += 1
        if entry.get("connection") or entry.get("serverIPAddress"):
            dropped_connection += 1

        request_headers, request_flattened = _convert_headers(
            request.get("headers"), request.get("cookies"), "cookie"
        )
        response_headers, response_flattened = _convert_headers(
            response.get("headers"), response.get("cookies"), "set-cookie"
        )
        if request_flattened or response_flattened:
            cookies_flattened += 1

        # Appendix B / section 8.1: a stored body is decoded, so a
        # content-encoding header describing the original compression is a lie.
        if any(name == "content-encoding" for name, _ in response_headers):
            content_encoding_dropped += 1

        interaction: Dict[str, Any] = {
            "request": {
                "method": str(request.get("method") or "GET").upper(),
                "url": _strip_fragment(url),
                "headers": [list(h) for h in request_headers],
                "body": _convert_post_data(request.get("postData"), options.preserve_bytes),
            },
            "response": {
                "status": status,
                "headers": [
                    list(h) for h in response_headers if h[0] != "content-encoding"
                ],
                "body": _convert_content(response.get("content"), options.preserve_bytes),
            },
        }
        status_text = response.get("statusText")
        if isinstance(status_text, str) and status_text:
            interaction["response"]["statusText"] = status_text

        time_ms = entry.get("time")
        if options.keep_timing and isinstance(time_ms, (int, float)) and time_ms >= 0:
            interaction["timing"] = {"latencyMs": round(time_ms)}

        interactions.append(interaction)

    if dropped_timings:
        plural = "y" if dropped_timings == 1 else "ies"
        notes.append(
            f'Collapsed "timings" to timing.latencyMs on {dropped_timings} entr{plural}: the '
            "per-phase breakdown (dns, connect, ssl, send, wait, receive) has no HIF equivalent."
        )
    if dropped_cache:
        notes.append(f'Dropped "cache" on {dropped_cache} entries.')
    if dropped_connection:
        notes.append(f'Dropped "connection" and "serverIPAddress" on {dropped_connection} entries.')
    if cookies_flattened:
        notes.append(
            f"Flattened cookie objects into header fields on {cookies_flattened} entries: "
            "attributes not present in the raw header (expires, httpOnly, sameSite) are lost."
        )
    if content_encoding_dropped:
        notes.append(
            f'Dropped "content-encoding" on {content_encoding_dropped} response(s): HIF stores '
            "decoded bodies, so the header would misdescribe them (spec §8.1)."
        )
    notes.append(
        "HAR defines no matching rules, so every interaction uses the HIF defaults (spec §7.1). "
        "A browser-captured HAR usually needs query.ignore for cache-busting parameters."
    )
    notes.append(
        "HAR performs no redaction. Run redaction over the result before committing it, and read it."
    )

    fixture: Dict[str, Any] = {
        "hif": SUPPORTED_VERSION,
        "meta": {
            "description": "Imported from a HAR file. See the import notes for what was dropped.",
            "recorder": {"name": "spool-python (har import)", "version": "0.1.0"},
            "redaction": {"applied": False, "rules": []},
        },
        "interactions": interactions,
    }

    return HarImportResult(fixture=fixture, notes=notes, skipped=skipped)


def _is_cache_hit(entry: Dict[str, Any]) -> bool:
    cache = entry.get("cache")
    if isinstance(cache, dict) and cache.get("afterRequest"):
        return True
    size = entry.get("_transferSize")
    if size is None and isinstance(entry.get("response"), dict):
        size = entry["response"].get("_transferSize")
    return size == 0


def _convert_headers(
    raw: Any, cookies: Any, cookie_header: str
) -> Tuple[List[Tuple[str, str]], bool]:
    entries: List[Tuple[str, str]] = []
    flattened = False

    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                continue
            name = item["name"].lower()
            # HTTP/2 pseudo-headers are connection metadata, not fields.
            if name.startswith(":"):
                continue
            value = item.get("value")
            entries.append((name, value if isinstance(value, str) else str(value or "")))

    # Only synthesise a cookie header if the headers array did not already carry
    # one; otherwise the same data appears twice.
    has_cookie_header = any(name == cookie_header for name, _ in entries)
    if not has_cookie_header and isinstance(cookies, list) and cookies:
        flattened = True
        if cookie_header == "cookie":
            pairs = [
                f"{c['name']}={c.get('value') or ''}"
                for c in cookies
                if isinstance(c, dict) and isinstance(c.get("name"), str)
            ]
            if pairs:
                entries.append(("cookie", "; ".join(pairs)))
        else:
            for c in cookies:
                if isinstance(c, dict) and isinstance(c.get("name"), str):
                    entries.append(("set-cookie", f"{c['name']}={c.get('value') or ''}"))

    return entries, flattened


def _convert_post_data(raw: Any, preserve_bytes: bool) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {"encoding": "empty"}
    mime_type = raw.get("mimeType")
    mime_type = mime_type if isinstance(mime_type, str) else None

    text = raw.get("text")
    if isinstance(text, str):
        return encode_body(text.encode("utf-8"), mime_type, preserve_bytes=preserve_bytes)

    # Section 6.5: `text` and `params` are mutually exclusive. Reassemble params
    # into a form-encoded body rather than dropping them.
    params = raw.get("params")
    if isinstance(params, list):
        from urllib.parse import quote

        encoded = "&".join(
            f"{quote(str(p['name']), safe='')}={quote(str(p.get('value') or ''), safe='')}"
            for p in params
            if isinstance(p, dict) and isinstance(p.get("name"), str)
        )
        return encode_body(
            encoded.encode("utf-8"),
            mime_type or "application/x-www-form-urlencoded",
            preserve_bytes=preserve_bytes,
        )

    return {"encoding": "empty"}


def _convert_content(raw: Any, preserve_bytes: bool) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {"encoding": "empty"}
    mime_type = raw.get("mimeType")
    mime_type = mime_type if isinstance(mime_type, str) else None
    text = raw.get("text")
    if not isinstance(text, str) or text == "":
        return {"encoding": "empty"}

    if raw.get("encoding") == "base64":
        try:
            data = base64.b64decode(text, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HifStructuralError(
                "HAR content claims base64 encoding but does not decode"
            ) from exc
        return encode_body(data, mime_type, preserve_bytes=preserve_bytes)

    return encode_body(text.encode("utf-8"), mime_type, preserve_bytes=preserve_bytes)


def _strip_fragment(url: str) -> str:
    return url.split("#", 1)[0]


def import_har_text(text: str, options: Optional[HarImportOptions] = None) -> HarImportResult:
    """Parse and convert in one step, for the CLI."""
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise HifStructuralError(f"HAR file is not valid JSON: {exc}") from exc
    return import_har(parsed, options)
