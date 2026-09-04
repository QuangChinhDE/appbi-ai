"""Knowledge tools: let an agent LOOK THINGS UP instead of being handed a paste.

Before these existed the module had 23 tools and every one of them read chart
data. The company's documents and its KPI definitions reached a model only by
being pre-assembled into a block and pasted in front of every question, whether
the question needed them or not — which meant an agent could never pull the one
document that would have answered a question the paste had summarised away.

    search_knowledge   keyword search over documents + managed KPI definitions.
                       Returns what matched and its id.
    read_document      the full body of one document, by id.

SCOPE IS A SECURITY BOUNDARY, NOT A RELEVANCE FILTER
----------------------------------------------------
A flow step on a public link runs as `actor_type='public_session'` — an
anonymous viewer of a shared report, with no User row. `get_knowledge_doc`
elsewhere in the codebase treats `current_user=None` as full access and performs
no permission check, so a tool built on it would let that viewer read every
document in the tenant, drafts included. These tools therefore do their own
scoping from first principles and never consult that helper:

  documents   Published only, AND attached to THIS dashboard or to one of its
              datasets. Attachment counts through either mechanism the product
              offers (`govern_doc_asset_links`, or the doc's own
              `related_dashboard_ids` / `related_dataset_ids`) — a document a
              person attached is in scope regardless of which screen they used.
              Long-form prose can contain anything, so there is no company-wide
              fallback here.

  KPIs        in scope when bound to this report's data, and ALSO when bound to
              nothing at all. An unbound managed KPI is by definition not
              report-specific: it is a dictionary entry — "GMV means …, computed
              as …" — and a central dictionary is the stated purpose of the
              knowledge modules. Definitions only; a KPI's target value is a
              declared number, never a measurement of this report's data.

The same rule applies to an authenticated user. One rule is easier to reason
about than two, and nobody has asked for a bot that answers about report A using
documents attached only to report B.

FIGURES FROM HERE ARE NOT EVIDENCE
----------------------------------
Both tools are listed in `evidence.NON_EVIDENTIAL_TOOLS`. A number that appears
in a sentence of prose — a target, an example, last quarter's figure quoted in a
memo — is not a measurement of the data on screen. Recording it as evidence
would let the verifier "confirm" a claim by matching it against a number the bot
read in a document, which is precisely the failure the verifier exists to catch.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.services.dashboard_ai_bot import knowledge_hit
from app.services.dashboard_ai_bot.tool_context import ToolContext, _err, _ok

logger = logging.getLogger(__name__)

#: One document's body, as handed to a model. Long enough for a real process
#: document, short enough that one call cannot consume the turn's whole budget.
MAX_BODY_CHARS = 6000
MAX_SNIPPET_CHARS = 320
MAX_HITS = 8


def _fold(text: str) -> str:
    """Lowercase and strip Vietnamese diacritics so "doanh thu" matches "Doanh Thu".

    Delegates to the one canonical folder. This was the ONLY one of thirteen
    helpers that handled `đ`; the rest silently did not, and keeping a local copy
    of the correct behaviour is how the other twelve came to be wrong.
    """
    from app.core.text_fold import fold_text

    return fold_text(text)


def _tokens(text: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", _fold(text)) if len(t) > 1}


def _score(haystack: str, needles: set[str]) -> float:
    """Fraction of query tokens present. Simple on purpose: the store is small,
    and an author debugging "why did it not find my document" can predict this."""
    if not needles:
        return 0.0
    hay = _tokens(haystack)
    return len(needles & hay) / len(needles)


def _plain(text: str, limit: int) -> str:
    """Markdown → something a model reads as prose, truncated on a word."""
    cleaned = re.sub(r"\{\{[^}]+\}\}", "", str(text or ""))
    cleaned = re.sub(r"[#>*`_\[\]]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) <= limit:
        return cleaned
    cut = cleaned[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit * 0.6 else cut).rstrip() + "…"


def _scope(ctx: ToolContext) -> tuple[set[int], set[int]]:
    """(dataset_table_ids, dataset_ids) backing this dashboard."""
    from app.models.dataset import DatasetTable
    from app.services.dashboard_ai_bot.knowledge_context import dashboard_table_ids

    tids = set(dashboard_table_ids(ctx.db, ctx.dashboard.id))
    dsids: set[int] = set()
    if tids:
        for table in ctx.db.query(DatasetTable).filter(DatasetTable.id.in_(tids)).all():
            if table.dataset_id:
                dsids.add(table.dataset_id)
    return tids, dsids


def _authored_doc_ids(ctx: ToolContext) -> set[int] | None:
    """The step's own document narrowing, or None when it did not narrow."""
    raw = (getattr(ctx, "knowledge_scope", None) or {}).get("doc_ids") or []
    out: set[int] = set()
    for item in raw:
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            continue
    return out or None


def _authored_metric_names(ctx: ToolContext) -> set[str] | None:
    raw = (getattr(ctx, "knowledge_scope", None) or {}).get("metric_names") or []
    out = {str(x).strip() for x in raw if str(x).strip()}
    return out or None


def _published_body(ctx: ToolContext, doc) -> str:
    """A document's LIVE prose — the published snapshot, never the draft.

    Cached on the context for the length of one tool call: a document scan reads
    every visible document, and each miss is a version-table lookup.
    """
    cache = getattr(ctx, "_published_body_cache", None)
    if cache is None:
        cache = {}
        try:
            ctx._published_body_cache = cache
        except Exception:  # noqa: BLE001 — a frozen context just re-reads
            cache = {}
    if doc.id in cache:
        return cache[doc.id]
    from app.services.governance_service import GovernanceService

    body = GovernanceService.published_body(ctx.db, doc) or ""
    cache[doc.id] = body
    return body


def _conflict_payload(answerability: dict | None) -> dict | None:
    """The conflict record, but only when there IS one."""
    conflict = (answerability or {}).get("conflict") or {}
    return conflict if conflict.get("conflict") else None


def _visible_doc_ids(ctx: ToolContext) -> set[int]:
    """Documents this report is allowed to read, then narrowed to what this STEP
    was scoped to. See the module docstring for why the order matters: the
    entitlement is computed first and the author's list only cuts inside it."""
    chosen = _authored_doc_ids(ctx)
    if chosen:
        # An EXPLICIT grant is the ceiling. It may reach outside this report — that
        # is the point, and it is safe because the grant was made in the builder
        # against the author's own view rights. Published is still required: a
        # draft is not something anyone chose to publish to a viewer.
        return chosen & _published_doc_ids(ctx)
    return _entitled_doc_ids(ctx)


def _published_doc_ids(ctx: ToolContext) -> set[int]:
    from app.models.governance import GovernKnowledgeDoc

    rows = (
        ctx.db.query(GovernKnowledgeDoc.id)
        .filter(GovernKnowledgeDoc.status == "Published")
        .all()
    )
    return {r[0] for r in rows}


def _entitled_doc_ids(ctx: ToolContext) -> set[int]:
    """Documents this report is allowed to read. See the module docstring."""
    from app.models.governance import GovernDocAssetLink, GovernKnowledgeDoc

    tids, dsids = _scope(ctx)
    dash_ref = str(ctx.dashboard.id)

    linked: set[int] = set()
    refs = {("dashboard", dash_ref)} | {("dataset", str(d)) for d in dsids}
    for link in (
        ctx.db.query(GovernDocAssetLink)
        .filter(GovernDocAssetLink.asset_type.in_(["dashboard", "dataset"]))
        .all()
    ):
        if (link.asset_type, str(link.asset_ref)) in refs:
            linked.add(link.doc_id)

    # The doc's own arrays are the other way a person attaches a document. Both
    # are honoured because both exist in the product and neither is documented
    # as the winner.
    published = (
        ctx.db.query(GovernKnowledgeDoc)
        .filter(GovernKnowledgeDoc.status == "Published")
        .all()
    )
    visible: set[int] = set()
    for doc in published:
        if doc.id in linked:
            visible.add(doc.id)
            continue
        own_dash = {str(x) for x in (doc.related_dashboard_ids or [])}
        own_ds = {str(x) for x in (doc.related_dataset_ids or [])}
        if dash_ref in own_dash or own_ds & {str(d) for d in dsids}:
            visible.add(doc.id)
    return visible


def _metrics_in_scope(ctx: ToolContext, question: str = "") -> list[Any]:
    """Metrics this report may read.

    `question` is used for one thing only: letting an UNBOUND metric in when the
    question names it. Admission is by name, not by token overlap — a metric's
    definition is prose, so overlap would readmit through the back door exactly
    what removing the `not bound` escape was meant to shut.
    """
    chosen = _authored_metric_names(ctx)
    from app.models.governance import GovernMetric
    from app.services.governance_service import GovernanceService

    tids, dsids = _scope(ctx)
    out: list[Any] = []
    for metric in (
        ctx.db.query(GovernMetric).filter(GovernMetric.status != "Deprecated").all()
    ):
        # Every valid semantic realization counts. A stale string or a dataset-only
        # Draft scope is not data reach and cannot place a KPI on a report.
        details = GovernanceService.metric_binding_details(ctx.db, metric)
        bound = bool(details)
        matched = any(
            row["status"] == "ok"
            and (row.get("dataset_id") in dsids or row.get("dataset_table_id") in tids)
            for row in details
        )
        # AN UNBOUND METRIC IS VOCABULARY, NOT A RESIDENT OF EVERY REPORT.
        #
        # This read `matched or not bound`, so a metric with no dataset appeared on
        # EVERY dashboard in the deployment. Unbound is the normal state while a
        # definition is being written, so the set that leaked was the newest and
        # least reviewed — and a metric carries `target_value`, so an out-of-scope
        # one does not merely add noise: it puts a NUMBER WITH A THRESHOLD into a
        # prompt about someone else's report, where a model may quote it as if it
        # had been measured.
        #
        # Unbound metrics still belong to the company's shared vocabulary, so they
        # are not banned — they must be NAMED. The question (or the step's own
        # attachment list) has to reach for them, exactly as an unwired glossary
        # term does. Nothing arrives merely by existing.
        if not matched:
            if bound:
                continue
            if not _question_names(question, [metric.display_name or "", metric.name]):
                continue
        # The step's own narrowing, applied AFTER entitlement — same rule as
        # documents, so a name that is not in scope cannot be added by listing it.
        if chosen and metric.name not in chosen and (metric.display_name or "") not in chosen:
            continue
        out.append(metric)
    return out


def _metric_text(metric: Any) -> str:
    bits = [metric.display_name, metric.name, metric.definition, metric.formula,
            metric.category, metric.unit]
    return " ".join(str(b) for b in bits if b)


def _authored_term_fqns(ctx: ToolContext) -> set[str] | None:
    raw = (getattr(ctx, "knowledge_scope", None) or {}).get("term_fqns") or []
    out = {str(x).strip() for x in raw if str(x).strip()}
    return out or None


def _measure_term_fqns(ctx: ToolContext, dsids: set[int]) -> set[str]:
    """Glossary terms reached THROUGH the report's own measures.

    A semantic measure can carry `glossary_terms` — the richest vocabulary link in
    the product, and the only many-to-many one. Nothing read it: the assistant
    reads `GovernMetric`, which carries a single `related_term_fqn`, so a term
    curated onto a measure decorated an object the assistant never opened. The
    Govern screen even counted "usage" from these links, which made the curation
    look effective while it changed nothing.

    This is the bridge, not a new store: dashboard → dataset → measure → term.
    """
    if not dsids:
        return set()
    out: set[str] = set()
    try:
        from app.models.dataset import DatasetTable
        from app.models.semantic import SemanticView

        table_ids = [
            t.id for t in ctx.db.query(DatasetTable.id)
            .filter(DatasetTable.dataset_id.in_(dsids)).all()
        ]
        if not table_ids:
            return set()
        for view in (
            ctx.db.query(SemanticView)
            .filter(SemanticView.dataset_table_id.in_(table_ids)).all()
        ):
            for coll in ("measures", "dimensions"):
                for field in (getattr(view, coll, None) or []):
                    if not isinstance(field, dict):
                        continue
                    for ref in (field.get("glossary_terms") or []):
                        fqn = (ref or {}).get("fqn") if isinstance(ref, dict) else ref
                        if fqn:
                            out.add(str(fqn).strip())
    except Exception:  # noqa: BLE001 — a bridge must never break a search
        logger.warning("search_knowledge: measure→term bridge failed", exc_info=True)
    return out


def _question_names(question: str, phrases: list[str]) -> str | None:
    """The phrase from `phrases` the question actually uses, or None.

    PHRASE CONTAINMENT, NOT TOKEN OVERLAP, and the difference is not academic.
    `_score` returns the fraction of question tokens present in a haystack, which
    is a fair signal for a DOCUMENT — long prose, already entitled to this report,
    where any overlap is weak evidence worth ranking. A glossary entry is two or
    three words, so one shared common word is a coincidence, not a reference:
    "khách hàng rời bỏ" scored a hit against the term "tổng giá trị hàng hoá" on
    the word `hàng` alone. Caught by the test that asked for exactly that.

    A vocabulary hit has to mean the question SAID the word. Matched on a word
    boundary so `gmv` does not match inside another token.
    """
    # Separators folded to spaces on BOTH sides. A machine name is the FQN-safe
    # spelling of the display name — `chi_phi_kho` for "Chi phí kho" — so matching
    # it literally would only ever fire if somebody typed the underscores.
    def flat(s: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[_\-.]+", " ", _fold(s or ""))).strip()

    hay = flat(question)
    if not hay:
        return None
    for phrase in phrases:
        p = flat(phrase)
        if len(p) < 2:
            continue
        if re.search(rf"(?<![a-z0-9]){re.escape(p)}(?![a-z0-9])", hay):
            return phrase
    return None


def _terms_in_scope(ctx: ToolContext, metrics: list[Any], question: str) -> list[dict]:
    """The glossary, reached the way a report actually relates to vocabulary.

    WHY THIS DID NOT EXIST
    ----------------------
    `search_knowledge` read documents and managed metrics and never touched
    `glossary_terms`, so the one store that answers "what do we mean by this word"
    was unreachable from a flow. Four separate things blocked it — no query here,
    no `term` source kind to attach one, the context block that used to carry the
    glossary deliberately switched off for flows, and the measure-level links
    dropped on read. Each had to go.

    RELEVANCE IS REALIZATION, NOT OWNERSHIP
    ---------------------------------------
    A term is company vocabulary; it belongs to no dataset, and the schema says so
    — `glossary_terms` has no asset column at all. So a report cannot "own" terms.
    It can only REACH them, four ways, and each hit says which one was used:

      attached   the step named this term explicitly — always included
      measure    a measure on this report's data points at it
      metric     a metric already in scope names it in `related_term_fqn`
      vocabulary the question itself uses the term or one of its synonyms

    The first three are structural and need no keyword luck. The fourth is the
    honest fallback for a term nobody has wired up yet — and it is a MATCH, not a
    dump: the alternative that was rejected is the one metrics still use, where
    anything unattached is shown everywhere.
    """
    try:
        from app.models.governance import Glossary, GlossaryTerm
    except Exception:  # noqa: BLE001
        return []

    attached = _authored_term_fqns(ctx)
    _tids, dsids = _scope(ctx)
    granted = _granted_dataset_ids(ctx)
    if granted:
        dsids = granted

    via_measure = _measure_term_fqns(ctx, dsids)
    via_metric = {
        str(m.related_term_fqn).strip()
        for m in metrics
        if getattr(m, "related_term_fqn", None)
    }

    out: list[dict] = []
    try:
        rows = (
            ctx.db.query(GlossaryTerm, Glossary.name)
            .join(Glossary, Glossary.id == GlossaryTerm.glossary_id)
            .all()
        )
    except Exception:  # noqa: BLE001
        logger.warning("search_knowledge: glossary scan failed", exc_info=True)
        return []

    for term, set_name in rows:
        if str(term.status or "").strip().lower() == "deprecated":
            continue
        fqn = f"{set_name}.{term.name}"
        synonyms = [str(s) for s in (term.synonyms or []) if str(s).strip()]

        if attached and fqn in attached:
            reached, score = "attached", 100.0
        elif fqn in via_measure:
            reached, score = "measure", 60.0
        elif fqn in via_metric:
            reached, score = "metric", 55.0
        else:
            # Vocabulary reach: the question has to NAME the term — its display
            # name, its machine name, or one of its synonyms — as a phrase.
            said = _question_names(question, [term.display_name or "", term.name, *synonyms])
            if not said:
                continue
            reached, score = "vocabulary", 40.0

        # An EXPLICIT step attachment is a ceiling here exactly as it is for
        # documents: once the author has named the terms this step may read,
        # nothing else joins on a keyword.
        if attached and reached != "attached":
            continue

        hit = knowledge_hit.from_term(term)
        hit["kind"] = "term"
        hit["id"] = fqn
        hit["definition"] = _plain(term.description, MAX_SNIPPET_CHARS)
        hit["synonyms"] = synonyms[:8]
        # WHY this term is here. Without it a reader cannot tell a structural hit
        # from a keyword coincidence, and those two deserve different trust —
        # which is the whole complaint about the metric list.
        hit["reached_by"] = reached
        hit["score"] = score
        out.append(hit)
    return out


def tool_search_knowledge(ctx: ToolContext, args: dict) -> dict:
    query = str((args or {}).get("query") or "").strip()
    if not query:
        return _err("'query' is required — a keyword or the question to look up")
    try:
        limit = int((args or {}).get("limit") or 6)
    except (TypeError, ValueError):
        limit = 6
    limit = max(1, min(limit, MAX_HITS))

    needles = _tokens(query)
    hits: list[dict] = []

    # ── embeddings first, keyword as the floor ───────────────────────────────
    #
    # THIS WAS NOT WIRED UP. The deployment has pgvector installed, an embedding
    # service, and 48 embedded chunks sitting in `govern_doc_chunk` — and this
    # tool never touched any of it. It scored whole documents by token overlap,
    # so a question phrased differently from the document's wording found
    # nothing, and there was no way to tell from the outside that retrieval was
    # keyword-only. That is why the system looked "not connected to embeddings":
    # it was connected everywhere except at the one place a flow reads.
    #
    # `retrieve_doc_chunks` is reused rather than reimplemented. It already does
    # hybrid recall (cosine OR full-text, fused — vector alone misses exact
    # identifiers like a quarter code), and it already restricts to Published
    # docs linked to THIS dashboard, which is the same boundary
    # `_visible_doc_ids` enforces. A second retrieval path would be a second
    # place for that boundary to drift.
    #
    # Keyword scoring still runs underneath: embeddings can be unavailable, a
    # doc can be unembedded, and a chunk store that returns nothing must not
    # turn a working search into an empty one.
    retrieval = "keyword"
    chunk_hits: list[dict] = []
    # The retriever's OWN rows, kept so the context assembler can be handed the
    # full shape — section text, block anchors, trust — rather than the flattened
    # hit dicts below, which are shaped for the tool's JSON reply.
    retrieved_rows: list[dict] = []
    # Computed ONCE and handed to both paths below. Two retrievers deriving the
    # same boundary separately is how they came to disagree about it.
    doc_scope = _visible_doc_ids(ctx)
    # `ToolContext` carries the Dashboard object, not a bare id.
    dash_id = getattr(getattr(ctx, "dashboard", None), "id", None)
    # Gated on the DOC SCOPE, not on the dashboard. A step's grant is a scope in
    # its own right, and gating on `dash_id` sent any dashboard-less flow back to
    # keyword-only recall — the one thing unifying the retrieval path was meant
    # to stop happening.
    if doc_scope:
        try:
            from app.services.dashboard_ai_bot.govern_doc_embeddings import (
                retrieve_doc_chunks,
            )

            # ONE boundary for both retrieval paths. `_visible_doc_ids` already
            # applied this report's entitlement AND the step's own narrowing;
            # passing it means vector recall can no longer reach a document the
            # keyword scan is forbidden from — which it could, through three of
            # the four ways a document gets attached, and past any grant the
            # author set on the step.
            for ch in retrieve_doc_chunks(
                ctx.db,
                int(dash_id) if dash_id else None,
                query,
                k=limit,
                doc_ids=doc_scope,
                consumer="agent_flow",
            ) or []:
                if not isinstance(ch, dict):
                    continue
                retrieved_rows.append(ch)
                # ONE shape, declared in knowledge_hit. This used to be a
                # hand-built dict that renamed six fields on the way past
                # (content→snippet, doc_id→id, rerank_score→rank_score…) and
                # dropped `chunk_id` entirely, so no consumer could point at a
                # passage and check it later.
                hit = knowledge_hit.from_chunk(ch)
                hit["kind"] = "document_chunk"
                chunk_hits.append(hit)
            if chunk_hits:
                retrieval = (
                    "embedding+keyword"
                    if any(h.get("retrieval_method") in ("vector", "both")
                           for h in chunk_hits)
                    else "keyword"
                )
                # The second query that used to live here — one SELECT over
                # GovernKnowledgeDoc purely to attach `updated_at`, `version` and
                # `doc_type` to each hit — is gone. The retriever already joins
                # that table, so it now carries them, along with the governance
                # fields ranking and review warnings need.
                #
                # That is not only one query fewer. The comment it replaced
                # described a real bug: the keyword path attached the date and the
                # chunk path did not, so wiring embeddings in silently dropped it
                # from the hits that rank FIRST. Two places attaching the same
                # fact is what made that possible; there is now one.
        except Exception:  # noqa: BLE001 — retrieval must never break a search
            logger.warning("search_knowledge: chunk retrieval failed", exc_info=True)

    try:
        from app.models.governance import GovernKnowledgeDoc

        doc_ids = doc_scope
        if doc_ids:
            for doc in (
                ctx.db.query(GovernKnowledgeDoc)
                .filter(GovernKnowledgeDoc.id.in_(doc_ids))
                .all()
            ):
                haystack = " ".join(
                    str(x) for x in (doc.title, doc.summary,
                                     _published_body(ctx, doc), doc.tags) if x
                )
                score = _score(haystack, needles)
                if score <= 0:
                    continue
                # WHEN was this written.
                #
                # The hit carried id, title, snippet and score — everything except
                # the one field that decides whether a reader should still trust
                # it. A process document from 2019 quoted as current is the same
                # failure as a forecast anchored to data that stopped in 2018, and
                # the date was sitting on the row all along.
                hit = knowledge_hit.from_document(
                    doc,
                    content=(doc.summary or _published_body(ctx, doc)),
                    method="keyword",
                )
                hit["kind"] = "document"
                hit["score"] = round(score, 3)
                hits.append(hit)
    except Exception:  # noqa: BLE001
        logger.warning("search_knowledge: document scan failed", exc_info=True)

    in_scope_metrics: list[Any] = []
    try:
        in_scope_metrics = _metrics_in_scope(ctx, query)
        for metric in in_scope_metrics:
            score = _score(_metric_text(metric), needles)
            if score <= 0:
                continue
            target = None
            if metric.target_operator and metric.target_value is not None:
                target = f"{metric.target_operator} {metric.target_value}"
            # The shared spine from the contract, then the fields only a metric
            # has. Forcing `formula` and `target` into a shape built for passages
            # would either lose them or put document fields on a KPI — "one
            # contract" means the SHARED facts share names, not that a metric must
            # pretend to be a paragraph.
            hit = knowledge_hit.from_metric(
                metric, home_doc_id=getattr(metric, "home_doc_id", None)
            )
            hit["kind"] = "metric"
            hit["id"] = metric.name
            hit["definition"] = _plain(metric.definition, MAX_SNIPPET_CHARS)
            hit["formula"] = _plain(metric.formula, MAX_SNIPPET_CHARS)
            hit["unit"] = metric.unit or None
            hit["target"] = target
            # A definition bound to this report's data and one that merely shares
            # a word deserve different trust, and only the record can tell them
            # apart.
            hit["reached_by"] = (
                "dataset"
                if (metric.dataset_id is not None or metric.dataset_table_id is not None)
                else "vocabulary"
            )
            hit["score"] = round(score, 3)
            hits.append(hit)
    except Exception:  # noqa: BLE001
        logger.warning("search_knowledge: metric scan failed", exc_info=True)

    # ── the glossary, reached through this report rather than dumped ──────────
    try:
        hits.extend(_terms_in_scope(ctx, in_scope_metrics, query))
    except Exception:  # noqa: BLE001
        logger.warning("search_knowledge: glossary scan failed", exc_info=True)

    hits.sort(key=lambda h: h["score"], reverse=True)
    # De-duplicated first: the same document can arrive down both paths, and
    # paying twice for it in the payload is a cost with no answer attached.
    # On `doc_id`, which is what both paths now call it. This read `c["id"]`,
    # the name the hand-built chunk dict used before the contract landed — and a
    # dedup key that no longer exists does not raise, it silently matches nothing
    # and lets the same document through twice.
    seen_docs = {c.get("doc_id") for c in chunk_hits if c.get("doc_id") is not None}
    vocabulary = [
        h for h in hits
        if not (h.get("kind") == "document" and h.get("doc_id") in seen_docs)
    ]

    # DEFINITIONS GET RESERVED SLOTS; THEY DO NOT COMPETE WITH PASSAGES.
    #
    # This was `chunk_hits + vocabulary`, truncated to `limit`. Passages always
    # won: a report with six embedded documents fills every slot with prose, so a
    # metric definition or a glossary term could be found, counted in
    # `total_matches`, and never once reach the model. Measured — asking "doanh
    # thu thuần nghĩa là gì" on a report whose glossary defines exactly that
    # returned eight document chunks and zero terms.
    #
    # They are not competing for the same job. A passage is evidence with context
    # and costs hundreds of tokens; a definition is one authoritative line and
    # costs a few dozen. Ranking them on one list means the cheap, exact answer
    # loses to whatever prose happened to embed near the question.
    reserved = min(len(vocabulary), max(1, limit // 3))
    top = (chunk_hits[: max(0, limit - reserved)] + vocabulary[:reserved])[:limit]
    # Anything either list still has, if the other left room.
    if len(top) < limit:
        for extra in chunk_hits[len(top):] + vocabulary[reserved:]:
            if extra not in top:
                top.append(extra)
            if len(top) >= limit:
                break
    merged = chunk_hits + vocabulary
    # One assembled, budgeted, NUMBERED evidence block alongside the raw hits, so
    # a step that wants to reason gets the same context the dashboard bot does
    # instead of re-inventing a snippet format — and so there is something for an
    # answer to cite and a verifier to check against.
    context = None
    answerability = None
    if retrieved_rows:
        try:
            from app.services.dashboard_ai_bot.govern_doc_context import assemble

            context = assemble(ctx.db, retrieved_rows)
        except Exception:  # noqa: BLE001 — the hits are still usable without it
            logger.warning("search_knowledge: context assembly failed", exc_info=True)

        # DOES THE EVIDENCE SUPPORT AN ANSWER, AND DO THE SOURCES AGREE?
        #
        # Returned with the passages rather than left to the model to infer. A
        # model handed twelve passages has no way to know that two of them state
        # different numbers for the same policy, or that the closest one is not
        # actually about the question — both are facts about the RESULT SET, which
        # is exactly what the tool is in a position to say and the model is not.
        try:
            from app.services.dashboard_ai_bot import (
                govern_doc_answerability as _ans,
            )
            from app.services.dashboard_ai_bot import govern_doc_conflict as _conf

            conflict = _conf.detect(query, retrieved_rows)
            answerability = _ans.evaluate(
                ctx.db, query, retrieved_rows,
                conflict=conflict, doc_ids=doc_scope,
            )
        except Exception:  # noqa: BLE001 — a verdict is an addition, not a gate
            logger.warning("search_knowledge: answerability failed", exc_info=True)
    return _ok({
        "query": query,
        "total_matches": len(merged),
        "returned": len(top),
        "results": top,
        # WHAT THE EVIDENCE SUPPORTS: ANSWERABLE | PARTIALLY_ANSWERABLE |
        # NOT_ENOUGH_EVIDENCE | CONTRADICTORY, with the reason and the parts of the
        # question that went unanswered.
        "answerability": (answerability or {}).get("verdict"),
        "answerability_reason": (answerability or {}).get("reason"),
        "missing_parts": (answerability or {}).get("missing_clauses") or [],
        # Present ONLY when two sources disagree. Carries both figures and, when
        # the governance record allows it, which one is current.
        #
        # `.get("conflict", {})` was tried and is wrong: the key is ALWAYS written,
        # with None for a non-conflict verdict, and a default only applies when a
        # key is absent. It raised on the first question that had no conflict.
        "conflict": _conflict_payload(answerability),
        # What to tell the reader when there is nothing to answer from — one
        # wording, so every consumer says the same thing.
        "abstain_text": (answerability or {}).get("abstain_text"),
        # The block to put in front of the model, with its citation rules, plus the
        # citations an answer is allowed to use.
        "context": (context or {}).get("text") or None,
        "citations": (context or {}).get("citations") or [],
        "context_tokens": (context or {}).get("tokens") or 0,
        "context_truncated": bool((context or {}).get("truncated")),
        # HOW these were found, said out loud. Without it there is no way to see
        # from a result whether the vector store was consulted, which is exactly
        # why a fully-embedded deployment could look unconnected.
        "retrieval": retrieval,
        "retrieval_note": (
            "Passages were retrieved by MEANING (embeddings) and by keyword, "
            "then merged."
            if retrieval != "keyword" else
            "Keyword ranking only — semantic query vectors were unavailable for "
            "the matching documents, or those documents are not indexed yet."
        ),
        # Said explicitly because the model must not treat a definition's target
        # or an example figure as a measurement of this report.
        "note": (
            "This is a written DEFINITION or DOCUMENT, NOT a measurement from "
            "the report's data. A target or an example figure here is not this "
            "report's number — read the chart data for that."
        ),
    })


def tool_read_document(ctx: ToolContext, args: dict) -> dict:
    raw_id = (args or {}).get("doc_id")
    try:
        doc_id = int(raw_id)
    except (TypeError, ValueError):
        return _err("'doc_id' must be a number — take it from a search_knowledge result")

    if doc_id not in _visible_doc_ids(ctx):
        # Deliberately the same message for "does not exist", "is a draft" and
        # "belongs to another report": an anonymous viewer must not be able to
        # probe which document ids exist by reading the error.
        return _err(
            "no such document within this report's scope. Only Published "
            "documents attached to this report or its dataset can be read."
        )

    from app.models.governance import GovernKnowledgeDoc

    doc = ctx.db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
    if doc is None:
        return _err("no such document within this report's scope")

    # THE PUBLISHED BODY, NOT THE WORKING DRAFT.
    #
    # Retrieval has always served `published_body()`; this tool read `doc.body`,
    # so an agent that searched found the published text and an agent that READ
    # the same document got whatever the author had typed since. On this
    # deployment that was not academic: document 26's draft carries a business
    # rule and a data caveat — "GMV chưa trừ hoàn tiền", "mọi báo cáo nhắc tới GMV
    # phải tham chiếu định nghĩa gốc" — that nobody has published, and the tool
    # handed them over as company policy.
    #
    # Publishing is the act by which somebody takes responsibility for a sentence.
    # A reader must never be shown one that has not happened.
    from app.services.governance_service import GovernanceService

    published = GovernanceService.published_body(ctx.db, doc) or ""
    full_len = len(published)
    body = _plain(published, MAX_BODY_CHARS)
    reading = "whole document"
    passages: list[dict] = []

    # A LONG DOCUMENT, READ AT THE RIGHT PLACE.
    #
    # Truncation took the first N characters, which is the correct passage only
    # when the answer happens to be at the top. On a long policy the reader gets
    # the preamble and the tool reports `truncated: true` — technically honest
    # and practically useless, because the paragraph that answered the question
    # was at the bottom.
    #
    # The chunks are already embedded. When the caller says what it is looking
    # for, rank them and return those instead of the opening. Without a
    # `question` the old behaviour stands: "show me this document" is a
    # different request from "what does this document say about X".
    question = str((args or {}).get("question") or "").strip()
    if question and full_len > MAX_BODY_CHARS:
        try:
            passages = _rank_doc_chunks(ctx, doc_id, question, k=6)
        except Exception:  # noqa: BLE001 — never fail a read over ranking
            logger.warning("read_document: chunk ranking failed", exc_info=True)
        if passages:
            reading = "passages most relevant to the question"
            # Each passage under its heading, so the model sees WHERE in the
            # document each one sits instead of a run-on of fragments, and the
            # answer can name the section it used.
            body = "\n\n".join(
                ("%s\n%s" % (p["heading_path"], p["content"]))
                if p.get("heading_path") else str(p.get("content") or "")
                for p in passages
            )[:MAX_BODY_CHARS]

    return _ok({
        "id": doc.id,
        "title": doc.title,
        "doc_type": doc.doc_type,
        "summary": _plain(doc.summary, MAX_SNIPPET_CHARS) or None,
        "body": body,
        "truncated": full_len > MAX_BODY_CHARS and not passages,
        # WHICH PART was read, and how it was chosen. Without this a model
        # cannot tell the opening of a document from the passages that answer
        # the question, and would summarise one as though it were the other.
        "reading": reading,
        **({"passages": passages,
            "reading_note": (
                f"The document is {full_len:,} characters. These are the "
                f"{len(passages)} passages closest in meaning to the question, "
                "not the document in order — do not describe them as its "
                "structure or its conclusion."
            )} if passages else {}),
        "owner": doc.owner or None,
        "note": (
            "This is prose somebody WROTE. Any figure inside it is a claim from "
            "the document, not a measurement from the report's data — attribute "
            "it to the document, and read the actual number from a chart."
        ),
    })


def _rank_doc_chunks(ctx: ToolContext, doc_id: int, question: str,
                     k: int = 6) -> list[dict]:
    """This document's own chunks, ranked by closeness to the question.

    Scoped to ONE doc_id that the caller has already been cleared for by
    `_visible_doc_ids`, so this adds no reach — it chooses where to read inside
    a document, not which document.
    """
    from app.services.dashboard_ai_bot.govern_doc_embeddings import (
        search_doc_chunks,
    )

    rows = search_doc_chunks(
        ctx.db,
        question,
        k=k,
        doc_ids={doc_id},
        published_only=True,
        authoring=False,
    )
    # Same contract as a search hit. Reading INSIDE one document produces the same
    # kind of thing as searching across many — a passage, with where it is and why
    # it was chosen — and it was returning a fourth shape with a `text` field and
    # no citation, so an agent could quote a section it could not name.
    return [knowledge_hit.from_chunk(row) for row in rows]


def _granted_dataset_ids(ctx: ToolContext) -> set[int] | None:
    raw = (getattr(ctx, "knowledge_scope", None) or {}).get("dataset_ids") or []
    out: set[int] = set()
    for item in raw:
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            continue
    return out or None


def tool_describe_semantic_model(ctx: ToolContext, args: dict) -> dict:
    """The business meaning of the fields behind this report's data.

    The semantic layer already carried this — measure and dimension descriptions,
    aliases, units — and `knowledge_context._semantic_fields` already read it, but
    only to paste into the steering block. Nothing let an agent ASK. So a step
    that needed to know what `payment_value` means had to infer it from the column
    name, which is the guess a later tool call cannot repair.

    Datasets come from the step's grant when it has one, and from the report
    otherwise. Same rule as documents: an explicit grant is the ceiling, and it
    was checked against the author's own rights when it was made.
    """
    from app.services.dashboard_ai_bot.knowledge_context import _semantic_fields

    tids, dsids = _scope(ctx)
    granted = _granted_dataset_ids(ctx)
    if granted:
        dsids = granted

    if not dsids:
        return _ok({
            "datasets": [],
            "fields": [],
            "note": ("No dataset attached to this report carries business descriptions, so "
             "there is no semantic meaning to report. Say the field meanings are "
             "not documented rather than guessing them from column names."),
        })

    try:
        fields = _semantic_fields(ctx.db, set(dsids))
    except Exception:  # noqa: BLE001
        logger.warning("describe_semantic_model failed", exc_info=True)
        fields = []

    query = str((args or {}).get("query") or "").strip()
    if query:
        needles = _tokens(query)
        fields = [
            f for f in fields
            if _score(" ".join(str(v) for v in f.values() if v), needles) > 0
        ]

    return _ok({
        "datasets": sorted(dsids),
        "total": len(fields),
        "fields": fields[:60],
        "note": (
            "These are field DEFINITIONS declared in the Semantic Layer, NOT "
            "measurements. `formula` is how the field is computed and `unit` is "
            "what a figure means once computed — quote them when asked how "
            "something is calculated. A field with no formula here is a plain "
            "column, not a derived one. Read the chart data to get an actual "
            "figure."
        ),
    })


DESCRIBE_SEMANTIC_TOOL_DEF: dict = {
    "name": "describe_semantic_model",
    "description": (
        "What the measures and dimensions behind this report MEAN and how they "
        "are CALCULATED: display name, description, the formula the semantic "
        "layer records, and the unit a figure is expressed in. Use it when the "
        "QUESTION is about what a field means or how it is worked out — "
        "answering that from the column name is a guess a later tool call "
        "cannot repair. Not when you are about to quote a figure: the "
        "measuring tools (total_measure, rank_values, share_of) already return "
        "the aggregation and the unit alongside every number they produce, so "
        "calling this first to learn them costs an extra model round for "
        "nothing. Returns definitions, never measurements."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Keyword to filter fields. Omit to list them all.",
            },
        },
    },
}


SEARCH_KNOWLEDGE_TOOL_DEF: dict = {
    "name": "search_knowledge",
    "description": (
        "Search the company's own knowledge: business documents and the "
        "definitions and formulas of governed KPIs. Use it when the question is "
        "about a concept or a process, or when you need to know how a metric is "
        "DEFINED and CALCULATED. Returns matches with ids; call read_document "
        "with an id to read one in full. Returns no measurements from the report."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to look up, e.g. 'how is GMV calculated'.",
            },
            "limit": {
                "type": "integer",
                "description": f"Maximum matches (1-{MAX_HITS}, default 6).",
            },
        },
        "required": ["query"],
    },
}

READ_DOCUMENT_TOOL_DEF: dict = {
    "name": "read_document",
    "description": (
        "Read one business document in full, by an id from search_knowledge. "
        "Only Published documents attached to this report or its dataset can be "
        "read. Use it when the search snippet is not enough to answer."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "doc_id": {"type": "integer",
                       "description": "Document id from search_knowledge."},
        },
        "required": ["doc_id"],
    },
}

EXPLAIN_MEASUREMENT_TOOL_DEF = {
    "name": "explain_measurement",
    "description": (
        "Ask the company's documents what a MEASUREMENT means. Give it the result "
        "of a target check — the measure's name and how it did against target — and "
        "it returns the passages that define that metric, say how it is calculated, "
        "and name the cases excluded from it. Use it when a figure missed its "
        "target and the answer needs to say why that matters, not just that it "
        "happened. Returns documents, never measurements."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "measure": {
                "type": "string",
                "description": "The measure's name, exactly as the target check "
                               "reported it (e.g. 'on_time_rate').",
            },
            "status": {
                "type": "string",
                "description": "'below_target' or 'on_or_above_target', from the "
                               "target check.",
            },
            "actual": {"type": "number", "description": "The measured value."},
            "target": {"type": "number", "description": "The target it was compared with."},
            "shortfall_pct": {
                "type": "number",
                "description": "How far below target, in percent, when it missed.",
            },
        },
        "required": ["measure"],
    },
}


def tool_explain_measurement(ctx: ToolContext, args: dict) -> dict:
    """A number that missed its target, explained by what the business wrote down.

    THE HALF THAT WAS MISSING
    -------------------------
    This pack's own docstring named it and deferred it: "the comparison tools and
    the knowledge tools are granted separately and never meet... nothing tells a
    comparison result that a relevant document exists." A flow could report
    "on-time delivery 91.2% against a 92% target" and never reach the document
    saying which orders are excluded from that rate.

    Data says WHAT happened; documents say what it MEANS. This is the join.

    TWO CHANNELS, AND THEY ARE NOT THE SAME KIND OF FACT
    ----------------------------------------------------
    * the metric's HOME DOCUMENT — somebody DECLARED that this document defines
      this KPI. Retrieved directly and marked `metric_home`, because a declaration
      outranks a good cosine and a reader should be able to tell them apart.
    * ordinary retrieval, using the metric's own recorded synonyms — a chart column
      called `on_time_rate` finds nothing in a corpus that says "tỷ lệ giao đúng
      hẹn", and the metric record is the translation between them.

    Scope is the same boundary as every other knowledge read: naming a metric does
    not grant access to the document that defines it.
    """
    from app.services.dashboard_ai_bot import govern_doc_evidence_link as link

    measure = str((args or {}).get("measure") or "").strip()
    if not measure:
        return _err("'measure' is required — take it from a target check result")

    evidence = {
        "measure": measure,
        "status": str((args or {}).get("status") or "below_target"),
        "actual": (args or {}).get("actual"),
        "target": (args or {}).get("target"),
        "shortfall_pct": (args or {}).get("shortfall_pct"),
        "unit": None,
    }
    scope = _visible_doc_ids(ctx)
    if not scope:
        return _err(
            "no documents are in this report's scope, so there is nothing to "
            "explain the figure with."
        )

    plan = link.to_question(ctx.db, evidence)

    from app.services.dashboard_ai_bot.govern_doc_embeddings import search_doc_chunks

    rows = search_doc_chunks(ctx.db, plan["question"], k=6, doc_ids=scope) or []
    # The declared definition, added on top and de-duplicated by chunk. It is a
    # different KIND of evidence, so it is fetched even when similarity already
    # found the same document.
    home_rows = link.home_doc_passages(
        ctx.db, plan["home_doc_id"], plan["question"], scope=scope, k=3)
    seen = {r.get("chunk_id") for r in rows}
    rows = home_rows + [r for r in rows if r.get("chunk_id") not in
                        {h.get("chunk_id") for h in home_rows}]

    hits = []
    for row in rows[:8]:
        hit = knowledge_hit.from_chunk(row)
        hit["kind"] = "document_chunk"
        # WHY this passage is here, in a word a trace can show.
        hit["reached_by"] = row.get("reached_by") or "semantic"
        hits.append(hit)

    context = None
    answerability = None
    if rows:
        try:
            from app.services.dashboard_ai_bot import (
                govern_doc_answerability as _ans,
            )
            from app.services.dashboard_ai_bot import govern_doc_conflict as _conf
            from app.services.dashboard_ai_bot.govern_doc_context import assemble

            context = assemble(ctx.db, rows)
            conflict = _conf.detect(plan["question"], rows)
            answerability = _ans.evaluate(
                ctx.db, plan["question"], rows, conflict=conflict, doc_ids=scope,
                # NO CLAUSE COVERAGE HERE. That verdict answers "did the evidence
                # cover every part the USER asked", and there is no user question
                # in this call — the query was composed from a measurement, and
                # its aspects ("định nghĩa, cách tính, trường hợp loại trừ") are
                # search hints, not things anyone asked separately. The clause
                # splitter reads the commas and reports PARTIALLY_ANSWERABLE by
                # construction on every single call.
                check_clauses=False)
        except Exception:  # noqa: BLE001 — the passages are usable without them
            logger.warning("explain_measurement: assembly failed", exc_info=True)

    return _ok({
        # WHAT WAS ASKED, and why. A trace showing "the bot searched the documents"
        # explains nothing; "it missed its target by 0.8 points and went looking
        # for the rule" explains it.
        "asked": plan["question"],
        "reason": plan["reason"],
        "grounded_in": plan["grounded_in"],
        "metric": plan["metric"],
        "home_doc_id": plan["home_doc_id"],
        "results": hits,
        "context": (context or {}).get("text") or None,
        "citations": (context or {}).get("citations") or [],
        "answerability": (answerability or {}).get("verdict"),
        "abstain_text": (answerability or {}).get("abstain_text"),
        "conflict": _conflict_payload(answerability),
        "note": (
            "These are DOCUMENTS explaining the metric, not measurements of it. "
            "A figure quoted in this prose is a target or an example somebody "
            "wrote, never this report's number — read the chart for that."
        ),
    })


GOVERN_TOOL_DEFS: list[dict] = [
    SEARCH_KNOWLEDGE_TOOL_DEF,
    READ_DOCUMENT_TOOL_DEF,
    DESCRIBE_SEMANTIC_TOOL_DEF,
    EXPLAIN_MEASUREMENT_TOOL_DEF,
]
GOVERN_TOOLS = {
    "search_knowledge": tool_search_knowledge,
    "read_document": tool_read_document,
    "describe_semantic_model": tool_describe_semantic_model,
    "explain_measurement": tool_explain_measurement,
}
