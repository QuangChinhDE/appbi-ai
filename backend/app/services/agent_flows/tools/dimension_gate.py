# -*- coding: utf-8 -*-
"""A grouped answer must be grouped by the thing that was asked about.

    question:  "Bang nào có doanh thu cao nhất?"        (which STATE)
    answer:    "health_beauty"                          (a product CATEGORY)

Reproduced live on report 67 twice in a row. `rank_values` ran on the
revenue-by-category chart, returned a correct ranking OF CATEGORIES, and the
answer presented the winner as the answer to a question about states. The
arithmetic was right and the semantic dimension was wrong, which is the worst
shape a BI answer can take: indistinguishable from a correct one.

WHY THE FIX IS HERE AND NOT IN THE SELECTION STEP. The flow's report-read step
runs in report-order mode, which is a legitimate authoring choice and stays one.
The answering Agent then calls the tool DIRECTLY with a chart id it picked
itself, so the last moment at which anything can tell the difference is the
moment before the tool runs — the same moment the capability gate already uses.

WHAT IT IS NOT. Not a relevance judge and not a second resolver. It asks one
question of two structured facts:

    the governed DIMENSION the viewer's question names   (semantic model + kind)
    the grouping key the chart actually uses             (roleConfig, via chart_meta)

and refuses only when both exist and disagree. A question with no breakdown in
it, a scalar tool, a chart whose grouping the runtime cannot see, or a run with
no question at all — each of those is silence, not a refusal. A KPI question has
no dimension and must never be gated.

THE REFUSAL IS RECOVERABLE ON PURPOSE. It names both dimensions and points at
`resolve_chart_candidates`, so the model can find a chart that DOES group by what
was asked. If none exists the honest answer is that this report cannot break the
measure down that way — which is a better answer than a confident wrong one.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Any

from app.services.agent_flows.tools import result as R
from app.services.agent_flows.tools.packs.discover import (
    _score, _terms_of, field_key,
)

#: Tools whose RESULT is per-group, so the chart's grouping key IS the answer's
#: subject.
#:
#: `get_chart_data` was left OUT of the first version on the reasoning that it
#: hands back rows the model still has to interpret. Measured on the next live
#: run, that is exactly what the model did: refused the category chart, read rows
#: from the monthly GMV chart instead, and answered "doanh thu cao nhất là
#: 1,179,143.77 vào tháng 11 năm 2017" — a MONTH offered as the answer to a
#: question about states. Rows carrying a grouping column are a grouped result
#: with one more step in front of it, and closing the first substitution route
#: while leaving the second open closes nothing.
#:
#: Still deliberately short. `total_measure` is a scalar and `compare_periods`
#: groups by time because that is what it is FOR — neither turns the chart's
#: dimension into the noun of the answer.
DIMENSION_SENSITIVE = frozenset({
    "rank_values",
    "share_of",
    "aggregate_chart_data",
    "compare_segments",
    "segment_compare",
    "get_chart_data",
})

#: A dimension is usually named in ONE word — "bang", "state", "danh mục" — so
#: the measure-side threshold of two would delete every dimension there is. One
#: shared token is enough to ASK the question; it is never enough to answer it,
#: because the refusal below also requires the chart to disagree.
_MIN_DIMENSION_SCORE = 1


def _semantic_fields(ctx: Any) -> list[dict]:
    from app.services.dashboard_ai_bot.govern_tools import (
        tool_describe_semantic_model,
    )

    try:
        res = tool_describe_semantic_model(ctx, {"query": getattr(ctx, "question", "")})
    except Exception:                                           # noqa: BLE001
        return []
    if not isinstance(res, dict) or not res.get("ok"):
        return []
    data = res.get("data") if isinstance(res.get("data"), dict) else res
    return [f for f in (data.get("fields") or []) if isinstance(f, dict)]


_RAW_WORD = re.compile(r"[0-9a-zà-ỹđ]+")


def _raw_terms(text: str) -> set[str]:
    """Words AS WRITTEN — lower-cased, diacritics kept. "bảng" (a table) and
    "bang" (a state) are different words; folding made them one, and a category
    chart titled "Bảng doanh thu theo danh mục" then answered for states."""
    t = unicodedata.normalize("NFC", str(text or "").lower())
    return {w for w in _RAW_WORD.findall(t) if len(w) > 1}


def _fold_word(word: str) -> str:
    return next(iter(_terms_of(word)), word)


def chart_dimension_words(ctx: Any) -> dict[int, list[tuple[str, set[str], set[str]]]]:
    """Per chart in scope: (grouping field, its field words, its TITLE words).

    ONE DEFINITION for the gate here and for `resolve_chart_candidates`, so the
    two cannot disagree about what a chart's breakdown is called.

    Title words are kept as written (see `_raw_terms`) and a word most titles
    share is dropped: "Olist · X theo Y · page-1" puts "olist", "theo" and "page"
    in every title, and a question saying "theo" then named every breakdown at
    once — found by review, the gate let the category chart answer "doanh thu
    theo bang?".
    """
    allowed = tuple(sorted(getattr(ctx, "allowed_chart_ids", None) or set()))
    cached = getattr(ctx, "_dimension_words_cache", None)
    if cached and cached[0] == allowed:
        return cached[1]
    meta_all = getattr(ctx, "chart_meta", None) or {}
    titled: dict[int, set[str]] = {}
    for cid in allowed:
        meta = meta_all.get(cid) or {}
        if ((meta.get("fields") or {}).get("dimensions") or []):
            # A PARENTHESISED WORD QUALIFIES THE BREAKDOWN, IT DOES NOT NAME IT.
            # "Số đơn theo bang (khách)": found in acceptance, a question about
            # "tiền khách đã thanh toán" became a question BY STATE, and its
            # correct total was withheld as a whole-report figure.
            titled[cid] = _raw_terms(re.sub(r"\([^)]*\)", " ", str(meta.get("name") or "")))
    common: set[str] = set()
    if len(titled) >= 3:
        counts = Counter(w for words in titled.values() for w in words)
        common = {w for w, n in counts.items() if n >= 3 and n > len(titled) / 2}
    out: dict[int, list[tuple[str, set[str], set[str]]]] = {}
    for cid, words in titled.items():
        for d in ((meta_all.get(cid) or {}).get("fields") or {}).get("dimensions") or []:
            ref = d.get("field") if isinstance(d, dict) else d
            if not ref:
                continue
            field_words = _terms_of(field_key(ref))
            if isinstance(d, dict):
                field_words |= _terms_of(str(d.get("label") or ""))
            out.setdefault(cid, []).append((str(ref), field_words, words - common))
    try:
        ctx._dimension_words_cache = (allowed, out)
    except Exception:                                           # noqa: BLE001
        pass
    return out


def _ambiguous_folds(ctx: Any) -> set[str]:
    """Folded forms two different written words share across the titles in
    scope ("bang" ← "bang", "bảng"). An unaccented question word matching one of
    these cannot say which it meant, so it matches only the unaccented one."""
    by_fold: dict[str, set[str]] = {}
    for rows in chart_dimension_words(ctx).values():
        for _ref, _fw, tw in rows:
            for w in tw:
                by_fold.setdefault(_fold_word(w), set()).add(w)
    return {f for f, forms in by_fold.items() if len(forms) > 1}


def title_hits(ctx: Any, asked: set[str], title_words: set[str]) -> set[str]:
    """Which of the asked words (as written) the title carries. An unaccented
    asked word also matches an accented title word it folds to — unless the
    report's titles use that folded form for two different words."""
    hits = asked & title_words
    ambiguous = _ambiguous_folds(ctx)
    # A QUESTION WRITTEN WITH DIACRITICS MEANS ITS PLAIN WORDS AS WRITTEN. "trang
    # tổng quan" (a page) folded onto "trạng thái" (status) and invented a
    # breakdown by status; the correct total was then withheld as a member's
    # figure (acceptance runs 4207, 4419). Folding is for questions typed
    # without accents at all.
    accented = any(not w.isascii() for w in asked)
    for q in asked - title_words:
        fq = _fold_word(q)
        if fq in ambiguous:
            continue
        # Either side may be the one written without accents; the fold is
        # trusted only when the report's titles never use it for two words.
        if any(_fold_word(t) == fq and ((q.isascii() and not accented) or t.isascii())
               for t in title_words):
            hits.add(q)
    return hits


def _chart_dimension_vocabulary(ctx: Any) -> list[tuple[str, set[str], set[str]]]:
    """Every breakdown this report offers, and the words that name it.

    THE GOVERNED `kind` IS NOT ENOUGH ON ITS OWN, and measuring that is what this
    function exists for. On the certification deployment
    `describe_semantic_model` returns 24 fields and EVERY ONE of them is
    `kind="measure"` — not one dimension is declared. A gate that waits for a
    declared dimension is a gate that never fires, on the exact report the defect
    was found on.

    What does exist, on every report, is the charts themselves: each declares its
    grouping key in `roleConfig`, and each carries a NAME its author wrote in the
    business's own language. "Olist · Số đơn theo bang (khách)" is where the word
    "bang" lives; the auto-humanised label is "Customer state" and would never
    match a Vietnamese question.

    The measure half of the question is removed on the OTHER side — see
    `_dimension_terms` — because a BI title reads "<measure> theo <dimension>"
    and the measure words are in both the title and the question.
    """
    return [row for rows in chart_dimension_words(ctx).values() for row in rows]


def _dimension_terms(ctx: Any, question: str) -> tuple[set[str], set[str]]:
    """The question's words, minus the ones that name a MEASURE.

    A WORD THAT NAMES WHAT IS BEING MEASURED IS NOT NAMING THE BREAKDOWN, and
    without saying so the ranking picks the wrong chart on the very question this
    gate exists for. "Bang nào có doanh thu cao nhất?" carries `doanh` and `thu`;
    so does the title "Olist · Doanh thu theo danh mục". The category chart then
    shares two words with the question and the state chart shares one, and the
    question about STATES resolves to the chart about CATEGORIES.

    The measure vocabulary is the governed one. It is the half of the semantic
    model this deployment actually fills in — 24 declared measures, with the
    Vietnamese labels the questions are written in — which is exactly why it can
    be relied on for subtraction while `kind="dimension"` cannot be relied on for
    selection.
    """
    terms = _terms_of(question)
    measure_words: set[str] = set()
    for f in _semantic_fields(ctx):
        if str(f.get("kind") or "").strip().lower() == "dimension":
            continue
        for key in ("name", "label"):
            measure_words |= _terms_of(str(f.get(key) or ""))
    stripped = terms - measure_words
    # Never strip the question down to nothing: a question made ENTIRELY of
    # measure words names no breakdown, and an empty set says that honestly.
    # The words AS WRITTEN, for titles; minus the same measure words.
    raw = {w for w in _raw_terms(question) if _fold_word(w) not in measure_words}
    return stripped, raw


def requested_dimension(ctx: Any) -> str | None:
    """The dimension this run's question asks to break down by, or None.

    Governed truth first: a semantic field the business declared `kind`
    ``dimension``. Where the model declares none — the common case, measured — it
    falls back to the breakdowns the authorised charts actually offer.

    Computed once per context and cached, because every grouped tool in the run
    asks the same question of it.
    """
    cache = getattr(ctx, "_dimension_cache", None)
    if cache is None:
        cache = {}
        try:
            ctx._dimension_cache = cache
        except Exception:                                       # noqa: BLE001
            pass
    question = str(getattr(ctx, "question", "") or "").strip()
    # KEYED ON THE QUESTION. A Skill's child context is a shallow copy of its
    # caller's, so it shares this dict — found by review: a child asked "Tổng
    # doanh thu là bao nhiêu?" was gated by its parent's "customer_state".
    if question in cache:
        return cache[question]
    if not question:
        cache[question] = None
        return None

    wanted = _terms_of(question)
    best: tuple[int, str] | None = None

    for f in _semantic_fields(ctx):
        if str(f.get("kind") or "").strip().lower() != "dimension":
            continue
        name = str(f.get("name") or "")
        if not name:
            continue
        hay = " ".join(str(f.get(k) or "") for k in ("name", "label", "description"))
        # A question written with diacritics is compared AS WRITTEN — see
        # `title_hits`: "trang" (a page) is not "Trạng thái" (status).
        if any(not w.isascii() for w in _raw_terms(question)):
            score = len(_raw_terms(question) & (_raw_terms(hay) | set(str(f.get("name") or "").lower().split("_"))))
        else:
            score = _score(hay, wanted)
        if score >= _MIN_DIMENSION_SCORE and (best is None or score > best[0]):
            best = (score, name)

    if best is None:
        narrowed, narrowed_raw = _dimension_terms(ctx, question)
        for ref, field_words, title_words in _chart_dimension_vocabulary(ctx):
            score = len(narrowed & field_words) + len(title_hits(ctx, narrowed_raw, title_words))
            if score >= _MIN_DIMENSION_SCORE and (best is None or score > best[0]):
                best = (score, ref)

    cache[question] = best[1] if best else None
    return cache[question]


def _question_names_this_chart_dimension(ctx: Any, chart_id: int) -> bool:
    """Does the viewer's question already name the breakdown this chart has?

    THE SAFETY VALVE. Ranking picks ONE best dimension, and a question can name a
    breakdown the ranking did not choose — "doanh thu theo danh mục" mentions the
    category, and if some other chart happened to score higher the gate would
    refuse a call that answers exactly what was asked. So a chart whose own
    breakdown is named in the question is never refused, whatever won the ranking.
    """
    question = str(getattr(ctx, "question", "") or "")
    wanted, wanted_raw = _dimension_terms(ctx, question)
    if not wanted and not wanted_raw:
        return False
    mine = set(_chart_dimensions(ctx, chart_id))
    for ref, field_words, title_words in _chart_dimension_vocabulary(ctx):
        if ref in mine and (wanted & field_words or title_hits(ctx, wanted_raw, title_words)):
            return True
    return False


def dimension_label(ctx: Any, field_ref: str) -> str:
    """The on-screen label for a dimension, for surfaces a READER looks at.

    A column path is the right thing to show an author in a trace and the wrong
    thing to show a viewer in a notice. Where the runtime already extracted a
    label from the chart, that is what a person recognises.
    """
    want = field_key(field_ref)
    for meta in (getattr(ctx, "chart_meta", None) or {}).values():
        for d in ((meta or {}).get("fields") or {}).get("dimensions") or []:
            if isinstance(d, dict) and field_key(d.get("field")) == want:
                label = str(d.get("label") or "").strip()
                if label:
                    return label
    return want.replace("_", " ").strip()


def _chart_dimensions(ctx: Any, chart_id: int) -> list[str]:
    meta = (getattr(ctx, "chart_meta", None) or {}).get(chart_id) or {}
    fields = meta.get("fields") or {}
    out = []
    for d in fields.get("dimensions") or []:
        ref = d.get("field") if isinstance(d, dict) else d
        if ref:
            out.append(str(ref))
    return out


def refusal(ctx: Any, tool_name: str, args: dict | None) -> dict | None:
    """A structured refusal when this grouped call answers a different question."""
    if tool_name not in DIMENSION_SENSITIVE:
        return None
    chart_id = (args or {}).get("chart_id")
    if not isinstance(chart_id, int):
        return None

    wanted = requested_dimension(ctx)
    if not wanted:
        return None                       # the question named no breakdown

    have = _chart_dimensions(ctx, chart_id)
    if not have:
        return None                       # nothing to compare against; stay silent

    want_key = field_key(wanted)
    if any(field_key(h) == want_key for h in have):
        return None
    if _question_names_this_chart_dimension(ctx, chart_id):
        return None

    shown = ", ".join(field_key(h) or h for h in have)
    # THE WAY OUT, NAMED. Live on a 70-chart report the model tried six wrong
    # charts and never called the resolver this refusal pointed it to. The
    # authorised charts that DO group by the asked breakdown are known right here
    # — same scope, same grouping keys — so the refusal hands their ids over.
    # Charts sharing the refused chart's measure come first.
    options = charts_grouped_by(ctx, want_key, prefer_like=chart_id)
    if options:
        listed = "; ".join(f"{o['chart_id']} ({o['name']})" for o in options)
        recovery = (f"Các biểu đồ trong phạm vi nhóm theo '{want_key}': {listed}. Dùng đúng "
                    "biểu đồ có số đo được hỏi trong số này (hoặc gọi resolve_chart_candidates "
                    f"với dimension='{want_key}' kèm measure để tìm thêm). Nếu không biểu đồ nào có số đo "
                    f"được hỏi, nói thẳng là báo cáo không tách số đó theo '{want_key}' — "
                    "đừng thay bằng một chiều khác.")
    else:
        recovery = (f"Không biểu đồ nào trong phạm vi nhóm theo '{want_key}' (resolve_chart_candidates "
                    f"với dimension='{want_key}' cũng sẽ không tìm thấy). Nói thẳng là báo "
                    f"cáo này không tách được số liệu theo '{want_key}' — đừng thay bằng một "
                    "chiều khác.")
    return R.err(
        f"biểu đồ {chart_id} nhóm theo '{shown}', không phải theo '{want_key}' — "
        f"câu hỏi đang hỏi theo '{want_key}'. Kết quả của công cụ này sẽ đúng cho "
        f"'{shown}' và KHÔNG trả lời được câu hỏi đã đặt.",
        code="dimension_mismatch",
        retryable=False,
        recovery=recovery,
        detail={"requested_dimension": want_key,
                "requested_label": dimension_label(ctx, wanted),
                "chart_dimensions": have, "chart_id": chart_id,
                "charts_with_dimension": [o["chart_id"] for o in options]},
    )


def _chart_measures(ctx: Any, chart_id: int) -> set[str]:
    meta = (getattr(ctx, "chart_meta", None) or {}).get(chart_id) or {}
    out = set()
    for m in (meta.get("fields") or {}).get("measures") or []:
        ref = m.get("field") if isinstance(m, dict) else m
        if ref:
            out.add(field_key(str(ref)))
    return out


def charts_grouped_by(ctx: Any, want_key: str, *, prefer_like: int | None = None,
                      limit: int = 6) -> list[dict]:
    """Authorised charts whose grouping key IS `want_key` — the same scope and the
    same structured keys the gate reads; charts sharing `prefer_like`'s measure first."""
    meta = getattr(ctx, "chart_meta", None) or {}
    allowed = getattr(ctx, "allowed_chart_ids", None) or set()
    like = _chart_measures(ctx, prefer_like) if prefer_like is not None else set()
    found = []
    for cid in sorted(allowed):
        if cid == prefer_like or cid not in meta:
            continue
        if any(field_key(d) == want_key for d in _chart_dimensions(ctx, cid)):
            found.append((0 if like & _chart_measures(ctx, cid) else 1, cid))
    return [{"chart_id": cid, "name": str((meta.get(cid) or {}).get("name") or f"Chart {cid}")[:60]}
            for _, cid in sorted(found)[:limit]]


#: Tools that read ONE figure of a chart as it stands — its whole period.
PERIOD_SENSITIVE = frozenset({"total_measure", "get_chart_summary", "get_chart_data"})


def period_refusal(ctx: Any, tool_name: str, args: dict | None) -> dict | None:
    """Asked about an explicit period, reading an all-period figure is refused when
    an authorised chart gives the same measure BY PERIOD.

    Measured in acceptance on report 67: asked "tỷ lệ giao đúng hẹn tháng 3/2018",
    the agent read the all-time KPI tile and called it March's, although chart 712
    gives the rate month by month. When no chart splits the measure by period the
    read is allowed — the answer must then say it is the overall figure, which the
    claim check holds it to.
    """
    if tool_name == "compare_periods":
        return _compare_periods_refusal(ctx, args or {})
    if tool_name not in PERIOD_SENSITIVE:
        return None
    chart_id = (args or {}).get("chart_id")
    if not isinstance(chart_id, int) or (args or {}).get("filters"):
        return None
    from app.services.time_semantics import looks_like_time_name, named_periods

    if not named_periods(str(getattr(ctx, "question", "") or "")):
        return None
    if any(looks_like_time_name(d) for d in _chart_dimensions(ctx, chart_id)):
        return None
    like = _chart_measures(ctx, chart_id)
    if not like:
        return None
    meta = getattr(ctx, "chart_meta", None) or {}
    options = [cid for cid in sorted(getattr(ctx, "allowed_chart_ids", None) or set())
               if cid != chart_id and cid in meta
               and any(looks_like_time_name(d) for d in _chart_dimensions(ctx, cid))
               and like & _chart_measures(ctx, cid)][:6]
    if not options:
        return None
    listed = "; ".join(f"{cid} ({str((meta.get(cid) or {}).get('name') or '')[:60]})" for cid in options)
    return R.err(
        f"biểu đồ {chart_id} cho số của TOÀN BỘ thời gian, còn câu hỏi hỏi về một kỳ cụ thể — "
        "con số này không phải số của kỳ được hỏi.",
        code="period_not_in_chart",
        retryable=False,
        recovery=(f"Các biểu đồ trong phạm vi cho cùng số đo theo từng kỳ: {listed}. Đọc đúng kỳ "
                  "được hỏi từ một biểu đồ này (get_chart_data / compare_periods). Nếu kỳ đó không "
                  "có trong dữ liệu, nói thẳng như vậy."),
        detail={"chart_id": chart_id, "charts_by_period": options},
    )


def _label(period: tuple) -> str:
    if period[0] == "m":
        return f"{period[1]}-{period[2]:02d}"
    if period[0] == "q":
        return f"{period[1]}-Q{period[2]}"
    return str(period[1])


def _compare_periods_refusal(ctx: Any, args: dict) -> dict | None:
    """The question names the periods; an automatic comparison of the LAST two is
    another question. Measured in acceptance: asked "tháng 1/2018 so với tháng
    12/2017", a Skill ran compare_periods(mode=auto) and compared 2018-09 with
    2018-08. Refused with the exact custom call instead of silently re-pointed."""
    from app.services.time_semantics import named_periods

    if str(args.get("mode") or "auto").lower() == "custom":
        # A custom comparison whose CURRENT period is the earlier one reports the
        # change backwards (acceptance run 4176: Q3 vs Q4 → "giảm 29,85%" for a
        # +42,56% rise). Refused with the order swapped.
        a = named_periods(str(args.get("period_a") or "").replace("Q", " q")) \
            or named_periods("nam " + str(args.get("period_a") or ""))
        b = named_periods(str(args.get("period_b") or "").replace("Q", " q")) \
            or named_periods("nam " + str(args.get("period_b") or ""))
        if len(a) == 1 and len(b) == 1:
            (pa,), (pb,) = a, b
            if pa[0] == pb[0] and pa < pb:
                return R.err(
                    f"period_a ({args.get('period_a')}) is EARLIER than period_b "
                    f"({args.get('period_b')}): compare_periods reports the change from "
                    "period_b to period_a, so this call measures the change backwards.",
                    code="period_not_in_chart", retryable=False,
                    recovery=(f"Call compare_periods again with period_a='{args.get('period_b')}' "
                              f"(the later period, the current one) and period_b='{args.get('period_a')}'."),
                    detail={"period_a": args.get("period_b"), "period_b": args.get("period_a")},
                )
        return None

    asked = sorted(named_periods(str(getattr(ctx, "question", "") or "")), reverse=True)
    grains = {p[0] for p in asked}
    if not asked or len(asked) > 2 or len(grains) != 1 or asked[0][0] == "y":
        return None
    if len(asked) == 1:
        from app.services.time_semantics import comparison_baseline

        asked = [asked[0], comparison_baseline(str(getattr(ctx, "question", "") or ""), asked[0])]
    a, b = _label(asked[0]), _label(asked[1])
    return R.err(
        f"câu hỏi nêu kỳ {a} và {b}; compare_periods ở chế độ tự động so hai kỳ CUỐI của "
        "biểu đồ — không phải hai kỳ được hỏi.",
        code="period_not_in_chart",
        retryable=False,
        recovery=(f"Gọi lại compare_periods với mode='custom', period_a='{a}', period_b='{b}' "
                  "(cùng chart_id). Nếu nhãn kỳ của biểu đồ khác dạng, lỗi trả về sẽ liệt kê các "
                  "nhãn hợp lệ — chọn đúng hai kỳ được hỏi trong danh sách đó."),
        detail={"period_a": a, "period_b": b},
    )
