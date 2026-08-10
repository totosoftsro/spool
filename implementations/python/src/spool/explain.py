"""The mismatch explanation engine, per specification section 13.

The design rule that matters, and the reason this module exists:

    **A suggestion is never emitted unless it has been verified.**

Verification is literal: apply the proposed configuration change, re-run the
matcher against the same live request, observe that it now matches. If nothing
verifies, the report says no single change explains the mismatch and offers
nothing. A wrong guess costs a developer more time than silence does, and
"request did not match" already wasted enough of it.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any, Callable, Dict, List, Optional, Tuple

from .fixture import interaction_ref, play_limit
from .match import (
    FieldResult,
    NormalizedRequest,
    is_match,
    match_request,
    normalize_request,
    resolve_match_config,
)


@dataclass
class CandidateReport:
    ref: str
    index: int
    score: int
    total: int
    depleted: bool
    fields: List[FieldResult]


@dataclass
class Suggestion:
    target: str
    value: Any
    description: str
    kind: str = "match-config"
    verified: bool = True


@dataclass
class MismatchReport:
    request: NormalizedRequest
    candidates: List[CandidateReport] = dataclass_field(default_factory=list)
    suggestions: List[Suggestion] = dataclass_field(default_factory=list)
    empty: bool = False


def explain(
    fixture: Dict[str, Any], live: NormalizedRequest, plays: Optional[Dict[int, int]] = None
) -> MismatchReport:
    """Build the mismatch report for a live request that matched nothing."""
    plays = plays or {}
    defaults = (fixture.get("defaults") or {}).get("match")
    candidates: List[CandidateReport] = []

    for index, interaction in enumerate(fixture.get("interactions", [])):
        config = resolve_match_config(defaults, interaction.get("match"))
        recorded = normalize_request(interaction["request"])
        fields = match_request(recorded, live, config)
        score = sum(1 for f in fields if f.ok)

        limit = play_limit(fixture, interaction)
        used = plays.get(index, 0)
        exhausted = limit != "unlimited" and used >= limit

        # Section 13.3: a depleted candidate that would otherwise have matched
        # is the actual cause. Reporting it as an ordinary mismatch hides "you
        # called this three times but recorded it twice".
        depleted = exhausted and is_match(fields)
        reported = list(fields)
        if depleted:
            reported.append(
                FieldResult("replay", False, reason="depleted", expected=limit, actual=used)
            )

        candidates.append(
            CandidateReport(
                ref=interaction_ref(interaction, index),
                index=index,
                score=score,
                total=len(fields),
                depleted=depleted,
                fields=reported,
            )
        )

    # Section 13.2: score desc, then total desc, then index asc. A total order,
    # so the report never depends on iteration order.
    candidates.sort(key=lambda c: (-c.score, -c.total, c.index))

    suggestions = _suggest_for(fixture, candidates[0], live) if candidates else []

    return MismatchReport(
        request=live,
        candidates=candidates,
        suggestions=suggestions,
        empty=len(fixture.get("interactions", [])) == 0,
    )


@dataclass
class _Proposal:
    target: str
    value: Any
    description: str
    apply: Callable[[Dict[str, Any]], Dict[str, Any]]


def _suggest_for(
    fixture: Dict[str, Any], candidate: CandidateReport, live: NormalizedRequest
) -> List[Suggestion]:
    """Section 13.4: propose in the specified order, verify each, keep three.

    The ordering is normative so that two implementations produce the same
    suggestions for the same failure. It runs most-targeted first: allowing
    extra JSON members before ignoring a whole field, and ignoring a whole field
    before ignoring the entire body.
    """
    interactions = fixture.get("interactions", [])
    if candidate.index >= len(interactions):
        return []

    # A depleted candidate has no configuration fix; the fixture needs another
    # recording or a higher play count. Saying nothing is correct here.
    if candidate.depleted:
        return []

    interaction = interactions[candidate.index]
    defaults = (fixture.get("defaults") or {}).get("match")
    base = resolve_match_config(defaults, interaction.get("match"))
    recorded = normalize_request(interaction["request"])
    prefix = f"interactions[{candidate.index}].match"

    proposals: List[_Proposal] = []

    if base["body"]["json"]["extra"] == "reject":
        proposals.append(
            _Proposal(
                f"{prefix}.body.json.extra",
                "allow",
                "Allow unexpected members in the request body",
                _set_body_extra,
            )
        )

    for path in _differing_json_paths(candidate.fields):
        proposals.append(
            _Proposal(
                f"{prefix}.body.json.ignore",
                base["body"]["json"]["ignore"] + [path],
                f"Ignore the request-body field {path}",
                _appender(("body", "json", "ignore"), path),
            )
        )

    for name in _differing_names(candidate.fields, "query"):
        proposals.append(
            _Proposal(
                f"{prefix}.query.ignore",
                base["query"]["ignore"] + [name],
                f'Ignore the query parameter "{name}"',
                _appender(("query", "ignore"), name),
            )
        )

    for name in _differing_names(candidate.fields, "headers"):
        proposals.append(
            _Proposal(
                f"{prefix}.headers.ignore",
                base["headers"]["ignore"] + [name],
                f'Ignore the "{name}" header',
                _appender(("headers", "ignore"), name),
            )
        )

    for scalar in ("method", "scheme", "host", "port", "path"):
        if base[scalar] != "exact":
            continue
        proposals.append(
            _Proposal(
                f"{prefix}.{scalar}",
                "ignore",
                f"Stop comparing the request {scalar}",
                _scalar_setter(scalar),
            )
        )

    if base["body"]["mode"] != "ignore":
        proposals.append(
            _Proposal(f"{prefix}.body.mode", "ignore", "Stop comparing the request body", _ignore_body)
        )

    verified: List[Suggestion] = []
    for proposal in proposals:
        if len(verified) == 3:
            break
        try:
            candidate_config = proposal.apply(copy.deepcopy(base))
            now_matches = is_match(match_request(recorded, live, candidate_config))
        except Exception:  # noqa: BLE001 - a proposal that raises is simply not a fix
            continue
        if not now_matches:
            continue
        verified.append(Suggestion(proposal.target, proposal.value, proposal.description))

    return verified


def _set_body_extra(config: Dict[str, Any]) -> Dict[str, Any]:
    config["body"]["json"]["extra"] = "allow"
    return config


def _ignore_body(config: Dict[str, Any]) -> Dict[str, Any]:
    config["body"]["mode"] = "ignore"
    return config


def _scalar_setter(name: str) -> Callable[[Dict[str, Any]], Dict[str, Any]]:
    def apply(config: Dict[str, Any]) -> Dict[str, Any]:
        config[name] = "ignore"
        return config

    return apply


def _appender(path: Tuple[str, ...], value: str) -> Callable[[Dict[str, Any]], Dict[str, Any]]:
    def apply(config: Dict[str, Any]) -> Dict[str, Any]:
        node: Any = config
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = list(node[path[-1]]) + [value]
        return config

    return apply


def _differing_json_paths(fields: List[FieldResult]) -> List[str]:
    paths: List[str] = []
    for field in fields:
        if field.field != "body" or field.ok:
            continue
        for detail in field.details or [field]:
            if not detail.path or detail.path in paths:
                continue
            if detail.reason and detail.reason.startswith("json."):
                paths.append(detail.path)
    return paths


def _differing_names(fields: List[FieldResult], which: str) -> List[str]:
    names: List[str] = []
    for field in fields:
        if field.field != which or field.ok:
            continue
        for detail in field.details or [field]:
            if detail.path and detail.path not in names:
                names.append(detail.path)
    return names
