"""Shared locale-aware number parsing for the Workboard runtime + expression
engine.

One source of truth so FE preview totals, BE footer totals, and the
computed-field evaluator (``expr_eval``) all read ``"1.234,5"`` / ``"20;31;25"``
identically. Previously ``_parse_locale_number`` lived only in ``screen_runtime``
and the expression engine used a plain ``float()``, so a preview could show one
value while the server stored another — the exact bug this consolidation fixes.
"""
from __future__ import annotations

import numbers
from typing import Any, Optional


def parse_locale_number(text: str) -> Optional[float]:
    """Parse a numeric string honouring the vi-VN number format
    (``.`` = thousands grouping, ``,`` = decimal separator).

    DETERMINISTIC locale rule (not a content guess). Examples::

        "1234,5"     -> 1234.5       "75.351.234,5" -> 75351234.5
        "1.000.000"  -> 1000000.0    "1,234"        -> 1.234
        "500000"     -> 500000.0     "(1.234,5)"    -> -1234.5

    Returns ``None`` for anything that is not a plain number.
    """
    s = text.strip()
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")")  # accounting negative
    if neg:
        s = s[1:-1].strip()
    s = s.replace(" ", "").replace(" ", "")  # NBSP + thin spaces
    if not s:
        return None
    # vi-VN: '.' groups thousands, ',' is the decimal mark. When a comma is
    # present it is the decimal point, so strip grouping dots then swap it.
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif "." in s:
        # A lone dot is thousands grouping ONLY when it forms valid vi-VN
        # groups: first segment 1-3 digits, every later segment EXACTLY 3
        # ("1.000.000" -> 1000000, "1.234" -> 1234). Otherwise it is a decimal
        # point ("98.0" -> 98.0) — a native numeric read back as VARCHAR — and
        # must NOT be inflated ×10.
        parts = s.split(".")
        is_grouping = (
            len(parts) >= 2
            and all(p.isdigit() for p in parts)
            and 1 <= len(parts[0]) <= 3
            and all(len(p) == 3 for p in parts[1:])
        )
        if is_grouping:
            s = "".join(parts)
    try:
        val = float(s)
    except ValueError:
        return None
    return -val if neg else val


def coerce_number(value: Any) -> Optional[float]:
    """Any -> float. Native numerics fast-path; strings via the locale rule."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, numbers.Number):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    if isinstance(value, str):
        return parse_locale_number(value)
    return None


def sum_split(value: Any, delimiter: str = ";", *, strict: bool = False) -> Optional[float]:
    """Split a delimited numeric string and return the sum of its parts.

    Generic + business-agnostic — knows nothing about weight/qty/size. Empty
    segments (and surrounding whitespace) are skipped. ``None``/``""`` -> ``0.0``.
    A non-empty, non-numeric segment raises ``ValueError`` in ``strict`` mode
    (computed fields that persist) and returns ``None`` in safe mode
    (``show_if``/``required_if`` conditional UI). A native number passes through.
    """
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return None if not strict else _raise_seg(value)
    if isinstance(value, (int, float)):
        return float(value)
    s = value if isinstance(value, str) else str(value)
    if not s.strip():
        return 0.0
    delim = delimiter if (isinstance(delimiter, str) and delimiter != "") else ";"
    total = 0.0
    for part in s.split(delim):
        seg = part.strip()
        if not seg:
            continue
        n = parse_locale_number(seg)
        if n is None:
            if strict:
                raise ValueError(f"SUM_SPLIT: non-numeric segment {seg!r}")
            return None
        total += n
    return total


def _raise_seg(value: Any) -> float:
    raise ValueError(f"SUM_SPLIT: unsupported value {value!r}")
