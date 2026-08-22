"""Does the cross-encoder rank better than what runs today?

WHY IT WRAPS THE PRODUCTION SCORER INSTEAD OF REBUILDING ONE
------------------------------------------------------------
The first version of this script assembled its own candidate pool. That is the
same mistake that produced the worst bug found in this pipeline: two code paths
building "the same" query, diverging, and returning different candidate sets. An
experiment that measures a reconstruction measures the reconstruction.

So this monkeypatches ONE function — `doc_rerank.score_candidates` — and runs the
real eval harness through the real retriever twice. Everything else, including
the diversity quota, the metric-SSOT term and the query planner, is identical
between the arms, which is the only way the difference is attributable.

ARMS
----
  current    cosine × lexical amplification (what ships today)
  ce_only    the cross-encoder replaces the relevance terms, keeping governance
             and metric-SSOT (a declared definition is a fact, not a relevance
             judgement for a language model to overrule)
  ce_blend   the cross-encoder amplified by the retriever's cosine — the same
             shape that beat a plain weighted sum when the lexical arm was swept

Three of the four things added to this pipeline as improvements made ranking
worse until they were measured. This runs before anything ships.
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from app.services.dashboard_ai_bot import doc_rerank  # noqa: E402
from app.services.dashboard_ai_bot import doc_rerank_semantic as ce  # noqa: E402

import run_document_retrieval_eval as harness  # noqa: E402

_ORIGINAL = doc_rerank.score_candidates


def _patched(mode: str):
    """`score_candidates` with the cross-encoder in place of the relevance terms.

    Governance and metric-SSOT are preserved verbatim: they answer "is this
    document authoritative for this metric", which no reranker observes.
    """
    def score_candidates(db, question, rows, *, sql_filter, params,
                         metric_home_docs=None):
        base = _ORIGINAL(db, question, rows, sql_filter=sql_filter, params=params,
                         metric_home_docs=metric_home_docs)
        scores = ce.score_pairs(question, base)
        if scores is None:
            return base
        for row, semantic in zip(base, scores):
            governance = doc_rerank._W_GOVERNANCE * doc_rerank.governance_score(row)
            ssot = (doc_rerank._W_METRIC_SSOT
                    if (metric_home_docs and row.get("doc_id") in metric_home_docs)
                    else 0.0)
            cosine = float(row.get("similarity") or 0.0)
            bm25 = float(row.get("bm25") or 0.0)
            if mode == "ce_only":
                relevance = semantic
            elif mode == "ce_w05":
                # Scaled DOWN so the cross-encoder ranks documents while cosine
                # still orders passages inside one. The saturation measurement said
                # the logit is nearly binary; a smaller weight lets a real gradient
                # break its ties instead of being steamrollered by ±8.
                relevance = 0.5 * semantic + cosine * max(1.0, bm25)
            elif mode == "ce_w015":
                relevance = 0.15 * semantic + cosine * max(1.0, bm25)
            else:  # ce_gate — the cross-encoder decides RELEVANT or NOT, the
                # existing score decides the order among the relevant ones. This
                # is the shape the saturation actually argues for.
                relevance = (2.0 if semantic > 0 else 0.0) + cosine * max(1.0, bm25)
            row["ce_score"] = round(semantic, 4)
            row["rerank_score"] = round(relevance + governance + ssot, 4)
        base.sort(key=lambda r: (-r["rerank_score"], r["chunk_id"]))
        return doc_rerank._diversify(base)

    return score_candidates


def run(k: int = 12) -> dict:
    """One arm, all three suites, using the harness's own case loop and metrics."""
    from app.core.database import SessionLocal
    from app.models.governance import GovernKnowledgeDoc
    from sqlalchemy import text

    with open(harness.CASES_PATH, encoding="utf-8") as handle:
        spec = json.load(handle)

    db = SessionLocal()
    published = db.query(GovernKnowledgeDoc).filter(
        GovernKnowledgeDoc.status == "Published"
    ).all()
    all_doc_ids = {d.id for d in published}
    title_to_id = {d.title: d.id for d in published}
    linked = {
        int(r[0]) for r in db.execute(text(
            "SELECT DISTINCT doc_id FROM govern_doc_asset_links "
            "WHERE asset_type = 'dashboard' AND asset_ref = :ref"
        ), {"ref": str(harness.DASHBOARD_ID)}).fetchall()
    } & all_doc_ids

    out = {}
    for scope, scope_docs in (("dashboard", None),
                              ("agent_same_scope", linked),
                              ("agent_all_docs", all_doc_ids)):
        applicable = [c for c in spec["cases"]
                      if scope in (c.get("scopes") or [scope])]
        results = [harness.run_case(db, c, k=k, scope=scope, doc_ids=scope_docs,
                                   title_to_id=title_to_id)
                   for c in applicable]
        out[scope] = harness.summarise(results)
    db.close()
    return out


def main() -> int:
    if not ce.available():
        print("cross-encoder model not present at %s — nothing to compare" % ce.MODEL_DIR)
        return 1

    arms = {}
    doc_rerank.score_candidates = _ORIGINAL
    arms["current"] = run()
    for mode in ("ce_only", "ce_w05", "ce_w015", "ce_gate"):
        doc_rerank.score_candidates = _patched(mode)
        arms[mode] = run()
    doc_rerank.score_candidates = _ORIGINAL

    keys = ("hit@1", "mrr", "recall@3", "recall@6", "phrase_hit", "p95_ms")
    for suite in ("dashboard", "agent_all_docs"):
        print("\n=== %s ===" % suite)
        print("%-10s" % "arm" + "".join("%11s" % key for key in keys))
        for name, summary in arms.items():
            row = summary[suite]
            print("%-10s" % name + "".join(
                "%11s" % (row.get(key) if row.get(key) is not None else "-")
                for key in keys
            ))
    print()
    print("A win on ranking that costs half a second per question is not a win.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
