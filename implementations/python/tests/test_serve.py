"""Tests for ``spool serve`` and ``spool proxy``.

These use a real socket and a real HTTP client, because the whole point of this
surface is that it works for a client Spool knows nothing about.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

import pytest

from spool.errors import HifStructuralError
from spool.serve import infer_origin, origins_of, proxy_fixture, serve_fixture

FIXTURE: Dict[str, Any] = {
    "hif": "1.0",
    "interactions": [
        {
            "id": "get-user",
            "request": {"method": "GET", "url": "https://api.example.com/v1/users/7"},
            "response": {
                "status": 200,
                "headers": [["content-type", "application/json"]],
                "body": {"encoding": "json", "json": {"id": 7, "name": "Ada"}},
            },
            "replay": {"times": "unlimited"},
        },
        {
            "id": "create-user",
            "request": {
                "method": "POST",
                "url": "https://api.example.com/v1/users",
                "body": {"encoding": "json", "json": {"name": "Grace"}},
            },
            "response": {"status": 201, "headers": [["location", "/v1/users/8"]]},
        },
        {
            "id": "binary",
            "request": {"method": "GET", "url": "https://api.example.com/v1/logo.png"},
            "response": {
                "status": 200,
                "headers": [["content-type", "image/png"]],
                "body": {"encoding": "base64", "base64": "iVBORw0KGgo="},
            },
        },
        {
            "id": "query-sensitive",
            "request": {"method": "GET", "url": "https://api.example.com/v1/search?q=ada&page=2"},
            "response": {"status": 200, "body": {"encoding": "text", "text": "results"}},
        },
    ],
}


def _get(
    url: str,
    method: str = "GET",
    data: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
) -> Tuple[int, Dict[str, str], bytes]:
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request) as response:  # noqa: S310 - localhost test server
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


@pytest.fixture
def server():
    running = serve_fixture(FIXTURE, port=0)
    yield running
    running.close()


def test_infers_a_single_shared_origin() -> None:
    assert infer_origin(FIXTURE) == "https://api.example.com"
    assert origins_of(FIXTURE) == ["https://api.example.com"]


def test_refuses_to_guess_when_a_fixture_spans_origins() -> None:
    multi = {
        "hif": "1.0",
        "interactions": [
            {"request": {"method": "GET", "url": "https://a.example.com/x"}, "response": {"status": 200}},
            {"request": {"method": "GET", "url": "https://b.example.com/x"}, "response": {"status": 200}},
        ],
    }
    assert infer_origin(multi) is None
    with pytest.raises(HifStructuralError, match="spans 2 origins"):
        serve_fixture(multi, port=0)


def test_answers_a_recorded_request_over_a_real_socket(server) -> None:
    status, headers, body = _get(f"{server.url}/v1/users/7")

    assert status == 200
    assert headers["content-type"] == "application/json"
    assert json.loads(body) == {"id": 7, "name": "Ada"}


def test_matches_a_post_body_sent_by_an_ordinary_client(server) -> None:
    status, headers, _ = _get(
        f"{server.url}/v1/users",
        method="POST",
        data=json.dumps({"name": "Grace"}).encode(),
        headers={"content-type": "application/json"},
    )

    assert status == 201
    assert headers["location"] == "/v1/users/8"


def test_delivers_binary_bodies_byte_for_byte(server) -> None:
    _, _, body = _get(f"{server.url}/v1/logo.png")
    assert body == bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def test_carries_the_query_string_through_to_matching(server) -> None:
    assert _get(f"{server.url}/v1/search?q=ada&page=2")[0] == 200
    assert _get(f"{server.url}/v1/search?q=grace&page=2")[0] == 551


def test_answers_551_with_the_full_explanation(server) -> None:
    status, headers, body = _get(f"{server.url}/v1/nope")

    assert status == 551
    assert headers["x-spool-error"] == "no-matching-interaction"
    text = body.decode()
    assert "REQUEST MISMATCH" in text
    assert "Closest candidate" in text


def test_maps_onto_an_explicit_origin_when_asked() -> None:
    other = {
        "hif": "1.0",
        "interactions": [
            {
                "request": {"method": "GET", "url": "https://other.example.com/ping"},
                "response": {"status": 200, "body": {"encoding": "text", "text": "pong"}},
            }
        ],
    }
    running = serve_fixture(other, port=0, origin="https://other.example.com")
    try:
        assert _get(f"{running.url}/ping")[2] == b"pong"
    finally:
        running.close()


# ---------------------------------------------------------------------------
# proxy
# ---------------------------------------------------------------------------


def _raw(port: int, payload: str) -> str:
    """Send a raw request, as a client configured with HTTP_PROXY would."""
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(payload.encode())
        chunks = []
        while True:
            data = sock.recv(65536)
            if not data:
                break
            chunks.append(data)
    return b"".join(chunks).decode("utf-8", errors="replace")


def test_proxy_matches_on_the_absolute_form_request_uri() -> None:
    running = proxy_fixture(FIXTURE, port=0)
    try:
        response = _raw(
            running.port,
            "GET https://api.example.com/v1/users/7 HTTP/1.1\r\n"
            "Host: api.example.com\r\nConnection: close\r\n\r\n",
        )
        assert "200" in response
        assert '"name":"Ada"' in response
    finally:
        running.close()


def test_proxy_supports_multi_origin_fixtures_which_serve_cannot() -> None:
    multi = {
        "hif": "1.0",
        "interactions": [
            {
                "request": {"method": "GET", "url": "https://a.example.com/x"},
                "response": {"status": 200, "body": {"encoding": "text", "text": "from-a"}},
            },
            {
                "request": {"method": "GET", "url": "https://b.example.com/x"},
                "response": {"status": 200, "body": {"encoding": "text", "text": "from-b"}},
            },
        ],
    }
    running = proxy_fixture(multi, port=0)
    try:
        for host, expected in (("a", "from-a"), ("b", "from-b")):
            response = _raw(
                running.port,
                f"GET https://{host}.example.com/x HTTP/1.1\r\n"
                f"Host: {host}.example.com\r\nConnection: close\r\n\r\n",
            )
            assert expected in response
    finally:
        running.close()


def test_proxy_rejects_a_relative_request_uri_with_an_explanation() -> None:
    running = proxy_fixture(FIXTURE, port=0)
    try:
        status, _, body = _get(f"{running.url}/v1/users/7")
        assert status == 400
        assert "spool serve" in body.decode()
    finally:
        running.close()


def test_proxy_explains_that_connect_is_unsupported() -> None:
    running = proxy_fixture(FIXTURE, port=0)
    try:
        response = _raw(
            running.port, "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com\r\n\r\n"
        )
        assert "501" in response
        assert "cannot serve https through a CONNECT tunnel" in response
        assert "spool serve" in response
    finally:
        running.close()


# ---------------------------------------------------------------------------
# Robustness against a hostile or awkward fixture
# ---------------------------------------------------------------------------


def test_strips_the_body_from_statuses_that_must_not_carry_one() -> None:
    """RFC 9110: 204, 304 and 1xx carry no content.

    A fixture that says otherwise used to produce a message the client cannot
    frame — on a keep-alive connection the body bytes are read as the start of
    the next response. Node stripped it silently; this server did not, which was
    both a protocol violation and a cross-language divergence.
    """
    no_body = {
        "hif": "1.0",
        "interactions": [
            {
                "id": f"s{status}",
                "request": {"method": "GET", "url": f"https://x.test/s{status}"},
                "response": {"status": status, "body": {"encoding": "text", "text": "MUST-NOT-APPEAR"}},
            }
            for status in (204, 304, 100)
        ],
    }
    running = serve_fixture(no_body, port=0)
    try:
        for status in (204, 304):
            code, headers, body = _get(f"{running.url}/s{status}")
            assert code == status
            assert body == b""
            assert "content-length" not in {k.lower() for k in headers}
    finally:
        running.close()


def test_rejects_a_request_body_beyond_the_bound() -> None:
    """An unbounded read let any client hold the process's memory hostage."""
    from spool.serve import MAX_REQUEST_BODY

    fixture = {
        "hif": "1.0",
        "interactions": [
            {
                "request": {"method": "POST", "url": "https://x.test/upload"},
                "response": {"status": 200},
            }
        ],
    }
    running = serve_fixture(fixture, port=0)
    try:
        # Claim a body far beyond the bound without sending it. The server must
        # answer 413 rather than try to buffer what was claimed.
        request = urllib.request.Request(
            f"{running.url}/upload",
            data=b"x" * 16,
            method="POST",
            headers={"content-length": str(MAX_REQUEST_BODY + 1)},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
                code = response.status
        except urllib.error.HTTPError as exc:
            code = exc.code
        assert code == 413
    finally:
        running.close()


def test_reports_the_same_reason_phrase_as_node_for_an_unregistered_status() -> None:
    """Node substitutes "unknown" for a falsy reason phrase and offers no way to
    send an empty one, so this server matches it rather than inventing a third."""
    fixture = {
        "hif": "1.0",
        "interactions": [
            {"request": {"method": "GET", "url": "https://x.test/odd"}, "response": {"status": 599}}
        ],
    }
    running = serve_fixture(fixture, port=0)
    try:
        raw = _raw(
            running.port, "GET /odd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
        )
        assert raw.split("\r\n")[0] == "HTTP/1.1 599 unknown"
    finally:
        running.close()


def test_record_serve_refuses_a_non_http_origin() -> None:
    """`urlopen` honours file:// and ftp://.

    The origin comes from the operator rather than from a fixture, but a typo
    should fail loudly instead of turning the recorder into a local-file reader.
    """
    from spool.serve import record_serve

    with pytest.raises(HifStructuralError):
        record_serve(origin="file:///etc/passwd", port=0)
