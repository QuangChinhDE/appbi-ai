"""Does query expansion ever fire, and does firing help?

WHY THIS IS ASKED BEFORE ANYTHING IS BUILT
------------------------------------------
`search_doc_chunks` escalates when `uncovered_clauses` says a part of the question
found no evidence. Phase 2 measured that exact function for a different purpose and
it caught 0 of 3 partial questions: it calls a clause covered when ANY of its terms
appears ANYWHERE in the retrieved text, and "chính sách" appears in something.

So the trigger may be firing almost never, or firing on the wrong questions. Adding
spelling correction and LLM rewrite on top of a trigger that does not work would be
building a second floor on an unmeasured one.

WHAT IS MEASURED
----------------
Per case, with expansion ON and OFF:

    fired          did the planner decide to look again
    extra          how many extra retrieval passes it paid for
    rank           where the expected document landed
    changed        did expansion move the answer at all

An expansion that fires often and changes nothing is a cost. One that never fires
is a feature that does not exist. Both are invisible without this.
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from app.core.database import SessionLocal  # noqa: E402
from app.models.governance import GovernKnowledgeDoc  # noqa: E402
from app.services.dashboard_ai_bot import govern_doc_expansion as expansion  # noqa: E402
from app.services.dashboard_ai_bot import govern_doc_query_plan as plan  # noqa: E402
from app.services.dashboard_ai_bot.govern_doc_embeddings import (  # noqa: E402
    search_doc_chunks,
)

import run_document_retrieval_eval as harness  # noqa: E402


def rank_of(rows: list[dict], expected: set[int]) -> int | None:
    for i, row in enumerate(rows, 1):
        if row.get("doc_id") in expected:
            return i
    return None


def main() -> int:
    spec = json.load(open(harness.CASES_PATH, encoding="utf-8"))
    db = SessionLocal()
    published = db.query(GovernKnowledgeDoc).filter(
        GovernKnowledgeDoc.status == "Published").all()
    all_ids = {d.id for d in published}
    title_to_id = {d.title: d.id for d in published}

    fired: list[tuple] = []
    changed: list[tuple] = []
    total = 0

    original_uncovered = plan.uncovered_clauses
    original_expand = expansion.expand

    for case in spec["cases"]:
        expected = harness.resolve_expected(db, case, title_to_id)
        question = case["question"]

        # WITH expansion (production behaviour)
        with_rows = search_doc_chunks(db, question, k=12, doc_ids=all_ids) or []
        plan_info = (with_rows[0].get("query_plan") if with_rows else None) or {}
        extra = int(plan_info.get("extra_passes") or 0)

        # WITHOUT: the same call with both expansion sources silenced
        plan.uncovered_clauses = lambda *a, **k: []
        expansion.expand = lambda *a, **k: []
        try:
            without_rows = search_doc_chunks(db, question, k=12, doc_ids=all_ids) or []
        finally:
            plan.uncovered_clauses = original_uncovered
            expansion.expand = original_expand

        total += 1
        if extra:
            fired.append((case["id"], extra,
                          [(e["source"], e["query"][:22])
                           for e in (plan_info.get("expansions") or [])]))
        if expected:
            before = rank_of(without_rows, expected)
            after = rank_of(with_rows, expected)
            if before != after:
                changed.append((case["id"], before, after))
        elif [r.get("chunk_id") for r in with_rows] != [r.get("chunk_id") for r in without_rows]:
            changed.append((case["id"], "—", "khac"))

    db.close()

    print("cases: %d" % total)
    print("expansion fired on: %d (%.0f%%)" % (len(fired), 100.0 * len(fired) / max(1, total)))
    print("outcome changed on: %d" % len(changed))
    print()
    if fired:
        print("--- fired ---")
        for cid, extra, uncovered in fired:
            print("   %-30s +%d pass  %s" % (cid, extra, uncovered[:3]))
    print()
    if changed:
        print("--- changed (rank of expected doc) ---")
        for cid, before, after in changed:
            print("   %-30s %s -> %s" % (cid, before, after))
    else:
        print("--- nothing changed: expansion is paying for passes that move no answer ---")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
