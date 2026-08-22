"""Can anything in retrieval tell an answerable question from an unanswerable one?

WHY THIS IS ASKED AGAIN
-----------------------
It was measured before and the answer was no: neither cosine nor term coverage
separates them on this corpus. Every weighting and both score formulas were swept,
and the best gap between the answerable and unanswerable distributions was
NEGATIVE — the unanswerable questions scored higher. `answer_confidence` was
deleted rather than shipped as a false signal.

That measurement is not stale, but it is incomplete: it predates the cross-encoder.
Cosine is a distance between two independently-built vectors, and a passage's
vector was built before anyone asked the question. The cross-encoder reads the pair
together and was TRAINED to answer "does this passage answer this question" — which
is the question being asked here, not a proxy for it. So it deserves its own
measurement rather than an assumption in either direction.

WHAT IS MEASURED
----------------
For every case, retrieval runs and these are recorded:

  best_ce       max cross-encoder logit over the candidates
  n_relevant    how many candidates the gate judged relevant (logit > 0)
  best_cosine   the old signal, kept as the control
  best_coverage the other old signal, same reason

Then, for each: the best threshold, and the accuracy that threshold buys. A signal
that cannot beat "always answer" is not a signal.

The corpus has 9 no-answer, 3 partial and 36 answerable cases. Small — a threshold
tuned on 48 questions is a hypothesis, not a constant — so the output reports the
GAP between distributions, not just an accuracy, because a large gap survives more
data than a lucky cut point.
"""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/eval")

from app.core.database import SessionLocal  # noqa: E402
from app.models.governance import GovernKnowledgeDoc  # noqa: E402
from app.services.dashboard_ai_bot.govern_doc_embeddings import (  # noqa: E402
    search_doc_chunks,
)

import run_document_retrieval_eval as harness  # noqa: E402


def signals(rows: list[dict]) -> dict:
    """Everything a deterministic evaluator could possibly read off the evidence."""
    if not rows:
        return {"best_ce": None, "n_relevant": 0, "best_cosine": 0.0,
                "best_coverage": 0.0, "rows": 0}
    logits = [r.get("ce_logit") for r in rows if r.get("ce_logit") is not None]
    return {
        "best_ce": max(logits) if logits else None,
        "n_relevant": sum(1 for r in rows if r.get("ce_relevant")),
        "best_cosine": max(float(r.get("similarity") or 0.0) for r in rows),
        "best_coverage": max(float(r.get("term_coverage") or 0.0) for r in rows),
        "rows": len(rows),
    }


def sweep(answerable: list[float], unanswerable: list[float], name: str) -> dict:
    """The best threshold for one signal, and what it actually buys.

    Reports the GAP as well as the accuracy: `min(answerable) - max(unanswerable)`
    is positive only when the two distributions do not overlap at all, which is the
    property a threshold needs to survive questions it was not tuned on.
    """
    if not answerable or not unanswerable:
        return {"signal": name, "usable": False}
    candidates = sorted(set(answerable + unanswerable))
    best = None
    for threshold in candidates:
        correct = (sum(1 for v in answerable if v >= threshold)
                   + sum(1 for v in unanswerable if v < threshold))
        accuracy = correct / (len(answerable) + len(unanswerable))
        if best is None or accuracy > best[1]:
            best = (threshold, accuracy)
    baseline = len(answerable) / (len(answerable) + len(unanswerable))
    return {
        "signal": name,
        "usable": True,
        "threshold": round(best[0], 4),
        "accuracy": round(best[1], 3),
        "always_answer": round(baseline, 3),
        "beats_baseline": best[1] > baseline,
        "answerable_min": round(min(answerable), 4),
        "unanswerable_max": round(max(unanswerable), 4),
        "gap": round(min(answerable) - max(unanswerable), 4),
    }


def main() -> int:
    spec = json.load(open(harness.CASES_PATH, encoding="utf-8"))
    db = SessionLocal()
    published = db.query(GovernKnowledgeDoc).filter(
        GovernKnowledgeDoc.status == "Published").all()
    all_ids = {d.id for d in published}

    groups: dict[str, list[dict]] = {"answerable": [], "no_answer": [], "partial": []}
    for case in spec["cases"]:
        rows = search_doc_chunks(db, case["question"], k=12, doc_ids=all_ids) or []
        record = {"id": case["id"], **signals(rows)}
        if case.get("should_abstain"):
            groups["no_answer"].append(record)
        elif case.get("partially_answerable"):
            groups["partial"].append(record)
        else:
            groups["answerable"].append(record)
    db.close()

    print("cases: %d answerable | %d partial | %d no-answer"
          % (len(groups["answerable"]), len(groups["partial"]), len(groups["no_answer"])))
    print()

    for key, label in (("best_ce", "cross-encoder (max logit)"),
                       ("n_relevant", "cross-encoder (count relevant)"),
                       ("best_cosine", "cosine  [control]"),
                       ("best_coverage", "term coverage  [control]")):
        yes = [r[key] for r in groups["answerable"] if r[key] is not None]
        no = [r[key] for r in groups["no_answer"] if r[key] is not None]
        out = sweep([float(v) for v in yes], [float(v) for v in no], label)
        if not out["usable"]:
            print("%-32s khong do duoc" % label)
            continue
        verdict = "SEPARATES" if out["gap"] > 0 else (
            "beats baseline" if out["beats_baseline"] else "no better than always-answer")
        print("%-32s threshold %-8s accuracy %-6s (always-answer %s)  gap %-8s  %s"
              % (label, out["threshold"], out["accuracy"], out["always_answer"],
                 out["gap"], verdict))

    print()
    print("--- no-answer cases, best cross-encoder logit ---")
    for r in sorted(groups["no_answer"], key=lambda x: -(x["best_ce"] or -99)):
        print("   %-24s best_ce %-9s relevant %d/%d"
              % (r["id"], round(r["best_ce"], 2) if r["best_ce"] is not None else "-",
                 r["n_relevant"], r["rows"]))
    print()
    print("--- answerable cases with the LOWEST logit (the ones a threshold loses) ---")
    for r in sorted(groups["answerable"], key=lambda x: (x["best_ce"] or -99))[:8]:
        print("   %-24s best_ce %-9s relevant %d/%d"
              % (r["id"], round(r["best_ce"], 2) if r["best_ce"] is not None else "-",
                 r["n_relevant"], r["rows"]))
    print()
    print("--- partial cases ---")
    for r in groups["partial"]:
        print("   %-24s best_ce %-9s relevant %d/%d"
              % (r["id"], round(r["best_ce"], 2) if r["best_ce"] is not None else "-",
                 r["n_relevant"], r["rows"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
