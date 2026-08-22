"""Where is the line between "this part of the question is answered" and "it is not"?

The question-level floor (−4.5) does not transfer. A clause is a fragment — "GMV
được tính thế nào" rather than a whole question — and the cross-encoder scores
fragments lower even when the evidence is right there: measured, an ANSWERABLE
clause reached only −1.31 while the question it came from was comfortably above the
question-level floor. Reusing −4.5 for clauses would call almost every clause
answered, which is exactly the bug this replaces: the query planner's `any(term in
haystack)` rule counted a clause as covered when one common word appeared.

So the clause floor gets its own measurement, over the clauses of every multi-part
case in the corpus, labelled by the case file:

    partially_answerable + answerable_part / unanswerable_part
        → the named part is the one that should come back missing

    multi_doc / anything else with two clauses
        → CONTROL. Both parts are answerable. Without these a detector that fires
          on every multi-part question would score perfectly and be useless.

Each clause is retrieved for SEPARATELY. Scoring a clause against passages fetched
for the whole composite question measures the retrieval split, not the clause.
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from app.core.database import SessionLocal  # noqa: E402
from app.core.text_fold import fold_text  # noqa: E402
from app.models.governance import GovernKnowledgeDoc  # noqa: E402
from app.services.dashboard_ai_bot.govern_doc_embeddings import (  # noqa: E402
    search_doc_chunks,
)
from app.services.dashboard_ai_bot.govern_doc_query_plan import clauses  # noqa: E402

import run_document_retrieval_eval as harness  # noqa: E402


def label(case: dict, clause: str) -> str | None:
    """Is this clause supposed to be answered? None when the case does not say."""
    if case.get("should_abstain"):
        # A no-answer case: EVERY clause is missing. Labelling them "covered"
        # because the case is not marked partial put two genuinely-absent clauses
        # into the covered distribution at −5.68 and −4.38, and made the two
        # distributions look hopelessly overlapped when they were not.
        return "missing"
    if not case.get("partially_answerable"):
        return "covered"          # a control case: every clause is answerable
    folded = fold_text(clause)
    for key, verdict in (("unanswerable_part", "missing"),
                         ("answerable_part", "covered")):
        part = case.get(key)
        if part and fold_text(part) in folded:
            return verdict
    return None                   # the splitter cut it somewhere the case did not name


def main() -> int:
    spec = json.load(open(harness.CASES_PATH, encoding="utf-8"))
    db = SessionLocal()
    doc_ids = {
        d.id for d in db.query(GovernKnowledgeDoc)
        .filter(GovernKnowledgeDoc.status == "Published").all()
    }

    covered: list[tuple[str, float]] = []
    missing: list[tuple[str, float]] = []
    for case in spec["cases"]:
        parts = clauses(case["question"])
        if len(parts) < 2:
            continue
        for clause in parts:
            verdict = label(case, clause)
            if verdict is None:
                continue
            rows = search_doc_chunks(db, clause, k=8, doc_ids=doc_ids) or []
            judged = [r["ce_logit"] for r in rows if r.get("ce_logit") is not None]
            if not judged:
                continue
            (covered if verdict == "covered" else missing).append(
                (clause[:40], max(judged))
            )
    db.close()

    print("clauses: %d covered | %d missing" % (len(covered), len(missing)))
    print()
    print("--- COVERED (bang chung co that) ---")
    for name, score in sorted(covered, key=lambda x: x[1]):
        print("   %-44s %6.2f" % (name, score))
    print()
    print("--- MISSING (corpus khong co) ---")
    for name, score in sorted(missing, key=lambda x: -x[1]):
        print("   %-44s %6.2f" % (name, score))

    if not covered or not missing:
        print("\nkhong du du lieu de quet nguong")
        return 1

    lo = min(s for _n, s in covered)
    hi = max(s for _n, s in missing)
    print()
    print("covered thap nhat  %6.2f" % lo)
    print("missing cao nhat   %6.2f" % hi)
    print("khoang cach        %6.2f   %s" % (
        lo - hi, "TACH RO" if lo > hi else "CHONG LAN — mot nguong se sai o day"))

    print()
    print("%-10s %-16s %-18s" % ("floor", "missing bat", "covered bi oan"))
    for floor in (-1.0, -1.5, -2.0, -2.5, -3.0, -3.5, -4.5):
        caught = sum(1 for _n, s in missing if s < floor)
        false = sum(1 for _n, s in covered if s < floor)
        print("%-10s %-16s %-18s" % (
            floor, "%d/%d" % (caught, len(missing)),
            "%d  %s" % (false, "<-- HONG" if false else "sach")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
