"""The code under test.

It knows nothing about Spool. A fixture replaces the network, not your
architecture: no injected client, no test-only branch, no interface extracted
purely to enable mocking.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

import httpx


class CardDeclined(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class Charge:
    id: str
    amount: int
    status: str


class PaymentsClient:
    def __init__(self, base_url: str, api_key: str, http: Optional[httpx.Client] = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._http = http or httpx.Client(headers={"authorization": f"Bearer {api_key}"})

    def create_charge(self, amount: int, currency: str) -> Charge:
        response = self._http.post(
            f"{self.base_url}/v1/charges",
            json={
                "amount": amount,
                "currency": currency,
                # Changes on every call. The fixture's `defaults.match` ignores
                # this path rather than the test having to control it.
                "idempotencyKey": str(uuid.uuid4()),
            },
        )
        if response.status_code == 402:
            error: Dict[str, Any] = response.json()["error"]
            raise CardDeclined(error["code"], error["message"])
        response.raise_for_status()
        body = response.json()
        return Charge(id=body["id"], amount=body["amount"], status=body["status"])

    def retrieve_charge(self, charge_id: str, retries: int = 2) -> Charge:
        """Retrieves a charge, retrying once on a transport failure."""
        last: Optional[Exception] = None
        for _ in range(retries):
            try:
                response = self._http.get(f"{self.base_url}/v1/charges/{charge_id}")
                response.raise_for_status()
                body = response.json()
                return Charge(id=body["id"], amount=body["amount"], status=body["status"])
            except httpx.TransportError as exc:
                last = exc
        raise RuntimeError(f"could not retrieve charge {charge_id}") from last
