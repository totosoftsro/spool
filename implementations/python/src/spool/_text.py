"""Formatting helpers for user-facing messages.

These exist for one reason: the TypeScript and Python implementations must
produce byte-identical diagnostics, and Python's ``repr`` does not agree with
JavaScript's ``JSON.stringify``. ``repr("1")`` is ``'1'`` while
``JSON.stringify("1")`` is ``"1"``, and that single character difference turns
up in every error message that quotes a value.

Use :func:`q` anywhere a value is interpolated into text a user will read.
Plain ``{x!r}`` is fine in comments, docstrings and internal debugging.
"""

from __future__ import annotations

import json
from typing import Any


def q(value: Any) -> str:
    """Quote a value the way ``JSON.stringify`` would.

    Falls back to ``repr`` for values JSON cannot represent, which only happens
    for internal types that should never reach a user-facing message anyway.
    """
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return repr(value)
