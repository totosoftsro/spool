"""The ``spool`` command line.

The command set is shared across implementations: ``spool lint`` here behaves
identically to ``spool lint`` in TypeScript, and the conformance suite checks
it. Adding a command to one implementation without the other is a divergence.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from . import __version__
from .body import body_bytes
from .digest import digest_request
from .errors import HifStructuralError
from .fixture import SUPPORTED_VERSION, load_fixture, serialize_fixture
from .player import Player
from .redact import redact_fixture, scan_fixture
from .render import render_mismatch

USAGE = f"""spool {__version__} — portable HTTP fixtures (HIF {SUPPORTED_VERSION})

Usage:
  spool lint <fixture...>            Validate fixtures and report warnings
  spool inspect <fixture>            Summarise a fixture's interactions
  spool digest <fixture>             Print the hif-digest-1 of each request
  spool scan <fixture...>            Report suspected secrets, without changing anything
  spool redact <fixture> [-o out]    Apply redaction rules to an existing fixture
  spool explain <fixture> <request>  Explain why a request does not match
  spool diff <a> <b>                 Compare two fixtures interaction by interaction

Options:
  -o, --output <path>   Write output to a file instead of stdout
      --json            Machine-readable output where supported
      --all             Show every candidate in explain output
      --color           Force ANSI colour
  -h, --help            Show this help
  -v, --version         Show the version

The <request> argument to "explain" is a JSON file or inline JSON of the form:
  {{ "method": "POST", "url": "https://api.example.com/v1/users",
    "headers": [["content-type","application/json"]],
    "body": {{ "encoding": "json", "json": {{ "name": "Ada" }} }} }}

Exit codes:
  0  success
  1  a fixture is invalid, a request does not match, or a diff found changes
  2  usage error
"""


@dataclass
class Options:
    output: Optional[str] = None
    json_output: bool = False
    all_candidates: bool = False
    color: bool = False


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    options = Options()
    positional: List[str] = []

    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("-h", "--help"):
            sys.stdout.write(USAGE)
            return 0
        if arg in ("-v", "--version"):
            sys.stdout.write(__version__ + "\n")
            return 0
        if arg in ("-o", "--output"):
            index += 1
            options.output = args[index] if index < len(args) else None
        elif arg == "--json":
            options.json_output = True
        elif arg == "--all":
            options.all_candidates = True
        elif arg == "--color":
            options.color = True
        elif arg.startswith("-"):
            sys.stderr.write(f"Unknown option {arg}\n\n{USAGE}")
            return 2
        else:
            positional.append(arg)
        index += 1

    if not positional:
        sys.stdout.write(USAGE)
        return 2

    command, rest = positional[0], positional[1:]
    handlers = {
        "lint": cmd_lint,
        "inspect": cmd_inspect,
        "digest": cmd_digest,
        "scan": cmd_scan,
        "redact": cmd_redact,
        "explain": cmd_explain,
        "diff": cmd_diff,
    }
    handler = handlers.get(command)
    if handler is None:
        sys.stderr.write(f'Unknown command "{command}"\n\n{USAGE}')
        return 2

    try:
        return handler(rest, options)
    except HifStructuralError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    except FileNotFoundError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1


def _emit(text: str, options: Options) -> None:
    if options.output:
        with open(options.output, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)


def _usage_error(message: str) -> int:
    sys.stderr.write(f"error: {message}\n\n{USAGE}")
    return 2


def cmd_lint(paths: List[str], options: Options) -> int:
    if not paths:
        return _usage_error("lint requires at least one fixture path")

    failed = False
    report: List[Dict[str, Any]] = []
    for path in paths:
        try:
            _, warnings = load_fixture(path)
            report.append({"file": path, "ok": True, "warnings": warnings})
        except (HifStructuralError, OSError) as exc:
            failed = True
            report.append({"file": path, "ok": False, "error": str(exc), "warnings": []})

    if options.json_output:
        _emit(json.dumps(report, indent=2) + "\n", options)
        return 1 if failed else 0

    for entry in report:
        if not entry["ok"]:
            sys.stderr.write(f"✗ {entry['file']}\n  {entry['error']}\n")
            continue
        warnings = entry["warnings"]
        if warnings:
            sys.stdout.write(f"✓ {entry['file']} ({len(warnings)} warning(s))\n")
            for warning in warnings:
                sys.stdout.write(f"  ! {warning}\n")
        else:
            sys.stdout.write(f"✓ {entry['file']}\n")
    return 1 if failed else 0


def cmd_inspect(paths: List[str], options: Options) -> int:
    if not paths:
        return _usage_error("inspect requires a fixture path")
    path = paths[0]
    fixture, _ = load_fixture(path)

    if options.json_output:
        _emit(json.dumps(fixture, indent=2) + "\n", options)
        return 0

    meta = fixture.get("meta") or {}
    lines = [path, f"  HIF {fixture['hif']}, {len(fixture.get('interactions', []))} interaction(s)"]
    if meta.get("name"):
        lines.append(f"  name: {meta['name']}")
    recorder = meta.get("recorder") or {}
    if recorder:
        lines.append(f"  recorder: {recorder.get('name', '?')} {recorder.get('version', '')}".rstrip())
    redaction = meta.get("redaction") or {}
    if redaction.get("applied"):
        lines.append(f"  redaction: applied ({', '.join(redaction.get('rules', []))})")
    else:
        lines.append("  redaction: not recorded as applied")
    lines.append("")

    for index, interaction in enumerate(fixture.get("interactions", [])):
        ref = interaction.get("id") or f"[{index}]"
        times = (interaction.get("replay") or {}).get("times", 1)
        fault = interaction.get("fault")
        response = interaction.get("response") or {}
        outcome = f"fault:{fault['type']}" if fault else str(response.get("status", "?"))
        size = len(body_bytes(response["body"])) if response.get("body") else 0
        lines.append(f"  {ref}")
        lines.append(f"    {interaction['request']['method']} {interaction['request']['url']}")
        suffix = f", {size} byte body" if size else ""
        plays = "" if times == 1 else f", plays {times}"
        lines.append(f"    -> {outcome}{suffix}{plays}")

    _emit("\n".join(lines) + "\n", options)
    return 0


def cmd_digest(paths: List[str], options: Options) -> int:
    if not paths:
        return _usage_error("digest requires a fixture path")
    fixture, _ = load_fixture(paths[0])
    rows = [
        {
            "ref": interaction.get("id") or f"interactions[{index}]",
            "digest": digest_request(interaction["request"]),
        }
        for index, interaction in enumerate(fixture.get("interactions", []))
    ]
    if options.json_output:
        _emit(json.dumps(rows, indent=2) + "\n", options)
    else:
        _emit("\n".join(f"{row['digest']}  {row['ref']}" for row in rows) + "\n", options)
    return 0


def cmd_scan(paths: List[str], options: Options) -> int:
    if not paths:
        return _usage_error("scan requires at least one fixture path")

    all_findings: List[Dict[str, str]] = []
    for path in paths:
        fixture, _ = load_fixture(path)
        for finding in scan_fixture(fixture):
            all_findings.append(
                {"file": path, "location": finding.location, "rule": finding.rule, "note": finding.note}
            )


    if options.json_output:
        _emit(json.dumps(all_findings, indent=2) + "\n", options)
    elif not all_findings:
        sys.stdout.write(
            "No rule matched.\n\n"
            "This is not a guarantee. Rule- and entropy-based detection have false\n"
            "negatives; review the fixture before publishing it.\n"
        )
    else:
        sys.stdout.write(f"{len(all_findings)} suspected secret(s):\n\n")
        for row in all_findings:
            sys.stdout.write(
                f"  {row['file']}\n    {row['location']}\n"
                f"    [{row['rule']}] {row['note']}\n\n"
            )
        sys.stdout.write("These are suspicions, not confirmations. Review each one.\n")

    # Findings are informational: `scan` reports, it does not fail a build. Use
    # it with --json and your own policy if you want a gate.
    return 0


def cmd_redact(paths: List[str], options: Options) -> int:
    if not paths:
        return _usage_error("redact requires a fixture path")
    path = paths[0]
    fixture, _ = load_fixture(path)
    result = redact_fixture(fixture)

    _emit(serialize_fixture(result.fixture), options)

    target = options.output or "<stdout>"
    if not result.rules:
        sys.stderr.write(
            f"No redaction rule matched {path}. This does not mean it is free of secrets.\n"
        )
    else:
        sys.stderr.write(
            f"Redacted {path} -> {target} ({', '.join(result.rules)}). "
            "Detection has false negatives; review the result before committing.\n"
        )
    return 0


def cmd_explain(paths: List[str], options: Options) -> int:
    if len(paths) < 2:
        return _usage_error("explain requires a fixture path and a request")
    fixture, _ = load_fixture(paths[0])
    request = _read_request(paths[1])

    player = Player(fixture, explain_all=options.all_candidates, color=options.color)
    if player.would_match(request):
        sys.stdout.write("The request matches.\n")
        return 0

    report = player.explain_request(request)
    if options.json_output:
        _emit(json.dumps(_report_to_json(report), indent=2) + "\n", options)
    else:
        _emit(
            render_mismatch(report, all_candidates=options.all_candidates, color=options.color), options
        )
    return 1


def _read_request(argument: str) -> Dict[str, Any]:
    if argument.lstrip().startswith("{"):
        text = argument
    else:
        with open(argument, encoding="utf-8") as handle:
            text = handle.read()
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise HifStructuralError(f"Request argument is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get("method"), str) or not isinstance(
        parsed.get("url"), str
    ):
        raise HifStructuralError('Request must have string "method" and "url" members')
    return parsed


def _report_to_json(report: Any) -> Dict[str, Any]:
    return {
        "request": {
            "method": report.request.method,
            "url": report.request.url,
        },
        "empty": report.empty,
        "candidates": [
            {
                "ref": candidate.ref,
                "index": candidate.index,
                "score": candidate.score,
                "total": candidate.total,
                "depleted": candidate.depleted,
                "fields": [
                    {
                        "field": field.field,
                        "ok": field.ok,
                        "reason": field.reason,
                        "path": field.path,
                    }
                    for field in candidate.fields
                ],
            }
            for candidate in report.candidates
        ],
        "suggestions": [
            {
                "kind": suggestion.kind,
                "target": suggestion.target,
                "value": suggestion.value,
                "description": suggestion.description,
                "verified": suggestion.verified,
            }
            for suggestion in report.suggestions
        ],
    }


def cmd_diff(paths: List[str], options: Options) -> int:
    if len(paths) < 2:
        return _usage_error("diff requires two fixture paths")
    a_path, b_path = paths[0], paths[1]
    a, _ = load_fixture(a_path)
    b, _ = load_fixture(b_path)

    a_items = a.get("interactions", [])
    b_items = b.get("interactions", [])
    a_digests = [digest_request(i["request"]) for i in a_items]
    b_digests = [digest_request(i["request"]) for i in b_items]

    changes: List[str] = []
    for index in range(max(len(a_digests), len(b_digests))):
        if index >= len(a_digests):
            request = b_items[index]["request"]
            changes.append(f"+ [{index}] only in {b_path}: {request['method']} {request['url']}")
        elif index >= len(b_digests):
            request = a_items[index]["request"]
            changes.append(f"- [{index}] only in {a_path}: {request['method']} {request['url']}")
        elif a_digests[index] != b_digests[index]:
            changes.append(f"~ [{index}] request differs")
            a_request = a_items[index]["request"]
            b_request = b_items[index]["request"]
            changes.append(f"    {a_path}: {a_request['method']} {a_request['url']}")
            changes.append(f"    {b_path}: {b_request['method']} {b_request['url']}")
        else:
            sa = json.dumps(a_items[index].get("response") or a_items[index].get("fault"), sort_keys=True)
            sb = json.dumps(b_items[index].get("response") or b_items[index].get("fault"), sort_keys=True)
            if sa != sb:
                changes.append(f"~ [{index}] response differs for {a_items[index]['request']['url']}")

    if options.json_output:
        _emit(json.dumps({"changes": changes}, indent=2) + "\n", options)
    elif not changes:
        sys.stdout.write("Fixtures are equivalent.\n")
    else:
        sys.stdout.write("\n".join(changes) + "\n")
    return 0 if not changes else 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
