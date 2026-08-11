#!/usr/bin/env python3
"""Check that every specification section cited anywhere in the repo exists.

Code comments, docs and error messages cite the specification by section number
("§7.4.2", "section 7.4.2", "spec section 9.1"). Those citations are the main
way a reader gets from an implementation detail to the rule it implements, and a
citation pointing at a section that no longer exists is a silent documentation
bug that no test would otherwise catch.

Run from the repository root:

    python3 tests/check_spec_references.py

Exit code 0 if every citation resolves, 1 otherwise.
"""

from __future__ import annotations

import pathlib
import re
import sys
from typing import Dict, List, Set, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = ROOT / "specification" / "hif-1.0.md"

# Directories whose contents are not ours to police.
SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "build",
    ".idea",
    ".vscode",
}

SEARCH_SUFFIXES = {".ts", ".mjs", ".js", ".py", ".md", ".json", ".sh", ".yml", ".yaml"}

# "§7.4.2", "section 7.4.2", "sections 6.4 and 6.4.1", "spec §12.3"
CITATION = re.compile(
    r"(?:§|(?<![A-Za-z])sections?\s+)(\d+(?:\.\d+)*)",
    re.IGNORECASE,
)

# Headings in the spec: "## 7. Matching", "### 7.4.2 `json`"
HEADING = re.compile(r"^#{2,4}\s+(?:Appendix\s+([A-Z])|(\d+(?:\.\d+)*)\.?)\s", re.MULTILINE)


def spec_sections() -> Set[str]:
    text = SPEC.read_text(encoding="utf-8")
    found: Set[str] = set()
    for appendix, number in HEADING.findall(text):
        if number:
            found.add(number)
        elif appendix:
            found.add(f"Appendix {appendix}")
    return found


def repo_files() -> List[pathlib.Path]:
    files: List[pathlib.Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix not in SEARCH_SUFFIXES:
            continue
        files.append(path)
    return sorted(files)


def main() -> int:
    if not SPEC.exists():
        print(f"error: specification not found at {SPEC}", file=sys.stderr)
        return 1

    sections = spec_sections()
    if not sections:
        print("error: no section headings parsed from the specification", file=sys.stderr)
        return 1

    broken: Dict[str, List[Tuple[pathlib.Path, int, str]]] = {}
    citations = 0

    for path in repo_files():
        # The spec cites RFCs by their own section numbers ("RFC 3986 §5.2.4"),
        # which are not HIF sections. Those are excluded by matching only
        # citations not immediately preceded by an RFC reference.
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue

        for lineno, line in enumerate(lines, start=1):
            for match in CITATION.finditer(line):
                before = line[: match.start()]
                # A citation belongs to another document when one is named earlier
                # on the same line and nothing has switched the subject back to
                # this specification. That covers a list of sections after a
                # single reference — "RFC 9110 §6.4.1, §15.4.5" — where an
                # adjacency check on the nearest few characters would only
                # recognise the first.
                other_doc = re.search(r"RFC\s*\d+|ECMA[- ]?\d*|OASIS|WHATWG", before, re.IGNORECASE)
                back_to_hif = re.search(r"\b(spec|specification|HIF)\b", before, re.IGNORECASE)
                if other_doc and not (back_to_hif and back_to_hif.start() > other_doc.start()):
                    continue
                number = match.group(1)
                citations += 1
                if number not in sections:
                    broken.setdefault(number, []).append((path, lineno, line.strip()))

    if not broken:
        print(f"ok: {citations} specification citation(s) across the repository all resolve")
        print(f"    ({len(sections)} sections defined in {SPEC.relative_to(ROOT)})")
        return 0

    print(f"{len(broken)} citation target(s) do not exist in the specification:\n")
    for number in sorted(broken, key=lambda n: [int(p) for p in n.split(".")]):
        print(f"  section {number} is cited but not defined:")
        for path, lineno, line in broken[number][:5]:
            print(f"    {path.relative_to(ROOT)}:{lineno}")
            print(f"      {line[:110]}")
        extra = len(broken[number]) - 5
        if extra > 0:
            print(f"    ... and {extra} more")
        print()

    print("Either the citation is wrong, or a section was renumbered without")
    print("updating the places that point at it.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
