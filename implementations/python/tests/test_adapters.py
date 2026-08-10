"""Adapter tests: httpx and requests.

These are the "does it actually work in a real test" tests. The conformance
suite proves the core agrees with the spec; this proves the seams are wired up.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from spool import HifExpectationError, HifMatchError

httpx = pytest.importorskip("httpx")
requests = pytest.importorskip("requests")

from spool.adapters.httpx_adapter import SpoolReplayTransport  # noqa: E402
from spool.adapters.requests_adapter import SpoolReplayAdapter, mount  # noqa: E402

FIXTURE: Dict[str, Any] = {
    "hif": "1.0",
    "interactions": [
        {
            "id": "get-user",
            "request": {"method": "GET", "url": "https://api.example.com/v1/users/7"},
            "response": {
                "status": 200,
                "statusText": "OK",
                "headers": [["content-type", "application/json"]],
                "body": {"encoding": "json", "json": {"id": 7, "name": "Ada"}},
            },
            "expect": {"called": "once"},
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
            "id": "flaky",
            "request": {"method": "GET", "url": "https://api.example.com/v1/flaky"},
            "fault": {"type": "connection-reset"},
        },
        {
            "id": "no-content",
            "request": {"method": "DELETE", "url": "https://api.example.com/v1/users/7"},
            "response": {"status": 204},
        },
        {
            "id": "binary",
            "request": {"method": "GET", "url": "https://api.example.com/v1/logo.png"},
            "response": {
                "status": 200,
                "headers": [["content-type", "image/png"]],
                # The first eight bytes of a PNG signature.
                "body": {"encoding": "base64", "base64": "iVBORw0KGgo="},
            },
        },
    ],
}

FIXTURE_TEXT = json.dumps(FIXTURE)


# ---------------------------------------------------------------------------
# httpx
# ---------------------------------------------------------------------------


def test_httpx_replays_json() -> None:
    transport = SpoolReplayTransport(FIXTURE_TEXT)
    with httpx.Client(transport=transport) as client:
        response = client.get("https://api.example.com/v1/users/7")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {"id": 7, "name": "Ada"}


def test_httpx_matches_post_by_body() -> None:
    transport = SpoolReplayTransport(FIXTURE_TEXT)
    with httpx.Client(transport=transport) as client:
        response = client.post("https://api.example.com/v1/users", json={"name": "Grace"})
    assert response.status_code == 201
    assert response.headers["location"] == "/v1/users/8"


def test_httpx_raises_a_transport_error_for_a_fault() -> None:
    transport = SpoolReplayTransport(FIXTURE_TEXT)
    # Application code that catches httpx.TransportError around a real network
    # failure catches the simulated one too (section 10).
    with httpx.Client(transport=transport) as client, pytest.raises(httpx.TransportError) as excinfo:
        client.get("https://api.example.com/v1/flaky")
    assert "simulated by a HIF fixture" in str(excinfo.value)


def test_httpx_delivers_204_and_binary() -> None:
    transport = SpoolReplayTransport(FIXTURE_TEXT)
    with httpx.Client(transport=transport) as client:
        empty = client.delete("https://api.example.com/v1/users/7")
        image = client.get("https://api.example.com/v1/logo.png")
    assert empty.status_code == 204
    assert empty.content == b""
    assert image.content == bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def test_httpx_unmatched_request_is_explained_and_never_hits_the_network() -> None:
    transport = SpoolReplayTransport(FIXTURE_TEXT)
    with httpx.Client(transport=transport) as client, pytest.raises(HifMatchError) as excinfo:
        client.get("https://api.example.com/v1/unknown")
    message = str(excinfo.value)
    assert "REQUEST MISMATCH" in message
    assert "Closest candidate" in message


def test_httpx_verifies_expectations() -> None:
    transport = SpoolReplayTransport(FIXTURE_TEXT)
    with pytest.raises(HifExpectationError):
        transport.assert_complete()
    with httpx.Client(transport=transport) as client:
        client.get("https://api.example.com/v1/users/7")
    transport.assert_complete()


def test_httpx_reports_unused_interactions() -> None:
    transport = SpoolReplayTransport(FIXTURE_TEXT)
    assert "create-user" in transport.unused()


# ---------------------------------------------------------------------------
# requests
# ---------------------------------------------------------------------------


def test_requests_replays_json() -> None:
    session = requests.Session()
    mount(session, FIXTURE_TEXT)
    response = session.get("https://api.example.com/v1/users/7")
    assert response.status_code == 200
    assert response.json() == {"id": 7, "name": "Ada"}
    assert response.headers["content-type"] == "application/json"


def test_requests_matches_post_by_body() -> None:
    session = requests.Session()
    mount(session, FIXTURE_TEXT)
    response = session.post("https://api.example.com/v1/users", json={"name": "Grace"})
    assert response.status_code == 201
    assert response.headers["location"] == "/v1/users/8"


def test_requests_raises_a_connection_error_for_a_fault() -> None:
    session = requests.Session()
    mount(session, FIXTURE_TEXT)
    with pytest.raises(requests.exceptions.ConnectionError) as excinfo:
        session.get("https://api.example.com/v1/flaky")
    assert "simulated by a HIF fixture" in str(excinfo.value)


def test_requests_delivers_binary_bytes() -> None:
    session = requests.Session()
    mount(session, FIXTURE_TEXT)
    response = session.get("https://api.example.com/v1/logo.png")
    assert response.content == bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def test_requests_unmatched_request_is_explained() -> None:
    session = requests.Session()
    adapter = SpoolReplayAdapter(FIXTURE_TEXT)
    session.mount("https://", adapter)
    with pytest.raises(HifMatchError) as excinfo:
        session.get("https://api.example.com/v1/nope")
    assert "REQUEST MISMATCH" in str(excinfo.value)


def test_both_adapters_select_the_same_interaction() -> None:
    """The two clients must be indistinguishable to the player.

    A difference here would mean one adapter is normalizing something the other
    is not, which is exactly the class of bug that makes fixtures non-portable.
    """
    httpx_transport = SpoolReplayTransport(FIXTURE_TEXT)
    with httpx.Client(transport=httpx_transport) as client:
        client.post("https://api.example.com/v1/users", json={"name": "Grace"})

    session = requests.Session()
    requests_adapter = SpoolReplayAdapter(FIXTURE_TEXT)
    session.mount("https://", requests_adapter)
    session.post("https://api.example.com/v1/users", json={"name": "Grace"})

    assert httpx_transport.player.play_count(1) == 1
    assert requests_adapter.player.play_count(1) == 1
