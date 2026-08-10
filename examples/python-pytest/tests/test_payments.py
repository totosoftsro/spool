from __future__ import annotations

import pathlib
import sys

import httpx
import pytest

from spool import HifMatchError
from spool.adapters.httpx_adapter import SpoolReplayTransport

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from payments import CardDeclined, PaymentsClient  # noqa: E402

FIXTURE = (
    pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "payments.hif.json"
).read_text(encoding="utf-8")


@pytest.fixture
def client():
    transport = SpoolReplayTransport(FIXTURE)
    http = httpx.Client(transport=transport, headers={"authorization": "Bearer not-a-real-key"})
    yield PaymentsClient("https://api.payments.example", "unused", http=http), transport
    http.close()


def test_creates_a_charge(client) -> None:
    payments, transport = client

    charge = payments.create_charge(4999, "GBP")

    assert charge.id == "ch_test_1"
    assert charge.status == "succeeded"
    # Section 5.4: the fixture declares `expect: { called: "once" }`.
    transport.assert_complete()


def test_ignores_a_field_that_changes_every_run(client) -> None:
    """`idempotencyKey` is a fresh UUID on every call.

    The fixture's `defaults.match.body.json.ignore` drops that path from the
    comparison, so the test does not have to patch `uuid.uuid4` or thread a
    factory through the client.
    """
    payments, _ = client
    first = payments.create_charge(4999, "GBP")
    assert first.id == "ch_test_1"


def test_surfaces_a_declined_card(client) -> None:
    payments, _ = client
    payments.create_charge(4999, "GBP")

    with pytest.raises(CardDeclined) as excinfo:
        payments.create_charge(100_000, "GBP")

    assert excinfo.value.code == "card_declined"


def test_retries_after_a_connection_reset(client) -> None:
    """Section 10: the first GET fails at the transport layer, the retry succeeds.

    This exercises the client's own `except httpx.TransportError` branch, which
    is normally hard to reach in a test without a fault-injection proxy.
    """
    payments, _ = client
    payments.create_charge(4999, "GBP")

    charge = payments.retrieve_charge("ch_test_1")

    assert charge.status == "succeeded"


def test_an_unrecorded_request_is_explained(client) -> None:
    payments, _ = client
    payments.create_charge(4999, "GBP")

    with pytest.raises(HifMatchError) as excinfo:
        payments.create_charge(4999, "USD")

    message = str(excinfo.value)
    assert "REQUEST MISMATCH" in message
    # The report points at the currency, not just "no match".
    assert "/currency" in message
