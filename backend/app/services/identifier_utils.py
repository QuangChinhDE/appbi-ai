"""Single source of truth for normalizing user-facing labels into SQL-safe identifiers.

Used everywhere a column name, table alias, or any identifier may originate from a non-ASCII
input (Vietnamese diacritics, spaces, special chars). Keeps display names intact while exposing
a deterministic ASCII snake_case identifier downstream callers can quote safely.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable

# SQL keywords that must not stand alone as bare identifiers in any supported dialect.
_RESERVED_WORDS = {
    "as", "by", "cross", "from", "full", "group", "inner", "join", "left",
    "limit", "on", "order", "outer", "right", "select", "table", "where",
    "with", "and", "or", "not", "null", "true", "false", "case", "when",
    "then", "else", "end", "in", "is", "like", "between", "having", "union",
    "all", "distinct", "asc", "desc", "values", "set", "update", "insert",
    "delete", "into", "from", "default", "primary", "foreign", "key", "index",
    "view", "schema", "database", "user", "column",
}

_VIETNAMESE_REPLACEMENTS = {
    "\u0110": "D",
    "\u0111": "d",
    "\u00d0": "D",
}

_NON_WORD_RE = re.compile(r"[^a-zA-Z0-9]+")
_COLLAPSE_UNDERSCORE_RE = re.compile(r"_+")


def _strip_diacritics(text: str) -> str:
    for src, dst in _VIETNAMESE_REPLACEMENTS.items():
        text = text.replace(src, dst)
    nfkd = unicodedata.normalize("NFKD", text)
    return nfkd.encode("ascii", "ignore").decode("ascii")


def normalize_identifier(
    raw: str | None,
    *,
    fallback: str = "col",
    lowercase: bool = True,
) -> str:
    """Convert any label to a deterministic ASCII snake_case identifier.

    Examples:
        "Doanh Thu"              -> "doanh_thu"
        "% Tang truong"          -> "tang_truong"
        "Don hang (moi)"         -> "don_hang_moi"
        "2024 Revenue"           -> "col_2024_revenue"
        ""                       -> "col"  (or `fallback`)

    Never returns an empty string. Always returns something that:
    - starts with a letter or underscore (numbers get prefixed with `col_`),
    - contains only [a-zA-Z0-9_],
    - has no leading/trailing underscores,
    - has no consecutive underscores,
    - is not a reserved SQL keyword (suffixed with `_col` if it would be).
    """
    text = str(raw or "").strip()
    if not text:
        return fallback

    ascii_text = _strip_diacritics(text)
    cleaned = _NON_WORD_RE.sub("_", ascii_text).strip("_")
    cleaned = _COLLAPSE_UNDERSCORE_RE.sub("_", cleaned)

    if lowercase:
        cleaned = cleaned.lower()

    if not cleaned:
        cleaned = fallback

    if cleaned[:1].isdigit():
        cleaned = f"col_{cleaned}"

    if cleaned.lower() in _RESERVED_WORDS:
        cleaned = f"{cleaned}_col"

    return cleaned


def normalize_column_identifier(
    raw: str | None,
    *,
    existing: Iterable[str] | None = None,
    fallback: str = "col",
) -> str:
    """Like `normalize_identifier` but guarantees uniqueness against `existing`.

    Adds `_2`, `_3`, ... suffixes when the candidate already exists. Comparison is
    case-insensitive to keep identifiers stable across dialects.
    """
    base = normalize_identifier(raw, fallback=fallback)
    if not existing:
        return base

    existing_lower = {str(item).lower() for item in existing if item}
    if base.lower() not in existing_lower:
        return base

    suffix = 2
    while True:
        candidate = f"{base}_{suffix}"
        if candidate.lower() not in existing_lower:
            return candidate
        suffix += 1


def normalize_table_alias(
    raw: str | None,
    *,
    fallback: str = "table",
) -> str:
    """Like `normalize_identifier` but uses table-friendly fallback rules.

    Differs from `normalize_identifier` in that:
    - leading digits are prefixed with `table_` (not `col_`),
    - reserved keywords are suffixed with `_table` (not `_col`).
    """
    text = str(raw or "").strip()
    if not text:
        return fallback
    # Drop a leading schema if present and the remainder has no whitespace,
    # so 'public.users' -> 'users' but 'My Schema.something' falls through.
    if "." in text and not re.search(r"\s", text):
        text = text.split(".")[-1]

    ascii_text = _strip_diacritics(text)
    cleaned = _NON_WORD_RE.sub("_", ascii_text).strip("_")
    cleaned = _COLLAPSE_UNDERSCORE_RE.sub("_", cleaned).lower()
    if not cleaned:
        cleaned = fallback
    if cleaned[:1].isdigit():
        cleaned = f"table_{cleaned}"
    if cleaned in _RESERVED_WORDS:
        cleaned = f"{cleaned}_table"
    return cleaned
