"""One canonical way to fold text for MATCHING, agreeing with the database.

WHY THIS MODULE EXISTS
----------------------
Thirteen separate diacritic-stripping helpers had grown across the codebase, and
they did not agree. Twelve of them used `unicodedata.normalize` plus a
combining-mark filter, which is correct for `á → a` and WRONG for Vietnamese `đ`:
U+0111 LATIN SMALL LETTER D WITH STROKE is its own letter, not a base plus a
combining mark, so no normalisation form decomposes it. Only one helper
(`govern_tools._fold`) had noticed and appended `.replace("đ", "d")`.

The consequences were not cosmetic:

  * The AI data scope excludes columns by folded name. A column excluded as
    "Đơn hàng" did not match a physical column `don_hang`, so the exclusion
    silently failed — a governance control that reported success and did nothing.
  * The retrieval evaluation harness scored a passage as "missing the answer"
    whenever the answer contained `đ`, which was most Vietnamese business prose.
    It reported phrase_hit 0.72 against a system that was not at fault.

The reference implementation is NOT a matter of taste: the keyword half of
retrieval folds inside Postgres via `appbi_unaccent` (migration 0046), so any
Python folding that disagrees with it produces matches the database will not, and
vice versa. This module reproduces `appbi_unaccent(...)` and `test_text_fold.py`
pins that agreement against output captured from the database itself.

Deliberately NOT used for generating SQL identifiers, column keys or slugs
(`identifier_utils`, `dataset_table_sql_service`, `type_override_service`,
`excel_structure_detector`): those values are persisted and referenced by existing
datasets, so changing how they fold would rename live objects. Matching and
naming are different jobs and are allowed to differ — as long as it is on purpose.
"""
from __future__ import annotations

import re
import unicodedata

#: Characters `unaccent` rewrites that no Unicode normalisation form decomposes,
#: because they are distinct letters (or punctuation) rather than base + mark.
#: Vietnamese only needs the first pair; the rest keep parity with the database
#: for text that arrives from elsewhere.
_UNDECOMPOSABLE = {
    "đ": "d", "Đ": "D",
    "ø": "o", "Ø": "O",
    "ł": "l", "Ł": "L",
    "ß": "ss",
    "æ": "ae", "Æ": "AE",
    "œ": "oe", "Œ": "OE",
    "ð": "d", "Ð": "D",
    "þ": "th", "Þ": "TH",
    # Punctuation `unaccent` also normalises. The en dash matters in practice:
    # documents written in a word processor contain "2–3 tuần", and a probe or
    # query typed as "2-3" would otherwise never match it.
    "–": "-", "—": "-", "‑": "-",
    "‘": "'", "’": "'", "“": '"', "”": '"',
}

_TRANSLATION = str.maketrans({k: v for k, v in _UNDECOMPOSABLE.items()})
_WHITESPACE_RE = re.compile(r"\s+")


def strip_diacritics(value: object) -> str:
    """`appbi_unaccent`'s behaviour, case preserved and whitespace untouched."""
    text = str(value or "").translate(_TRANSLATION)
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def fold_text(value: object) -> str:
    """Lowercase, diacritic-free, whitespace-collapsed form for MATCHING.

    "Tỷ lệ giao đúng hẹn" and "ty le  giao dung hen" fold to the same string, so a
    reader who types without diacritics finds a document that uses them.
    """
    return _WHITESPACE_RE.sub(" ", strip_diacritics(value).lower()).strip()


def fold_token_list(value: object) -> list[str]:
    """Matchable tokens in order, with repeats — folded, split on anything that is
    not alphanumeric, single characters dropped.

    Splitting on non-alphanumerics rather than whitespace is the whole point.
    A passage containing `delivered_customer_date`, "(BRL)" or "≥ 92%." yields the
    tokens a reader would search for; splitting on whitespace yields
    "`delivered_customer_date`", "(brl)" and "92%." — which match nothing, and
    which is how a lexical scorer came to award zero to three questions whose
    answers were sitting in the retrieved passage.

    Query and document MUST be tokenised by this one function. Asymmetric
    tokenisation is invisible: both sides look reasonable in isolation.
    """
    return [t for t in re.split(r"[^a-z0-9]+", fold_text(value)) if len(t) > 1]


def fold_tokens(value: object) -> set[str]:
    """`fold_token_list` as a set, for membership tests."""
    return set(fold_token_list(value))
