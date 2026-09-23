# -*- coding: utf-8 -*-
"""Is this column a time axis? One module, three tiers, and an honest middle.

SESSION 1 REMOVED THE DRIFT. FOUR implementations answered this and disagreed in
both directions; they now all come here. That part stands and is not revisited.

SESSION 2 REMOVES A DIFFERENT FAULT: one canonical answer can still be
canonically WRONG. A single boolean forced every ambiguous Vietnamese name into
"yes", and `ky` and `quy` are not words a name-only rule can settle:

    kỳ báo cáo   a reporting period        kỹ thuật   engineering
    quý          a quarter                 quy định   a regulation
                                           quy mô     a size

`ky_thuat` scored as a time axis, so `analyze_trend` would run time-series
mathematics over `["engineering", "sales", "support"]` and report a trend in
alphabetical order. More exceptions in the token list cannot fix that: the name
genuinely does not carry the answer.

THE THREE TIERS, AND WHY THE MIDDLE ONE EARNS ITS KEEP.

    STRONG     the name settles it            `created_at`, `year_month`, `kỳ`
    AMBIGUOUS  the name suggests, values decide `ky_bao_cao`, `quy`, `quy_dinh`
    NONE       the name says no                `holiday_flag`, `username`

Collapsing AMBIGUOUS into STRONG is the bug above. Collapsing it into NONE loses
`ky_bao_cao` and `quy`, which are real report axes. So it stays a third answer,
and a caller doing time-series arithmetic must PROVE it from the values.

DIACRITICS ARE EVIDENCE, and this is why the split is cheap. `kỳ` (period) is a
different word from `kỹ` (technique), and `quý` (quarter) from `quy` (rule). A
name that kept its diacritics has already disambiguated itself; one that lost
them to a warehouse loader has not. So `kỳ`/`quý` are STRONG and bare `ky`/`quy`
are AMBIGUOUS — the uncertainty is attached to exactly the spelling that is
actually uncertain.

THE SEGMENT RULE, unchanged from Session 1. A column name is a path of segments —
`schema.table__col_name` — so a token counts only at a segment edge. `year_month`,
`thang_ban_hang` and `order_day` match; `name`, `kythuat`, `holiday_flag`,
`payday_amount` and `monday_sales` do not. That rule is what makes `day` safe to
carry at all.

NAME AND VALUE ARE SEPARATE TIERS AND STAY THAT WAY. `looks_like_period_value`
lives here beside the name rule because it is the other half of one semantic, not
because they merge. Nothing in this module lets a name regex stand in for value
parsing, and the stronger calendar validation each tool does on top is untouched:
`coverage` still finds a date column named `key` by reading its values.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Literal

#: What a name alone can establish.
TimeNameClass = Literal["strong", "ambiguous", "none"]

#: Tokens where the name settles it — English and Vietnamese, with and without
#: diacritics, because warehouse loaders strip them and authors type both.
STRONG_TIME_TOKENS: tuple[str, ...] = (
    "date", "ngay", "ngày", "thang", "tháng", "nam", "năm", "time", "timestamp",
    "at", "dt", "period", "month", "quarter", "week", "year",
    "day", "tuan", "tuần",
    # Diacritics carry the disambiguation: `kỳ` is a period and `quý` is a
    # quarter, whatever their bare spellings can also mean.
    "kỳ", "quý",
)

#: Tokens where the name only SUGGESTS. Bare `ky` is `kỳ` (period) or `kỹ`
#: (technique); bare `quy` is `quý` (quarter), `quy định` (regulation) or
#: `quy mô` (size). Values decide.
AMBIGUOUS_TIME_TOKENS: tuple[str, ...] = ("ky", "quy")

#: A segment edge: the string boundary, or any character that is not a letter or
#: digit. `À-ỹ` keeps Vietnamese letters on the "inside a word" side, so `năm` in
#: `tên` does not count as a boundary crossing.
_SEG = r"(?:^|[^0-9A-Za-zÀ-ỹ])"
_END = r"(?=$|[^0-9A-Za-zÀ-ỹ])"


def _rx(tokens: Iterable[str]) -> re.Pattern[str]:
    return re.compile(_SEG + r"(?:" + "|".join(tokens) + r")" + _END, re.IGNORECASE)


#: STRONG only. This is the safe name hint and the default for any caller that
#: will not look at values.
TIME_NAME_RX = _rx(STRONG_TIME_TOKENS)

#: STRONG or AMBIGUOUS — worth reading the values of. For callers that prove it.
TIME_NAME_CANDIDATE_RX = _rx(tuple(STRONG_TIME_TOKENS) + AMBIGUOUS_TIME_TOKENS)

#: A date/period VALUE: 2024, 2024-06, 2024-06-15, 2024/06, Q1 2024.
#: Moved here from `advanced_tools` so the two halves of one semantic sit
#: together. They remain separate FUNCTIONS: nothing here lets a name stand in
#: for a parsed value.
_PERIOD_VALUE_RX = re.compile(
    r"^\s*(?:Q[1-4][\s\-/]?\d{4}|\d{4}(?:[\-/](?:0?[1-9]|1[0-2]))?(?:[\-/]\d{1,2})?|\d{4})\s*$",
    re.IGNORECASE,
)

#: A bare quarter or period label with no year: `Q1`, `quy 1`, `kỳ 2`. Accepted
#: as value evidence because an axis labelled this way is still a time axis.
_BARE_PERIOD_RX = re.compile(
    r"^\s*(?:q|quy|quý|ky|kỳ|tuần|tuan|w|week|thang|tháng|month)\s*[\-/ ]?\s*\d{1,2}\s*$",
    re.IGNORECASE,
)


def classify_time_name(name: str | None) -> TimeNameClass:
    """What this column NAME establishes on its own."""
    text = name or ""
    if TIME_NAME_RX.search(text):
        return "strong"
    if TIME_NAME_CANDIDATE_RX.search(text):
        return "ambiguous"
    return "none"


def looks_like_time_name(name: str | None) -> bool:
    """True only when the NAME settles it.

    The safe default. A caller that cannot look at values should use this and
    accept that `ky_bao_cao` will be declined rather than guessed at.
    """
    return classify_time_name(name) == "strong"


def could_be_time_name(name: str | None) -> bool:
    """True when the name is worth reading the VALUES of — strong or ambiguous.

    For callers that follow up with value parsing, such as `coverage`, which
    scores candidates and then requires most of them to parse as real dates.
    """
    return classify_time_name(name) != "none"


def looks_like_period_value(value: Any) -> bool:
    """True if one dimension VALUE reads as a calendar period label."""
    text = str(value if value is not None else "")
    return bool(_PERIOD_VALUE_RX.match(text) or _BARE_PERIOD_RX.match(text))


def values_look_like_time(values: Iterable[Any], *, min_ratio: float = 0.6) -> bool:
    """Do the sampled VALUES actually look like a period axis?

    ONE HIT IS NOT EVIDENCE. This used to return True on the first recognisable
    label, which is what the analytical tools did before the semantic was
    unified — and it means

        ["engineering", "2024", "support", "finance"]

    becomes a time axis because one category happens to be a bare year. A column
    with a `ky_*` or `quy_*` name and one numeric-looking value would then reach
    time-series arithmetic, which is the whole failure this tier exists to stop.

    THE RULE: a MAJORITY of the sampled non-empty values must read as periods.
    The threshold is 0.6 rather than 1.0 because a genuine axis carries noise —
    an "Unknown", an "Other", a stray blank label — and demanding purity would
    refuse real series. It is not 0.5: a bare majority is what a half-categorical
    column looks like. At three sampled values it accepts two and refuses one,
    which is the smallest series where the distinction is meaningful.

    Empty and null values are DROPPED rather than counted against the series, so
    a sparse axis is not punished for being sparse.
    """
    sampled = [v for v in values if v is not None and str(v).strip() != ""]
    if not sampled:
        return False
    hits = sum(1 for v in sampled if looks_like_period_value(v))
    if hits == 0:
        return False
    if len(sampled) == 1:
        # A single value can only speak for itself; it is not a pattern, but
        # refusing it would break a legitimately one-row chart.
        return True
    return hits / len(sampled) >= min_ratio

def accept_as_time_axis(name: str | None, values: Iterable[Any] | None = None) -> bool:
    """The question an analytical tool actually has: may I do time maths on this?

    STRONG passes on the name. AMBIGUOUS passes only on value evidence — this is
    the whole point of the middle tier, and the reason `ky_thuat` over
    `["engineering", "sales", "support"]` is refused while `ky_bao_cao` over
    `["2024-01", "2024-02"]` is not. NONE never passes on the name; a caller
    holding values may still consult `values_look_like_time` directly, which is
    how a column named `key` full of dates remains usable.
    """
    verdict = classify_time_name(name)
    if verdict == "strong":
        return True
    if verdict == "none":
        return False
    return values is not None and values_look_like_time(values)
