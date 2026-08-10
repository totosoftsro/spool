"""requests transport adapter.

``requests`` has a documented extension seam too: ``HTTPAdapter.send``. Mounting
a replay adapter on a Session serves every request that session makes from the
fixture, with no monkeypatching.

``requests`` is an optional dependency.
"""

from __future__ import annotations

import io
from typing import Any, Dict, List, Mapping, Optional, Tuple, Union

from ..body import encode_body
from ..errors import HifFaultError
from ..fixture import parse_fixture
from ..player import Player, deliverable, fault_error

try:  # pragma: no cover - exercised by the presence or absence of requests
    import requests
    from requests.adapters import HTTPAdapter
    from requests.models import PreparedRequest, Response
    from urllib3 import HTTPResponse
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "The requests adapter requires requests. Install it with `pip install spool-hif[requests]`."
    ) from exc


def _to_hif_request(request: Any) -> Dict[str, Any]:
    body = request.body or b""
    if isinstance(body, str):
        body = body.encode("utf-8")
    headers = [[k.lower(), v] for k, v in request.headers.items()]
    content_type = next((v for k, v in request.headers.items() if k.lower() == "content-type"), None)
    return {
        "method": str(request.method).upper(),
        "url": str(request.url),
        "headers": headers,
        "body": encode_body(body, content_type),
    }


class SpoolReplayAdapter(HTTPAdapter):
    """A requests HTTPAdapter that replays from a fixture.

    Mount it on a Session::

        session = requests.Session()
        adapter = SpoolReplayAdapter(fixture_text)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
    """

    def __init__(self, fixture: Any, **player_options: Any) -> None:
        super().__init__()
        if isinstance(fixture, str):
            fixture = parse_fixture(fixture).fixture
        self.player = Player(fixture, **player_options)

    def send(
        self,
        request: PreparedRequest,
        stream: bool = False,
        timeout: Union[float, Tuple[float, float], Tuple[float, None], None] = None,
        verify: Union[bool, str] = True,
        cert: Any = None,
        proxies: Optional[Mapping[str, str]] = None,
    ) -> Response:
        play = self.player.select(_to_hif_request(request))
        self.player.delay(play)

        fault = play.fault
        if fault and fault.get("type") != "partial-response":
            raise _as_requests_error(fault_error(fault), request)

        assert play.response is not None
        out = deliverable(play.response, truncate=bool(fault))

        response = Response()
        response.status_code = out.status
        response.reason = out.status_text
        response.url = str(request.url)
        response.request = request
        for name, value in out.headers:
            response.headers[name] = value
        response.raw = HTTPResponse(
            body=io.BytesIO(out.body),
            headers=dict(out.headers),
            status=out.status,
            reason=out.status_text or None,
            preload_content=False,
        )
        # requests has no public setter for a response body. Setting both of
        # these is what `Response.content` reads, and skipping the second would
        # make the body re-read from `raw` and come back empty.
        response._content = out.body
        response._content_consumed = True  # type: ignore[attr-defined]
        return response

    def assert_complete(self) -> None:
        self.player.assert_complete()

    def unused(self) -> List[str]:
        return self.player.unused_interactions()


def _as_requests_error(error: HifFaultError, request: Any) -> Exception:
    """Raise the requests error the real condition would raise (section 10)."""
    mapping = {
        "connection-refused": requests.exceptions.ConnectionError,
        "connection-reset": requests.exceptions.ConnectionError,
        "timeout": requests.exceptions.ReadTimeout,
        "dns-failure": requests.exceptions.ConnectionError,
        "tls-error": requests.exceptions.SSLError,
    }
    cls: Any = mapping.get(error.fault_type, requests.exceptions.ConnectionError)
    raised: Exception = cls(str(error), request=request)
    raised.__cause__ = error
    return raised


def mount(session: Any, fixture: Any, **player_options: Any) -> SpoolReplayAdapter:
    """Convenience: build a replay adapter and mount it for http and https."""
    adapter = SpoolReplayAdapter(fixture, **player_options)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return adapter


class SpoolRecordAdapter(HTTPAdapter):
    """A requests HTTPAdapter that performs real requests and records them."""

    def __init__(self, recorder: Optional[Any] = None) -> None:
        super().__init__()
        from ..player import Recorder

        self.recorder = recorder or Recorder()

    def send(
        self,
        request: PreparedRequest,
        stream: bool = False,
        timeout: Union[float, Tuple[float, float], Tuple[float, None], None] = None,
        verify: Union[bool, str] = True,
        cert: Any = None,
        proxies: Optional[Mapping[str, str]] = None,
    ) -> Response:
        import time

        request_headers = [(k, v) for k, v in request.headers.items()]
        body = request.body or b""
        if isinstance(body, str):
            body = body.encode("utf-8")

        start = time.monotonic()
        try:
            response = super().send(request, stream, timeout, verify, cert, proxies)
        except requests.exceptions.RequestException as exc:
            self.recorder.record_fault(
                str(request.method), str(request.url), request_headers, body, _classify(exc)
            )
            raise

        latency = (time.monotonic() - start) * 1000
        self.recorder.record(
            method=str(request.method),
            url=str(request.url),
            request_headers=request_headers,
            request_body=body,
            status=response.status_code,
            response_headers=[(k, v) for k, v in response.headers.items()],
            response_body=response.content,
            status_text=response.reason or "",
            latency_ms=latency,
        )
        return response

    def to_json(self) -> str:
        return self.recorder.to_json()

    def redaction_summary(self) -> str:
        return self.recorder.redaction_summary()


def _classify(exc: Exception) -> str:
    if isinstance(exc, requests.exceptions.SSLError):
        return "tls-error"
    if isinstance(exc, (requests.exceptions.ConnectTimeout, requests.exceptions.ReadTimeout)):
        return "timeout"
    text = str(exc).lower()
    if "name or service not known" in text or "nodename" in text or "resolve" in text:
        return "dns-failure"
    if "refused" in text:
        return "connection-refused"
    return "connection-reset"
