"""Placeholders, per specification section 7.6.

A placeholder marks a position whose value is not fixed. The rule that makes it
safe is narrow recognition: outside a text-body template, a string is a
placeholder only if the *entire* string is ``{{...}}`` and names a defined
placeholder.
"""

from __future__ import annotations

import re
from typing import Any, List, NamedTuple, Optional

from .regexsubset import compile_portable_regex

_UUID = re.compile(r"\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")
_ISO8601 = re.compile(r"\A\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})\Z")
_JSON_NUMBER = re.compile(r"\A-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?\Z")

_PLACEHOLDER_ANYWHERE = re.compile(r"\{\{(any(?::[a-z0-9]+)?|redacted|regex:(?:[^}]|\}(?!\}))*)\}\}")


class Placeholder(NamedTuple):
    kind: str  # any | type | uuid | iso8601 | regex | redacted
    detail: str = ""


_SIMPLE = {
    "any": Placeholder("any"),
    "redacted": Placeholder("redacted"),
    "any:string": Placeholder("type", "string"),
    "any:number": Placeholder("type", "number"),
    "any:boolean": Placeholder("type", "boolean"),
    "any:array": Placeholder("type", "array"),
    "any:object": Placeholder("type", "object"),
    "any:uuid": Placeholder("uuid"),
    "any:iso8601": Placeholder("iso8601"),
}


def parse_placeholder(text: str) -> Optional[Placeholder]:
    """Recognise a whole-string placeholder, or return None."""
    if not text.startswith("{{") or not text.endswith("}}") or len(text) < 5:
        return None
    inner = text[2:-2]
    if "}}" in inner:
        return None
    simple = _SIMPLE.get(inner)
    if simple is not None:
        return simple
    if inner.startswith("regex:"):
        return Placeholder("regex", inner[len("regex:") :])
    return None


def is_placeholder(text: str) -> bool:
    return parse_placeholder(text) is not None


def unescape_literal(text: str) -> str:
    """Section 7.6.1: ``\\{{...}}`` at position 0 denotes literal ``{{...}}``."""
    return text[1:] if text.startswith("\\{{") else text


def satisfies_json(placeholder: Placeholder, actual: Any) -> bool:
    """Does a JSON value satisfy a placeholder? Used for json body matching."""
    kind = placeholder.kind
    if kind in ("any", "redacted"):
        return True
    if kind == "type":
        wanted = placeholder.detail
        if wanted == "string":
            return isinstance(actual, str)
        if wanted == "number":
            return isinstance(actual, (int, float)) and not isinstance(actual, bool)
        if wanted == "boolean":
            return isinstance(actual, bool)
        if wanted == "array":
            return isinstance(actual, list)
        if wanted == "object":
            return isinstance(actual, dict)
        return False
    if kind == "uuid":
        return isinstance(actual, str) and _UUID.match(actual) is not None
    if kind == "iso8601":
        return isinstance(actual, str) and _ISO8601.match(actual) is not None
    if kind == "regex":
        return isinstance(actual, str) and compile_portable_regex(placeholder.detail).test(actual)
    return False


def satisfies_string(placeholder: Placeholder, actual: str) -> bool:
    """Does a string satisfy a placeholder?

    Used for header values, query values and text bodies. Section 7.6:
    ``{{any}}`` matches any string here, and ``{{any:number}}`` matches a string
    whose content is a JSON number literal.
    """
    kind = placeholder.kind
    if kind in ("any", "redacted"):
        return True
    if kind == "type":
        wanted = placeholder.detail
        if wanted == "string":
            return True
        if wanted == "number":
            return _JSON_NUMBER.match(actual) is not None
        if wanted == "boolean":
            return actual in ("true", "false")
        return False
    if kind == "uuid":
        return _UUID.match(actual) is not None
    if kind == "iso8601":
        return _ISO8601.match(actual) is not None
    if kind == "regex":
        return compile_portable_regex(placeholder.detail).test(actual)
    return False


def string_matches(recorded: str, actual: str) -> bool:
    """Compare a recorded string to a live one, honouring placeholders."""
    placeholder = parse_placeholder(recorded)
    if placeholder is not None:
        return satisfies_string(placeholder, actual)
    return unescape_literal(recorded) == actual


class TextTemplate(NamedTuple):
    segments: List[str]
    placeholders: List[Placeholder]


def parse_text_template(recorded: str) -> TextTemplate:
    """Split a recorded text body into literal segments and placeholders."""
    segments: List[str] = []
    placeholders: List[Placeholder] = []
    last = 0
    for match in _PLACEHOLDER_ANYWHERE.finditer(recorded):
        placeholder = parse_placeholder(match.group(0))
        if placeholder is None:
            continue
        segments.append(recorded[last : match.start()])
        placeholders.append(placeholder)
        last = match.end()
    segments.append(recorded[last:])
    return TextTemplate(segments, placeholders)


def text_matches_template(template: TextTemplate, actual: str) -> bool:
    """Section 7.4.3: anchored at both ends, leftmost-shortest per gap.

    A single left-to-right scan with no backtracking, which is what makes this
    deterministic and linear.
    """
    segments, placeholders = template.segments, template.placeholders
    if not placeholders:
        return segments[0] == actual

    first = segments[0]
    if not actual.startswith(first):
        return False
    cursor = len(first)

    for index, placeholder in enumerate(placeholders):
        next_literal = segments[index + 1]
        is_last = index == len(placeholders) - 1

        if is_last:
            if not actual.endswith(next_literal):
                return False
            gap_end = len(actual) - len(next_literal)
            if gap_end < cursor:
                return False
        elif next_literal == "":
            # Adjacent placeholders: the gap is empty under leftmost-shortest.
            gap_end = cursor
        else:
            found = actual.find(next_literal, cursor)
            if found == -1:
                return False
            gap_end = found

        if not satisfies_string(placeholder, actual[cursor:gap_end]):
            return False
        cursor = gap_end + len(next_literal)

    return cursor == len(actual)
