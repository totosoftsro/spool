"""Replay the shared fixture from Python.

Its TypeScript twin is `client.test.mjs` in this directory. Both read the same
`fixtures/github-user.hif.json` and assert the same behaviour.
"""

from __future__ import annotations

import pathlib

import httpx
import pytest

from spool.adapters.httpx_adapter import SpoolReplayTransport

FIXTURE = (pathlib.Path(__file__).parent / "fixtures" / "github-user.hif.json").read_text(
    encoding="utf-8"
)


@pytest.fixture
def client():
    transport = SpoolReplayTransport(FIXTURE)
    with httpx.Client(
        transport=transport,
        headers={"accept": "application/vnd.github+json", "user-agent": "spool-example/1.0"},
    ) as http:
        yield http, transport
    # Section 5.4: the fixture declares `expect: called atLeastOnce`, and this
    # is where that is checked.
    transport.assert_complete()


def test_fetches_a_user(client) -> None:
    http, _ = client
    response = http.get("https://api.github.com/users/octocat")

    assert response.status_code == 200
    assert response.json()["login"] == "octocat"
    assert response.headers["x-ratelimit-remaining"] == "59"


def test_handles_a_404(client) -> None:
    http, _ = client
    http.get("https://api.github.com/users/octocat")  # satisfy the atLeastOnce expectation

    response = http.get("https://api.github.com/users/this-user-does-not-exist-000")

    assert response.status_code == 404
    assert response.json()["message"] == "Not Found"


def test_retries_after_a_rate_limit(client) -> None:
    """The retry path, with no sequencing API involved.

    Two interactions share the same recorded request. Section 7.5 selects them
    in document order, so the first call gets the 403 and the second gets the
    200 — which is exactly the behaviour a retrying client should be tested
    against, and is awkward to express in most other tools.
    """
    http, _ = client
    http.get("https://api.github.com/users/octocat")

    first = http.get("https://api.github.com/users/octocat/repos")
    assert first.status_code == 403
    assert first.headers["retry-after"] == "1"

    second = http.get("https://api.github.com/users/octocat/repos")
    assert second.status_code == 200
    assert [repo["name"] for repo in second.json()] == ["Hello-World", "Spoon-Knife"]


def test_an_unrecorded_request_fails_loudly_and_offline(client) -> None:
    """An unmatched request never falls through to the network."""
    from spool import HifMatchError

    http, _ = client
    http.get("https://api.github.com/users/octocat")

    with pytest.raises(HifMatchError) as excinfo:
        http.get("https://api.github.com/users/someone-else")

    message = str(excinfo.value)
    assert "REQUEST MISMATCH" in message
    # The report names the closest recorded interaction rather than just failing.
    assert "Closest candidate" in message
