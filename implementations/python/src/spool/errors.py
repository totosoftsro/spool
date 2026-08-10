"""Error types.

Specification section 11.3 keeps structural errors and match failures strictly
apart. Conflating them produces the failure mode HIF exists to fix: a typo in a
fixture surfacing as "request did not match".
"""

from __future__ import annotations

from typing import TYPE_CHECKING, List, Optional

if TYPE_CHECKING:  # pragma: no cover - import cycle only matters to type checkers
    from .explain import MismatchReport


class HifStructuralError(Exception):
    """The document is not a valid fixture. Loading must fail."""

    def __init__(self, message: str, at: Optional[str] = None) -> None:
        super().__init__(f"{message} (at {at})" if at else message)
        self.at = at


class HifMatchError(Exception):
    """The document is valid, but no interaction corresponds to a live request."""

    def __init__(self, message: str, report: MismatchReport) -> None:
        super().__init__(message)
        self.report = report


class HifExpectationError(Exception):
    """An `expect` was not satisfied (section 5.4)."""

    def __init__(self, failures: List[str]) -> None:
        joined = "\n  ".join(failures)
        super().__init__(f"Fixture expectations not met:\n  {joined}")
        self.failures = failures


class HifFaultError(Exception):
    """A simulated transport failure (section 10)."""

    def __init__(self, fault_type: str, code: str, message: str) -> None:
        super().__init__(message)
        self.fault_type = fault_type
        self.code = code
