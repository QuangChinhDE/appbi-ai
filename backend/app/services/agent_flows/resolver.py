# -*- coding: utf-8 -*-
"""ONE path from a business question to the assets that answer it.

WHY THIS EXISTS

`list_charts` matches a question against chart names and on-screen field labels,
folded and tokenised. That is enough for "doanh thu theo danh mục" and not enough
for real BI language:

    question: "phân tích biến động mrr qua từng tháng"
    chart:    "[Demo_NetSuite] MRR Active by time"
    measure:  mrr_active          dimension: year_month

Only `mrr` overlaps. "biến động" and "qua từng tháng" are correct business
language that appears nowhere in the English metadata, so the lexical pass
returns `ambiguous` and the caller falls back to report order — reading whatever
happens to be first and presenting it as an answer to the question.

WHAT THIS IS NOT

Not a new matching algorithm, and not an LLM guess. It COMPOSES paths that
already exist and are already audited:

    lexical    list_charts                 name + on-screen labels
    semantic   search_business_assets      governed metrics, glossary terms,
                                           semantic fields, descriptions
    bridge     resolve_chart_candidates    metric/field -> the charts realising it

The bridge is the part that was missing. Matching "mrr" to the governed metric
`mrr_active` was already possible; nothing walked from that metric back to the
chart that plots it.

PERMISSION

Resolution MAY NARROW scope and MUST NEVER DEFINE OR WIDEN it. Every id returned
is intersected with the caller's already-authorised set, here, once — not left to
a caller to remember.

AMBIGUITY STAYS VISIBLE

The status vocabulary is the point. "Could not tell which chart this is about" is
not "the first charts are relevant", and a deterministic step must not make a
semantic guess it cannot justify.
"""
from __future__ import annotations

from typing import Any, Callable, Literal

from app.services.agent_flows.tools.packs.discover import _TIME_GRAIN_WORDS, _score, _terms_of

Status = Literal["exact", "semantic", "ambiguous", "none", "lookup_failed"]

#: How this module reaches a tool: `call(name, args) -> normalised result`.
#:
#: INJECTED RATHER THAN IMPORTED, and the reason is a defect this shipped with for
#: one commit. Calling the tool functions directly meant passing a context, the
#: caller passed the RunContext instead of the ToolContext inside it, and the whole
#: question-matching path died with `'RunContext' object has no attribute
#: 'allowed_chart_ids'` — while the unit tests stayed green, because they stubbed
#: both searches and never exercised a real context.
#:
#: Taking a `call` removes the parameter that was wrong. It also puts these calls
#: back through `tool_registry.execute`, which is what counts them against the
#: turn's tool budget and records them in the run's tool log; calling the functions
#: directly silently bypassed both.
Call = Callable[[str, dict], Any]

#: Above this many distinct concepts behind the candidates, the question is not
#: pointing at one thing. Two charts realising ONE metric is a ranked answer; two
#: charts arriving from two unrelated metrics is a question we did not understand.
_AMBIGUOUS_AT = 2

#: Words that say WHEN or ASK, never WHAT. Live round 7: "ARR tháng 8 năm 2026 là
#: bao nhiêu?" has seven terms and one of them names the figure, so `arr_active`
#: — matched on that one — failed "every term of a short question" and was
#: dropped; the hybrid writer got no chart and said the data did not exist. The
#: period is resolved by the measuring tools, not by picking an asset.
_FILLER = {"la", "bao", "nhieu", "gi", "what", "is", "was", "the", "of", "how", "much", "many"}
#: Finest first: the grain a question names, when it names several.
_GRAIN_ORDER = ("ngay", "day", "daily", "date", "tuan", "week", "weekly", "thang", "month",
                "monthly", "quy", "quarter", "quarterly", "nam", "year", "yearly", "annual")


def _content_terms(question: str) -> set[str]:
    return {t for t in _terms_of(question)
            if t not in _FILLER and t not in _TIME_GRAIN_WORDS and not t.isdigit()}


def _grain_named(question: str) -> str:
    terms = _terms_of(question)
    return next((g for g in _GRAIN_ORDER if g in terms), "")


def _lexical(call: Call, question: str) -> tuple:
    """`list_charts`' own verdict. Its fallback listing is never a match.

    A third element carries each listed chart's on-screen measure labels and a
    fourth its name, both already read by this call — see `_by_measure_label`
    and `_by_name_winner`."""
    res = call("list_charts", {"query": question})
    if not isinstance(res, dict) or not res.get("ok"):
        return "lookup_failed", []
    data = res.get("data") if isinstance(res.get("data"), dict) else res
    labels = {c["chart_id"]: [str(m) for m in (c.get("measures") or []) if m]
              for c in (data.get("charts") or [])
              if isinstance(c, dict) and isinstance(c.get("chart_id"), int)}
    names = {c["chart_id"]: str(c.get("chart_name") or "")
             for c in (data.get("charts") or [])
             if isinstance(c, dict) and isinstance(c.get("chart_id"), int)}
    selection = data.get("selection") if isinstance(data.get("selection"), dict) else {}
    status = str(selection.get("status") or "")
    ids = [c for c in (selection.get("selected_ids") or []) if isinstance(c, int)]
    if not status:
        coverage = data.get("coverage") if isinstance(data.get("coverage"), dict) else {}
        if "query_matched_nothing" in coverage:
            return "none", [], labels, names
        ids = ids or [
            c.get("chart_id") for c in (data.get("charts") or [])
            if isinstance(c, dict) and isinstance(c.get("chart_id"), int)
        ]
        return ("matched" if ids else "none"), ids, labels, names
    return status, ids, labels, names


def _semantic(call: Call, question: str) -> list[dict]:
    """Charts reached through a governed metric or a semantic field.

    Returns one entry per (concept, chart) so the caller can see how many
    DISTINCT concepts the question touched — which is what separates a ranked
    answer from an ambiguous one.
    """
    found = call("search_business_assets", {"query": question})
    if not isinstance(found, dict) or not found.get("ok"):
        return []
    data = found.get("data") if isinstance(found.get("data"), dict) else found

    # WHAT THE QUESTION NAMED, BY WHAT KIND OF THING IT IS.
    #
    # This loop used to send every surviving asset to `resolve_chart_candidates`
    # as a `measure`, because `search_business_assets` published field results
    # typed only `"field"` — the semantic `kind` was read and dropped on the way
    # out. So a DIMENSION was resolved as a measure, any chart mentioning it
    # matched, and "bang nào có doanh thu cao nhất?" came back with
    # `health_beauty`: a product category presented as a state.
    #
    # Now the kinds are kept apart, and when the question named both a measure
    # and a breakdown the pair is resolved TOGETHER — a chart answers it only by
    # having both.
    measures: list[tuple[dict, str, int]] = []      # (asset, ident, strength)
    dimensions: list[tuple[dict, str, int]] = []
    #: Dimensions that matched on one token only — usable as the second half of a
    #: pair, never on their own. See the note at the threshold below.
    weak_dimensions: list[tuple[dict, str, int]] = []
    metrics: list[tuple[dict, str, int]] = []

    for asset in (data.get("results") or []):
        if not isinstance(asset, dict):
            continue
        kind = asset.get("type")
        if kind not in ("metric", "field"):
            continue
        # `id` carries the IDENTIFIER (governed metric name / semantic field
        # name); `name` is the display label. `resolve_chart_candidates` matches
        # on the identifier, so passing the label finds nothing.
        ident = asset.get("id") or asset.get("name") or ""
        if not ident:
            continue
        # HOW STRONG IS THIS, ACTUALLY?
        #
        # `search_business_assets` returns anything sharing ONE token, which is
        # right for a model that reads the list and judges. This caller has no
        # judge, and it treated every hit as a semantic match: asked "thời tiết Hà
        # Nội hôm nay", it reported `status: "semantic"` on two Olist charts and
        # the answer opened with 91.89% and 99,441 before admitting it had no
        # weather data. One incidental word is not a match.
        #
        # Scored with the discover pack's own scorer, not a second one. Two shared
        # terms, or every term of a short question — measured against the real
        # governed vocabulary: "số đơn hàng" scores 3, "tỷ lệ giao đúng hạn" 4,
        # "doanh thu theo tháng" 2, both weather questions 0.
        hay = " ".join(str(asset.get(k) or "") for k in ("id", "name", "detail"))
        # On the words that name WHAT is asked — see `_FILLER`. A period word
        # shared with an unrelated asset is still not a match ("thời tiết tháng 8").
        terms = _content_terms(question)
        strength = _score(hay, terms)
        strong = strength >= 2 or (strength and strength == len(terms))
        is_dimension = str(asset.get("field_kind") or "").lower() == "dimension"

        # A BREAKDOWN IS NAMED IN ONE WORD, AND THAT IS NORMAL.
        #
        # The threshold above exists because `search_business_assets` returns
        # anything sharing ONE token, and one incidental word is not a match —
        # asked "thời tiết Hà Nội hôm nay" the resolver used to report `semantic`
        # on two Olist charts. But a dimension almost never earns two tokens:
        # "bang nào có doanh thu cao nhất" gives `customer_state` exactly one.
        # Holding dimensions to the measure's threshold deleted the very half
        # this pass exists to keep, and the pairing below silently degraded back
        # to a measure-only match — the original bug, reintroduced by its own fix.
        #
        # So a weak dimension is kept ONLY for pairing, where `both` has to hold.
        # Requiring the chart to plot the measure AND carry the breakdown is a far
        # stronger test than token overlap, and it is the test that actually
        # decides. On its own — a dimension-only question — the full threshold
        # still applies, so one incidental word still cannot resolve anything.
        if not strong and not (is_dimension and strength >= 1):
            continue

        if kind == "metric":
            metrics.append((asset, ident, strength))
        elif is_dimension:
            (dimensions if strong else weak_dimensions).append(
                (asset, ident, strength))
        else:
            # `measure` and `unknown` alike: a field whose kind the semantic
            # layer never declared is treated as it always was, so an
            # undeclared model keeps working exactly as before.
            measures.append((asset, ident, strength))

    out: list[dict] = []

    def _collect(args: dict, *, accept: set[str], via: str, concept: str,
                 strength: int, why: str) -> None:
        res = call("resolve_chart_candidates", args)
        if not isinstance(res, dict) or not res.get("ok"):
            return
        payload = res.get("data") if isinstance(res.get("data"), dict) else res
        for cand in (payload.get("candidates") or payload.get("charts") or []):
            if not isinstance(cand, dict) or not isinstance(cand.get("chart_id"), int):
                continue
            # `same_table` is explicitly NOT a match. A chart on the same table may
            # plot something else entirely, and presenting it at the same
            # confidence is how a caller picks a plausible wrong chart.
            if cand.get("match") not in accept:
                continue
            # A TITLE IS A JUDGEMENT CALL, and this caller has no judge: a
            # chart's title naming the breakdown is offered to a model (which can
            # read it and decide) but never selected here on its own.
            if cand.get("dimension_match_basis") == "chart_title":
                continue
            out.append({
                "chart_id": cand["chart_id"],
                "chart_name": cand.get("chart_name") or "",
                "via": via,
                "concept": concept,
                "strength": strength,
                "why": why,
            })

    # BOTH HALVES, OR NEITHER. When the question named a figure and a breakdown,
    # only `both` counts: a chart that plots the right measure against the wrong
    # dimension is not an answer to the question that was asked, and accepting it
    # is the exact substitution this pass exists to stop.
    paired = False
    pairable = dimensions + weak_dimensions
    if pairable and (measures or metrics):
        for m_asset, m_ident, m_strength in (measures or metrics):
            for d_asset, d_ident, d_strength in pairable:
                args = {"dimension": d_ident}
                args["metric" if not measures else "measure"] = m_ident
                _collect(
                    args, accept={"both"}, via="measure+dimension",
                    concept=f"{m_ident}×{d_ident}",
                    strength=max(m_strength, d_strength),
                    why=(
                        f"this chart plots “{m_asset.get('name') or m_ident}” "
                        f"broken down by “{d_asset.get('name') or d_ident}”"
                    ),
                )
                paired = True

    # A NAMED PERIOD GRAIN IS A BREAKDOWN TOO. "ARR tháng 8" is answered by the
    # chart that plots ARR by month, not by the all-period KPI or the by-segment
    # bar that plot the same measure. Matched through the time axis (see
    # `_field_matches`); when no chart has one, the measure alone still answers.
    grain = _grain_named(question)
    if not paired and grain and (measures or metrics):
        before = len(out)
        for m_asset, m_ident, m_strength in (measures or metrics):
            _collect(
                {"metric" if not measures else "measure": m_ident, "dimension": grain},
                accept={"both"}, via="measure+time", concept=str(m_ident), strength=m_strength,
                why=f"this chart plots “{m_asset.get('name') or m_ident}” over time",
            )
        paired = len(out) > before

    # A question that named only one of the two is answered by the one it named.
    if not paired:
        for asset, ident, strength in metrics:
            _collect(
                {"metric": ident}, accept={"measure", "both"}, via="metric",
                concept=str(ident), strength=strength,
                why=f"metric “{asset.get('name') or ident}” is plotted by this chart",
            )
        for asset, ident, strength in measures:
            _collect(
                {"measure": ident}, accept={"measure", "both"}, via="field",
                concept=str(ident), strength=strength,
                why=f"field “{asset.get('name') or ident}” is plotted by this chart",
            )
        for asset, ident, strength in dimensions:
            _collect(
                {"dimension": ident}, accept={"dimension", "both"}, via="field",
                concept=str(ident), strength=strength,
                why=(
                    f"this chart is broken down by "
                    f"“{asset.get('name') or ident}”"
                ),
            )
    return out


def _by_measure_label(call: Call, question: str, lex_ids: list[int],
                      labels: dict[int, list[str]]) -> dict | None:
    """Narrow an ambiguous name match by the ONE measure the question names.

    Only when exactly one distinct on-screen measure label shares a content word
    with the question: two named measures, or none, stay ambiguous. A period grain
    in the question then prefers the charts that plot it over time — the same
    `both` test as a named breakdown — and falls back to every chart plotting the
    measure. No translation: "khách hàng rời bỏ" does not reach "Cus churned"
    without governed vocabulary, by design.
    """
    content = _content_terms(question)
    named: dict[str, str] = {}
    for cid in lex_ids:
        for label in labels.get(cid, []):
            if _terms_of(label) & content:
                named.setdefault(" ".join(sorted(_terms_of(label))), label)
    if len(named) != 1:
        return None
    label = next(iter(named.values()))
    attempts = []
    grain = _grain_named(question)
    if grain:
        attempts.append(({"measure": label, "dimension": grain}, {"both"}, "measure+time"))
    attempts.append(({"measure": label}, {"measure", "both"}, "measure_label"))
    for args, accept, via in attempts:
        res = call("resolve_chart_candidates", args)
        if not isinstance(res, dict) or not res.get("ok"):
            continue
        payload = res.get("data") if isinstance(res.get("data"), dict) else res
        ids: list[int] = []
        for cand in (payload.get("candidates") or []):
            if (isinstance(cand, dict) and cand.get("chart_id") in lex_ids
                    and cand.get("match") in accept and cand["chart_id"] not in ids):
                ids.append(cand["chart_id"])
        if ids:
            return {"status": "semantic", "chart_ids": ids, "concepts": [label],
                    "candidates": [{"chart_id": c, "via": via, "concept": label,
                                    "why": f"plots the measure “{label}” the question names"
                                           + (" over time" if via == "measure+time" else "")}
                                   for c in ids]}
    return None


def _by_name_winner(question: str, lex_ids: list[int], names: dict[int, str]) -> dict | None:
    """A CLEAR WINNER BY NAME IS NOT AMBIGUITY — the rule `resolve_charts` already
    applies to concepts, applied to chart names on the question's CONTENT words.

    `list_charts` judges a match against every word of the question, so a long
    question is "ambiguous" however well one chart fits it. Live round 7: "Danh mục
    nào có doanh thu cao nhất và chiếm bao nhiêu % tổng doanh thu?" against
    "Doanh thu theo danh mục" (four content words) and "Doanh thu sản phẩm" (two)
    was ambiguous, the hybrid read nothing, and it answered that the report had no
    category revenue. Two shared content words at least, and strictly more than
    every other chart; a tie stays ambiguous.
    """
    content = _content_terms(question)
    scored = sorted(((len(_terms_of(names.get(c, "")) & content), c) for c in lex_ids), reverse=True)
    if not scored or scored[0][0] < 2 or (len(scored) > 1 and scored[1][0] == scored[0][0]):
        return None
    best, cid = scored[0]
    return {"status": "semantic", "chart_ids": [cid], "concepts": [],
            "candidates": [{"chart_id": cid, "via": "name_winner",
                            "why": f"its name shares {best} of the question's content words, "
                                   "more than any other chart"}]}


def resolve_charts(question: str, allowed: list[int], *, call: Call) -> dict:
    """Which charts this question is about, with the evidence for saying so.

    Returns `{status, chart_ids, candidates, concepts}` where status is
    exact / semantic / ambiguous / none. `chart_ids` is meaningful only for
    `exact` and `semantic`; for `ambiguous` the candidates are the answer and the
    caller must not pick one.
    """
    keep = set(allowed or [])
    empty = {"status": "none", "chart_ids": [], "candidates": [], "concepts": []}
    if not question.strip() or not keep:
        return empty

    lex = _lexical(call, question)
    lex_status, lex_ids = lex[0], lex[1]
    lex_labels = lex[2] if len(lex) > 2 else {}
    lex_names = lex[3] if len(lex) > 3 else {}
    lex_ids = [c for c in lex_ids if c in keep]
    if lex_status == "matched" and lex_ids:
        return {"status": "exact", "chart_ids": lex_ids, "concepts": [],
                "candidates": [{"chart_id": c, "via": "name", "why": "chart name or "
                                "on-screen field labels match"} for c in lex_ids]}

    # The lexical pass could not tell. Ask the business vocabulary before giving
    # up — this is the step that was missing, not a second opinion on the first.
    cands = [c for c in _semantic(call, question) if c["chart_id"] in keep]
    if not cands:
        # ONE MEASURE NAMED BY ITS ON-SCREEN LABEL. Live round 7: on a report
        # with no declared vocabulary, every chart shares the word "ARR", so the
        # name match was ambiguous and the vocabulary pass had nothing to pair —
        # the hybrid read nothing and answered "no data" for a figure on screen.
        if lex_status == "ambiguous" and lex_ids:
            narrowed = (_by_measure_label(call, question, lex_ids, lex_labels)
                        or _by_name_winner(question, lex_ids, lex_names))
            if narrowed:
                return narrowed
        # An `ambiguous` lexical verdict is still ambiguity, not absence: the
        # caller may want to offer those candidates rather than say "no chart".
        if lex_status == "ambiguous" and lex_ids:
            return {"status": "ambiguous", "chart_ids": [], "concepts": [],
                    "candidates": [{"chart_id": c, "via": "name",
                                    "why": "one shared word only"} for c in lex_ids]}
        if lex_status == "lookup_failed":
            # A BROKEN LOOKUP IS NOT AN ANSWER ABOUT THE DOMAIN.
            #
            # Folding it into `none` would turn a transient tool failure into
            # "this report has no data for that question" — told to the viewer,
            # with the read skipped. The caller degrades to its default scope
            # instead, which is what it did before question matching existed.
            return {"status": "lookup_failed", "chart_ids": [], "candidates": [],
                    "concepts": []}
        return empty

    concepts = sorted({c["concept"] for c in cands if c["concept"]})
    ids: list[int] = []
    for c in cands:
        if c["chart_id"] not in ids:
            ids.append(c["chart_id"])

    if len(concepts) >= _AMBIGUOUS_AT:
        # A CLEAR WINNER IS NOT AMBIGUITY.
        #
        # "giá trị đơn hàng trung bình" reaches two governed metrics — average
        # order value AND average review score, which share "trung bình" — and
        # refusing an ordinary BI question because a weaker concept also cleared
        # the bar would be a regression caused by the bar itself. One concept
        # matching strictly more of the question than every other is evidence,
        # already computed; a genuine tie stays ambiguous.
        best: dict[str, int] = {}
        for c in cands:
            key = c.get("concept") or ""
            best[key] = max(best.get(key, 0), int(c.get("strength") or 0))
        ranked = sorted(best.items(), key=lambda kv: -kv[1])
        if len(ranked) > 1 and ranked[0][1] > ranked[1][1]:
            winner = ranked[0][0]
            won = [c for c in cands if c.get("concept") == winner]
            ids = []
            for c in won:
                if c["chart_id"] not in ids:
                    ids.append(c["chart_id"])
            return {"status": "semantic", "chart_ids": ids, "candidates": won,
                    "concepts": [winner]}
        # Same rule by NAME, among the charts the concepts reached: live round 8
        # (Q2) reached revenue through three metrics at equal strength, while one
        # of their charts is "Doanh thu theo danh mục" — the question, in words.
        named = _by_name_winner(question, ids, lex_names)
        if named:
            return named
        return {"status": "ambiguous", "chart_ids": [], "candidates": cands,
                "concepts": concepts}
    return {"status": "semantic", "chart_ids": ids, "candidates": cands,
            "concepts": concepts}
