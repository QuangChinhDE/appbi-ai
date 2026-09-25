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
#: `get_chart_summary` for the same reason, measured the same way. It joined the
#: routing core so KPI questions could be read — and on a grouped chart its
#: `top_values` ARE per-group figures. Live, asked "Bang SP chiếm bao nhiêu phần
#: trăm tổng doanh thu?", a run summarised the revenue-by-CATEGORY chart and
#: answered "Bang SP … 1,258,681.34 … 9.26%" — health_beauty's figures, presented
#: as a state's. On a chart with no grouping (a KPI tile) the gate stays silent.
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
    "get_chart_summary",
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
            titled[cid] = _raw_terms(str(meta.get("name") or ""))
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
    for q in asked - title_words:
        fq = _fold_word(q)
        if fq in ambiguous:
            continue
        # Either side may be the one written without accents; the fold is
        # trusted only when the report's titles never use it for two words.
        if any(_fold_word(t) == fq and (q.isascii() or t.isascii()) for t in title_words):
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
    if "value" in cache:
        return cache["value"]

    question = str(getattr(ctx, "question", "") or "").strip()
    if not question:
        cache["value"] = None
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
        score = _score(hay, wanted)
        if score >= _MIN_DIMENSION_SCORE and (best is None or score > best[0]):
            best = (score, name)

    if best is None:
        narrowed, narrowed_raw = _dimension_terms(ctx, question)
        for ref, field_words, title_words in _chart_dimension_vocabulary(ctx):
            score = len(narrowed & field_words) + len(title_hits(ctx, narrowed_raw, title_words))
            if score >= _MIN_DIMENSION_SCORE and (best is None or score > best[0]):
                best = (score, ref)

    cache["value"] = best[1] if best else None
    return cache["value"]


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
    return R.err(
        f"biểu đồ {chart_id} nhóm theo '{shown}', không phải theo '{want_key}' — "
        f"câu hỏi đang hỏi theo '{want_key}'. Kết quả của công cụ này sẽ đúng cho "
        f"'{shown}' và KHÔNG trả lời được câu hỏi đã đặt.",
        code="dimension_mismatch",
        retryable=False,
        recovery=(
            f"Gọi resolve_chart_candidates với dimension='{want_key}' (kèm measure "
            "nếu câu hỏi có nêu) để tìm biểu đồ thực sự nhóm theo chiều này. Nếu "
            "không có biểu đồ nào, hãy nói thẳng là báo cáo này không tách được số "
            f"liệu theo '{want_key}' — đừng thay bằng một chiều khác."
        ),
        detail={"requested_dimension": want_key,
                "requested_label": dimension_label(ctx, wanted),
                "chart_dimensions": have, "chart_id": chart_id},
    )
