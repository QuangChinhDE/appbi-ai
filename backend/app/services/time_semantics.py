# -*- coding: utf-8 -*-
"""What makes a column NAME look like a time axis. One definition, one file.

THERE WERE FOUR, AND THEY DISAGREED IN BOTH DIRECTIONS.

    packs/_timefield.TIME_NAME_RX          segment-edge regex, 18 tokens
    advanced_tools._looks_like_datetime    substring `in`, 10 tokens
    insight_pack._looks_like_datetime_name substring `in`, 8 tokens
    (coverage and project_ahead aliased the first)

Measured against one corpus:

    created_at     canonical=TIME   advanced_tools=-      (no `at` token)
    holiday_flag   canonical=-      advanced_tools=TIME   (`day` inside `holiday`)
    tuan / quy     canonical=-      advanced_tools=TIME   (tokens only it carried)
    ky_bao_cao     canonical=TIME   advanced_tools=-      (no `ky` token)

`compare_periods`, `analyze_trend`, forecast and seasonality gate on the
substring version; `coverage` and `project_ahead` on the regex one. Two tools
asked the same question about the same column and got opposite answers — one
would chart a trend over a column the other had already called categorical.

WHY IT LIVES HERE AND NOT UNDER `agent_flows`.

It was under `agent_flows/tools/packs/`, which made it Agent Flow product code.
`dashboard_ai_bot` is a lower-level consumer; pointing it at that path to ask a
generic semantic question inverts the layering. `services/time_semantics` is
owned by neither, so both import downward.

THE RULE. A column name is a path of segments — `schema.table__col_name` — so a
token counts only at a segment edge: the start or end of the string, or next to a
separator such as `_`, `.`, `-`, a space or a digit. `year_month`,
`thang_ban_hang` and `order_day` match; `name`, `kythuat` and `holiday_flag` do
not. Segment-edge matching is what lets `day` be carried at all: as a substring it
fires on `holiday`, `payday` and `monday`, which is why the tool that had it also
had those false positives.

WHAT THIS FILE DOES NOT DECIDE. Names are a hint, not a verdict. `coverage` still
parses the VALUES and requires most of them to be real dates before it trusts a
column, which is how it finds a date column named `key`. That check is strictly
stronger than this one and is deliberately left where it is: this module answers
only the name question, so every tool answers THAT question identically, and each
tool keeps whatever stronger calendar validation its job needs.
"""
from __future__ import annotations

import re

#: Tokens that name a time field, English and Vietnamese, with and without
#: diacritics — warehouse loaders strip them and authors type both.
#:
#: KNOWINGLY AMBIGUOUS: `ky`/`kỳ` (period) and `quy`/`quý` (quarter). `ky_bao_cao`
#: is a reporting period and `ky_thuat` is engineering; `quy_1` is a quarter and
#: `quy_dinh` is a regulation. No name-only rule separates them, and both are kept
#: because the time sense is the one that appears on report axes. The cost of the
#: false positive is bounded: a name is a hint, and the tools that need certainty
#: parse the values. The cost of dropping them is a real axis nobody can chart.
TIME_NAME_TOKENS: tuple[str, ...] = (
    "date", "ngay", "ngày", "thang", "tháng", "nam", "năm", "time", "timestamp",
    "at", "dt", "period", "ky", "kỳ", "month", "quarter", "week", "year",
    # Carried over from `advanced_tools`, which was the only one that had them.
    # Safe here because matching is segment-edge, not substring.
    "day", "tuan", "tuần", "quy", "quý",
)

#: A segment edge: the string boundary, or any character that is not a letter or
#: digit. `À-ỹ` keeps Vietnamese letters on the "inside a word" side, so `năm` in
#: `tên` does not count as a boundary crossing.
_SEG = r"(?:^|[^0-9A-Za-zÀ-ỹ])"

TIME_NAME_RX = re.compile(
    _SEG + r"(?:" + "|".join(TIME_NAME_TOKENS) + r")(?=$|[^0-9A-Za-zÀ-ỹ])",
    re.IGNORECASE,
)


def looks_like_time_name(name: str | None) -> bool:
    """True if this column NAME carries a time token as a whole segment."""
    return bool(TIME_NAME_RX.search(name or ""))
