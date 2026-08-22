"""Does the answerability verdict match what each question actually deserves?

A detector is only as good as its FALSE POSITIVE rate. Abstaining on a question the
corpus answers, or announcing a contradiction where there is none, are both worse
than the silence they replace: the first makes the system look broken to somebody
holding the document, the second teaches readers to ignore the warning.

So this reports a confusion matrix over every case, not an accuracy. The four
verdicts are not interchangeable and their errors are not symmetric.

Expected verdict per case comes from the case file:

    should_abstain: true        → NOT_ENOUGH_EVIDENCE
    partially_answerable: true  → PARTIALLY_ANSWERABLE
    expect_conflict: true       → CONTRADICTORY
    otherwise                   → ANSWERABLE

Run per SCOPE, because a conflict is a property of what is in reach: the same
question is answerable on a dashboard whose documents agree and contradictory
across a corpus that also holds an old handbook. A detector that ignores scope
would be wrong on one of the two.
"""
from __future__ import annotations

import json
import sys
from collections import Counter

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from app.core.database import SessionLocal  # noqa: E402
from app.models.governance import GovernKnowledgeDoc  # noqa: E402
from app.services.dashboard_ai_bot import govern_doc_answerability as ans  # noqa: E402
from app.services.dashboard_ai_bot import govern_doc_conflict as conf  # noqa: E402
from app.services.dashboard_ai_bot.govern_doc_embeddings import (  # noqa: E402
    search_doc_chunks,
)
from sqlalchemy import text  # noqa: E402

import run_document_retrieval_eval as harness  # noqa: E402


def expected(case: dict, scope: str) -> str:
    """The verdict this case deserves IN THIS SCOPE.

    Conflict is scope-dependent and nothing else is: a question about the on-time
    delivery figure is answerable on a dashboard whose documents agree and
    contradictory across a corpus that also holds an old handbook stating a
    different number. `conflict_in_scopes` names where that happens.
    """
    if case.get("should_abstain"):
        return ans.NOT_ENOUGH_EVIDENCE
    if case.get("partially_answerable"):
        return ans.PARTIALLY_ANSWERABLE
    if case.get("expect_conflict"):
        return ans.CONTRADICTORY
    if scope in (case.get("conflict_in_scopes") or []):
        return ans.CONTRADICTORY
    return ans.ANSWERABLE


def main() -> int:
    spec = json.load(open(harness.CASES_PATH, encoding="utf-8"))
    db = SessionLocal()
    published = db.query(GovernKnowledgeDoc).filter(
        GovernKnowledgeDoc.status == "Published").all()
    all_ids = {d.id for d in published}
    linked = {
        int(r[0]) for r in db.execute(text(
            "SELECT DISTINCT doc_id FROM govern_doc_asset_links "
            "WHERE asset_type = 'dashboard' AND asset_ref = :ref"
        ), {"ref": str(harness.DASHBOARD_ID)}).fetchall()
    } & all_ids

    for scope_key, scope_name, doc_ids in (
            ("dashboard", "dashboard (fixtures out of reach)", linked),
            ("agent_all_docs", "agent_all_docs (fixtures in reach)", all_ids)):
        cases = [c for c in spec["cases"]
                 if scope_name.startswith("agent") or "agent_all_docs" not in (c.get("scopes") or ["x"])]
        matrix: Counter = Counter()
        wrong: list[tuple] = []
        for case in cases:
            rows = search_doc_chunks(db, case["question"], k=12, doc_ids=doc_ids) or []
            conflict = conf.detect(case["question"], rows)
            verdict = ans.evaluate(db, case["question"], rows, conflict=conflict,
                                   doc_ids=doc_ids)
            want = expected(case, scope_key)
            got = verdict["verdict"]
            matrix[(want, got)] += 1
            if want != got:
                wrong.append((case["id"], case["category"], want, got,
                              verdict["reason"][:74]))

        total = sum(matrix.values())
        correct = sum(n for (w, g), n in matrix.items() if w == g)
        print("\n=== %s ===" % scope_name)
        print("   %d/%d dung (%.0f%%)" % (correct, total, 100.0 * correct / max(1, total)))
        print()
        verdicts = [ans.ANSWERABLE, ans.PARTIALLY_ANSWERABLE,
                    ans.NOT_ENOUGH_EVIDENCE, ans.CONTRADICTORY]
        print("   %-22s %s" % ("mong \\ nhan", "".join("%-9s" % v[:8] for v in verdicts)))
        for want in verdicts:
            row = "".join("%-9s" % matrix.get((want, got), 0) for got in verdicts)
            if any(matrix.get((want, g)) for g in verdicts):
                print("   %-22s %s" % (want[:20], row))
        if wrong:
            print()
            print("   sai:")
            for cid, cat, want, got, why in wrong:
                print("      %-26s [%s] mong %-20s nhan %-20s" % (cid, cat, want, got))
                print("            %s" % why)
    db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
