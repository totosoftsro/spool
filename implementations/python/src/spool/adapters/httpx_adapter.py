"""httpx transport adapter.

httpx is the cleanest interception point in Python: a ``Transport`` is a
documented extension seam, so nothing here monkeypatches anything. Pass the
transport to a client and every request that client makes is served from the
fixture.

``httpx`` is an optional dependency. Importing this module without it raises a
clear ImportError rather than failing somewhere deep inside a test.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

from ..errors import HifFaultError
from ..fixture import parse_fixture
from ..player import Player, Recorder, deliverable, fault_error

try:  # pragma: no cover - exercised by the presence or absence of httpx
    import httpx
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "The httpx adapter requires httpx. Install it with `pip install spool-hif[httpx]`."
    ) from exc


def _to_hif_request(request: httpx.Request) -> Dict[str, Any]:
    return {
        "method": request.method.upper(),
        "url": str(request.url),
        "headers": [[k.lower(), v] for k, v in request.headers.items()],
        "body": _encode_request_body(request),
    }


def _encode_request_body(request: httpx.Request) -> Dict[str, Any]:
    from ..body import encode_body

    content = request.content or b""
    return encode_body(content, request.headers.get("content-type"))


class SpoolReplayTransport(httpx.BaseTransport):
    """An httpx transport that replays from a fixture.

    Unmatched requests raise ``HifMatchError`` with the section 13 explanation
    in the message. Nothing reaches the network.
    """

    def __init__(self, fixture: Any, **player_options: Any) -> None:
        if isinstance(fixture, str):
            fixture = parse_fixture(fixture).fixture
        self.player = Player(fixture, **player_options)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        play = self.player.select(_to_hif_request(request))
        self.player.delay(play)

        fault = play.fault
        if fault and fault.get("type") != "partial-response":
            raise _as_httpx_error(fault_error(fault), request)

        assert play.response is not None
        out = deliverable(play.response, truncate=bool(fault))
        return httpx.Response(
            status_code=out.status,
            headers=out.headers,
            content=out.body,
            request=request,
            extensions={"reason_phrase": out.status_text.encode("ascii", "ignore")}
            if out.status_text
            else {},
        )

    def assert_complete(self) -> None:
        self.player.assert_complete()

    def unused(self) -> List[str]:
        return self.player.unused_interactions()


def _as_httpx_error(error: HifFaultError, request: httpx.Request) -> Exception:
    """Raise the httpx error the real condition would raise (section 10).

    Application code that catches ``httpx.ConnectError`` around a real network
    failure catches the simulated one too. Where httpx has no distinct type, the
    closest one is used and the HifFaultError is chained so the cause is visible.
    """
    mapping = {
        "connection-refused": httpx.ConnectError,
        "connection-reset": httpx.ReadError,
        "timeout": httpx.ReadTimeout,
        "dns-failure": httpx.ConnectError,
        "tls-error": httpx.ConnectError,
    }
    cls = mapping.get(error.fault_type, httpx.TransportError)
    raised = cls(str(error), request=request)
    raised.__cause__ = error
    return raised


class SpoolRecordTransport(httpx.BaseTransport):
    """An httpx transport that performs real requests and records them.

    Redaction runs before anything is stored (section 9). Passing
    ``redact=False`` to the recorder is the only way to disable it.
    """

    def __init__(
        self,
        recorder: Optional[Recorder] = None,
        inner: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self.recorder = recorder or Recorder()
        self._inner = inner or httpx.HTTPTransport()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        request_headers: List[Tuple[str, str]] = [(k, v) for k, v in request.headers.items()]
        body = request.content or b""
        start = time.monotonic()

        try:
            response = self._inner.handle_request(request)
        except httpx.TransportError as exc:
            # A real transport failure is recorded as a fault so the fixture can
            # reproduce it later (section 10). The error still propagates.
            self.recorder.record_fault(
                request.method, str(request.url), request_headers, body, _classify(exc)
            )
            raise

        response.read()
        latency = (time.monotonic() - start) * 1000

        self.recorder.record(
            method=request.method,
            url=str(request.url),
            request_headers=request_headers,
            request_body=body,
            status=response.status_code,
            response_headers=[(k, v) for k, v in response.headers.items()],
            response_body=response.content,
            status_text=response.reason_phrase or "",
            latency_ms=latency,
        )
        return response

    def to_json(self) -> str:
        return self.recorder.to_json()

    def redaction_summary(self) -> str:
        return self.recorder.redaction_summary()


def _classify(exc: Exception) -> str:
    """Map an httpx transport error onto the closest HIF fault type."""
    if isinstance(exc, (httpx.ConnectTimeout, httpx.ReadTimeout)):
        return "timeout"
    if isinstance(exc, httpx.ConnectError):
        text = str(exc).lower()
        if "name" in text or "resolve" in text or "nodename" in text:
            return "dns-failure"
        if "certificate" in text or "ssl" in text or "tls" in text:
            return "tls-error"
        return "connection-refused"
    return "connection-reset"
