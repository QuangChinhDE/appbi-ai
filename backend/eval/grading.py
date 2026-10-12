# -*- coding: utf-8 -*-
"""Meaning-based grading for the Agent Flow live evaluation.

The first harness counted an answer "wrong as verified" only when it contained a
number from a hand-written `wrong` list. Product revenue (13,591,643.70) published
as GMV was not on Q3's list, so every one of those runs was counted safe.

This grader starts from what the numbers MEAN. `FACTS` is every trusted value of
the two evaluation reports — measure, period, aggregation — produced by the engine
itself (deterministic Tool steps) or by the fixture rows. Each number an answer
states is looked up there:

  the expected fact for the question       → supports the answer
  another measure's value                  → wrong_metric
  the asked measure at another period      → wrong_period
  an invalid aggregation (e.g. ARR summed) → wrong_aggregation
  a value derivable from the question's facts (a delta, a %) → allowed
  nothing known                            → unsupported_number

and the answer as a whole is then one of the verdicts in `VERDICTS`. A wrong
number counts as CONFIDENT (`*_confident`) unless the run itself warned: a
withheld figure ([đã ẩn]) or an unverified-claim notice.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

VERDICTS = (
    "correct", "wrong_metric", "wrong_period", "wrong_scope", "wrong_aggregation", "unsupported_number",
    "false_missing_data", "legitimate_refusal", "withheld_by_checker", "incomplete",
    "execution_failed",
)


@dataclass(frozen=True)
class Fact:
    measure: str
    value: float
    period: str = ""            # "" = whole report / all periods
    aggregation: str = "valid"  # "invalid" = a sum that means nothing (balance over time)
    member: str = ""
    report: str = "saas"        # facts are judged only within their own report


ARR = dict(zip(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"],
               [600, 660, 696, 720, 792, 840, 864, 72]))
MRR = dict(zip(ARR, [50, 55, 58, 60, 66, 70, 72, 6]))
CHURN = dict(zip(ARR, [3, 2, 4, 1, 5, 2, 3, 40]))

FACTS: list[Fact] = [
    # Olist (dashboard 67): engine values read by deterministic Tool steps.
    Fact("total_revenue", 13591643.70, report="olist"),
    Fact("gmv", 15843553.24, report="olist"),
    Fact("total_revenue", 1258681.34, member="health_beauty", report="olist"),
    Fact("total_revenue", 1205005.68, member="watches_gifts", report="olist"),
    Fact("total_revenue", 1036988.68, member="bed_bath_table", report="olist"),
    Fact("gmv", 1179143.77, period="2017-11", report="olist"),
    Fact("gmv", 1159698.04, period="2018-04", report="olist"),
    # SaaS fixture (dashboard 136): the fixture rows.
    *[Fact("arr_active", v, period=p) for p, v in ARR.items()],
    *[Fact("mrr_active", v, period=p) for p, v in MRR.items()],
    *[Fact("cus_churned", v, period=p) for p, v in CHURN.items()],
    Fact("cus_churned", 60, period="2026-01..2026-08"),
    Fact("arr_active", 5244, aggregation="invalid"),        # ARR summed over all months
    Fact("mrr_active", 437, aggregation="invalid"),         # MRR summed over all months
    Fact("arr_active", 5000, member="enterprise"),
    Fact("arr_active", 1200, member="smb"),
    Fact("arr_active", 300, member="startup"),
    Fact("arr_active", 6500),                               # all segments: a real whole (one point in time)
]


@dataclass
class Expect:
    """What a correct answer says. `facts` must all be stated; `derived` are other
    numbers a correct answer may state (a delta, a share, a difference)."""
    facts: list[Fact]
    derived: list[float] = field(default_factory=list)
    words: list[str] = field(default_factory=list)       # e.g. a definition the answer must give
    refusal_expected: bool = False
    report: str = "saas"


def numbers(text: str) -> list[float]:
    return [v for v, _, _ in numbers_at(text)]


def numbers_at(text: str) -> list[tuple[float, int, int]]:
    """Numbers stated as figures, with their positions — not years, month numbers
    or list markers."""
    out = []
    for m in re.finditer(r"(?<![\w/])-?\d[\d.,]*\d|(?<![\w/])\d", text or ""):
        raw = m.group(0)
        after = text[m.end():m.end() + 1]
        if after == "/":                     # "8/2026": a month, not a figure
            continue
        before = text[max(0, m.start() - 2):m.start()]
        if before.endswith("[") or before.endswith("[e") or text[m.end():m.end() + 1] == "]":
            continue                            # "[1]", "[e3]": a citation, not a figure
        s = raw
        if "," in s and "." in s:
            s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
        elif s.count(",") > 1 or re.fullmatch(r"-?\d{1,3},\d{3}", s):
            s = s.replace(",", "")
        elif s.count(".") > 1 or re.fullmatch(r"-?\d{1,3}\.\d{3}", s):
            s = s.replace(".", "")
        else:
            s = s.replace(",", ".")
        try:
            v = float(s)
        except ValueError:
            continue
        if 1900 <= v <= 2100 and v == int(v):  # a year
            continue
        if re.search(r"(tháng|thang|month|quý|quy|ngày|ngay)\s*$", (text[max(0, m.start() - 8):m.start()]).lower()) \
                and v == int(v) and v <= 31:
            continue                            # "tháng 8": a month
        # "biểu đồ 1219", "chart 684", "ID 684": an identifier, not a figure. Round 7
        # graded a correct refusal citing chart 1219 as a confident wrong answer.
        if v == int(v) and re.search(r"(biểu đồ|bieu do|chart|chart_id|\bid|#)\s*(số\s*)?:?\s*$",
                                     (text[max(0, m.start() - 16):m.start()]).lower()):
            continue
        out.append((v, m.start(), m.end()))
    return out


#: How each measure is named in an answer (lower-case). A clause naming one of
#: these gives its numbers to that measure.
MEASURE_WORDS: dict[str, tuple[str, ...]] = {
    "gmv": ("gmv",),
    "total_revenue": ("doanh thu", "revenue"),
    "arr_active": ("arr",),
    "mrr_active": ("mrr",),
    "cus_churned": ("rời bỏ", "roi bo", "churn"),
}


def _clause(text: str, start: int, end: int) -> str:
    """The clause around a number: split on . ; , : and line breaks."""
    lo = max(text.rfind(c, 0, start) for c in ".;\n:") + 1
    his = [i for i in (text.find(c, end) for c in ".;\n") if i >= 0]
    return text[lo:min(his) if his else len(text)]


def _named(clause: str) -> set[str]:
    low = clause.lower()
    return {m for m, words in MEASURE_WORDS.items()
            if any(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", low) for w in words)}


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= max(0.006, abs(b) * 0.0005)


_MISSING = re.compile(r"(không có (dữ liệu|số liệu|biểu đồ|thông tin)|không tìm thấy|chưa có dữ liệu|"
                      r"no (data|chart)|not available|không thể cung cấp)", re.IGNORECASE)


@dataclass
class Grade:
    verdict: str
    confident: bool = False
    details: list[str] = field(default_factory=list)

    @property
    def confident_wrong(self) -> bool:
        return self.confident and self.verdict in ("wrong_metric", "wrong_period", "wrong_scope",
                                                  "wrong_aggregation", "unsupported_number")


def grade(answer: str, expect: Expect, *, status: str = "ok", notices: list[str] | None = None) -> Grade:
    notices = notices or []
    text = answer or ""
    warned = "[đã ẩn" in text or bool({"claims_unverified", "qualifier_unverified", "figures_unverified"}
                                        & set(notices))
    if status == "failed" and not text.strip():
        return Grade("execution_failed")
    located = numbers_at(text)
    nums = [v for v, _, _ in located]
    asked = {(f.measure, f.period, f.member) for f in expect.facts}
    asked_measures = {f.measure for f in expect.facts}
    details: list[str] = []
    worst = None
    order = ["wrong_metric", "wrong_aggregation", "wrong_period", "wrong_scope", "unsupported_number"]
    for v, a, b in located:
        # A BARE SMALL INTEGER ("1 tháng", "top 3") is a count of things in the
        # sentence far more often than a figure; judged only when it is expected.
        if v == int(v) and abs(v) < 10 and not any(_close(v, f.value) for f in expect.facts):
            continue
        hits = [f for f in FACTS if f.report == expect.report and _close(v, f.value)]
        # ATTRIBUTION FIRST: a known figure in a clause that names another measure
        # is that other measure's figure given the wrong name, whatever the
        # question asked (the GMV/revenue case the old counter missed).
        named = _named(_clause(text, a, b))
        if hits and named and not any(f.measure in named for f in hits):
            details.append(f"{v:g} is {hits[0].measure} but its clause names {sorted(named)} (wrong_metric)")
            worst = "wrong_metric"
            continue
        if hits and named and any(f.measure in named and f.aggregation == "valid"
                                  and f.measure not in asked_measures for f in hits)                 and not any(f.measure in named and f.aggregation == "invalid" for f in hits):
            continue          # a true figure under its own name: not wrong (completeness is judged below)
        if any(_close(v, f.value) for f in expect.facts) or any(_close(v, d) for d in expect.derived):
            continue
        if hits:
            f = hits[0]
            if f.aggregation == "invalid":
                kind = "wrong_aggregation"
            elif f.measure in asked_measures and (f.measure, f.period, f.member) not in asked:
                asked_members = {m for _, _, m in asked if m}
                if asked_members and f.member not in asked_members:
                    # ANOTHER MEMBER'S (or the whole's) figure is wrong only when its
                    # clause gives it to the member asked about: "ARR của enterprise là
                    # 6500" is; "6,500 là tổng của toàn bộ báo cáo" is not.
                    clause = _clause(text, a, b).lower()
                    if not any(m.lower() in clause for m in asked_members):
                        continue
                    kind = "wrong_scope"
                else:
                    kind = "wrong_period" if f.period or any(x[1] for x in asked) else "wrong_metric"
            else:
                kind = "wrong_metric"
            details.append(f"{v:g} is {f.measure}{'@' + f.period if f.period else ''}"
                           f"{'/' + f.member if f.member else ''} ({kind})")
        elif abs(v) >= 10 or v != int(v):
            kind = "unsupported_number"
            details.append(f"{v:g} matches no known fact")
        else:
            continue
        if worst is None or order.index(kind) < order.index(worst):
            worst = kind
    stated = all(any(_close(v, f.value) for v in nums) for f in expect.facts)
    words_ok = all(w.lower() in text.lower() for w in expect.words)
    if worst:
        return Grade(worst, confident=not warned, details=details)
    if expect.refusal_expected:
        return Grade("legitimate_refusal" if not nums or _MISSING.search(text) else "incomplete",
                     details=details)
    if stated and words_ok:
        return Grade("correct", details=details)
    if "[đã ẩn" in text:
        return Grade("withheld_by_checker", details=details)
    if _MISSING.search(text):
        return Grade("false_missing_data", confident=True, details=details)
    if status == "failed":
        return Grade("execution_failed", details=details)
    return Grade("incomplete", details=details)


def self_check() -> None:
    """The defects the old counter missed must be caught; correct answers must pass."""
    q3 = Expect(facts=[Fact("gmv", 15843553.24, report="olist")], derived=[13591643.70, 2251909.54],
                words=["vận chuyển"], report="olist")
    assert grade("Theo tài liệu [1], doanh thu sản phẩm [e2] là 13,591,643.70.",
                 Expect([Fact("total_revenue", 13591643.70, report="olist")], report="olist")
                 ).verdict == "correct"                                   # citations ignored
    # A chart identifier is not a figure; a figure beside it still is.
    assert numbers("biểu đồ 1219 không cho phép; chart 684; ID 684") == []
    assert numbers("biểu đồ ARR là 5244") == [5244.0]
    # The answer that escaped `wrong_as_verified` in every architecture:
    g = grade("GMV gồm phí vận chuyển. Theo báo cáo, GMV toàn kỳ là 13,591,643.70.", q3)
    assert g.verdict == "wrong_metric" and g.confident_wrong, g
    # A revenue figure under its own name, with GMV missing, is incomplete — not wrong:
    assert grade("GMV gồm phí vận chuyển nhưng báo cáo không có số GMV; doanh thu sản phẩm là "
                 "13,591,643.70.", q3).verdict in ("incomplete", "false_missing_data")
    # ... while revenue given to revenue, beside the right GMV, is correct:
    g = grade("GMV gồm phí vận chuyển. GMV toàn kỳ là 15,843,553.24; doanh thu sản phẩm là "
              "13,591,643.70.", q3)
    assert g.verdict == "correct", g
    s2 = Expect(facts=[Fact("arr_active", 72, "2026-08"), Fact("arr_active", 864, "2026-07")],
                derived=[-792, 792, -91.67, 91.67])
    g = grade("Không so sánh được. Tổng ARR từ tất cả các tháng là 5244.", s2)
    assert g.verdict == "wrong_aggregation" and g.confident_wrong, g
    s1 = Expect(facts=[Fact("arr_active", 72, "2026-08")])
    assert grade("ARR tháng 7/2026 là 864.", s1).verdict == "wrong_period"
    assert grade("ARR tháng 8/2026 là 72.", s1).verdict == "correct"
    h1 = Expect(facts=[Fact("cus_churned", 60, "2026-01..2026-08")])
    assert grade("Không có dữ liệu khách rời bỏ theo tháng.", h1).verdict == "false_missing_data"
    assert grade("Tổng là [đã ẩn: chưa kiểm chứng].", h1).verdict == "withheld_by_checker"
    assert grade("Tổng số khách rời bỏ tháng 1-8/2026 là 60.", h1).verdict == "correct"
    assert grade("Tổng là 58,3.", h1).verdict == "unsupported_number"
    s5 = Expect([Fact("arr_active", 5000, member="enterprise")])
    assert grade("ARR của phân khúc enterprise là 6500.", s5).verdict == "wrong_scope"
    assert grade("Không có số riêng; 6,500 là tổng của toàn bộ báo cáo.", s5).verdict != "wrong_scope"


if __name__ == "__main__":
    self_check()
    print("grading self-check ok")
