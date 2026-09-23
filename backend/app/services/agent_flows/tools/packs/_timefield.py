"""What makes a column NAME look like a time axis. One definition, one file.

THERE WERE TWO, AND THEY DISAGREED IN BOTH DIRECTIONS.

`project_ahead` decides whether a chart has a time axis at all — get it wrong and
`detect_seasonality` reports cycles over alphabetical order. `coverage` decides
which column to read a date range from, and which charts to try first. Same
question, two regexes, and by the time both were measured against the same
columns they had drifted apart in BOTH directions:

    product_category_name_english   coverage=MATCH   project_ahead=-
    year_month                      coverage=-       project_ahead=MATCH
    product_name_lenght             coverage=MATCH   project_ahead=-

`coverage` still carried the substring rule — "nam" (year) living inside the word
"name" — that was fixed in `project_ahead`, AND it had never learned
`month|quarter|week|year`, so it did not recognise the single most common month
column in the reports it scans.

THE RULE. A column name is a path of segments — `schema.table__col_name` — so a
token counts only at a segment edge: start or end of the string, or next to a
separator such as `_`, `.`, `-`, a space or a digit. `year_month` and
`thang_ban_hang` match; `name` and `kythuat` do not.

WHAT THIS FILE DOES NOT DECIDE. Names are a hint, not a verdict. `coverage` still
parses the VALUES and requires most of them to be real dates before it will trust
a column, which is how it finds a date column named `key`. That check is strictly
stronger than this one and is deliberately left where it is — this module answers
only the name question, so the two tools answer it identically.

A THIRD DEFINITION STILL EXISTS, unmerged on purpose:
`dashboard_ai_bot.thinking.advanced_tools._looks_like_datetime` is a substring
test over a different token list, and it disagrees with this one — it does not
recognise `created_at`, and it carries `day`/`tuan`/`quy`, which this one does
not. It gates `compare_periods`, so folding it in would change that tool's
acceptance in the same pass that is changing its edge handling. It is recorded as
an open item instead of being merged quietly.
"""
from __future__ import annotations

import re

#: Tokens that name a time field, English and Vietnamese, with and without
#: diacritics — warehouse loaders strip them and authors type both.
#:
#: `ky`/`kỳ` (period) is knowingly ambiguous: `ky_bao_cao` is a reporting period
#: and `ky_thuat` is engineering, and no name-only rule separates them. It is
#: kept because the period sense is the one that appears on report axes.
TIME_NAME_TOKENS: tuple[str, ...] = (
    "date", "ngay", "ngày", "thang", "tháng", "nam", "năm", "time", "timestamp",
    "at", "dt", "period", "ky", "kỳ", "month", "quarter", "week", "year",
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
