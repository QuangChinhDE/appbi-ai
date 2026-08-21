"""Two questions this asks that no other suite does.

1. WHAT HAPPENS WHEN THE READER TYPES WITHOUT DIACRITICS
-------------------------------------------------------
Vietnamese users type "muc tieu giao dung hen" constantly — it is the reason
`text_fold` exists and the reason every lexical path in this codebase folds. The
eval corpus, however, is written in careful accented Vietnamese, so it has never
measured the query shape a real user is most likely to send.

Observed on one question: with diacritics the cross-encoder scores the answering
passage +7.5 and the irrelevant ones below zero; without them EVERY candidate
scores negative. The relative order survives, the absolute sign does not — which
matters because the gate's decision boundary is zero. So on unaccented queries the
gate contributes nothing at all. It does no harm (the ranking falls back to the
base score) but the whole component is inert on the input a user is most likely to
type, and that is worth knowing before calling it shipped.

2. WHETHER A RELATIVE GATE WOULD BE BETTER
------------------------------------------
A sign test assumes the score is calibrated in absolute terms. Relevance ranking
does not need that — it needs SEPARATION. So this measures a `margin` gate: lift
the candidates within a margin of the best-scoring one, whatever the absolute
values. If it holds up on accented queries and also works on unaccented ones, it
is strictly better. If it loses on accented queries, the sign gate stays and this
file records why.

Arms × query forms, all through the real retriever with only the gate swapped.

SLOW BY CONSTRUCTION: 3 arms × 2 query forms × 2 suites, each a full retrieval
pass with cross-encoder scoring — budget 10-15 minutes and run it detached, not
inside a shell with a timeout.
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from app.core.text_fold import strip_diacritics  # noqa: E402
from app.services.dashboard_ai_bot import doc_rerank  # noqa: E402
from app.services.dashboard_ai_bot import doc_rerank_semantic as ce  # noqa: E402

import run_document_retrieval_eval as harness  # noqa: E402

_ORIGINAL_GATE = doc_rerank._apply_relevance_gate

#: How far below the best score still counts as relevant, for the margin arm.
MARGIN = 4.0


def gate_off(question, scored):
    return scored


def gate_margin(question, scored):
    """Relevant = within MARGIN of the best candidate, not "above zero"."""
    if len(scored) < 2:
        return scored
    verdicts = ce.score_pairs(question, scored)
    if verdicts is None:
        return scored
    best = max(verdicts)
    for row, logit in zip(scored, verdicts):
        row["ce_logit"] = round(float(logit), 3)
        if logit >= best - MARGIN:
            row["rerank_score"] = round(row["rerank_score"] + doc_rerank._W_CE_GATE, 4)
    scored.sort(key=lambda r: (-r["rerank_score"], r["chunk_id"]))
    return scored


def run(k: int = 12, unaccented: bool = False) -> dict:
    from app.core.database import SessionLocal
    from app.models.governance import GovernKnowledgeDoc
    from sqlalchemy import text

    with open(harness.CASES_PATH, encoding="utf-8") as handle:
        spec = json.load(handle)

    db = SessionLocal()
    published = db.query(GovernKnowledgeDoc).filter(
        GovernKnowledgeDoc.status == "Published").all()
    all_doc_ids = {d.id for d in published}
    title_to_id = {d.title: d.id for d in published}

    out = {}
    for scope, scope_docs in (("dashboard", None), ("agent_all_docs", all_doc_ids)):
        applicable = [c for c in spec["cases"]
                      if scope in (c.get("scopes") or [scope])]
        cases = []
        for case in applicable:
            # ONLY the question is folded. The expected phrases stay as written,
            # because the DOCUMENT still has its diacritics — which is exactly the
            # asymmetry a real unaccented query has to cross.
            cases.append({**case, "question": strip_diacritics(case["question"])}
                         if unaccented else case)
        results = [harness.run_case(db, c, k=k, scope=scope, doc_ids=scope_docs,
                                   title_to_id=title_to_id)
                   for c in cases]
        out[scope] = harness.summarise(results)
    db.close()
    return out


def main() -> int:
    if not ce.available():
        print("cross-encoder model not present — nothing to compare")
        return 1

    arms = {"gate off": gate_off, "gate sign (ships)": _ORIGINAL_GATE,
            "gate margin %.0f" % MARGIN: gate_margin}
    keys = ("hit@1", "mrr", "recall@3", "recall@6", "phrase_hit")

    for label, unaccented in (("ACCENTED (as authored)", False),
                              ("UNACCENTED (as typed)", True)):
        print("\n=== %s · agent_all_docs ===" % label)
        print("%-20s" % "arm" + "".join("%11s" % key for key in keys))
        for name, gate in arms.items():
            doc_rerank._apply_relevance_gate = gate
            row = run(unaccented=unaccented)["agent_all_docs"]
            print("%-20s" % name + "".join(
                "%11s" % (row.get(key) if row.get(key) is not None else "-")
                for key in keys))
    doc_rerank._apply_relevance_gate = _ORIGINAL_GATE
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
