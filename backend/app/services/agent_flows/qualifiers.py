# -*- coding: utf-8 -*-
"""A qualifier is a claim, and a claim needs a source.

WHAT A "QUALIFIER" IS HERE. Not the number — the words wrapped around it. "1.258.681,34"
is a figure and `verify_answer` already checks it against the evidence. "1.258.681,34 VNĐ
doanh thu tháng 9" carries four further assertions:

    UNIT         it is in Vietnamese đồng
    SCOPE        it is September's
    TIME         (elsewhere) the data runs from X to Y
    AGGREGATION  it is a total rather than an average

Every one of those can be wrong while the digits are right, and the figure verifier
passes all four without looking at any of them. Measured: `1,258,681.34 USD` on one run
and `1.258.681,34 VNĐ` on another, over BRAZILIAN data, with no currency declared
anywhere. Both answers verified clean.

THE RULE, and it is one rule rather than five:

    A QUALIFIER MAY BE STATED ONLY IF IT APPEARS IN THE EVIDENCE.

That is deterministic, needs no model, and is the same test the figure verifier applies
to numbers — extended to the words that give them meaning. It is not a semantic theorem
prover and cannot become one: it asks whether a token the answer asserts is present in
what the run actually read, nothing more.

WHAT IT DELIBERATELY DOES NOT DO. It does not judge whether a qualifier is APT — whether
September is the right month to report, whether a total is the right statistic. A
qualifier that appears in the evidence passes, even if the answer applied it to the wrong
figure. Catching that needs the dimension work in `resolve_chart_candidates`, which is
where it belongs, not a text rule here.

FALSE POSITIVES ARE THE FAILURE MODE TO FEAR. A correction round costs an LLM call and,
worse, teaches the model to hedge a right answer. So each check below fires only when the
evidence is POSITIVELY SILENT on the qualifier — not when it is merely unclear — and the
whole pass is skipped when there are no tool results to check against.
"""
from __future__ import annotations

import json
import re
from typing import Any

# ── what the answer is asserting ────────────────────────────────────────────

#: Currency markers, as an answer writes them. `đ`/`₫` are matched as whole tokens
#: because `đ` is an ordinary Vietnamese letter and would otherwise fire on prose.
_CURRENCY = {
    "$": re.compile(r"\$"),
    "USD": re.compile(r"\bUSD\b", re.IGNORECASE),
    "VND": re.compile(r"\bVN[ĐD]\b", re.IGNORECASE),
    "đồng": re.compile(r"\bđồng\b", re.IGNORECASE),
    "EUR": re.compile(r"\bEUR\b|€", re.IGNORECASE),
    "GBP": re.compile(r"\bGBP\b|£", re.IGNORECASE),
    "BRL": re.compile(r"\bBRL\b|R\$", re.IGNORECASE),
    "₫": re.compile(r"₫"),
}

#: "the data runs from X to Y" — a claim about the whole dataset's extent, which is
#: exactly what a truncated row sample cannot establish. Narrow on purpose: a range
#: stated INSIDE a chart's own reading ("doanh thu tháng 1 đến tháng 3") is not this.
_COVERAGE_CLAIM = re.compile(
    r"(?:dữ\s*liệu|số\s*liệu|báo\s*cáo|data(?:set)?)[^.\n]{0,40}"
    r"(?:từ|bắt\s*đầu\s*từ|trải\s*dài|covers?|ranges?\s+from|spans?)"
    r"[^.\n]{0,40}\d{4}"
    r"|\d{4}[^.\n]{0,20}(?:đến|tới|->|–|—|to)\s*\d{4}"
    r"[^.\n]{0,30}(?:dữ\s*liệu|số\s*liệu|toàn\s*bộ|entire|whole|all\s+data)",
    re.IGNORECASE,
)

#: A named period. Months in both languages, quarters, and ISO `YYYY-MM`, each
#: with an OPTIONAL trailing year, because the year is what makes a period
#: comparable with the evidence. Years alone are excluded: "2018" appears in too
#: many innocent places.
_MONTHS_EN = ("january", "february", "march", "april", "may", "june", "july",
              "august", "september", "october", "november", "december")
_YEAR_TAIL = r"(?:\s*(?:năm|nam|of)?\s*(\d{4}))?"
_PERIOD = re.compile(
    r"\b(?:tháng\s*(?:0?[1-9]|1[0-2])" + _YEAR_TAIL +
    r"|thang\s*(?:0?[1-9]|1[0-2])" + _YEAR_TAIL +
    r"|quý\s*[1-4]" + _YEAR_TAIL +
    r"|Q[1-4]\s*[/-]?\s*(\d{4})"
    r"|(\d{4})-(?:0?[1-9]|1[0-2])"
    r"|(?:" + "|".join(_MONTHS_EN) + r")" + _YEAR_TAIL +
    r")\b",
    re.IGNORECASE,
)

#: The month inside whatever form the answer wrote it in.
_MONTH_NUM = re.compile(r"(?:tháng|thang)\s*(0?[1-9]|1[0-2])", re.IGNORECASE)
_ISO_MONTH = re.compile(r"\d{4}-(0?[1-9]|1[0-2])\b")
_QUARTER_NUM = re.compile(r"(?:quý|quy|Q)\s*[/-]?\s*([1-4])", re.IGNORECASE)

#: Any number. Used to ask whether a period has a FIGURE attached to it — which
#: is what makes naming it a scope claim rather than a mention.
_ANY_NUMBER = re.compile(r"\d[\d.,]*")


def _month_of(text: str) -> int | None:
    """The month number this period names, whatever form it is written in."""
    low = text.lower()
    m = _ISO_MONTH.search(low) or _MONTH_NUM.search(low)
    if m:
        return int(m.group(1))
    for i, name in enumerate(_MONTHS_EN, start=1):
        if name in low:
            return i
    q = _QUARTER_NUM.search(low)
    if q:
        return (int(q.group(1)) - 1) * 3 + 1
    return None


def _canonical_period(text: str) -> str | None:
    """`tháng 09 năm 2016`, `September 2016`, `2016-09` -> `2016-09`.

    WITHOUT THIS THE RULE COMPARED SPELLINGS, NOT PERIODS. Measured: the answer
    wrote "tháng 09 năm 2016" and `describe_time_coverage` had returned
    "2016-09-04", so the folded token `thang 09` was not in the evidence and a
    correctly sourced period was reported as unsourced. The rule is about
    provenance; a rendering difference is not a provenance failure.

    Returns None when no YEAR is attached, because `tháng 9` on its own names no
    specific period and cannot be matched against evidence.
    """
    low = text.lower()
    year = re.search(r"\b(\d{4})\b", low)
    if not year:
        return None
    y = year.group(1)

    m = _ISO_MONTH.search(low) or _MONTH_NUM.search(low)
    if m:
        return f"{y}-{int(m.group(1)):02d}"
    for i, name in enumerate(_MONTHS_EN, start=1):
        if name in low:
            return f"{y}-{i:02d}"
    q = _QUARTER_NUM.search(low)
    if q:
        return f"{y}-{(int(q.group(1)) - 1) * 3 + 1:02d}"
    return None


def _period_hints(raw: str) -> list[str]:
    """Every canonical `YYYY-MM` that would show the evidence reaches this period.

    A QUARTER IS THREE MONTHS, and evidence for any one of them is evidence the
    run saw that part of the calendar. Matching only the first month made "quý 3
    năm 2016" unsourced against coverage starting 2016-09-04 — a quarter the data
    genuinely reaches, reported as one it does not.
    """
    canonical = _canonical_period(raw)
    if canonical is None:
        return []
    if not _QUARTER_NUM.search(raw.lower()) or _MONTH_NUM.search(raw.lower()):
        return [canonical]
    year, month = canonical.split("-")
    start = int(month)
    return [f"{year}-{m:02d}" for m in range(start, start + 3)]

#: Words that assert a SUM.
_SUM_WORD = re.compile(
    r"\b(?:tổng(?:\s*cộng)?|tổng\s*số|sum|total)\b", re.IGNORECASE)

#: Aggregations that are not sums. If every declared aggregation in the run is one of
#: these and the answer says "total", the answer renamed the statistic.
_NON_ADDITIVE = {"avg", "average", "mean", "rate", "ratio", "median", "pct",
                 "percent", "percentage", "min", "max"}

#: The one tool that can establish the data's full extent.
_COVERAGE_TOOL = "describe_time_coverage"


# ── what the evidence actually said ─────────────────────────────────────────


def _result_blob(results: list[Any]) -> str:
    """Every tool result as one searchable string.

    Serialised rather than walked, because a qualifier can be declared in a value, a
    key, a note or a row label, and a walker that visits only the places we thought of
    is a walker that misses the one we did not.
    """
    parts: list[str] = []
    for item in results:
        if isinstance(item, str):
            parts.append(item)
            continue
        try:
            parts.append(json.dumps(item, ensure_ascii=False, default=str))
        except Exception:                                       # noqa: BLE001
            parts.append(str(item))
    return "\n".join(parts)


def _declared_aggregations(blob: str) -> set[str]:
    return {m.lower() for m in re.findall(
        r'"aggregation"\s*:\s*"([^"]+)"', blob)}


def _unit_is_declared(blob: str) -> bool:
    """Did anything the run read declare a unit at all?

    `measure_meta` already computes this and publishes `unit_known`, so the fact is
    borrowed rather than re-derived — a second opinion about a measure's unit is a
    second place for it to be wrong.
    """
    return bool(re.search(r'"unit_known"\s*:\s*true', blob, re.IGNORECASE))


# ── the check ───────────────────────────────────────────────────────────────


def check_qualifiers(text: str, results: list[Any], tools_called: list[str]
                     ) -> list[dict]:
    """Qualifiers the answer asserts that the evidence does not carry.

    `results` are the raw tool results this answer was written from; `tools_called`
    the names of the tools that produced them. Returns one entry per violation:
    `{"kind", "claim", "why"}` — `kind` for tests and telemetry, `why` for the model.
    """
    if not text or not results:
        # Nothing was read, so there is no evidence to be silent. A flow that reads
        # nothing is the figure verifier's problem, not this one's.
        return []

    blob = _result_blob(results)
    found: list[dict] = []

    # UNIT — the measured failure. No currency was declared anywhere and the answer
    # picked one, differently on two runs, over data from a third country.
    if not _unit_is_declared(blob):
        for name, rx in _CURRENCY.items():
            if rx.search(text) and not rx.search(blob):
                found.append({
                    "kind": "unit",
                    "claim": name,
                    "why": (
                        f"Câu trả lời ghi đơn vị “{name}”, nhưng không có kết quả "
                        "công cụ nào khai báo đơn vị cho số này. Bỏ đơn vị đi, "
                        "hoặc nói rõ là đơn vị chưa được khai báo."
                    ),
                })
                break          # one unit violation is the message; five is noise

    # TIME — a claim about the data's whole extent, from a run that never asked.
    if _COVERAGE_TOOL not in set(tools_called or ()):
        match = _COVERAGE_CLAIM.search(text)
        if match:
            found.append({
                "kind": "time",
                "claim": match.group(0).strip()[:80],
                "why": (
                    "Câu trả lời nói dữ liệu trải dài trong một khoảng thời gian, "
                    "nhưng bước này chưa gọi describe_time_coverage — các dòng đã "
                    f"đọc chỉ là một phần. Gọi {_COVERAGE_TOOL}, hoặc bỏ khẳng định "
                    "về phạm vi dữ liệu."
                ),
            })

    # SCOPE — an all-time figure given a month's name. The evidence has to contain
    # the period, as a row label, a filter value or coverage output; if the run
    # never saw September, the answer cannot be about September.
    #
    # TWO THINGS THIS LEARNED THE HARD WAY, both measured on the live suite:
    #
    #   1. NAMING A PERIOD IS NOT CLAIMING IT. "Báo cáo không chứa bất kỳ dữ liệu
    #      nào cho tháng 12 năm 2030" is the CORRECT refusal, and the first version
    #      flagged it, spent an LLM correction round on it and attached a reader
    #      notice telling the viewer to double-check a figure the answer never
    #      gave. So the period must have a figure attached — a number that is not
    #      part of the period's own digits, in the same sentence.
    #
    #   2. A SPELLING IS NOT A PERIOD. The answer wrote "tháng 09 năm 2016" where
    #      the coverage tool had returned "2016-09-04", and the folded token did
    #      not appear in the evidence. Both name the same month. Comparison is on
    #      the canonical `YYYY-MM`.
    folded_blob = _fold(blob)
    for sentence in re.split(r"[.!?\n]+", text):
        for match in _PERIOD.finditer(sentence):
            raw = match.group(0)
            rest = sentence[:match.start()] + sentence[match.end():]
            if not _ANY_NUMBER.search(rest):
                continue                      # mentioned, not measured
            hints = _period_hints(raw)
            canonical = hints[0] if hints else None
            if hints:
                if _fold(raw) in folded_blob or any(h in folded_blob for h in hints):
                    continue
            else:
                # NO YEAR, WHICH IS THE HISTORICAL FAILURE ITSELF — "September
                # revenue" attached to an all-time scalar names no year either.
                # So it is still checked, against the month alone: an ISO month
                # segment or the same month written out. Only when the evidence
                # contains neither is the period unsourced.
                month = _month_of(raw)
                if month is None:
                    continue
                if any(hint in folded_blob for hint in (
                        f"-{month:02d}", f"thang {month}", f"thang {month:02d}")):
                    continue
                canonical = f"tháng {month}, không rõ năm"
            if any(v["kind"] == "scope" and v["claim"] == raw for v in found):
                continue
            found.append({
                "kind": "scope",
                "claim": raw,
                "why": (
                    f"Câu trả lời gán số liệu cho “{raw}” ({canonical}), nhưng kỳ "
                    "này không xuất hiện trong bất kỳ kết quả công cụ nào — không "
                    "có dòng, bộ lọc hay thông tin phạm vi nào nói tới nó. Số đang "
                    "có là số chưa lọc theo kỳ; hãy bỏ tên kỳ hoặc nói rõ đó là số "
                    "toàn kỳ."
                ),
            })

    # AGGREGATION — a rate renamed as a total. Fires only when EVERY declared
    # aggregation in the run is non-additive, so a run that summed something and also
    # averaged something is left alone.
    aggs = _declared_aggregations(blob)
    if aggs and aggs <= _NON_ADDITIVE and _SUM_WORD.search(text):
        found.append({
            "kind": "aggregation",
            "claim": ", ".join(sorted(aggs)),
            "why": (
                f"Câu trả lời gọi con số là “tổng”, nhưng phép gộp duy nhất trong dữ "
                f"liệu đã đọc là {', '.join(sorted(aggs))}. Một tỷ lệ hay trung bình "
                "không cộng được — hãy gọi đúng tên phép gộp."
            ),
        })

    return found


def _fold(s: str) -> str:
    from app.core.text_fold import fold_text

    return fold_text(s or "")
