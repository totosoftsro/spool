"""Spool — record and replay HTTP traffic using the portable HIF fixture format.

The public API is everything exported here. It follows semantic versioning: a
breaking change to any of it requires a major release. Anything not listed in
``__all__`` is internal and may change in a patch.

Quick start::

    import httpx
    from spool.adapters.httpx_adapter import SpoolReplayTransport

    transport = SpoolReplayTransport(open("fixtures/users.hif.json").read())
    client = httpx.Client(transport=transport)

    response = client.get("https://api.example.com/v1/users/7")
    transport.assert_complete()
"""

from __future__ import annotations

from .body import (
    body_bytes,
    body_json,
    body_text,
    encode_body,
    normalize_headers,
    or_empty,
    strip_ows,
    to_entries,
)
from .canonical import canonical_equal, canonicalize, es_number_to_string, find_lossy_numbers
from .digest import digest_preimage, digest_request
from .errors import HifExpectationError, HifFaultError, HifMatchError, HifStructuralError
from .explain import CandidateReport, MismatchReport, Suggestion, explain
from .fixture import (
    SUPPORTED_VERSION,
    LoadResult,
    interaction_ref,
    load_fixture,
    parse_fixture,
    play_limit,
    serialize_fixture,
    validate_fixture,
)
from .har import HarImportOptions, HarImportResult, import_har, import_har_text
from .match import (
    FieldResult,
    NormalizedRequest,
    default_match_config,
    is_match,
    match_request,
    normalize_request,
    resolve_match_config,
)
from .placeholder import (
    Placeholder,
    TextTemplate,
    is_placeholder,
    parse_placeholder,
    parse_text_template,
    satisfies_json,
    satisfies_string,
    string_matches,
    text_matches_template,
)
from .player import DeliverableResponse, Play, Player, Recorder, deliverable, fault_error
from .pointer import PathToken, format_path, omit_paths, parse_path, replace_paths, resolve_path
from .redact import (
    DEFAULT_HEADERS,
    DEFAULT_JSON_FIELDS,
    DEFAULT_QUERY_PARAMS,
    REDACTED,
    EntropyConfig,
    RedactionConfig,
    RedactionResult,
    ScanFinding,
    entropy_tokens,
    redact_fixture,
    redact_request,
    redact_response,
    scan_fixture,
    shannon_entropy,
)
from .regexsubset import CompiledPattern, compile_portable_regex
from .render import render_mismatch, render_request
from .serve import (
    RecordingServer,
    RunningServer,
    infer_origin,
    origins_of,
    proxy_fixture,
    record_serve,
    serve_fixture,
)
from .url import ParsedUrl, QueryParam, decode_query, encode_query, normalize_url, remove_dot_segments

__version__ = "0.1.0"

#: Conformance levels this implementation claims. Asserted by the conformance
#: suite rather than declared here on trust.
CONFORMANCE_LEVELS = ("core", "explain", "redact", "full")

__all__ = [
    "CONFORMANCE_LEVELS",
    "CandidateReport",
    "CompiledPattern",
    "DEFAULT_HEADERS",
    "DEFAULT_JSON_FIELDS",
    "DEFAULT_QUERY_PARAMS",
    "DeliverableResponse",
    "EntropyConfig",
    "FieldResult",
    "HarImportOptions",
    "HarImportResult",
    "HifExpectationError",
    "HifFaultError",
    "HifMatchError",
    "HifStructuralError",
    "LoadResult",
    "MismatchReport",
    "NormalizedRequest",
    "ParsedUrl",
    "PathToken",
    "Placeholder",
    "Play",
    "Player",
    "QueryParam",
    "REDACTED",
    "Recorder",
    "RecordingServer",
    "RedactionConfig",
    "RedactionResult",
    "RunningServer",
    "SUPPORTED_VERSION",
    "ScanFinding",
    "Suggestion",
    "TextTemplate",
    "__version__",
    "body_bytes",
    "body_json",
    "body_text",
    "canonical_equal",
    "canonicalize",
    "compile_portable_regex",
    "decode_query",
    "default_match_config",
    "deliverable",
    "digest_preimage",
    "digest_request",
    "encode_body",
    "encode_query",
    "entropy_tokens",
    "es_number_to_string",
    "explain",
    "fault_error",
    "find_lossy_numbers",
    "format_path",
    "import_har",
    "import_har_text",
    "infer_origin",
    "interaction_ref",
    "is_match",
    "is_placeholder",
    "load_fixture",
    "match_request",
    "normalize_headers",
    "normalize_request",
    "normalize_url",
    "omit_paths",
    "or_empty",
    "origins_of",
    "parse_fixture",
    "parse_path",
    "parse_placeholder",
    "parse_text_template",
    "play_limit",
    "proxy_fixture",
    "record_serve",
    "redact_fixture",
    "redact_request",
    "redact_response",
    "remove_dot_segments",
    "render_mismatch",
    "render_request",
    "replace_paths",
    "resolve_match_config",
    "resolve_path",
    "satisfies_json",
    "satisfies_string",
    "scan_fixture",
    "serialize_fixture",
    "serve_fixture",
    "shannon_entropy",
    "string_matches",
    "strip_ows",
    "text_matches_template",
    "to_entries",
    "validate_fixture",
]
