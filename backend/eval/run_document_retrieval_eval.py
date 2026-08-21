"""Baseline measurement for Document Retrieval.

Measures RETRIEVAL, not answer quality: no LLM is in the loop, so a run is
deterministic apart from the embedding call and two runs are directly comparable.
Answer groundedness needs a judge model and belongs in a later phase — but every
later phase (reranker, contextual chunks, AST) can silently make retrieval WORSE,
and this is the instrument that would notice.

Three suites over the SAME cases, on purpose:

    dashboard        scope resolved the way the Dashboard Bot does (asset links)
    agent_same_scope the same documents, handed in as an explicit grant the way an
                     Agent Flow step carries one
    agent_all_docs   every published document — wider reach, reported for contrast

The first two MUST agree exactly: same documents in, same ranking out, proving the
two consumers share one retrieval path rather than two that drift. The third is
deliberately NOT compared with them — it searches a different corpus (published
documents attached to no dashboard), so a different ranking there is the scope
working, not a defect. An earlier version of this script compared it anyway and
reported a failure that did not exist.

Run inside the backend container:
    PYTHONPATH=/app python /app/eval/run_document_retrieval_eval.py --verbose
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import unicodedata
from datetime import datetime, timezone

sys.path.insert(0, "/app")

from sqlalchemy import text  # noqa: E402

from app.core.database import SessionLocal  # noqa: E402
from app.models.governance import GovernKnowledgeDoc  # noqa: E402
from app.services.dashboard_ai_bot.govern_doc_embeddings import (  # noqa: E402
    search_doc_chunks,
    stale_index_docs,
)

CASES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "document_retrieval_cases.json")
DASHBOARD_ID = 67
CUTOFFS = (1, 3, 6, 12)


def fold(value: object) -> str:
    """The SAME folding the retriever uses — imported, not reimplemented.

    The first version of this harness had its own copy built on `normalize("NFD")`,
    which cannot fold Vietnamese `đ`. It therefore scored a passage as "missing
    the answer" for most Vietnamese business prose and reported phrase_hit 0.72
    against a system that was not at fault. A measuring instrument that folds
    differently from the thing it measures is measuring itself.
    """
    from app.core.text_fold import fold_text

    return fold_text(value)


def rank_of_first_expected(rows, expected):
    for position, row in enumerate(rows, start=1):
        if row.get("doc_id") in expected:
            return position
    return None


def resolve_expected(db, case, title_to_id):
    """`expect_docs` may name documents by TITLE.

    Fixtures created by seed_eval_fixtures.py get whatever id the database hands
    out, so pinning them by number would break on every re-seed. Titles are
    stable; ids are not.
    """
    out = set()
    for item in case.get("expect_docs") or []:
        if isinstance(item, int):
            out.add(item)
        else:
            resolved = title_to_id.get(str(item))
            if resolved:
                out.add(resolved)
    return out


def run_case(db, case, *, k, scope, doc_ids, title_to_id=None):
    expected = resolve_expected(db, case, title_to_id or {})
    started = time.perf_counter()
    rows = search_doc_chunks(
        db,
        case["question"],
        k=k,
        dashboard_id=DASHBOARD_ID if scope == "dashboard" else None,
        doc_ids=None if scope == "dashboard" else doc_ids,
        published_only=True,
    ) or []
    elapsed_ms = (time.perf_counter() - started) * 1000

    docs_ranked = [row.get("doc_id") for row in rows]
    top_score = max((row.get("similarity") or 0.0) for row in rows) if rows else 0.0
    # Reported so the abstention question stays visible, NOT because it works:
    # neither cosine nor term coverage separates answerable from unanswerable on
    # this set. Keeping both columns is how that stays a known open problem
    # instead of an assumption someone re-discovers later.
    top_confidence = max((row.get("term_coverage") or 0.0) for row in rows) if rows else 0.0
    # Two corpora, because there are two honest questions.
    #
    # `child` is the passage that matched. `assembled` is child PLUS its section —
    # which is what small-to-big actually hands the model, and therefore what the
    # answer is grounded in. Measuring only the child would score the retrieval
    # as if the parent were never fetched, and measuring only the assembled text
    # would hide a chunker that stopped being precise. Both are reported.
    child_corpus = fold(" ".join(str(row.get("content") or "") for row in rows))
    assembled_corpus = fold(" ".join(
        " ".join([
            str(row.get("heading_path") or ""),   # the heading is no longer copied
            str(row.get("content") or ""),        # into the body; it lives here
            str(row.get("section_content") or ""),
        ])
        for row in rows
    ))
    corpus = child_corpus

    probes = [fold(p) for p in (case.get("expect_phrases") or []) if p]
    found = [p for p in probes if p in corpus]
    found_assembled = [p for p in probes if p in assembled_corpus]
    # Text that must NOT come back. Retrieval serves the PUBLISHED snapshot, so a
    # sentence living only in a newer draft is required to be unreachable — and a
    # suite that only ever asserts presence cannot tell a boundary from a bug.
    absent_probes = [fold(p) for p in (case.get("expect_absent_phrases") or []) if p]
    leaked = [p for p in absent_probes if p in corpus]

    def reached(window):
        # A multi-doc question is only answered when EVERY document it spans was
        # reached; scoring it on "any" would hide the half-answer it tests for.
        if case.get("expect_all_docs"):
            return expected.issubset(window)
        return bool(expected & window)

    result = {
        "id": case["id"], "category": case["category"], "scope": scope,
        "expected_docs": sorted(expected), "retrieved_docs": docs_ranked,
        "rank": rank_of_first_expected(rows, expected),
        "recall_hit": reached(set(docs_ranked[:k])) if expected else None,
        "hit_at_1": (bool(docs_ranked) and docs_ranked[0] in expected) if expected else None,
        "phrases_total": len(probes), "phrases_found": len(found),
        "phrases_missing": [p for p in probes if p not in found],
        "phrase_hit": (len(found) == len(probes)) if probes else None,
        "phrase_hit_assembled": (len(found_assembled) == len(probes)) if probes else None,
        "docs_in_top_k": len({d for d in docs_ranked[:k] if d is not None}),
        # The governance graph promises PRESENCE and AUTHORITY, not rank 1. A
        # glossary entry that literally contains the term is a legitimate hit;
        # what must never happen is the declared definition being absent, or
        # present but indistinguishable from a passage that merely repeats the
        # words. Forcing it to rank 1 would mean out-bidding real lexical
        # evidence on every question that happens to name a metric.
        "metric_home_flagged": any(r.get("is_metric_home") for r in rows),
        "metric_home_rank": next(
            (i for i, r in enumerate(rows, start=1) if r.get("is_metric_home")), None),
        "absent_total": len(absent_probes), "leaked": leaked,
        "absence_hit": (not leaked) if absent_probes else None,
        "top_score": round(float(top_score), 4),
        "top_confidence": round(float(top_confidence), 4),
        "top_rerank": round(float(rows[0].get("rerank_score") or 0.0), 4) if rows else 0.0,
        "should_abstain": bool(case.get("should_abstain")),
        "rows": len(rows),
        "matched_by": sorted({str(row.get("matched_by")) for row in rows}),
        "ms": round(elapsed_ms, 1),
    }
    for cutoff in CUTOFFS:
        if expected:
            result["recall@%d" % cutoff] = reached(set(docs_ranked[:cutoff]))
    return result


def best_abstain_threshold(results, field="top_score"):
    """Can a score threshold separate answerable from unanswerable at all?

    Hybrid search always returns its nearest neighbour, so "no answer" does not
    look like an empty result — it looks like a weak one. Whether abstention is
    even POSSIBLE is a property of the score distribution, not a policy decision,
    so the best achievable separation is reported rather than a threshold guessed.
    """
    answerable = [r[field] for r in results if not r["should_abstain"]]
    unanswerable = [r[field] for r in results if r["should_abstain"]]
    if not answerable or not unanswerable:
        return {"available": False}
    best_threshold, best_correct = None, -1
    for candidate in sorted({round(s, 3) for s in answerable + unanswerable}):
        correct = (sum(1 for s in answerable if s >= candidate)
                   + sum(1 for s in unanswerable if s < candidate))
        if correct > best_correct:
            best_threshold, best_correct = candidate, correct
    total = len(answerable) + len(unanswerable)
    return {
        "available": True,
        "threshold": best_threshold,
        "accuracy": round(best_correct / total, 3),
        "answerable_min": round(min(answerable), 4),
        "unanswerable_max": round(max(unanswerable), 4),
        "separable": min(answerable) > max(unanswerable),
    }


def summarise(results):
    scored = [r for r in results if r["recall_hit"] is not None]
    phrased = [r for r in results if r["phrase_hit"] is not None]
    ranked = [r for r in scored if r["rank"]]
    times = sorted(r["ms"] for r in results)
    out = {
        "cases": len(results),
        "answerable": len(scored),
        "mrr": round(sum(1.0 / r["rank"] for r in ranked) / len(scored), 3) if scored else 0.0,
        "hit@1": round(sum(1 for r in scored if r["hit_at_1"]) / len(scored), 3) if scored else 0.0,
        "phrase_hit": round(sum(1 for r in phrased if r["phrase_hit"]) / len(phrased), 3) if phrased else 0.0,
        "phrase_hit_assembled": round(
            sum(1 for r in phrased if r["phrase_hit_assembled"]) / len(phrased), 3) if phrased else 0.0,
        "avg_docs_in_top_k": round(
            sum(r["docs_in_top_k"] for r in results) / max(1, len(results)), 2),
        "p95_ms": times[max(0, int(len(times) * 0.95) - 1)] if times else 0.0,
    }
    for cutoff in CUTOFFS:
        key = "recall@%d" % cutoff
        vals = [r[key] for r in scored if key in r]
        out[key] = round(sum(1 for v in vals if v) / len(vals), 3) if vals else 0.0
    ssot = [r for r in results if r["category"] == "metric_ssot"]
    out["metric_ssot_flagged"] = (
        round(sum(1 for r in ssot if r["metric_home_flagged"]) / len(ssot), 3)
        if ssot else None)
    out["metric_ssot_top3"] = (
        round(sum(1 for r in ssot if (r["metric_home_rank"] or 99) <= 3) / len(ssot), 3)
        if ssot else None)
    guarded = [r for r in results if r["absence_hit"] is not None]
    out["absence_hit"] = (round(sum(1 for r in guarded if r["absence_hit"]) / len(guarded), 3)
                          if guarded else None)
    out["abstain"] = best_abstain_threshold(results, "top_score")
    out["abstain_confidence"] = best_abstain_threshold(results, "top_confidence")

    by_cat = {}
    for r in scored:
        by_cat.setdefault(r["category"], []).append(r)
    out["by_category"] = {}
    for cat, rs in sorted(by_cat.items()):
        with_probes = [r for r in rs if r["phrase_hit"] is not None]
        out["by_category"][cat] = {
            "n": len(rs),
            "recall@6": round(sum(1 for r in rs if r.get("recall@6")) / len(rs), 3),
            "phrase_hit": (round(sum(1 for r in with_probes if r["phrase_hit"]) / len(with_probes), 3)
                           if with_probes else None),
        }
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--k", type=int, default=12)
    parser.add_argument("--out", default="")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    with open(CASES_PATH, encoding="utf-8") as fh:
        spec = json.load(fh)

    db = SessionLocal()
    all_doc_ids = {
        d.id for d in db.query(GovernKnowledgeDoc)
        .filter(GovernKnowledgeDoc.status == "Published").all()
    }
    # The dashboard's own document set, resolved from the SAME link table the
    # retriever uses, so the agent suite can be handed exactly that scope.
    linked_doc_ids = {
        int(r[0]) for r in db.execute(text(
            "SELECT DISTINCT doc_id FROM govern_doc_asset_links "
            "WHERE asset_type = 'dashboard' AND asset_ref = :ref"
        ), {"ref": str(DASHBOARD_ID)}).fetchall()
    } & all_doc_ids
    title_to_id = {
        d.title: d.id for d in db.query(GovernKnowledgeDoc)
        .filter(GovernKnowledgeDoc.status == "Published").all()
    }
    stale = stale_index_docs(db)

    print("corpus: %d published docs | untrusted index: %s"
          % (len(all_doc_ids), sorted(stale) if stale else "none"))
    if stale:
        print("  WARNING: the retriever excludes those documents, so this baseline "
              "measures a degraded corpus. Repair before trusting it.")
    print("cases: %d | k=%d" % (len(spec["cases"]), args.k))
    for cat, why in (spec.get("_pending") or {}).items():
        print("  NOT COVERED — %s: %s" % (cat, why))

    report = {
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "k": args.k,
        "corpus": {"published_docs": sorted(all_doc_ids), "untrusted_index": sorted(stale)},
        "not_covered": spec.get("_pending") or {},
        "suites": {},
    }

    suites = (
        ("dashboard", None),
        ("agent_same_scope", linked_doc_ids),
        ("agent_all_docs", all_doc_ids),
    )
    for scope, scope_docs in suites:
        # A case may declare which suites it belongs to. The scanned and
        # contradictory fixtures are attached to no dashboard, so scoring them
        # against the dashboard scope would penalise a document that is correctly
        # out of reach.
        applicable = [c for c in spec["cases"]
                      if scope in (c.get("scopes") or [scope])]
        results = [run_case(db, c, k=args.k, scope=scope, doc_ids=scope_docs,
                            title_to_id=title_to_id)
                   for c in applicable]
        summary = summarise(results)
        report["suites"][scope] = {"summary": summary, "cases": results}

        print("\n=== suite: %s ===" % scope)
        print("  recall@1/3/6/12   %s  %s  %s  %s"
              % (summary["recall@1"], summary["recall@3"], summary["recall@6"], summary["recall@12"]))
        print("  MRR %s   hit@1 %s   phrase_hit child %s / assembled %s   absence_hit %s"
              % (summary["mrr"], summary["hit@1"], summary["phrase_hit"],
                 summary["phrase_hit_assembled"], summary["absence_hit"]))
        if summary["metric_ssot_flagged"] is not None:
            print("  metric SSOT: flagged %s   within top-3 %s"
                  % (summary["metric_ssot_flagged"], summary["metric_ssot_top3"]))
        print("  docs represented in top-k (avg) %s   p95 %sms"
              % (summary["avg_docs_in_top_k"], summary["p95_ms"]))
        for label, key in (("cosine  ", "abstain"), ("coverage", "abstain_confidence")):
            ab = summary[key]
            if ab.get("available"):
                print("  abstain by %s: threshold %-6s accuracy %-6s "
                      "answerable_min %-7s unanswerable_max %-7s separable %s"
                      % (label, ab["threshold"], ab["accuracy"], ab["answerable_min"],
                         ab["unanswerable_max"], ab["separable"]))
        print("  %-20s%-5s%-11s%s" % ("category", "n", "recall@6", "phrase_hit"))
        for cat, m in summary["by_category"].items():
            print("  %-20s%-5s%-11s%s" % (cat, m["n"], m["recall@6"], m["phrase_hit"]))
        if args.verbose:
            print("\n  %-22s%-6s%-6s%-8s%-8s%s"
                  % ("case", "rank", "r@6", "phrase", "score", "matched_by"))
            for r in results:
                phr = ("-" if r["phrase_hit"] is None
                       else "%d/%d%s" % (r["phrases_found"], r["phrases_total"],
                                         "" if r["phrase_hit_assembled"] else "!"))
                print("  %-22s%-6s%-6s%-8s%-8s%s"
                      % (r["id"], r["rank"] or "-", r.get("recall@6", "-"), phr,
                         r["top_score"], ",".join(r["matched_by"])))
                if r["phrases_missing"]:
                    print("      missing probe(s): %s" % "; ".join(r["phrases_missing"]))
                if r["leaked"]:
                    print("      LEAKED draft-only text: %s" % "; ".join(r["leaked"]))

    # Path equivalence, not corpus equivalence: the ranked document lists are
    # compared case by case. Equal aggregates could hide two different orderings
    # that happen to average the same.
    left = {c["id"]: c for c in report["suites"]["dashboard"]["cases"]}
    right = {c["id"]: c for c in report["suites"]["agent_same_scope"]["cases"]}
    mismatched = [cid for cid in left if cid in right
                  and left[cid]["retrieved_docs"] != right[cid]["retrieved_docs"]]
    print("\ndashboard path == agent path on the same scope: %s"
          % ("YES" if not mismatched else "NO — differs on " + ", ".join(mismatched)))
    report["path_equivalence"] = {"equal": not mismatched, "mismatched": mismatched}

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print("written: %s" % args.out)
    db.close()


if __name__ == "__main__":
    main()
