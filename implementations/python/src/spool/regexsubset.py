"""The portable regex subset of specification section 7.6.2.

Two problems are solved here, both about cross-language agreement:

1. **Rejection.** Constructs whose behaviour differs between engines, or that
   enable catastrophic backtracking, are rejected outright rather than handed to
   the host engine. A pattern that runs must mean the same thing everywhere.

2. **Translation.** ``\\d``, ``\\w``, ``\\s`` and ``.`` are ASCII-defined by the
   spec. Python's ``re`` matches Unicode digits and word characters by default,
   so each shorthand is rewritten to an explicit class. ``re.ASCII`` would fix
   the shorthands but not ``.``, and relying on a flag makes the behaviour
   invisible at the call site.

Validation and translation happen in one left-to-right pass. Doing them
separately with a pre-scan is wrong: a pre-scan cannot tell ``a??`` (lazy,
excluded) from ``\\??`` (an optional literal question mark, allowed).
"""

from __future__ import annotations

import re
from typing import List

from ._text import q
from .errors import HifStructuralError

_CLASS_D = "0-9"
_CLASS_W = "A-Za-z0-9_"
_CLASS_S = r" \t\n\r\f\v"

_ESCAPABLE = set("\\.^$|?*+()[]{}/-") | set("tnrfv")

#: Longest subject a compiled pattern will be run against (section 7.6.2).
#:
#: A secondary measure only. Bounding length does not prevent exponential
#: backtracking — ``(a+)+b`` against 40 characters already runs indefinitely —
#: which is why the structural rule forbidding a quantifier on a group is the
#: real protection. Header values and JSON strings do not legitimately reach
#: this size.
MAX_SUBJECT = 8192

_COUNTED = re.compile(r"^\d+(,\d*)?$")


class CompiledPattern:
    __slots__ = ("source", "_compiled")

    def __init__(self, source: str, compiled: re.Pattern[str]) -> None:
        self.source = source
        self._compiled = compiled

    def test(self, subject: str) -> bool:
        if len(subject) > MAX_SUBJECT:
            raise HifStructuralError(
                f"Regex subject of {len(subject)} characters exceeds the "
                f"{MAX_SUBJECT}-character bound of spec §7.6.2"
            )
        return self._compiled.match(subject) is not None


def compile_portable_regex(pattern: str) -> CompiledPattern:
    """Validate a pattern against the subset and compile it, anchored."""
    translated = _translate(pattern)
    try:
        compiled = re.compile(f"(?:{translated})\\Z")
    except re.error as exc:
        raise HifStructuralError(f"Regex {q(pattern)} is not valid: {exc}") from exc
    return CompiledPattern(pattern, compiled)


def _reject(pattern: str, why: str) -> None:
    raise HifStructuralError(
        f"Regex {q(pattern)} uses {why}, which the HIF regex subset (spec §7.6.2) excludes"
    )


def _reject_quantified_group(pattern: str, quantifier: str) -> None:
    raise HifStructuralError(
        f"Regex {q(pattern)} applies the quantifier {q(quantifier)} to a group, which the HIF "
        "regex subset (spec §7.6.2) excludes. A quantified group is what makes backtracking "
        'exponential: "(a+)+b" never finishes against a run of "a" characters. Rewrite without '
        "the group, or match this value with a placeholder other than {{regex:...}}."
    )


def _translate(pattern: str) -> str:  # noqa: C901 - a single flat scanner reads better than a split one
    out: List[str] = []
    in_class = False
    quantifiable = False
    group_depth = 0
    # True when the last thing emitted was a closing ")". Section 7.6.2 forbids a
    # quantifier on a group, because a quantified group whose body is ambiguous
    # is what makes backtracking exponential.
    after_group = False

    i = 0
    length = len(pattern)
    while i < length:
        ch = pattern[i]

        # ---- escape sequences -------------------------------------------
        if ch == "\\":
            if i + 1 >= length:
                raise HifStructuralError(f"Regex {q(pattern)} ends with a trailing backslash")
            nxt = pattern[i + 1]
            i += 2

            if nxt.isdigit() and nxt != "0":
                _reject(pattern, "backreferences")
            if nxt in ("b", "B"):
                _reject(pattern, "word boundaries")
            if nxt in ("p", "P"):
                _reject(pattern, "Unicode property escapes")
            if nxt == "k":
                _reject(pattern, "named backreferences")
            if nxt in ("A", "Z", "z", "G"):
                _reject(pattern, "anchors outside ^ and $")

            after_group = False
            if in_class:
                if nxt == "d":
                    out.append(_CLASS_D)
                elif nxt == "w":
                    out.append(_CLASS_W)
                elif nxt == "s":
                    out.append(_CLASS_S)
                elif nxt in ("D", "W", "S"):
                    _reject(pattern, f"\\{nxt} inside a character class, whose expansion is ambiguous")
                elif nxt in _ESCAPABLE:
                    out.append("\\" + nxt)
                else:
                    _reject(pattern, f"the escape \\{nxt}")
                continue

            if nxt == "d":
                out.append(f"[{_CLASS_D}]")
            elif nxt == "D":
                out.append(f"[^{_CLASS_D}]")
            elif nxt == "w":
                out.append(f"[{_CLASS_W}]")
            elif nxt == "W":
                out.append(f"[^{_CLASS_W}]")
            elif nxt == "s":
                out.append(f"[{_CLASS_S}]")
            elif nxt == "S":
                out.append(f"[^{_CLASS_S}]")
            elif nxt in _ESCAPABLE:
                out.append("\\" + nxt)
            else:
                _reject(pattern, f"the escape \\{nxt}")
            quantifiable = True
            continue

        # ---- inside a character class ------------------------------------
        if in_class:
            out.append(ch)
            if ch == "]":
                in_class = False
                quantifiable = True
                after_group = False
            i += 1
            continue

        # ---- structure -----------------------------------------------------
        if ch == "[":
            in_class = True
            after_group = False
            out.append(ch)
            i += 1
            # A `^` or `]` immediately after `[` is literal.
            if i < length and pattern[i] == "^":
                out.append("^")
                i += 1
            if i < length and pattern[i] == "]":
                out.append("\\]")
                i += 1
            quantifiable = False
            continue

        if ch == "(":
            if i + 1 < length and pattern[i + 1] == "?":
                _reject(
                    pattern,
                    "groups other than plain ( ) — non-capturing, named, lookaround and inline-flag groups",
                )
            group_depth += 1
            out.append("(")
            quantifiable = False
            after_group = False
            i += 1
            continue

        if ch == ")":
            if group_depth == 0:
                raise HifStructuralError(f'Regex {q(pattern)} has an unmatched ")"')
            group_depth -= 1
            out.append(")")
            quantifiable = True
            after_group = True
            i += 1
            continue

        if ch in "*+?":
            if not quantifiable:
                raise HifStructuralError(f'Regex {q(pattern)} has a quantifier "{ch}" with nothing to repeat')
            if after_group:
                _reject_quantified_group(pattern, ch)
            out.append(ch)
            i += 1
            if i < length and pattern[i] == "?":
                _reject(pattern, "lazy quantifiers")
            if i < length and pattern[i] == "+":
                _reject(pattern, "possessive quantifiers")
            quantifiable = False
            continue

        if ch == "{":
            close = pattern.find("}", i)
            if close == -1:
                raise HifStructuralError(
                    f'Regex {q(pattern)} has an unterminated "{{"; write "\\{{" for a literal brace'
                )
            inner = pattern[i + 1 : close]
            if not _COUNTED.match(inner):
                raise HifStructuralError(
                    f'Regex {q(pattern)} has an invalid counted quantifier "{{{inner}}}"; '
                    'write "\\{" for a literal brace'
                )
            if not quantifiable:
                raise HifStructuralError(
                    f'Regex {q(pattern)} has a quantifier "{{{inner}}}" with nothing to repeat'
                )
            if after_group:
                _reject_quantified_group(pattern, "{" + inner + "}")
            out.append("{" + inner + "}")
            i = close + 1
            if i < length and pattern[i] == "?":
                _reject(pattern, "lazy quantifiers")
            if i < length and pattern[i] == "+":
                _reject(pattern, "possessive quantifiers")
            quantifiable = False
            continue

        if ch in "|^$":
            out.append(ch)
            quantifiable = False
            after_group = False
            i += 1
            continue

        if ch == ".":
            # Section 7.6.2: `.` matches any character except U+000A.
            out.append("[^\\n]")
            quantifiable = True
            after_group = False
            i += 1
            continue

        if ch in "}]":
            raise HifStructuralError(
                f'Regex {q(pattern)} has an unmatched "{ch}"; write "\\{ch}" for a literal'
            )

        out.append(re.escape(ch))
        quantifiable = True
        after_group = False
        i += 1

    if in_class:
        raise HifStructuralError(f"Regex {q(pattern)} has an unterminated character class")
    if group_depth:
        raise HifStructuralError(f'Regex {q(pattern)} has an unclosed "("')
    return "".join(out)
