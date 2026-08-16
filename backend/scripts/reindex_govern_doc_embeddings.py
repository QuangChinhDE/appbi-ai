"""Rebuild knowledge-document vector indexes the retriever will not search.

Run from the backend directory:

    python scripts/reindex_govern_doc_embeddings.py          # only what is stale
    python scripts/reindex_govern_doc_embeddings.py --all    # every published doc

WHY THIS DELEGATES INSTEAD OF LOOPING
-------------------------------------
This used to walk every document and call `embed_doc` itself. That was a SECOND
implementation of "which indexes need rebuilding", beside the one the scheduler
and the health endpoint use — and two answers to that question drift: one counts a
document whose body moved on, the other counts a document whose vectors are gone,
and neither counts both. It now calls `repair_stale_index`, so the command line,
the boot job and the health screen cannot disagree.

The embedding pipeline is hash-gated, so a current index makes no provider call.
Each document is committed independently; a provider failure can be retried by
running the same command again.
"""
import sys

from app.core.database import SessionLocal
from app.services.dashboard_ai_bot.govern_doc_embeddings import (
    repair_stale_index,
    stale_index_docs,
)

_FAILURE_STATUSES = {"error", "unavailable"}


def main() -> int:
    everything = "--all" in sys.argv
    db = SessionLocal()
    try:
        stale = stale_index_docs(db)
        if not stale and not everything:
            print("Every published document has a searchable index. Nothing to do.")
            return 0

        if stale:
            print(f"{len(stale)} document(s) need rebuilding:")
            for doc_id, reason in sorted(stale.items()):
                print(f"  doc={doc_id} reason={reason}")

        # `--all` is the escape hatch for a suspicion the detector does not share:
        # a large limit sweeps everything the hash gate still lets through cheaply.
        result = repair_stale_index(db, limit=10_000 if everything else 200)
        for doc_id, status in sorted(result["results"].items()):
            print(f"  doc={doc_id} status={status}")
        print(
            f"Done: {result['repaired']} repaired, {result['failed']} failed, "
            f"{result['remaining']} left."
        )
        return 1 if result["failed"] else 0
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print(f"ERROR: {type(exc).__name__}: {exc}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
