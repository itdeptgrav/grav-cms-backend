"""Pure controller contract for the bounded dialogue classifier."""

from __future__ import annotations

import re


def route_for_output(raw: str) -> tuple[str, str, float]:
    """Convert a one-code model answer into the controller contract."""
    match = re.fullmatch(r"[\s`'\".]*([ARDWIOPHX])[\s`'\".]*", raw.strip().upper())
    code = match.group(1) if match else "X"
    candidate, act = {
        "A": ("APPROVE", "CONFIRM_APPROVE"),
        "R": ("REJECT", "CONFIRM_REJECT"),
        "D": ("DEFER", "CONFIRM_DEFER"),
        "W": ("UNKNOWN", "WHO_REQUESTED"),
        "I": ("UNKNOWN", "ITEMS"),
        "O": ("UNKNOWN", "OPEN_REQUEST"),
        "P": ("UNKNOWN", "REPEAT"),
        "H": ("UNKNOWN", "ACKNOWLEDGE"),
        "X": ("UNKNOWN", "REFOCUS"),
    }[code]
    return candidate, act, 0.8 if candidate != "UNKNOWN" else 1.0
