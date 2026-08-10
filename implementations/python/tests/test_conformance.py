"""The shared conformance suite, run against this implementation.

Cases live in ``conformance/cases/`` and are language-neutral JSON. Every
implementation runs exactly these, so a case that passes here and fails in
TypeScript is a real divergence — in one of the implementations, or in the spec.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any, Dict, List

import pytest

from spool import (
    EntropyConfig,
    HifMatchError,
    HifStructuralError,
    Player,
    RedactionConfig,
    canonicalize,
    compile_portable_regex,
    decode_query,
    digest_preimage,
    digest_request,
    entropy_tokens,
    explain,
    find_lossy_numbers,
    is_match,
    match_request,
    normalize_request,
    normalize_url,
    parse_fixture,
    parse_text_template,
    redact_fixture,
    resolve_match_config,
    text_matches_template,
)

CONFORMANCE = pathlib.Path(__file__).resolve().parents[3] / "conformance"
MANIFEST = json.loads((CONFORMANCE / "manifest.json").read_text(encoding="utf-8"))

HANDLED_KINDS = {
    "normalize",
    "query",
    "canonical",
    "lossy",
    "digest",
    "match",
    "template",
    "regex",
    "select",
    "explain",
    "redact",
    "entropy",
    "structural",
    "version",
}


def load(entry: Dict[str, Any]) -> Dict[str, Any]:
    return json.loads((CONFORMANCE / entry["file"]).read_text(encoding="utf-8"))


def cases(kind: str) -> List[Dict[str, Any]]:
    found = [c for c in MANIFEST["cases"] if c["kind"] == kind]
    assert found, f'No conformance cases of kind "{kind}"'
    return found


def ids(entries: List[Dict[str, Any]]) -> List[str]:
    return [e["id"] for e in entries]


def test_targets_the_same_spec_version_as_the_suite() -> None:
    assert MANIFEST["specVersion"] == "1.0"


def test_runs_every_case_in_the_manifest() -> None:
    unhandled = [c["id"] for c in MANIFEST["cases"] if c["kind"] not in HANDLED_KINDS]
    assert unhandled == []


def test_declares_the_conformance_levels_it_actually_runs() -> None:
    # This implementation runs every level. A partial implementation should skip
    # and report, never silently pass.
    levels = sorted({c["level"] for c in MANIFEST["cases"]})
    assert levels == ["core", "explain", "full", "redact"]


def test_every_case_file_parses_and_matches_its_manifest_entry() -> None:
    for entry in MANIFEST["cases"]:
        case = load(entry)
        assert case["id"] == entry["id"], entry["file"]
        assert case["kind"] == entry["kind"], entry["file"]
        assert isinstance(case["description"], str), entry["file"]


# ---------------------------------------------------------------------------


@pytest.mark.parametrize("entry", cases("normalize"), ids=ids(cases("normalize")))
def test_normalize(entry: Dict[str, Any]) -> None:
    case = load(entry)
    url = normalize_url(case["url"])
    actual = {
        "scheme": url.scheme,
        "host": url.host,
        "port": url.port,
        "path": url.path,
        "query": [p.as_dict() for p in decode_query(url.raw_query)],
        "href": url.href,
    }
    assert actual == case["expected"]


@pytest.mark.parametrize("entry", cases("query"), ids=ids(cases("query")))
def test_query(entry: Dict[str, Any]) -> None:
    case = load(entry)
    assert [p.as_dict() for p in decode_query(case["query"])] == case["expected"]


@pytest.mark.parametrize("entry", cases("canonical"), ids=ids(cases("canonical")))
def test_canonical(entry: Dict[str, Any]) -> None:
    case = load(entry)
    assert canonicalize(case["value"]) == case["expected"]


@pytest.mark.parametrize("entry", cases("lossy"), ids=ids(cases("lossy")))
def test_lossy(entry: Dict[str, Any]) -> None:
    case = load(entry)
    assert [n.as_dict() for n in find_lossy_numbers(case["text"])] == case["expected"]


@pytest.mark.parametrize("entry", cases("digest"), ids=ids(cases("digest")))
def test_digest(entry: Dict[str, Any]) -> None:
    case = load(entry)
    # The pre-image is checked separately from the hash so a failure says
    # whether the construction or the hashing is wrong.
    assert canonicalize(digest_preimage(case["request"])) == case["preimage"]
    assert digest_request(case["request"]) == case["digest"]


@pytest.mark.parametrize("entry", cases("match"), ids=ids(cases("match")))
def test_match(entry: Dict[str, Any]) -> None:
    case = load(entry)
    config = resolve_match_config(None, case["config"])
    result = match_request(
        normalize_request(case["recorded"]), normalize_request(case["live"]), config
    )
    assert is_match(result) is case["expected"]["matches"]


@pytest.mark.parametrize("entry", cases("template"), ids=ids(cases("template")))
def test_template(entry: Dict[str, Any]) -> None:
    case = load(entry)
    template = parse_text_template(case["recorded"])
    actual = [text_matches_template(template, subject) for subject in case["subjects"]]
    assert actual == case["expected"]["matches"]


@pytest.mark.parametrize("entry", cases("regex"), ids=ids(cases("regex")))
def test_regex(entry: Dict[str, Any]) -> None:
    case = load(entry)
    expected = case["expected"]
    if not expected["valid"]:
        with pytest.raises(HifStructuralError):
            compile_portable_regex(case["pattern"])
        return
    compiled = compile_portable_regex(case["pattern"])
    assert [compiled.test(s) for s in case["subjects"]] == expected["matches"]


@pytest.mark.parametrize("entry", cases("select"), ids=ids(cases("select")))
def test_select(entry: Dict[str, Any]) -> None:
    case = load(entry)
    fixture, _ = parse_fixture(json.dumps(case["fixture"]))
    player = Player(fixture)
    expected = case["expected"]

    selected: List[str] = []
    faults: List[Any] = []
    for request in case["requests"]:
        try:
            play = player.select(request)
            selected.append(play.ref)
            faults.append((play.fault or {}).get("type"))
        except HifMatchError:
            selected.append("<unmatched>")
            faults.append(None)

    assert selected == expected["selected"]
    if "faults" in expected:
        assert faults == expected["faults"]


@pytest.mark.parametrize("entry", cases("explain"), ids=ids(cases("explain")))
def test_explain(entry: Dict[str, Any]) -> None:
    case = load(entry)
    fixture, _ = parse_fixture(json.dumps(case["fixture"]))
    expected = case["expected"]
    plays = {int(k): v for k, v in (case.get("plays") or {}).items()}

    report = explain(fixture, normalize_request(case["live"]), plays)

    if "empty" in expected:
        assert report.empty is expected["empty"]
    if "candidateOrder" in expected:
        assert [c.ref for c in report.candidates] == expected["candidateOrder"]
    if "topScore" in expected:
        assert report.candidates[0].score == expected["topScore"]
    if "topTotal" in expected:
        assert report.candidates[0].total == expected["topTotal"]
    if "depleted" in expected:
        assert report.candidates[0].depleted is expected["depleted"]

    if "reasons" in expected:
        reasons = set()
        for field in report.candidates[0].fields if report.candidates else []:
            if field.ok:
                continue
            for detail in field.details or [field]:
                if detail.reason:
                    reasons.add(detail.reason)
        for required in expected["reasons"]:
            assert required in reasons

    if "paths" in expected:
        paths = set()
        for field in report.candidates[0].fields if report.candidates else []:
            for detail in field.details or [field]:
                if detail.path:
                    paths.add(detail.path)
        for required in expected["paths"]:
            assert required in paths

    if "suggestions" in expected:
        wanted = expected["suggestions"]
        if not wanted:
            assert report.suggestions == []
        else:
            for index, want in enumerate(wanted):
                suggestion = report.suggestions[index]
                assert suggestion.target == want["target"]
                assert suggestion.value == want["value"]
                assert suggestion.verified is True

    # Section 13.4 is a hard guarantee, so check it on every explain case rather
    # than only where a case happens to assert it: applying any emitted
    # suggestion must actually make the request match.
    for suggestion in report.suggestions:
        assert suggestion.verified is True
        index = int(suggestion.target.split("[", 1)[1].split("]", 1)[0])
        interaction = fixture["interactions"][index]
        patched = _apply_suggestion(interaction.get("match") or {}, suggestion.target, suggestion.value)
        config = resolve_match_config((fixture.get("defaults") or {}).get("match"), patched)
        assert is_match(
            match_request(
                normalize_request(interaction["request"]), normalize_request(case["live"]), config
            )
        ), f"suggestion {suggestion.target} did not actually fix the match"


def _apply_suggestion(base: Dict[str, Any], target: str, value: Any) -> Dict[str, Any]:
    """Apply a dotted suggestion target onto a match config, for verification."""
    import copy

    path = target.split(".match", 1)[1].lstrip(".")
    out = copy.deepcopy(base)
    parts = path.split(".") if path else []
    node: Any = out
    for key in parts[:-1]:
        if not isinstance(node.get(key), dict):
            node[key] = {}
        node = node[key]
    if parts:
        node[parts[-1]] = value
    return out


@pytest.mark.parametrize("entry", cases("redact"), ids=ids(cases("redact")))
def test_redact(entry: Dict[str, Any]) -> None:
    case = load(entry)
    fixture, _ = parse_fixture(json.dumps(case["fixture"]))
    config = _redaction_config(case.get("config") or {})
    result = redact_fixture(fixture, config)
    expected = case["expected"]
    first = result.fixture["interactions"][0]

    if "rules" in expected:
        assert result.rules == expected["rules"]
    if "requestHeaders" in expected:
        assert first["request"]["headers"] == expected["requestHeaders"]
    if "responseHeaders" in expected:
        assert first["response"]["headers"] == expected["responseHeaders"]
    if "requestBodyJson" in expected:
        assert first["request"]["body"]["json"] == expected["requestBodyJson"]
    if "responseBodyJson" in expected:
        assert first["response"]["body"]["json"] == expected["responseBodyJson"]
    if "requestBodyRedactedFlag" in expected:
        assert first["request"]["body"].get("redacted") is expected["requestBodyRedactedFlag"]
    if "metaApplied" in expected:
        assert result.fixture["meta"]["redaction"]["applied"] is expected["metaApplied"]
    if "requestUrlContains" in expected:
        for fragment in expected["requestUrlContains"]:
            assert fragment in first["request"]["url"]


def _redaction_config(raw: Dict[str, Any]) -> RedactionConfig:
    return RedactionConfig(
        headers=raw.get("headers", ()),
        query_params=raw.get("queryParams", ()),
        json_fields=raw.get("jsonFields", ()),
        json_paths=raw.get("jsonPaths", ()),
        patterns=raw.get("patterns", ()),
    )


@pytest.mark.parametrize("entry", cases("entropy"), ids=ids(cases("entropy")))
def test_entropy(entry: Dict[str, Any]) -> None:
    case = load(entry)
    raw = case["config"]
    config = EntropyConfig(
        min_length=raw["minLength"], max_length=raw["maxLength"], min_bits=raw["minBits"]
    )
    assert entropy_tokens(case["subject"], config) == case["expected"]["tokens"]


@pytest.mark.parametrize("entry", cases("structural"), ids=ids(cases("structural")))
def test_structural(entry: Dict[str, Any]) -> None:
    case = load(entry)
    with pytest.raises(HifStructuralError) as excinfo:
        parse_fixture(json.dumps(case["document"]))
    contains = case["expected"].get("errorContains")
    if contains:
        assert contains in str(excinfo.value)


@pytest.mark.parametrize("entry", cases("version"), ids=ids(cases("version")))
def test_version(entry: Dict[str, Any]) -> None:
    case = load(entry)
    expected = case["expected"]
    if not expected["accepted"]:
        with pytest.raises(HifStructuralError):
            parse_fixture(json.dumps(case["document"]))
        return
    _, warnings = parse_fixture(json.dumps(case["document"]))
    assert bool(warnings) is expected["warns"]
