"""The player and recorder.

Implements section 7.5 (selection), 8.1 (header handling on delivery), 10
(faults), 5.4 (expectations), and section 9 redaction at record time.

The player is the only stateful part of the system. Fixtures are immutable
during replay; play counts live here and are reset when a player is constructed
or reset, so tests stay isolated (section 7.5).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from .body import body_bytes, encode_body, to_entries
from .errors import HifExpectationError, HifFaultError, HifMatchError
from .explain import MismatchReport, explain
from .fixture import SUPPORTED_VERSION, interaction_ref, play_limit, serialize_fixture
from .match import is_match, match_request, normalize_request, resolve_match_config
from .redact import RedactionConfig, redact_request, redact_response
from .render import render_mismatch


@dataclass
class Play:
    interaction: Dict[str, Any]
    index: int
    ref: str
    response: Optional[Dict[str, Any]]
    fault: Optional[Dict[str, Any]]
    latency_ms: float


class Player:
    """Replays a fixture."""

    def __init__(
        self,
        fixture: Dict[str, Any],
        simulate_latency: bool = False,
        latency_scale: float = 1.0,
        explain_all: Optional[bool] = None,
        color: bool = False,
    ) -> None:
        self.fixture = fixture
        self.simulate_latency = simulate_latency
        self.latency_scale = latency_scale
        self._explain_all = explain_all
        self.color = color
        self._plays: Dict[int, int] = {}

    def reset(self) -> None:
        """Section 7.5: reset play counts. Call between tests to restore isolation."""
        self._plays = {}

    def play_count(self, index: int) -> int:
        return self._plays.get(index, 0)

    def select(self, request: Dict[str, Any]) -> Play:
        """Section 7.5 selection.

        Returns the chosen interaction and consumes one play, or raises
        :class:`HifMatchError` carrying the section 13 report. The player never
        performs a live request; falling through to the network is a caller
        decision, made by catching this error.
        """
        live = normalize_request(request)
        found = self._find(live)

        if found is None:
            report = explain(self.fixture, live, self._plays)
            raise HifMatchError(
                render_mismatch(report, all_candidates=self._show_all(), color=self.color), report
            )

        interaction, index = found
        self._plays[index] = self._plays.get(index, 0) + 1
        timing = interaction.get("timing") or {}
        return Play(
            interaction=interaction,
            index=index,
            ref=interaction_ref(interaction, index),
            response=interaction.get("response"),
            fault=interaction.get("fault"),
            latency_ms=float(timing.get("latencyMs", 0)),
        )

    def explain_request(self, request: Dict[str, Any]) -> MismatchReport:
        """Build the section 13 report for a request without consuming a play."""
        return explain(self.fixture, normalize_request(request), self._plays)

    def would_match(self, request: Dict[str, Any]) -> bool:
        """True when the request would match, without consuming a play."""
        return self._find(normalize_request(request)) is not None

    def _find(self, live: Any) -> Optional[Tuple[Dict[str, Any], int]]:
        defaults = (self.fixture.get("defaults") or {}).get("match")
        for index, interaction in enumerate(self.fixture.get("interactions", [])):
            limit = play_limit(self.fixture, interaction)
            if limit != "unlimited" and self._plays.get(index, 0) >= limit:
                continue
            config = resolve_match_config(defaults, interaction.get("match"))
            recorded = normalize_request(interaction["request"])
            if is_match(match_request(recorded, live, config)):
                return interaction, index
        return None

    def delay(self, play: Play) -> None:
        """Sleep for the play's latency, if simulation is enabled (5.3, 10)."""
        if not self.simulate_latency:
            return
        extra = float((play.fault or {}).get("afterMs", 0))
        total = (play.latency_ms + extra) * self.latency_scale
        if total > 0:
            time.sleep(total / 1000.0)

    def assert_complete(self) -> None:
        """Section 5.4: verify every ``expect``. Call at test teardown.

        Lists every unmet expectation, not just the first: one run should tell
        you everything that is wrong.
        """
        failures: List[str] = []
        for index, interaction in enumerate(self.fixture.get("interactions", [])):
            called = (interaction.get("expect") or {}).get("called")
            if called is None or called == "any":
                continue
            count = self._plays.get(index, 0)
            ref = interaction_ref(interaction, index)

            if called == "once" and count != 1:
                failures.append(f"{ref}: expected exactly 1 call, got {count}")
            elif called == "atLeastOnce" and count < 1:
                failures.append(f"{ref}: expected at least 1 call, got 0")
            elif called == "never" and count != 0:
                failures.append(f"{ref}: expected no calls, got {count}")
            elif isinstance(called, dict) and count != called.get("times"):
                failures.append(f"{ref}: expected exactly {called.get('times')} call(s), got {count}")

        if failures:
            raise HifExpectationError(failures)

    def unused_interactions(self) -> List[str]:
        """Interactions that were never played. Useful for pruning stale fixtures."""
        return [
            interaction_ref(interaction, index)
            for index, interaction in enumerate(self.fixture.get("interactions", []))
            if not self._plays.get(index)
        ]

    def _show_all(self) -> bool:
        if self._explain_all is not None:
            return self._explain_all
        return os.environ.get("SPOOL_EXPLAIN") == "all"


# ---------------------------------------------------------------------------
# Faults (section 10)
# ---------------------------------------------------------------------------

#: Section 10 requires raising what the ecosystem's client raises. Python has no
#: single transport error type, so the code is carried on the exception and the
#: adapters translate it into their client's own error where one exists.
FAULT_CODES = {
    "connection-refused": "ECONNREFUSED",
    "connection-reset": "ECONNRESET",
    "timeout": "ETIMEDOUT",
    "dns-failure": "ENOTFOUND",
    "tls-error": "SSLCERTVERIFICATIONFAILED",
    # No transport-level code exists for a truncated body; the player delivers
    # headers and then errors the body.
    "partial-response": "ECONNRESET",
}

FAULT_MESSAGES = {
    "connection-refused": "connection refused (simulated by a HIF fixture)",
    "connection-reset": "connection reset by peer (simulated by a HIF fixture)",
    "timeout": "request timed out (simulated by a HIF fixture)",
    "dns-failure": "name resolution failed (simulated by a HIF fixture)",
    "tls-error": "TLS handshake failed (simulated by a HIF fixture)",
    "partial-response": "response body truncated (simulated by a HIF fixture)",
}


def fault_error(fault: Dict[str, Any]) -> HifFaultError:
    fault_type = str(fault["type"])
    return HifFaultError(
        fault_type,
        FAULT_CODES[fault_type],
        str(fault.get("message") or FAULT_MESSAGES[fault_type]),
    )


# ---------------------------------------------------------------------------
# Response delivery (section 8.1)
# ---------------------------------------------------------------------------


@dataclass
class DeliverableResponse:
    status: int
    status_text: str
    headers: List[Tuple[str, str]]
    body: bytes


def deliverable(response: Dict[str, Any], truncate: bool = False) -> DeliverableResponse:
    """Prepare a recorded response for delivery.

    Section 8.1: ``content-length`` is recomputed from the delivered body — a
    recorded value may disagree after redaction changed it — and
    ``transfer-encoding`` and ``content-encoding`` are dropped, because the
    stored body is already decoded.
    """
    full = body_bytes(response["body"]) if response.get("body") else b""
    body = full[: len(full) // 2] if truncate else full

    headers: List[Tuple[str, str]] = []
    had_content_length = False
    for entry in response.get("headers") or []:
        name = str(entry[0]).lower()
        if name == "content-length":
            had_content_length = True
            continue
        if name in ("transfer-encoding", "content-encoding"):
            continue
        value = "" if (len(entry) == 3 or entry[1] is None) else str(entry[1])
        headers.append((name, value))

    if body or had_content_length:
        headers.append(("content-length", str(len(body))))

    return DeliverableResponse(
        status=int(response["status"]),
        status_text=str(response.get("statusText") or ""),
        headers=headers,
        body=body,
    )


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

RECORDER_NAME = "spool-python"
RECORDER_VERSION = "0.1.0"


class Recorder:
    """Turns live traffic into a fixture.

    Redaction (section 9) runs here, before anything is written, so credentials
    never reach disk. There is no "record without redaction" default; disabling
    it takes an explicit ``redact=False``.
    """

    def __init__(
        self,
        name: Optional[str] = None,
        redact: Any = None,
        default_match: Optional[Dict[str, Any]] = None,
        preserve_bytes: bool = False,
        record_timing: bool = True,
        record_timestamp: bool = False,
    ) -> None:
        self.name = name
        self.redact = redact  # None -> defaults; False -> disabled; RedactionConfig -> custom
        self.default_match = default_match
        self.preserve_bytes = preserve_bytes
        self.record_timing = record_timing
        self.record_timestamp = record_timestamp
        self.interactions: List[Dict[str, Any]] = []
        self.warnings: List[str] = []
        self._rules: Set[str] = set()

    def record(
        self,
        method: str,
        url: str,
        request_headers: Sequence[Tuple[str, str]],
        request_body: bytes,
        status: int,
        response_headers: Sequence[Tuple[str, str]],
        response_body: bytes,
        status_text: str = "",
        latency_ms: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Record one completed exchange."""
        request: Dict[str, Any] = {
            "method": method.upper(),
            "url": url.split("#", 1)[0],
            "headers": to_entries(request_headers),
            "body": encode_body(
                request_body,
                _content_type(request_headers),
                preserve_bytes=self.preserve_bytes,
                on_warning=self._warn,
            ),
        }
        response: Dict[str, Any] = {
            "status": status,
            "headers": to_entries(response_headers),
            "body": encode_body(
                response_body,
                _content_type(response_headers),
                preserve_bytes=self.preserve_bytes,
                on_warning=self._warn,
            ),
        }
        if status_text:
            response["statusText"] = status_text

        if self.redact is not False:
            config = self.redact if isinstance(self.redact, RedactionConfig) else RedactionConfig()
            findings: List[str] = []
            request = redact_request(request, config, self._rules, findings)
            response = redact_response(response, config, self._rules, findings)
            self.warnings.extend(findings)

        interaction: Dict[str, Any] = {"request": request, "response": response}
        if self.record_timing and latency_ms is not None:
            interaction["timing"] = {"latencyMs": round(latency_ms)}

        self.interactions.append(interaction)
        return interaction

    def record_fault(
        self,
        method: str,
        url: str,
        request_headers: Sequence[Tuple[str, str]],
        request_body: bytes,
        fault_type: str,
    ) -> Dict[str, Any]:
        """Record a transport failure as a fault interaction (section 10)."""
        request: Dict[str, Any] = {
            "method": method.upper(),
            "url": url.split("#", 1)[0],
            "headers": to_entries(request_headers),
            "body": encode_body(request_body, _content_type(request_headers)),
        }
        if self.redact is not False:
            config = self.redact if isinstance(self.redact, RedactionConfig) else RedactionConfig()
            request = redact_request(request, config, self._rules, [])

        interaction = {"request": request, "fault": {"type": fault_type}}
        self.interactions.append(interaction)
        return interaction

    def to_fixture(self) -> Dict[str, Any]:
        meta: Dict[str, Any] = {
            "recorder": {"name": RECORDER_NAME, "version": RECORDER_VERSION},
            "redaction": {
                "applied": self.redact is not False and bool(self._rules),
                "rules": sorted(self._rules),
            },
        }
        if self.name:
            meta["name"] = self.name
        if self.record_timestamp:
            from datetime import datetime, timezone

            meta["createdAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        fixture: Dict[str, Any] = {"hif": SUPPORTED_VERSION, "meta": meta, "interactions": self.interactions}
        if self.default_match:
            fixture["defaults"] = {"match": self.default_match}
        return fixture

    def to_json(self) -> str:
        return serialize_fixture(self.to_fixture())

    def redaction_summary(self) -> str:
        """A summary of what redaction did.

        Deliberately worded as "reduces exposure", never "safe" or "sanitized"
        (section 9). A fixture recorded against a real system must still be
        reviewed.
        """
        if self.redact is False:
            return (
                "Redaction was DISABLED. This fixture may contain credentials verbatim. "
                "Review it before committing."
            )
        if not self._rules:
            return (
                "No redaction rule matched. This does not mean the fixture is free of secrets "
                "— review it before committing."
            )
        return (
            f"Redaction applied ({', '.join(sorted(self._rules))}). Rule- and entropy-based "
            "detection have false negatives, so review the fixture before committing it."
        )

    def _warn(self, message: str) -> None:
        self.warnings.append(message)


def _content_type(headers: Sequence[Tuple[str, str]]) -> Optional[str]:
    for name, value in headers:
        if name.lower() == "content-type":
            return value
    return None
