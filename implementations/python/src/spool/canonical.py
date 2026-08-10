"""RFC 8785 (JSON Canonicalization Scheme), per specification section 12.

Python is the hard case. RFC 8785 defines number serialization as ECMAScript
``Number::toString``, and Python's ``repr`` disagrees with it in several places
that matter:

===================  ==================  ====================
value                Python ``repr``     ECMAScript
===================  ==================  ====================
100.0                ``100.0``           ``100``
1e-7                 ``1e-07``           ``1e-7``
1e21                 ``1e+21``           ``1e+21``
1e20                 ``1e+20``           ``100000000000000000000``
===================  ==================  ====================

So ``es_number_to_string`` implements the ECMAScript algorithm directly, using
Python's shortest-round-trip ``repr`` only as the source of the significant
digits. The conformance suite pins every one of the cases above.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Dict, Generator, List, NamedTuple, Tuple


def es_number_to_string(value: float) -> str:
    """Serialize a float exactly as ECMAScript ``Number::toString`` would.

    Implements ECMA-262 "Number::toString ( x, 10 )". The variable names below
    are the spec's: the value is ``s * 10**(n - k)`` where ``s`` has ``k``
    digits and is not divisible by 10.
    """
    if isinstance(value, bool):  # bool is a subclass of int; catch it early
        raise TypeError("Booleans are not JSON numbers")
    if isinstance(value, int):
        # Python ints are arbitrary precision, but JSON numbers are doubles.
        # Converting here keeps behaviour identical to a JSON round trip.
        value = float(value)
    if math.isnan(value) or math.isinf(value):
        raise TypeError(f"{value!r} is not a valid JSON number")
    if value == 0:
        return "0"  # covers -0.0, which RFC 8785 serializes as 0
    if value < 0:
        return "-" + es_number_to_string(-value)

    digits, n = _significant_digits(value)
    k = len(digits)

    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    exponent = n - 1
    sign = "+" if exponent >= 0 else "-"
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{mantissa}e{sign}{abs(exponent)}"


def _significant_digits(value: float) -> Tuple[str, int]:
    """Return ``(digits, n)`` such that the value is ``0.digits * 10**n``.

    ``digits`` carries no leading or trailing zeros. Python's ``repr`` gives the
    shortest string that round-trips, which is exactly the ``k`` minimality that
    ECMAScript requires; only the *formatting* differs, and that is what the
    caller fixes up.
    """
    text = repr(value)
    if "e" in text or "E" in text:
        mantissa, _, exponent_text = text.partition("e")
        if not exponent_text:
            mantissa, _, exponent_text = text.partition("E")
        exponent = int(exponent_text)
    else:
        mantissa, exponent = text, 0

    integer_part, _, fraction = mantissa.partition(".")
    raw = integer_part + fraction
    stripped = raw.lstrip("0")
    leading_zeros = len(raw) - len(stripped)
    n = len(integer_part) + exponent - leading_zeros
    digits = stripped.rstrip("0") or "0"
    return digits, n


# ECMAScript QuoteJSONString: short escapes where JSON defines them, \u00xx with
# lowercase hex for the remaining C0 controls, everything else literal.
_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def es_quote_string(value: str) -> str:
    """Serialize a string per RFC 8785 section 3.2.2.2."""
    out = ['"']
    for ch in value:
        escape = _SHORT_ESCAPES.get(ch)
        if escape is not None:
            out.append(escape)
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonicalize(value: Any) -> str:
    """Serialize a JSON value to its RFC 8785 canonical form."""
    out: List[str] = []
    _write(value, out, "")
    return "".join(out)


def _write(value: Any, out: List[str], path: str) -> None:
    if value is None:
        out.append("null")
    elif isinstance(value, bool):
        out.append("true" if value else "false")
    elif isinstance(value, (int, float)):
        out.append(es_number_to_string(value))
    elif isinstance(value, str):
        out.append(es_quote_string(value))
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _write(item, out, f"{path}/{index}")
        out.append("]")
    elif isinstance(value, dict):
        out.append("{")
        # Section 12.1: sort by the UTF-16 code unit sequence of the member name.
        for index, key in enumerate(sorted(value.keys(), key=_utf16_sort_key)):
            if not isinstance(key, str):
                raise TypeError(f"Non-string member name at {path or '/'}: {key!r}")
            if index:
                out.append(",")
            out.append(es_quote_string(key))
            out.append(":")
            _write(value[key], out, f"{path}/{key}")
        out.append("}")
    else:
        raise TypeError(f"Value of type {type(value).__name__} at {path or '/'} is not JSON")


def _utf16_sort_key(name: str) -> Tuple[int, ...]:
    """UTF-16 code unit ordering.

    Python compares strings by code point, which differs from UTF-16 code unit
    order for astral characters: U+FFFD sorts *after* U+10000 by code point but
    *before* it by code unit, because U+10000 becomes the surrogate pair
    D800 DC00. Encoding to UTF-16 makes the comparison match RFC 8785 and
    JavaScript's default string sort.
    """
    encoded = name.encode("utf-16-be", errors="surrogatepass")
    return tuple(int.from_bytes(encoded[i : i + 2], "big") for i in range(0, len(encoded), 2))


def canonical_equal(a: Any, b: Any) -> bool:
    """Structural equality under canonical form."""
    return canonicalize(a) == canonicalize(b)


class LossyNumber(NamedTuple):
    literal: str
    canonical: str

    def as_dict(self) -> Dict[str, str]:
        return {"literal": self.literal, "canonical": self.canonical}


_NUMBER_LITERAL = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_EXACT_DECIMAL = re.compile(r"^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$")


def find_lossy_numbers(raw_json: str) -> List[LossyNumber]:
    """Section 12.3 round-trip loss detection.

    Finds numeric literals whose exact decimal value changes when parsed as an
    IEEE 754 double — the case that silently corrupts 64-bit integer ids. Scans
    the raw text because the parsed value has already lost the information.
    """
    found: List[LossyNumber] = []
    seen = set()
    for segment in _outside_strings(raw_json):
        for match in _NUMBER_LITERAL.finditer(segment):
            literal = match.group(0)
            if literal in seen:
                continue
            seen.add(literal)
            canonical = es_number_to_string(float(literal))
            if _exact_decimal(literal) != _exact_decimal(canonical):
                found.append(LossyNumber(literal, canonical))
    return found


def _exact_decimal(literal: str) -> str:
    """The exact mathematical value of a decimal literal, as a comparable key.

    ``1``, ``1.0``, ``1e0`` and ``100e-2`` all reduce to the same key, so a
    literal that merely *looks* different from its canonical form is not
    reported as lossy.
    """
    match = _EXACT_DECIMAL.match(literal)
    if not match:
        return literal
    sign = "-" if match.group(1) == "-" else ""
    integer_part = match.group(2)
    fraction = match.group(3) or ""
    exponent = int(match.group(4)) if match.group(4) else 0

    digits = integer_part + fraction
    scale = exponent - len(fraction)
    stripped = digits.lstrip("0")
    if not stripped:
        return "0"
    digits = stripped
    trimmed = digits.rstrip("0")
    scale += len(digits) - len(trimmed)
    return f"{sign}{trimmed}e{scale}"


def _outside_strings(text: str) -> Generator[str, None, None]:
    """Yield the parts of a JSON document that lie outside string literals."""
    i = 0
    start = 0
    length = len(text)
    while i < length:
        if text[i] == '"':
            yield text[start:i]
            i += 1
            while i < length and text[i] != '"':
                if text[i] == "\\":
                    i += 1
                i += 1
            i += 1
            start = i
        else:
            i += 1
    yield text[start:]


def parse_json(text: str) -> Any:
    """``json.loads`` with the duplicate-member check RFC 8785 assumes."""
    return json.loads(text)
