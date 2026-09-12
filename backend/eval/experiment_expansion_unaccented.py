"""Does vocabulary expansion recover what unaccented Vietnamese loses?

THE MEASURED GAP THIS ANSWERS
-----------------------------
Phase 2 established that the cross-encoder is inert on unaccented Vietnamese: every
candidate scores negative, the relevance gate adds the same zero to all of them, and
the ranking falls back to the folding lexical path. Measured then:

    arm            accented          unaccented
    gate off       0.742 / 0.860     0.742 / 0.860
    gate sign      0.806 / 0.898     0.742 / 0.860   ← identical to off

A Vietnamese reader types "muc tieu giao dung hen" as often as "mục tiêu giao đúng
hẹn". On those questions a third of the pipeline is switched off, and the eval
corpus — written in careful accented Vietnamese — never showed it.

Expansion is the repair: when a question is unaccented AND the business vocabulary
holds the accented form of a term it names, that form is a better query for the half
of the pipeline that cannot fold. This measures whether it actually is.

Arms, on the SAME cases with diacritics stripped from every question:

    expansion off      what phase 2 measured
    expansion on       production behaviour after phase 4

The accented run is the ceiling. Closing part of the distance to it is the win;
matching "off" exactly means the feature does nothing where it was aimed.
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from app.core.text_fold import strip_diacritics  # noqa: E402
from app.models.governance import GovernKnowledgeDoc  # noqa: E402
from app.services.dashboard_ai_bot import govern_doc_expansion as expansion  # noqa: E402

import run_document_retrieval_eval as harness  # noqa: E402


def run(*, unaccented: bool, k: int = 12) -> dict:
    from app.core.database import SessionLocal

    with open(harness.CASES_PATH, encoding="utf-8") as handle:
        spec = json.load(handle)

    db = SessionLocal()
    published = db.query(GovernKnowledgeDoc).filter(
        GovernKnowledgeDoc.status == "Published").all()
    doc_ids = {d.id for d in published}
    title_to_id = {d.title: d.id for d in published}

    cases = [c for c in spec["cases"]
             if "agent_all_docs" in (c.get("scopes") or ["agent_all_docs"])]
    # ONLY the question is folded. The documents keep their diacritics — that
    # asymmetry IS the case being measured.
    if unaccented:
        cases = [{**c, "question": strip_diacritics(c["question"])} for c in cases]

    results = [harness.run_case(db, c, k=k, scope="agent_all_docs",
                                doc_ids=doc_ids, title_to_id=title_to_id)
               for c in cases]
    db.close()
    return harness.summarise(results)


def main() -> int:
    original = expansion.expand
    keys = ("hit@1", "mrr", "recall@3", "recall@6", "phrase_hit")

    print("%-34s%s" % ("arm", "".join("%11s" % key for key in keys)))

    def show(label: str, summary: dict) -> None:
        print("%-34s%s" % (label, "".join(
            "%11s" % (summary.get(key) if summary.get(key) is not None else "-")
            for key in keys)))

    show("ACCENTED (ceiling)", run(unaccented=False))

    expansion.expand = lambda *a, **k: []
    try:
        show("unaccented, expansion OFF", run(unaccented=True))
    finally:
        expansion.expand = original

    show("unaccented, expansion ON", run(unaccented=True))
    print()
    print("Matching OFF exactly means the feature does nothing where it was aimed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
