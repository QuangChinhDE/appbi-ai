"""EXPERIMENT — how many chunks from one document should the window allow?

Structure-aware chunking made chunks smaller, and small chunks let one document
fill the window: `multi-targets` ("list the operations and experience targets")
needs documents 27 AND 28, and stopped finding both inside the top 6. A per
document quota trades depth on the best-matching document for breadth across
documents, and which way that trade should go is a measurement, not an opinion.

Reported for each quota:

    recall@1/3/6    did the expected document(s) make the window
    MRR             ranking quality overall
    phrase (asm)    is the answer text in what the model would be handed
    docs@k          how many distinct documents the window actually contained

A quota that improves recall@6 while dropping MRR is buying breadth with
precision; the numbers below say whether that happened.

Run:  PYTHONPATH=/app:/app/eval python /app/eval/experiment_diversity.py
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from sqlalchemy import text  # noqa: E402

from app.core.database import SessionLocal  # noqa: E402
from app.models.governance import GovernKnowledgeDoc  # noqa: E402
from app.services.dashboard_ai_bot import doc_rerank  # noqa: E402

import run_document_retrieval_eval as harness  # noqa: E402


def main():
    with open(harness.CASES_PATH, encoding="utf-8") as fh:
        cases = json.load(fh)["cases"]

    db = SessionLocal()
    published = {
        d.id for d in db.query(GovernKnowledgeDoc)
        .filter(GovernKnowledgeDoc.status == "Published").all()
    }
    linked = {
        int(r[0]) for r in db.execute(text(
            "SELECT DISTINCT doc_id FROM govern_doc_asset_links "
            "WHERE asset_type = 'dashboard' AND asset_ref = :ref"
        ), {"ref": str(harness.DASHBOARD_ID)}).fetchall()
    } & published

    original = doc_rerank._MAX_PER_DOC
    print("scope: %d docs | %d cases | k=12\n" % (len(linked), len(cases)))
    print("%-10s%-10s%-10s%-10s%-8s%-14s%s"
          % ("quota", "recall@1", "recall@3", "recall@6", "MRR", "phrase(asm)", "docs@k"))

    for quota in (1, 2, 3, 4, 6, 999):
        doc_rerank._MAX_PER_DOC = quota
        results = [harness.run_case(db, c, k=12, scope="agent_same_scope", doc_ids=linked)
                   for c in cases]
        s = harness.summarise(results)
        print("%-10s%-10s%-10s%-10s%-8s%-14s%s"
              % ("none" if quota == 999 else quota,
                 s["recall@1"], s["recall@3"], s["recall@6"], s["mrr"],
                 s["phrase_hit_assembled"], s["avg_docs_in_top_k"]))

    doc_rerank._MAX_PER_DOC = original
    db.close()


if __name__ == "__main__":
    main()
