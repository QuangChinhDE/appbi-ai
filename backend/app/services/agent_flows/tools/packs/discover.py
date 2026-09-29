"""Looking around before reaching for anything — the step that had no tool.

WHY THIS PACK EXISTS
--------------------
Measured on this deployment: of 34 tools, exactly ONE could list what exists
(`list_charts`). Every other store could only be SEARCHED, and searching requires
already knowing what you are looking for:

    search_knowledge(query="")        -> refused, `query` is required
    recall_knowledge()                -> 0 facts
    describe_semantic_model()         -> takes a query and nothing else

So a question that names a business concept rather than a chart had one route:
guess a chart name. When the guess missed, nothing said so — the run answered
from whatever it had. That is how "danh mục nào doanh thu cao nhất" came back as
the report's grand total.

The second half of the same gap: 20 of the 34 tools require a `chart_id`, and the
only thing that issues one matches on chart NAMES. Meanwhile the governed link
`metric -> govern_metric_bindings -> dataset_table -> chart` sits in the database,
knowing exactly which charts realise a metric, and nothing walked it. Measured on
report 67: the binding knows 11 charts carry `on_time_rate`; a keyword search for
the metric's own Vietnamese name finds 6. One of the five it misses is "Đơn trễ
theo tháng" — the same measure named by its inverse, which no string match can
ever reach.

WHAT THESE TWO TOOLS ARE, AND ARE NOT
-------------------------------------
`search_business_assets` finds ASSETS BY NAME and returns their ids. It is cheap,
it reads no document bodies and runs no warehouse query.

`search_knowledge` retrieves CONTENT: passages, embeddings, reranking. It answers
"what do we know about X", which is a different question and costs accordingly.

Keeping them apart matters. Folding the asset lookup into the retriever would put
an embedding call in front of "which chart should I use", and folding retrieval
into the lookup would return prose where a step needed an id.

SCOPE IS BORROWED, NEVER RE-DERIVED
-----------------------------------
Every entitlement decision here delegates to the helpers in `govern_tools` that
already make it — `_metrics_in_scope`, `_visible_doc_ids`, `_terms_in_scope`,
`_scope` — and to `ctx.allowed_chart_ids` for charts. A second implementation of
"what may this step read" is a second place for it to be wrong, and this is the
one kind of bug where being wrong is a data leak rather than a bad answer.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.services.agent_flows.tools import result as R
from app.services.agent_flows.tools.packs._source import local
from app.services.agent_flows.tools.registry import ToolPack

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[0-9A-Za-zÀ-ỹ]+", re.UNICODE)

#: Asset kinds this searches. The five stores a business question can land in —
#: the same five the flow contract lets an author attach, plus charts, which are
#: not attachable because they come from the link.
_KINDS = ("chart", "metric", "term", "field", "document")

_MAX_PER_KIND = 8

#: Chart candidates returned at once. The count scales with the report, and the
#: caller needs enough to choose between — not every chart sharing a table.
_MAX_CANDIDATES = 12


def _fold(s: str) -> str:
    from app.core.text_fold import fold_text

    return fold_text(s or "")


def _terms_of(text: str) -> set[str]:
    return {t for t in _WORD_RE.findall(_fold(text)) if len(t) > 1}


def _score(haystack: str, wanted: set[str]) -> int:
    """How many of the question's words this asset answers to.

    Count, not ratio. A three-word match on a long description is a better hit
    than a one-word match on a short name, and normalising by length would invert
    that — the longer text would win for being shorter on average.
    """
    if not wanted:
        return 0
    return len(wanted & _terms_of(haystack))


# ── the search ──────────────────────────────────────────────────────────────


class _Once:
    """Work shared by the finders, done once per search.

    MEASURED: `_metrics_in_scope` ran twice in one call — once for the metric
    finder, once because the glossary needs the metric list to decide which terms a
    report can reach — and cost 60ms of a 123ms search with SIX metrics in the
    dictionary. It queries each metric's bindings, so that is ~5ms per metric, per
    pass. The whole purpose of this pack is to be useful on a FULL dictionary, and
    at a hundred metrics the duplicate pass alone is half a second.

    A plain memo rather than a cache: it lives for one call and is thrown away, so
    it cannot serve a later request a scope that was computed for a different one.
    That distinction is the reason this is not on `ctx`.
    """

    def __init__(self, ctx: Any, query: str):
        self._ctx = ctx
        self._query = query
        self._metrics: list[Any] | None = None

    def metrics(self) -> list[Any]:
        if self._metrics is None:
            from app.services.dashboard_ai_bot.govern_tools import _metrics_in_scope

            self._metrics = _metrics_in_scope(self._ctx, question=self._query)
        return self._metrics


def _charts(ctx: Any, query: str, wanted: set[str], once: _Once) -> list[dict]:
    """Charts, matched by the same code path `list_charts` uses.

    Called rather than reimplemented: two matchers would drift, and the one an
    author tested against in the builder must be the one that runs here.
    """
    from app.services.dashboard_ai_bot.thinking.tools import tool_list_charts

    res = tool_list_charts(ctx, {"query": query})
    data = res.get("data") or res
    if not res.get("ok"):
        return []
    coverage = data.get("coverage") or {}
    # `list_charts` falls back to the FULL listing when a query matches nothing.
    # That is right for a browse and wrong here: an asset search that answers
    # "no chart matches" with all seventy charts has not answered.
    if not coverage.get("query"):
        return []
    out = []
    for c in (data.get("charts") or [])[:_MAX_PER_KIND]:
        out.append({
            "type": "chart",
            "id": c.get("chart_id"),
            "name": c.get("chart_name") or c.get("name") or "",
            "detail": ", ".join(
                str(x) for x in (c.get("measures") or [])[:3]
            ) or None,
            "why": "chart name or on-screen field labels match",
            "use_with": "any measuring tool — pass this id as chart_id",
        })
    return out


def _metrics(ctx: Any, query: str, wanted: set[str], once: _Once) -> list[dict]:
    scored = []
    for m in once.metrics():
        hay = " ".join(str(x or "") for x in (
            m.name, m.display_name, getattr(m, "definition", "") or "",
            getattr(m, "description", "") or "",
        ))
        s = _score(hay, wanted)
        if s:
            scored.append((-s, m))
    scored.sort(key=lambda p: (p[0], str(p[1].name)))
    out = []
    for _, m in scored[:_MAX_PER_KIND]:
        out.append({
            "type": "metric",
            "id": m.name,
            "name": m.display_name or m.name,
            "detail": (getattr(m, "definition", None) or "")[:160] or None,
            "why": "governed metric whose name or definition matches",
            "use_with": (
                "explain_measurement for its definition; resolve_chart_candidates "
                "to find the charts that measure it"
            ),
        })
    return out


def _terms(ctx: Any, query: str, wanted: set[str], once: _Once) -> list[dict]:
    from app.services.dashboard_ai_bot.govern_tools import _terms_in_scope

    try:
        # The SAME metric list the metric finder used: a report reaches a term
        # partly THROUGH its metrics, so recomputing the scope here would pay for
        # the identical answer twice.
        rows = _terms_in_scope(ctx, once.metrics(), query)
    except Exception:  # noqa: BLE001 — vocabulary is never worth failing a search over
        logger.debug("[discover] glossary scope failed", exc_info=True)
        return []
    # THE KEYS ARE THE RETRIEVER'S, NOT THE GLOSSARY TABLE'S.
    #
    # `_terms_in_scope` returns retrieval hits, not ORM rows: a term arrives as
    # `{source_type: "term", title: ..., content: ..., synonyms: ...}`. Read as
    # `term`/`name` — the column names — every result came back with a blank id
    # and a blank label, which is worse than no result: a caller sees a hit it
    # cannot act on. Found by searching real data, not by reading the signature.
    scored = []
    for t in rows or []:
        hay = " ".join(str(t.get(k) or "") for k in
                       ("title", "definition", "content", "synonyms"))
        s = _score(hay, wanted)
        if s:
            scored.append((-s, t))
    scored.sort(key=lambda p: (p[0], str(p[1].get("title") or "")))
    out = []
    for _, t in scored[:_MAX_PER_KIND]:
        name = str(t.get("title") or "")
        out.append({
            "type": "term",
            "id": t.get("id") or name,
            "name": name,
            "detail": (str(t.get("definition") or t.get("content") or ""))[:160] or None,
            "why": "glossary term whose name or definition matches",
            "use_with": "search_knowledge to read how it is used in documents",
        })
    return out


def _fields(ctx: Any, query: str, wanted: set[str], once: _Once) -> list[dict]:
    """Semantic fields — the layer that carries formulas and units."""
    from app.services.dashboard_ai_bot.govern_tools import tool_describe_semantic_model

    res = tool_describe_semantic_model(ctx, {"query": query})
    if not res.get("ok"):
        return []
    data = res.get("data") or res
    scored = []
    for f in data.get("fields") or []:
        hay = " ".join(str(f.get(k) or "") for k in ("name", "label", "description"))
        s = _score(hay, wanted)
        if s:
            scored.append((-s, f))
    scored.sort(key=lambda p: (p[0], str(p[1].get("name") or "")))
    out = []
    for _, f in scored[:_MAX_PER_KIND]:
        # THE KIND WAS READ AND THROWN AWAY, AND THAT WAS THE BUG.
        #
        # `use_with` below has always branched on it, so this function KNEW
        # whether it was looking at a measure or a dimension — and then published
        # a result whose only type was `"field"`. Every reader downstream had to
        # guess, and every reader guessed "measure": the resolver sent
        # `product_category_name_english` to `resolve_chart_candidates` as a
        # measure, got a category chart back, and answered "which STATE has the
        # highest revenue?" with `health_beauty`.
        #
        # Serialised, so the distinction survives the tool boundary instead of
        # dying inside a sentence of English prose.
        kind = str(f.get("kind") or "").strip().lower() or "unknown"
        out.append({
            "type": "field",
            "field_kind": kind,
            "id": f.get("name"),
            "name": f.get("label") or f.get("name") or "",
            "detail": f.get("formula") or f.get("description") or None,
            "why": "semantic field whose name, label or description matches",
            "use_with": (
                "resolve_chart_candidates(measure=...) to find charts built on it"
                if kind == "measure" else
                "resolve_chart_candidates(dimension=...) to find charts broken "
                "down by it, or name it as the grouping in rank_values or "
                "aggregate_chart_data"
            ),
        })
    return out


def _documents(ctx: Any, query: str, wanted: set[str], once: _Once) -> list[dict]:
    """Documents matched on TITLE only — deliberately.

    Reading bodies here would duplicate `search_knowledge` at a fraction of its
    quality: no embeddings, no reranking, no answerability verdict. This answers
    "which documents exist about X", and hands off.
    """
    from app.models.governance import GovernKnowledgeDoc
    from app.services.dashboard_ai_bot.govern_tools import _visible_doc_ids

    ids = _visible_doc_ids(ctx)
    if not ids:
        return []
    scored = []
    for d in ctx.db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id.in_(ids)).all():
        s = _score(" ".join(str(x or "") for x in (d.title, getattr(d, "summary", "") or "")), wanted)
        if s:
            scored.append((-s, d))
    scored.sort(key=lambda p: (p[0], p[1].id))
    out = []
    for _, d in scored[:_MAX_PER_KIND]:
        out.append({
            "type": "document",
            "id": d.id,
            "name": d.title or f"Document {d.id}",
            "detail": (getattr(d, "summary", None) or "")[:160] or None,
            "why": "document title matches",
            "use_with": "read_document with this id, or search_knowledge for the passage",
        })
    return out


_FINDERS = {
    "chart": _charts,
    "metric": _metrics,
    "term": _terms,
    "field": _fields,
    "document": _documents,
}


def tool_search_business_assets(ctx: Any, args: dict) -> dict:
    """One search across everything a question could be about."""
    query = str(args.get("query") or "").strip()
    if not query:
        return R.err(
            "query is required — the words from the question",
            code="bad_argument",
            recovery="Pass the business terms the viewer used, e.g. 'tỷ lệ giao đúng hẹn'.",
        )
    kinds = args.get("types") or list(_KINDS)
    if isinstance(kinds, str):
        kinds = [kinds]
    unknown = [k for k in kinds if k not in _KINDS]
    if unknown:
        return R.err(
            f"unknown asset type(s): {', '.join(unknown)}",
            code="bad_argument",
            recovery=f"Valid types are: {', '.join(_KINDS)}.",
        )

    wanted = _terms_of(query)
    once = _Once(ctx, query)
    results: list[dict] = []
    searched: list[str] = []
    failed: list[str] = []
    for kind in _KINDS:
        if kind not in kinds:
            continue
        searched.append(kind)
        try:
            results.extend(_FINDERS[kind](ctx, query, wanted, once) or [])
        except Exception:  # noqa: BLE001
            # ONE STORE BEING UNAVAILABLE IS NOT THE SEARCH FAILING.
            #
            # The whole point is looking in five places at once; letting a glossary
            # outage take the chart results with it would make this tool less
            # reliable than the five calls it replaces. The failure is reported,
            # not swallowed — a caller that sees `unavailable: ["metric"]` knows an
            # empty metric list means "could not look", not "nothing there".
            logger.warning("[discover] %s search failed", kind, exc_info=True)
            failed.append(kind)

    by_kind: dict[str, int] = {}
    for r in results:
        by_kind[r["type"]] = by_kind.get(r["type"], 0) + 1

    out: dict[str, Any] = {
        "results": results,
        "coverage": {
            "query": query,
            "searched": searched,
            "found": len(results),
            "by_type": by_kind,
        },
    }
    if failed:
        out["coverage"]["unavailable"] = failed
    if not results:
        # SAY WHICH WAY IT IS EMPTY. "No results" reads to a model as "this
        # business does not track that", and it answers accordingly. The honest
        # reading is usually narrower: nothing is NAMED this way.
        out["coverage"]["note"] = (
            f"Nothing in this report's scope is named like '{query}'. The business "
            "may call it something else — try the words from the report itself, or "
            "a single distinctive word. Do NOT conclude the measure does not exist."
        )
    return R.ok(out, kind="catalogue")


SEARCH_ASSETS_DEF = {
    "name": "search_business_assets",
    "description": (
        "Look around before measuring anything. ONE search across charts, "
        "governed metrics, glossary terms, semantic fields and documents — "
        "returns what each match IS, its id, and which tool to use it with. "
        "Start here whenever the question names a business concept rather than a "
        "chart, so the next call uses a real id instead of a guess. Returns names "
        "and ids only, no figures and no document text."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "The business words from the question, e.g. 'tỷ lệ giao đúng "
                    "hẹn'. Accent-insensitive."
                ),
            },
            "types": {
                "type": "array",
                "items": {"type": "string", "enum": list(_KINDS)},
                "description": (
                    "Narrow to certain asset kinds. Omit to search all five."
                ),
            },
        },
        "required": ["query"],
    },
}


# ── metric / field -> the charts that realise it ────────────────────────────


#: Strongest first. `both` leads whenever both concepts were asked for; when only
#: one was, its own match is the best available and the other never occurs.
_MATCH_RANK = {"both": 0, "measure": 1, "dimension": 1, "same_table": 3}


def field_key(ref: str) -> str:
    """The comparable name inside a qualified field reference.

    `dataset_table_441.customer_state` and `customer_state` are the same field
    said two ways — the first is how a chart stores it, the second how a question
    and the semantic model name it. Table-qualified prefixes and the `__…__`
    joins a date dimension carries are stripped, then folded.
    """
    text = str(ref or "").strip()
    if not text:
        return ""
    return _fold(text.rsplit(".", 1)[-1])


def _field_matches(needle: str, entries: Any) -> bool:
    """Does one of these chart fields refer to the field the caller named?

    Matched on the field's own name and on its on-screen label, because a
    Vietnamese author asks for `Bang` and the warehouse column is
    `customer_state`; the semantic layer is what connects them, and the label is
    the connection it publishes.
    """
    want = field_key(needle)
    if not want:
        return False
    # A TABLE-QUALIFIED needle (a governed binding) names one column of one
    # table, and matches only that.
    if "." in str(needle) and not str(needle).startswith("."):
        full = _fold(str(needle))
        return any(_fold(str((e.get("field") if isinstance(e, dict) else e) or "")) == full
                   for e in entries or [])
    for entry in entries or []:
        if not isinstance(entry, dict):
            if field_key(entry) == want:
                return True
            continue
        if field_key(entry.get("field")) == want:
            return True
        if _fold(str(entry.get("label") or "")) == _fold(needle):
            return True
    return False


def _vocabulary(ctx: Any, phrase: str, kind: str) -> list[str]:
    """The identifiers the GOVERNED vocabulary gives a phrase, for one kind.

    `resolve_chart_candidates` has always promised `measure` "as the question
    phrases it — e.g. 'doanh thu' … works without anything being registered
    first", and matched only a field's exact name or label. Asked for
    "doanh thu" by "danh mục sản phẩm" on the Olist report it answered "no chart
    shows that" — while chart 686, revenue by product category, sat in scope —
    and the live model told the viewer the report had no such data.

    The bridge is the one `search_business_assets` already uses: semantic fields
    of the right KIND whose name, label or description answer to the phrase, and
    — for a measure — the fields a governed metric of that name is bound to. No
    translation, no model: governed vocabulary only. A phrase that is already an
    identifier stays first, so an exact caller is matched exactly as before.
    """
    phrase = (phrase or "").strip()
    if not phrase:
        return []
    out = [phrase]
    # AN IDENTIFIER IS MATCHED EXACTLY, as it always was — `total_revenue` must
    # not also become every field whose words overlap it (found by review: it
    # matched an AOV chart). Only a phrase is translated.
    if re.fullmatch(r"[A-Za-z0-9_.]+", phrase) and ("_" in phrase or "." in phrase):
        return out
    wanted = _terms_of(phrase)
    if not wanted:
        return out
    once = _Once(ctx, phrase)
    try:
        fields = _fields(ctx, phrase, wanted, once)
    except Exception:  # noqa: BLE001 — vocabulary is never worth failing a lookup over
        logger.debug("[discover] vocabulary lookup failed", exc_info=True)
        fields = []

    def fit(*texts: str) -> int | None:
        """How closely a NAME/LABEL states the phrase: every phrase word must be
        in it; fewer extra words is closer. None = it does not state it. The
        description is not read — "doanh thu" in an AOV field's description does
        not make AOV revenue (found by review)."""
        words = set().union(*(_terms_of(t) for t in texts))
        return len(words - wanted) if wanted <= words else None

    scored: list[tuple[int, str]] = []
    for f in fields:
        fk = str(f.get("field_kind") or "unknown")
        if kind == "measure" and fk == "dimension" or kind == "dimension" and fk == "measure":
            continue
        extra = fit(str(f.get("id") or ""), str(f.get("name") or ""))
        if extra is not None and f.get("id"):
            scored.append((extra, str(f["id"])))
    if kind == "measure":
        try:
            metrics = once.metrics()
        except Exception:  # noqa: BLE001
            metrics = []
        from app.services.governance_service import GovernanceService

        for m in metrics:
            extra = fit(str(m.name or ""), str(m.display_name or ""))
            if extra is None:
                continue
            for row in GovernanceService.metric_binding_details(ctx.db, m) or []:
                ref = str(row.get("measure_ref") or "")
                if row.get("status") == "ok" and ref:
                    # TABLE-QUALIFIED: a binding names one column of one table; a
                    # same-named column elsewhere is a different figure.
                    scored.append((extra, ref))
    if scored:
        best = min(extra for extra, _ in scored)
        for extra, ident in scored:
            if extra == best and ident not in out:
                out.append(ident)
    return out


def _labelled_dimensions(ctx: Any) -> set[str]:
    """Field keys of dimensions the semantic model gives a label."""
    try:
        from app.services.dashboard_ai_bot.govern_tools import tool_describe_semantic_model

        res = tool_describe_semantic_model(ctx, {"query": ""})
        data = (res.get("data") if isinstance(res.get("data"), dict) else res) if isinstance(res, dict) else {}
    except Exception:  # noqa: BLE001
        return set()
    return {field_key(str(f.get("name") or "")) for f in (data.get("fields") or [])
            if isinstance(f, dict) and str(f.get("kind") or "").lower() == "dimension"
            and str(f.get("label") or "").strip()}


def _charts_on_table(ctx: Any, table_id: int, measure: str | None,
                     dimension: str | None = None, *,
                     measure_aliases: list[str] | None = None,
                     dimension_aliases: list[str] | None = None) -> list[dict]:
    """Charts in THIS step's scope built on a table, best match first.

    `ctx.allowed_chart_ids` is the boundary and it is applied here rather than
    trusted to a caller: this is the one tool whose whole job is to produce ids
    other tools will act on.
    """
    from app.models.models import Chart

    allowed = set(getattr(ctx, "allowed_chart_ids", None) or set())
    if not allowed:
        return []
    rows = (
        ctx.db.query(Chart)
        .filter(Chart.dataset_table_id == table_id, Chart.id.in_(allowed))
        .all()
    )
    out = []
    m_needle = (measure or "").strip()
    d_needle = (dimension or "").strip()
    # A title may name the breakdown only when the governed vocabulary gave the
    # phrase no field at all (it is then the only words there are).
    title_allowed = bool(d_needle) and list(dimension_aliases or [d_needle]) == [d_needle]
    labelled_dims = _labelled_dimensions(ctx) if title_allowed else set()
    for c in rows:
        # THE GROUPING KEY, NOT A SUBSTRING OF THE CONFIG.
        #
        # This used to ask whether the column name appeared anywhere in
        # `json.dumps(chart.config)`. A real chart config carries the dataset's
        # whole column vocabulary — `baseFilters` alone lists every filterable
        # column — so EVERY chart of a dataset "matched" EVERY column. Measured
        # on report 67:
        #
        #   resolve_chart_candidates(measure=total_revenue, dimension=customer_state)
        #     684 GMV by month        -> both, complete
        #     685 orders by status    -> both, complete
        #     686 revenue by CATEGORY -> both, complete
        #     687 orders by STATE     -> dimension, NOT complete
        #
        # The only chart that genuinely groups by state was the only one not
        # reported complete, and asking for `product_category_name_english`
        # returned the identical set. A matcher that answers the same for two
        # different questions is not matching anything.
        #
        # `roleConfig` is where the chart says what it plots, and the runtime
        # already extracts it into `chart_meta[id]["fields"]`. Borrowed rather
        # than re-derived: a second opinion about what a chart measures is a
        # second place for it to be wrong.
        fields = (getattr(ctx, "chart_meta", None) or {}).get(c.id) or {}
        fields = fields.get("fields") or {}
        m_hit = bool(m_needle) and any(
            _field_matches(a, fields.get("measures")) for a in (measure_aliases or [m_needle]))
        d_hit = bool(d_needle) and any(
            _field_matches(a, fields.get("dimensions")) for a in (dimension_aliases or [d_needle]))
        # THE AUTHOR'S OWN WORDS FOR THE BREAKDOWN, when the semantic model has
        # none. Measured on the Olist report: its category dimension carries no
        # label in any language, so "danh mục" reaches it through nothing — while
        # the chart is titled "Doanh thu theo danh mục". A title is weaker than a
        # field, so it counts only for a chart that STRUCTURALLY has a grouping
        # dimension (never a KPI tile), only when the title carries the phrase,
        # and it is reported as what it is (`dimension_match_basis`). The measure
        # half is never matched by title.
        d_basis = "field" if d_hit else ""
        if d_needle and not d_hit and title_allowed:
            from app.services.agent_flows.tools.dimension_gate import (
                _raw_terms,
                chart_dimension_words,
                title_hits,
            )

            asked = _raw_terms(d_needle)
            for ref, _fw, title_words in chart_dimension_words(ctx).get(c.id, []):
                # Only a breakdown the semantic model has no word for can be named
                # by a title: a LABELLED dimension already says what it is, and a
                # title saying something else is not evidence against it.
                if field_key(ref) in labelled_dims:
                    continue
                if asked and len(title_hits(ctx, asked, title_words)) >= min(2, len(asked)):
                    d_hit, d_basis = True, "chart_title"
                    break
        # THE DISTINCTION THE CALLER HAS TO SEE.
        #
        # "Same table" and "same measure" are not the same claim. A chart on the
        # same table may plot something else entirely — counting orders is not
        # measuring on-time delivery — and presenting both at one confidence is
        # how a caller picks a plausible wrong chart.
        #
        # AND "SAME MEASURE" IS NOT "ANSWERS THE QUESTION". Asked which STATE has
        # the highest revenue, every revenue chart on the table matches the
        # measure, including the one broken down by product category — which is
        # how `health_beauty` came back as the name of a state. When the caller
        # names a dimension too, satisfying one half is a weak match and saying
        # WHICH half is the whole point.
        if m_needle and d_needle:
            match = ("both" if m_hit and d_hit else
                     "measure" if m_hit else
                     "dimension" if d_hit else "same_table")
        elif d_needle:
            match = "dimension" if d_hit else "same_table"
        else:
            match = "measure" if m_hit else "same_table"
        # SATISFIED EVERYTHING THAT WAS ASKED — which is not the same as
        # "matched the measure". Asked for a measure alone, matching it IS the
        # complete answer; asked for both, matching one half is not.
        complete = (m_hit or not m_needle) and (d_hit or not d_needle)
        row = {
            "chart_id": c.id,
            "chart_name": c.name or f"Chart {c.id}",
            "match": match,
            "measure_match": m_hit,
            "dimension_match": d_hit,
            "complete": complete,
            "confidence": ("medium" if d_basis == "chart_title" else "high") if complete else "low",
        }
        if d_basis:
            row["dimension_match_basis"] = d_basis
        out.append(row)
    out.sort(key=lambda r: (not r["complete"], _MATCH_RANK[r["match"]], r["chart_id"]))
    return out


def tool_resolve_chart_candidates(ctx: Any, args: dict) -> dict:
    """From a governed metric or a semantic field, the charts that realise it."""
    metric_name = str(args.get("metric") or "").strip()
    measure = str(args.get("measure") or "").strip()
    # A QUESTION CAN NAME TWO INDEPENDENT THINGS. "Which state has the highest
    # revenue" names a measure AND a breakdown, and a chart answers it only if it
    # has both. Before this argument existed the breakdown had nowhere to go, so
    # the tool matched on revenue alone and handed back a chart broken down by
    # product category — which is how a category became the name of a state.
    dimension = str(args.get("dimension") or "").strip()
    if not metric_name and not measure and not dimension:
        return R.err(
            "pass `metric` (a governed metric name), `measure` (a semantic field "
            "name), `dimension` (a breakdown field name), or a measure together "
            "with a dimension",
            code="bad_argument",
            recovery="Call search_business_assets first; its results carry the id to pass here.",
        )

    from app.models.governance import GovernMetric
    from app.services.dashboard_ai_bot.govern_tools import _metrics_in_scope
    from app.services.governance_service import GovernanceService

    resolved_via = None
    tables: list[tuple[int, str | None]] = []

    if metric_name:
        in_scope = _metrics_in_scope(ctx, question=metric_name)
        folded = _fold(metric_name)
        metric = next(
            (m for m in in_scope
             if _fold(m.name) == folded or _fold(m.display_name or "") == folded),
            None,
        )
        if metric is None:
            known = sorted({m.name for m in in_scope})[:10]
            exists = (
                ctx.db.query(GovernMetric)
                .filter(GovernMetric.name == metric_name)
                .first()
            )
            return R.err(
                f"metric '{metric_name}' is "
                + ("not in this report's scope" if exists else "not defined"),
                # `bad_argument`, not a bespoke code: the caller passed a name
                # this tool cannot use, which is exactly what that code means. A
                # new code would need every branching node in every flow to learn
                # it before it could be acted on.
                code="bad_argument",
                recovery=(
                    "Metrics readable here: " + (", ".join(known) if known else "none")
                    + ". Call search_business_assets to find the right name."
                ),
                detail={"metrics_in_scope": known},
            )
        for row in GovernanceService.metric_binding_details(ctx.db, metric) or []:
            if row.get("status") != "ok":
                continue
            tid = row.get("dataset_table_id")
            if tid:
                ref = str(row.get("measure_ref") or "")
                tables.append((int(tid), ref.rsplit(".", 1)[-1] if ref else None))
        resolved_via = "metric_binding"
        if not tables:
            return R.err(
                f"metric '{metric_name}' has no dataset binding, so no chart can be "
                "traced to it",
                code="not_applicable",
                recovery=(
                    "The metric is defined but not wired to data. Use "
                    "explain_measurement for its written definition, and say the "
                    "figure is not available on this report."
                ),
            )
    else:
        from app.services.dashboard_ai_bot.govern_tools import _scope

        tids, _ = _scope(ctx)
        tables = [(t, measure or None) for t in sorted(tids)]
        resolved_via = "semantic_field" if measure else "dimension"

    # THE PHRASE, AND WHAT THE GOVERNED VOCABULARY SAYS IT MEANS — for the
    # caller's free text only. A metric binding already names its field exactly.
    d_aliases = _vocabulary(ctx, dimension, "dimension") if dimension else []
    phrase_aliases = _vocabulary(ctx, measure, "measure") if measure and not metric_name else []
    seen: dict[int, dict] = {}
    for tid, meas in tables:
        m_aliases = phrase_aliases or ([meas] if meas else [])
        for row in _charts_on_table(ctx, tid, meas, dimension,
                                    measure_aliases=m_aliases, dimension_aliases=d_aliases):
            prev = seen.get(row["chart_id"])
            better = (not row["complete"], _MATCH_RANK[row["match"]])
            if prev is None or better < (not prev["complete"],
                                         _MATCH_RANK[prev["match"]]):
                seen[row["chart_id"]] = row
    ranked = sorted(
        seen.values(),
        key=lambda r: (not r["complete"], _MATCH_RANK[r["match"]], r["chart_id"]),
    )
    # CAPPED, because this list is as long as the report is wide. On the demo
    # report an unbounded answer was 18 candidates and 656 tokens against a
    # declared budget of 500 — the registry caught it, which is the check this
    # tool's own pack docstring complains was missing elsewhere. Exact matches
    # sort first, so the cap drops the weakest rows.
    candidates = ranked[:_MAX_CANDIDATES]
    # EXACT MEANS "SATISFIES EVERYTHING THAT WAS ASKED", not "matched the
    # measure". With a dimension in play those are different sets, and calling
    # the second one exact is what let a half-match be reported as a resolution.
    exact = [c for c in candidates if c["complete"]]

    out: dict[str, Any] = {
        "candidates": candidates,
        "coverage": {
            "resolved_via": resolved_via,
            "asked": metric_name or measure,
            "asked_dimension": dimension or None,
            # Which identifiers the phrases were matched through — so a match
            # made via the vocabulary is visible, not a black box.
            "matched_via": {
                "measure": phrase_aliases[1:],
                "dimension": d_aliases[1:],
            },
            "total": len(ranked),
            "returned": len(candidates),
            "exact": len(exact),
        },
    }
    if len(ranked) > len(candidates):
        out["coverage"]["note"] = (
            f"Showing the {len(candidates)} best of {len(ranked)} charts built on "
            "this data; exact measure matches are listed first."
        )
    if not candidates:
        out["coverage"]["note"] = (
            "No chart on this report is built on the data behind "
            f"'{metric_name or measure or dimension}'. The figure is not on this "
            "report — say so rather than measuring a different chart."
        )
    elif not exact and dimension and (metric_name or measure):
        # THE HISTORICAL WRONG ANSWER, NAMED. Half a match used to be reported as
        # a match, so "which state has the highest revenue" was answered from a
        # chart broken down by product category.
        out["coverage"]["note"] = (
            f"No chart on this report shows '{metric_name or measure}' broken "
            f"down by '{dimension}'. The ones listed match only one half — check "
            "`measure_match` and `dimension_match` before using any of them, and "
            "do NOT substitute a different breakdown for the one that was asked "
            "about."
        )
    elif not exact and dimension:
        out["coverage"]["note"] = (
            f"No chart on this report is broken down by '{dimension}'; the ones "
            "listed only share its source table. Check with get_chart_glossary "
            "before quoting a number from them."
        )
    elif not exact:
        out["coverage"]["note"] = (
            "No chart plots this measure directly; the ones listed only share its "
            "source table and probably show something else. Check with "
            "get_chart_glossary before quoting a number from them."
        )
    return R.ok(out, kind="catalogue")


RESOLVE_CHARTS_DEF = {
    "name": "resolve_chart_candidates",
    "description": (
        "Which charts actually measure a given field — followed through the "
        "semantic binding, not by guessing chart names. Use this whenever the "
        "question names a figure: it finds charts whose TITLE says nothing about "
        "it (a chart named 'Đơn trễ theo tháng' measures on-time delivery), which "
        "a name search cannot. Returns chart_ids ranked by whether they plot the "
        "measure itself.\n"
        "PASS `measure` — the field or figure name as the question says it. Pass "
        "`metric` ONLY for a name search_business_assets returned as a governed "
        "metric; any other value is refused, because a governed metric is a "
        "registered entry, not a synonym."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            # `measure` FIRST, and it is not cosmetic. Schema order is what the
            # model reads as "the normal way to call this", and it was reading
            # `metric` — which is refused outright unless that exact name is
            # registered in the Metrics Dictionary. Measured on this deployment,
            # where no metric is registered: every `metric` call fails with
            # "metric 'GMV' is not defined" while the same question answered
            # correctly through `measure`. The chat seed grants this tool by
            # default, so the first thing a new chat flow did was call it the one
            # way that cannot work.
            "measure": {
                "type": "string",
                "description": (
                    "PREFERRED. A measure or field name as the question phrases "
                    "it — e.g. 'gmv', 'doanh thu', 'on-time rate'. Works without "
                    "anything being registered first."
                ),
            },
            # A DIMENSION IS NOT A SMALL MEASURE.
            #
            # Passing a breakdown through `measure` matched any chart whose
            # config mentioned it and reported that as a resolution, so "which
            # state has the highest revenue" resolved to a chart broken down by
            # product category and the answer named `health_beauty` as a state.
            # Named separately, a chart has to satisfy BOTH before it is exact.
            "dimension": {
                "type": "string",
                "description": (
                    "The BREAKDOWN the question asks for — 'state', 'danh mục', "
                    "'tháng'. Pass it alongside `measure` when the question asks "
                    "which X has the most Y: only a chart that has both is a "
                    "real answer, and the result says which half each candidate "
                    "matched."
                ),
            },
            "metric": {
                "type": "string",
                "description": (
                    "A GOVERNED metric's exact name, only as returned by "
                    "search_business_assets. Refused if that name is not "
                    "registered — use `measure` instead."
                ),
            },
        },
    },
}


PACK = ToolPack(
    key="discover",
    label_vi="Tìm đúng thứ cần dùng",
    label_en="Find the right asset",
    purpose_vi=(
        "Nhìn quanh xem báo cáo có gì trước khi đo. Tìm một lần trên biểu đồ, chỉ "
        "số, thuật ngữ, trường ngữ nghĩa và tài liệu — rồi lần từ chỉ số ra đúng "
        "biểu đồ đang đo nó. Gọi nhóm này TRƯỚC khi gọi bất kỳ công cụ nào cần "
        "chart_id."
    ),
    tools=[
        local(
            "search_business_assets",
            tool_search_business_assets,
            SEARCH_ASSETS_DEF,
            label_vi="Tìm mọi thứ liên quan",
            label_en="Search business assets",
            description_vi=(
                "Một lần tìm trên cả 5 kho: biểu đồ, chỉ số, thuật ngữ, trường ngữ "
                "nghĩa, tài liệu. Trả về id và gợi ý dùng tiếp với công cụ nào. "
                "Đây là cửa vào khi câu hỏi nói bằng ngôn ngữ nghiệp vụ chứ không "
                "nêu tên biểu đồ."
            ),
            result_kind="catalogue",
            returns={
                "results": (
                    "mỗi kết quả: type (chart/metric/term/field/document), id, tên, "
                    "vì sao khớp, và nên dùng tiếp với công cụ nào"
                ),
                "coverage": (
                    "đã tìm những kho nào, mỗi kho ra mấy kết quả, kho nào lỗi "
                    "không đọc được"
                ),
            },
            cost_class="cheap",
            payload="medium",
            answers_vi=(
                "Báo cáo có gì về tỷ lệ giao đúng hẹn?",
                "Chúng ta có đo doanh thu theo danh mục không?",
                "Có tài liệu nào nói về chính sách giao hàng?",
            ),
            data_exposure="metadata",
            risk="read_only",
        ),
        local(
            "resolve_chart_candidates",
            tool_resolve_chart_candidates,
            RESOLVE_CHARTS_DEF,
            label_vi="Chỉ số này nằm ở biểu đồ nào",
            label_en="Resolve charts for a metric",
            description_vi=(
                "Lần từ chỉ số đã quản trị ra đúng biểu đồ đang đo nó, đi theo liên "
                "kết metric → bảng dữ liệu → biểu đồ. Tìm được cả biểu đồ có tên "
                "không nhắc gì tới chỉ số — thứ tìm theo tên không bao giờ ra."
            ),
            result_kind="catalogue",
            returns={
                "candidates": (
                    "mỗi ứng viên: chart_id, tên, match (measure = đúng chỉ số, "
                    "same_table = chỉ chung nguồn), confidence"
                ),
                "coverage": "lần theo đường nào, có mấy ứng viên, mấy cái khớp đúng chỉ số",
            },
            cost_class="cheap",
            # `scales_with_report`, not `small`: the answer is as long as the
            # report has charts on that table. Declared `small` first and the
            # registry measured 656 tokens against a 500 budget on the demo report.
            payload="scales_with_report",
            answers_vi=(
                "Tỷ lệ giao đúng hẹn xem ở biểu đồ nào?",
                "Biểu đồ nào đang đo GMV?",
            ),
            data_exposure="metadata",
            resource_refs={"metric": "metric"},
            risk="read_only",
        ),
    ],
)
