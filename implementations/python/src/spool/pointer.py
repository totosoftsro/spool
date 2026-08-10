"""JSON paths, per specification section 7.7.

RFC 6901 JSON Pointer, plus ``*`` as a single-token wildcard matching any member
name or array index. A literal ``*`` member name is written ``~2``.
"""

from __future__ import annotations

import copy
from typing import Any, List, NamedTuple, Tuple

from ._text import q
from .errors import HifStructuralError

WILDCARD = object()


class PathToken(NamedTuple):
    kind: str  # "literal" or "wildcard"
    value: str


def parse_path(path: str) -> List[PathToken]:
    if path == "":
        raise HifStructuralError(
            "JSON path must not be empty; the whole-document pointer is not valid here"
        )
    if not path.startswith("/"):
        raise HifStructuralError(f'JSON path must start with "/": {q(path)}')
    tokens: List[PathToken] = []
    for raw in path[1:].split("/"):
        if raw == "*":
            tokens.append(PathToken("wildcard", "*"))
        else:
            tokens.append(PathToken("literal", _unescape_token(raw, path)))
    return tokens


def _unescape_token(token: str, path: str) -> str:
    out: List[str] = []
    i = 0
    while i < len(token):
        ch = token[i]
        if ch != "~":
            out.append(ch)
            i += 1
            continue
        nxt = token[i + 1] if i + 1 < len(token) else ""
        if nxt == "0":
            out.append("~")
        elif nxt == "1":
            out.append("/")
        elif nxt == "2":
            out.append("*")
        else:
            raise HifStructuralError(
                f"Invalid escape ~{nxt} in JSON path {q(path)}; only ~0, ~1 and ~2 are defined"
            )
        i += 2
    return "".join(out)


def resolve_path(value: Any, tokens: List[PathToken]) -> List[List[str]]:
    """Every concrete location a path resolves to, as literal token sequences.

    A wildcard expands to one result per member or index present, so a path that
    matches nothing returns an empty list — which section 7.4.2 requires not to
    be an error.
    """
    frontier: List[Tuple[Any, List[str]]] = [(value, [])]
    for token in tokens:
        nxt: List[Tuple[Any, List[str]]] = []
        for node, path in frontier:
            if isinstance(node, list):
                if token.kind == "wildcard":
                    for index, child in enumerate(node):
                        nxt.append((child, path + [str(index)]))
                elif token.value.isdigit() and int(token.value) < len(node):
                    index = int(token.value)
                    nxt.append((node[index], path + [token.value]))
            elif isinstance(node, dict):
                if token.kind == "wildcard":
                    for key in node:
                        nxt.append((node[key], path + [key]))
                elif token.value in node:
                    nxt.append((node[token.value], path + [token.value]))
        frontier = nxt
    return [path for _, path in frontier]


def omit_paths(value: Any, paths: List[str]) -> Any:
    """A deep copy of ``value`` with every matched location removed.

    Removal rather than replacement: section 7.4.2's ``json.ignore`` must make a
    member invisible to both the missing-member and unexpected-member checks,
    which only removal does.
    """
    if not paths:
        return value
    clone = copy.deepcopy(value)
    locations: List[List[str]] = []
    for path in paths:
        locations.extend(resolve_path(clone, parse_path(path)))
    # Deepest first, then highest index first, so a removal never invalidates a
    # location computed before it.
    locations.sort(key=lambda loc: (-len(loc), -_last_index(loc)))
    for location in locations:
        _remove_at(clone, location)
    return clone


def _last_index(location: List[str]) -> int:
    if not location:
        return 0
    last = location[-1]
    return int(last) if last.isdigit() else 0


def _remove_at(root: Any, location: List[str]) -> None:
    if not location:
        return
    node = root
    for key in location[:-1]:
        if isinstance(node, list):
            node = node[int(key)]
        elif isinstance(node, dict):
            node = node[key]
        else:
            return
    last = location[-1]
    if isinstance(node, list):
        index = int(last)
        if 0 <= index < len(node):
            node.pop(index)
    elif isinstance(node, dict):
        node.pop(last, None)


def replace_paths(value: Any, paths: List[str], replacement: Any) -> Tuple[Any, int]:
    """A deep copy with every matched location replaced. Returns (value, hits)."""
    if not paths:
        return value, 0
    clone = copy.deepcopy(value)
    locations: List[List[str]] = []
    for path in paths:
        locations.extend(resolve_path(clone, parse_path(path)))
    for location in locations:
        _set_at(clone, location, replacement)
    return clone, len(locations)


def _set_at(root: Any, location: List[str], replacement: Any) -> None:
    if not location:
        return
    node = root
    for key in location[:-1]:
        if isinstance(node, list):
            node = node[int(key)]
        elif isinstance(node, dict):
            node = node[key]
        else:
            return
    last = location[-1]
    if isinstance(node, list):
        index = int(last)
        if 0 <= index < len(node):
            node[index] = replacement
    elif isinstance(node, dict):
        node[last] = replacement


def format_path(location: List[str]) -> str:
    """Render a location as a section 7.7 path string, for diagnostics."""
    escaped = [t.replace("~", "~0").replace("/", "~1").replace("*", "~2") for t in location]
    return "/" + "/".join(escaped)
