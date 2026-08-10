"""HAR import tests.

HAR conversion is Appendix B of the specification, which is informative rather
than normative, so it is not part of the conformance suite. It is still
compared between implementations by ``conformance/cross-check.sh``.
"""

from __future__ import annotations

import pathlib

import pytest

from spool.errors import HifStructuralError
from spool.fixture import validate_fixture
from spool.har import HarImportOptions, import_har, import_har_text

SAMPLE = (
    pathlib.Path(__file__).resolve().parents[3] / "conformance" / "fixtures" / "sample.har"
).read_text(encoding="utf-8")


def test_produces_a_fixture_that_passes_validation() -> None:
    result = import_har_text(SAMPLE)
    validate_fixture(result.fixture)
    assert result.fixture["hif"] == "1.0"


def test_converts_request_and_response_faithfully() -> None:
    first = import_har_text(SAMPLE).fixture["interactions"][0]

    assert first["request"]["method"] == "GET"
    assert first["request"]["url"] == "https://api.example.com/v1/users/7?_=1723280000"
    assert first["response"]["status"] == 200
    assert first["response"]["body"] == {
        "encoding": "json",
        "json": {"id": 7, "name": "Ada"},
        "contentType": "application/json",
    }


def test_collapses_har_timings_into_latency_ms() -> None:
    assert import_har_text(SAMPLE).fixture["interactions"][0]["timing"] == {"latencyMs": 188}


def test_drops_http2_pseudo_headers() -> None:
    headers = import_har_text(SAMPLE).fixture["interactions"][0]["request"]["headers"]
    names = [h[0] for h in headers]
    assert ":method" not in names
    assert "accept" in names


def test_flattens_cookie_objects_into_a_cookie_header() -> None:
    headers = import_har_text(SAMPLE).fixture["interactions"][0]["request"]["headers"]
    cookie = next(h for h in headers if h[0] == "cookie")
    assert cookie[1] == "session=abc123def456"


def test_drops_content_encoding_because_the_stored_body_is_decoded() -> None:
    headers = import_har_text(SAMPLE).fixture["interactions"][0]["response"]["headers"]
    names = [h[0] for h in headers]
    assert "content-encoding" not in names
    assert "content-type" in names


def test_reassembles_postdata_params_into_a_form_body() -> None:
    body = import_har_text(SAMPLE).fixture["interactions"][1]["request"]["body"]
    assert body["encoding"] == "text"
    assert body["text"] == "name=Grace&password=hunter2"


def test_skips_cache_hits_non_http_schemes_and_aborted_requests() -> None:
    skipped = {s["url"]: s["reason"] for s in import_har_text(SAMPLE).skipped}

    assert "browser cache" in skipped["https://api.example.com/v1/cached"]
    assert "out of scope" in skipped["wss://api.example.com/socket"]
    assert "status is 0" in skipped["https://api.example.com/v1/aborted"]


def test_always_reports_no_matching_rules_and_no_redaction() -> None:
    notes = import_har_text(SAMPLE).notes
    assert any("no matching rules" in note for note in notes)
    assert any("HAR performs no redaction" in note for note in notes)


def test_does_not_redact_by_itself() -> None:
    """Redaction is the caller's explicit decision; the CLI makes it by default."""
    result = import_har_text(SAMPLE)
    headers = result.fixture["interactions"][0]["request"]["headers"]
    auth = next(h for h in headers if h[0] == "authorization")
    assert "Bearer" in auth[1]
    assert result.fixture["meta"]["redaction"]["applied"] is False


def test_rejects_a_document_that_is_not_a_har() -> None:
    with pytest.raises(HifStructuralError):
        import_har({})
    with pytest.raises(HifStructuralError):
        import_har({"log": {}})
    with pytest.raises(HifStructuralError):
        import_har_text("not json")


def test_honours_the_filter_option() -> None:
    result = import_har_text(SAMPLE, HarImportOptions(filter="/v1/users/7"))
    assert len(result.fixture["interactions"]) == 1
