"""HTTP servers that replay or record a fixture, per ``spool serve`` and
``spool proxy``.

This is what makes HIF usable from a language with no adapter. Point a client at
the server — either by overriding its base URL (``serve``) or by setting
``HTTP_PROXY`` (``proxy``) — and the fixture backs it, with the same matching,
the same explanations and the same redaction as the in-process adapters.

Built on ``http.server`` only. No dependencies, no TLS interception.

**The HTTPS limitation is real and is not worked around here.** A forward proxy
cannot see inside a CONNECT tunnel without generating a certificate and
persuading the client to trust it. Rather than ship a man-in-the-middle CA —
which is a serious thing to put on a developer machine and a worse thing to put
in CI — ``proxy`` answers CONNECT with a clear explanation pointing at
``serve``, which needs no such trick.
"""

from __future__ import annotations

import contextlib
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from .body import encode_body, to_entries
from .errors import HifMatchError, HifStructuralError
from .fixture import serialize_fixture
from .player import Player, Recorder, deliverable
from .redact import RedactionConfig
from .url import normalize_url

#: Headers a proxy or origin server adds that the fixture never saw. `host` is
#: rewritten by the mapping and the rest are hop-by-hop transport artefacts.
#: Dropping them keeps `headers: {mode: "all"}` fixtures working through the
#: server exactly as they do in-process.
TRANSPORT_HEADERS = frozenset(
    {
        "host",
        "connection",
        "proxy-connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "te",
        "trailer",
        "content-length",
    }
)

#: Largest request body the servers will buffer. These servers exist to replay
#: fixtures in tests, so a body beyond this is either a mistake or an attempt to
#: exhaust memory. Reading without a bound let any client hold the process's
#: memory hostage.
MAX_REQUEST_BODY = 32 * 1024 * 1024


def _body_forbidden(status: int) -> bool:
    """Statuses that must not carry content (RFC 9110 sections 6.4.1, 15.4.5).

    Node strips the body for these silently while ``http.server`` does not, so
    both implementations now apply the rule explicitly. Emitting a body with a
    204 produces a message a client cannot frame, and on a keep-alive connection
    the bytes are read as the start of the next response.
    """
    return status in (204, 304) or 100 <= status < 200


def _default_reason(status: int) -> str:
    """The reason phrase to send when the fixture does not supply one.

    Left to the two HTTP servers this differed: Node invents "unknown" for an
    unregistered code and ``http.server`` invents an empty string. Node's
    ``writeHead`` substitutes "unknown" for any falsy reason phrase and offers no
    way to send an empty one, so that is the value both implementations use —
    matching an existing platform behaviour rather than inventing a third.
    """
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "unknown"


CONNECT_EXPLANATION = """spool proxy cannot serve https through a CONNECT tunnel.

Doing so would require generating a TLS certificate and persuading your client
to trust it. Installing a man-in-the-middle certificate authority on a developer
machine or in CI is a bigger security decision than a test tool should make for
you, so spool does not do it.

Two things that do work:

  spool serve fixtures/api.hif.json --origin https://api.example.com
      Serves the fixture as a plain-HTTP origin on localhost. Point your
      client's base URL at it. The fixture still describes the https origin,
      so nothing about the recording changes.

  Use an in-process adapter if your language has one:
      TypeScript: @spool/hif/fetch
      Python:     spool.adapters.httpx_adapter, spool.adapters.requests_adapter
"""


def origins_of(fixture: Dict[str, Any]) -> List[str]:
    """Every distinct origin in a fixture, sorted, for diagnostics."""
    origins: Set[str] = set()
    for interaction in fixture.get("interactions", []):
        url = normalize_url(interaction["request"]["url"])
        netloc = url.host if url.port is None else f"{url.host}:{url.port}"
        origins.add(f"{url.scheme}://{netloc}")
    return sorted(origins)


def infer_origin(fixture: Dict[str, Any]) -> Optional[str]:
    """The origin every interaction shares, or None when they differ."""
    found = origins_of(fixture)
    return found[0] if len(found) == 1 else None


class RunningServer:
    """A started server, and the handle to stop it."""

    def __init__(self, server: ThreadingHTTPServer, thread: threading.Thread) -> None:
        self._server = server
        self._thread = thread
        self.port = int(server.server_address[1])
        self.url = f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def __enter__(self) -> RunningServer:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class _BaseHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def version_string(self) -> str:
        """No ``Server:`` banner.

        The fixture describes the recorded origin's headers; a banner announcing
        the replay server is not one of them, and it would also make the two
        implementations' responses differ.
        """
        return ""

    def send_response(self, code: int, message: Optional[str] = None) -> None:
        """Send the status line and ``Date`` only when the fixture asked for it.

        ``BaseHTTPRequestHandler.send_response`` adds ``Server`` and ``Date``
        headers. Neither came from the recording, and ``Date`` in particular
        would make responses non-deterministic.
        """
        self.log_request(code)
        self.send_response_only(code, message)

    # Silence the default stderr access log; the CLI prints its own.
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        on_log = getattr(self.server, "on_log", None)
        if on_log:
            on_log(format % args)

    def _read_body(self) -> Optional[bytes]:
        """Read the request body, or None when it exceeds MAX_REQUEST_BODY."""
        length = self.headers.get("content-length")
        if length is None:
            return b""
        try:
            declared = int(length)
        except ValueError:
            return b""
        if declared > MAX_REQUEST_BODY:
            return None
        try:
            return self.rfile.read(declared)
        except OSError:
            return b""

    def _header_pairs(self) -> List[Tuple[str, str]]:
        return [
            (name.lower(), value)
            for name, value in self.headers.items()
            if name.lower() not in TRANSPORT_HEADERS
        ]

    def _to_hif_request(self, url: str, body: bytes) -> Dict[str, Any]:
        pairs = self._header_pairs()
        content_type = next((v for n, v in pairs if n == "content-type"), None)
        return {
            "method": self.command.upper(),
            "url": url,
            "headers": to_entries(pairs),
            "body": encode_body(body, content_type),
        }

    def _write_deliverable(self, out: Any, truncated: bool) -> None:
        payload = out.body
        self.send_response(out.status, out.status_text or _default_reason(out.status))
        for name, value in out.headers:
            if name == "content-length":
                continue
            self.send_header(name, value)

        if _body_forbidden(out.status):
            # No content-length either: RFC 9110 forbids content, and a length of
            # 0 on a 304 is still a framing claim the origin never made.
            self.end_headers()
            return

        if truncated:
            # Section 10 partial-response: announce the full length, send half,
            # then drop the connection, so the client sees a genuine mid-body
            # failure rather than a short but well-formed reply.
            self.send_header("content-length", str(len(payload) * 2 or 1))
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
            self.close_connection = True
            with contextlib.suppress(OSError):
                self.connection.close()
            return
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def _write_text(
        self, status: int, text: str, error_kind: str, reason: Optional[str] = None
    ) -> None:
        payload = text.encode("utf-8")
        self.send_response(status, reason or _default_reason(status))
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("x-spool-error", error_kind)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _write_mismatch(self, error: HifMatchError) -> None:
        # 551 is outside the registered range on purpose: it cannot be confused
        # with a status the recorded API might itself return, so a test that
        # asserts on status codes will not mistake a Spool failure for an
        # application response.
        self._write_text(551, str(error), "no-matching-interaction", "No Matching Interaction")

    def _drop_connection(self) -> None:
        """A transport fault has no HTTP representation; destroy the socket."""
        self.close_connection = True
        with contextlib.suppress(OSError):
            self.connection.close()


class _ReplayHandler(_BaseHandler):
    def _handle(self) -> None:
        server: Any = self.server
        try:
            if server.mode == "proxy":
                target = self.path
                if not target.lower().startswith(("http://", "https://")):
                    self._write_text(
                        400,
                        "spool proxy expects an absolute-form request URI, which is what a client\n"
                        "sends to a forward proxy. This request had a relative path, which means\n"
                        "the client is treating spool as an origin server. Use `spool serve`.\n",
                        "server-error",
                    )
                    return
            else:
                base = server.origin.rstrip("/")
                path = self.path if self.path.startswith("/") else "/" + self.path
                target = base + path

            body = self._read_body()
            if body is None:
                self._write_text(
                    413,
                    f"spool: request body exceeds {MAX_REQUEST_BODY} bytes\n",
                    "server-error",
                )
                return
            request = self._to_hif_request(target, body)
            self.log_message("%s %s", request["method"], self.path)

            play = server.player.select(request)
            server.player.delay(play)

            fault = play.fault
            if fault and fault.get("type") != "partial-response":
                self._drop_connection()
                return

            out = deliverable(play.response, truncate=bool(fault))
            self._write_deliverable(out, truncated=bool(fault))
        except HifMatchError as exc:
            self._write_mismatch(exc)
        except Exception as exc:  # noqa: BLE001 - a server must not die on one request
            self._write_text(500, f"spool: {exc}\n", "server-error")

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_PATCH = _handle
    do_DELETE = _handle
    do_HEAD = _handle
    do_OPTIONS = _handle

    def do_CONNECT(self) -> None:  # noqa: N802 - stdlib naming
        payload = CONNECT_EXPLANATION.encode("utf-8")
        self.send_response(501)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True


class _RecordHandler(_BaseHandler):
    def _handle(self) -> None:
        server: Any = self.server
        base = server.origin.rstrip("/")
        path = self.path if self.path.startswith("/") else "/" + self.path
        target = base + path

        body = self._read_body()
        if body is None:
            self._write_text(
                413, f"spool: request body exceeds {MAX_REQUEST_BODY} bytes\n", "server-error"
            )
            return
        pairs = self._header_pairs()
        method = self.command.upper()
        self.log_message("%s %s -> %s", method, path, target)

        start = time.monotonic()
        request = urllib.request.Request(
            target, data=body or None, method=method, headers=dict(pairs)
        )
        try:
            with urllib.request.urlopen(request) as upstream:  # noqa: S310 - target is operator-supplied
                status = upstream.status
                reason = upstream.reason or ""
                response_headers = [(k.lower(), v) for k, v in upstream.headers.items()]
                payload = upstream.read()
        except urllib.error.HTTPError as exc:
            # An HTTP error response is a perfectly good recording.
            status = exc.code
            reason = exc.reason or ""
            response_headers = [(k.lower(), v) for k, v in exc.headers.items()]
            payload = exc.read()
        except urllib.error.URLError as exc:
            server.recorder.record_fault(method, target, pairs, body, "connection-reset")
            self._write_text(502, f"spool: upstream request failed: {exc.reason}\n", "server-error")
            return

        latency = (time.monotonic() - start) * 1000
        server.recorder.record(
            method=method,
            url=target,
            request_headers=pairs,
            request_body=body,
            status=status,
            response_headers=response_headers,
            response_body=payload,
            status_text=reason,
            latency_ms=latency,
        )

        self.send_response(status, reason or None)
        for name, value in response_headers:
            if name in TRANSPORT_HEADERS or name == "content-encoding":
                continue
            self.send_header(name, value)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_PATCH = _handle
    do_DELETE = _handle
    do_HEAD = _handle
    do_OPTIONS = _handle


def _start(server: ThreadingHTTPServer) -> RunningServer:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return RunningServer(server, thread)


def serve_fixture(
    fixture: Dict[str, Any],
    port: int = 8080,
    host: str = "127.0.0.1",
    origin: Optional[str] = None,
    simulate_latency: bool = False,
    on_log: Optional[Callable[[str], None]] = None,
) -> RunningServer:
    """Serve a fixture as an HTTP origin.

    Point your client's base URL at it. This is the mode that works from every
    language, because it needs nothing from the client but a configurable base
    URL — and it needs no TLS interception, because the client speaks plain HTTP
    to localhost while the fixture still describes the original https origin.
    """
    resolved = origin or infer_origin(fixture)
    if not resolved:
        found = origins_of(fixture)
        if not found:
            raise HifStructuralError(
                "This fixture has no interactions, so serve has no origin to map requests "
                "onto. Pass --origin."
            )
        raise HifStructuralError(
            f"This fixture spans {len(found)} origins ({', '.join(found)}), so serve cannot "
            "tell which one an incoming request means. Pass --origin to choose, or use "
            "`spool proxy`, where the client sends the full URL and no mapping is needed."
        )

    server = ThreadingHTTPServer((host, port), _ReplayHandler)
    server.daemon_threads = True
    server.mode = "serve"  # type: ignore[attr-defined]
    server.origin = resolved  # type: ignore[attr-defined]
    server.player = Player(fixture, simulate_latency=simulate_latency)  # type: ignore[attr-defined]
    server.on_log = on_log  # type: ignore[attr-defined]
    return _start(server)


def proxy_fixture(
    fixture: Dict[str, Any],
    port: int = 8080,
    host: str = "127.0.0.1",
    simulate_latency: bool = False,
    on_log: Optional[Callable[[str], None]] = None,
) -> RunningServer:
    """Replay through an HTTP forward proxy.

    Set ``HTTP_PROXY`` and plain-HTTP requests are matched using their
    absolute-form request URI, which carries the full original URL — so no
    origin mapping is needed and multi-origin fixtures work. HTTPS is not
    supported; see :data:`CONNECT_EXPLANATION`.
    """
    server = ThreadingHTTPServer((host, port), _ReplayHandler)
    server.daemon_threads = True
    server.mode = "proxy"  # type: ignore[attr-defined]
    server.origin = ""  # type: ignore[attr-defined]
    server.player = Player(fixture, simulate_latency=simulate_latency)  # type: ignore[attr-defined]
    server.on_log = on_log  # type: ignore[attr-defined]
    return _start(server)


class RecordingServer(RunningServer):
    def __init__(
        self, server: ThreadingHTTPServer, thread: threading.Thread, recorder: Recorder
    ) -> None:
        super().__init__(server, thread)
        self.recorder = recorder

    def to_json(self) -> str:
        return serialize_fixture(self.recorder.to_fixture())

    def redaction_summary(self) -> str:
        return self.recorder.redaction_summary()


def record_serve(
    origin: str,
    port: int = 8080,
    host: str = "127.0.0.1",
    redact: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> RecordingServer:
    """Serve as a recording reverse proxy.

    Forwards to ``origin``, records what comes back, and hands the client the
    real response. Redaction runs before anything is stored, exactly as
    in-process recording does (section 9).
    """
    # `urllib.request.urlopen` honours file://, ftp:// and more. The origin comes
    # from the operator rather than from a fixture, but a typo should fail loudly
    # instead of turning the recorder into a local-file reader.
    normalize_url(origin if origin.endswith("/") else origin + "/")

    recorder = Recorder(redact=redact if redact is not None else RedactionConfig())
    server = ThreadingHTTPServer((host, port), _RecordHandler)
    server.daemon_threads = True
    server.origin = origin  # type: ignore[attr-defined]
    server.recorder = recorder  # type: ignore[attr-defined]
    server.on_log = on_log  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return RecordingServer(server, thread, recorder)
