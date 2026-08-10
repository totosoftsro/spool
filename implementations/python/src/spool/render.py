"""Human-readable rendering of a mismatch report (section 13).

The report data structure is normative; this rendering is not. It is, however,
the thing a developer actually reads at 2am, so it gets the same care.

Rules followed here:
  - Show what matched, not just what failed.
  - Never imply a cause that has not been proven.
  - Deterministic output: no timestamps, no durations, no set iteration.

The output is kept byte-identical to the TypeScript renderer, so a mismatch in
CI reads the same whichever implementation produced it.
"""

from __future__ import annotations

import json
from typing import Any, List, Optional

from .explain import CandidateReport, MismatchReport
from .match import FieldResult, NormalizedRequest

TICK = "✓"
CROSS = "✗"

_ABSENT = "(absent)"


class _Color:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _wrap(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def bold(self, text: str) -> str:
        return self._wrap("1", text)

    def dim(self, text: str) -> str:
        return self._wrap("2", text)

    def red(self, text: str) -> str:
        return self._wrap("31", text)

    def green(self, text: str) -> str:
        return self._wrap("32", text)

    def yellow(self, text: str) -> str:
        return self._wrap("33", text)


def render_mismatch(
    report: MismatchReport, all_candidates: bool = False, color: bool = False, max_value_length: int = 400
) -> str:
    c = _Color(color)
    lines: List[str] = []

    lines.append(c.bold("REQUEST MISMATCH"))
    lines.append("")
    lines.append(f"  {report.request.method} {report.request.url}")
    lines.append("")

    if report.empty:
        lines.append("  The fixture contains no interactions, so nothing could match.")
        lines.append("  Record it first, or point the player at a different fixture.")
        return "\n".join(lines) + "\n"

    shown = report.candidates if all_candidates else report.candidates[:1]
    for candidate in shown:
        lines.extend(_render_candidate(candidate, c, max_value_length))
        lines.append("")

    hidden = len(report.candidates) - len(shown)
    if hidden > 0:
        plural = "" if hidden == 1 else "s"
        lines.append(f"  {hidden} other candidate{plural} checked. Set SPOOL_EXPLAIN=all to see them.")
        lines.append("")

    if report.suggestions:
        lines.append(c.bold("  Suggested action"))
        for suggestion in report.suggestions:
            lines.append(f"    {suggestion.description}:")
            lines.append(c.dim(f"      {suggestion.target} = {json.dumps(suggestion.value)}"))
        lines.append("")
        lines.append(c.dim("  Each suggestion was verified: applying it makes this request match."))
    elif not (report.candidates and report.candidates[0].depleted):
        # Section 13.4: silence beats speculation.
        lines.append("  No single configuration change makes the closest candidate match,")
        lines.append("  so no fix is suggested. Re-record the fixture, or compare the")
        lines.append("  differences above by hand.")

    return "\n".join(lines) + "\n"


def _render_candidate(candidate: CandidateReport, c: _Color, max_len: int) -> List[str]:
    lines: List[str] = []
    score = c.dim(f"({candidate.score}/{candidate.total} fields matched)")
    lines.append(f"  {c.bold('Closest candidate')}: {candidate.ref}  {score}")
    lines.append("")

    for field in candidate.fields:
        if field.ok:
            lines.append(f"    {c.green(TICK)} {_pad(field.field)} {c.dim(_ok_value(field))}".rstrip())
            continue
        if field.reason == "depleted":
            lines.append(
                f"    {c.red(CROSS)} {_pad('replay')} already played {field.actual} of "
                f"{field.expected} times"
            )
            lines.append("")
            lines.append("      This interaction matches the request in every compared field,")
            lines.append("      but its play count is exhausted. Either the code under test")
            lines.append("      makes more calls than were recorded, or the fixture needs")
            lines.append(f'      "replay": {{ "times": {int(field.actual) + 1} }} or "unlimited".')
            continue
        lines.append(f"    {c.red(CROSS)} {_pad(field.field)} {c.dim(field.reason or '')}")
        for detail in field.details or [field]:
            lines.extend(_render_detail(detail, c, max_len))

    return lines


def _render_detail(detail: FieldResult, c: _Color, max_len: int) -> List[str]:
    lines: List[str] = []
    where = f"      at {detail.path}" if detail.path else "     "

    if detail.reason in ("json.unexpected-member", "query.unexpected-param", "header.unexpected"):
        lines.append(where)
        lines.append(f"        {c.dim('expected')}  {_ABSENT}")
        lines.append(f"        {c.dim('received')}  {_short(detail.actual, max_len)}")
        lines.append(f"        {c.yellow('unexpected')}")
    elif detail.reason in ("json.missing-member", "query.missing-param", "header.missing"):
        lines.append(where)
        lines.append(f"        {c.dim('expected')}  {_short(detail.expected, max_len)}")
        lines.append(f"        {c.dim('received')}  {_ABSENT}")
        lines.append(f"        {c.yellow('missing')}")
    elif detail.reason == "json.placeholder-unsatisfied":
        lines.append(where)
        lines.append(f"        {c.dim('placeholder')}  {_short(detail.expected, max_len)}")
        lines.append(f"        {c.dim('received')}     {_short(detail.actual, max_len)}")
        lines.append(f"        {c.yellow('the received value does not satisfy the placeholder')}")
    elif detail.reason == "body.not-json":
        lines.append("        the body was expected to be JSON but did not parse")
    elif detail.reason == "body.not-text":
        lines.append("        the body is binary and cannot be compared as text")
    else:
        lines.append(where)
        lines.append(f"        {c.dim('expected')}  {_short(detail.expected, max_len)}")
        lines.append(f"        {c.dim('received')}  {_short(detail.actual, max_len)}")

    return lines


def _ok_value(field: FieldResult) -> str:
    """What to show beside a field that matched.

    A compared-and-equal composite field (query, headers, body) has no single
    value worth printing, so it prints nothing rather than "(absent)", which
    would read as a failure. A null port means the scheme default applied.
    """
    from .match import _UNSET

    if field.field == "port" and field.actual is None:
        return "(scheme default)"
    if field.actual is _UNSET:
        return ""
    return _short(field.actual, 80)


def _pad(field: str) -> str:
    return (field + ":").ljust(9)


def _short(value: Any, max_len: int) -> str:
    from .match import _UNSET  # local import keeps the sentinel private to match.py

    # Only the sentinel means "absent". A JSON null is a value and renders as
    # `null`, matching the TypeScript renderer, where `undefined` and `null` are
    # likewise distinct.
    if value is _UNSET:
        return _ABSENT
    text = value if isinstance(value, str) else json.dumps(value)
    if len(text) > max_len:
        return text[:max_len] + f"... ({len(text)} chars)"
    return text


def render_request(request: NormalizedRequest) -> str:
    """Render a normalized request compactly, for `spool explain` and debugging."""
    lines = [f"{request.method} {request.url}"]
    for header in request.headers:
        lines.append(f"  {header.name}: {header.value}")
    summary = _body_summary(request)
    if summary is not None:
        lines.append("")
        lines.append(f"  {summary}")
    return "\n".join(lines)


def _body_summary(request: NormalizedRequest) -> Optional[str]:
    body = request.body
    encoding = body.get("encoding")
    if encoding == "empty":
        return None
    if encoding == "text":
        text = str(body["text"])
        return text[:500] + "..." if len(text) > 500 else text
    if encoding == "json":
        return json.dumps(body["json"], indent=2).replace("\n", "\n  ")
    return f"(binary, {len(body.get('base64', '')) * 3 // 4} bytes)"
