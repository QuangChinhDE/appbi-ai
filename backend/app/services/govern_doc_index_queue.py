"""The one way a document gets indexed.

Nothing embeds inside a request any more. Saving, publishing, syncing a source and
pressing Re-index all do the SAME thing — put the document in this queue — and a
background worker is the only caller of `embed_doc`. That is the point: two ways
to index means two behaviours to reason about, and the one that ran inside the
request was the one that timed out silently on a large document.

The cost is that indexing is no longer instant, so it has to be VISIBLE. Every
document reports its job state, and the UI says "queued" or "indexing" rather
than showing a stale index as if it were current.
"""
from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

#: How many documents one worker pass will index. A pass holds a DB session and
#: makes provider calls, so it is bounded; the queue survives to the next tick.
_BATCH = 5

#: Give up after this many tries. A document that fails five times is failing for
#: a reason a retry will not fix, and an infinite retry loop spends money quietly.
_MAX_ATTEMPTS = 5

VALID_REASONS = ("save", "publish", "source_sync", "manual", "repair", "config")


def enqueue(db: Session, doc_id: int, *, reason: str = "save",
            requested_by: str | None = None) -> dict:
    """Queue a document for (re)indexing. Idempotent per document.

    UPSERT, not INSERT: ten saves while the worker is busy must leave one job.
    A row already `running` is left alone but re-queued afterwards — the worker
    started from a snapshot that no longer includes the newest edit, so the work
    has to happen again rather than be assumed complete.
    """
    reason = reason if reason in VALID_REASONS else "save"
    try:
        row = db.execute(
            text(
                """
                INSERT INTO govern_doc_index_job
                    (doc_id, reason, state, attempts, requested_by, queued_at)
                VALUES (:d, :r, 'queued', 0, :by, NOW())
                ON CONFLICT (doc_id) DO UPDATE
                   SET reason = EXCLUDED.reason,
                       requested_by = EXCLUDED.requested_by,
                       queued_at = NOW(),
                       -- A job mid-flight is re-queued, not reset to running.
                       state = 'queued',
                       -- Attempts reset because this is NEW work, not a retry of
                       -- the failure that came before it.
                       attempts = 0,
                       error = NULL,
                       started_at = NULL,
                       finished_at = NULL
                RETURNING id, state, reason, queued_at
                """
            ),
            {"d": int(doc_id), "r": reason, "by": requested_by},
        ).first()
        db.commit()
        return {"id": int(row[0]), "state": row[1], "reason": row[2],
                "queued_at": row[3].isoformat() if row[3] else None}
    except Exception:  # noqa: BLE001 — a save must not fail because the queue did
        db.rollback()
        logger.warning("govern_doc_index_queue: could not enqueue doc %s", doc_id, exc_info=True)
        return {"state": "unknown", "reason": reason}


def job_status(db: Session, doc_id: int) -> dict | None:
    try:
        row = db.execute(
            text(
                """
                SELECT state, reason, attempts, error, queued_at, started_at,
                       finished_at, result
                FROM govern_doc_index_job WHERE doc_id = :d
                """
            ),
            {"d": int(doc_id)},
        ).first()
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_index_queue: status read failed", exc_info=True)
        return None
    if row is None:
        return None
    return {
        "state": row[0], "reason": row[1], "attempts": int(row[2] or 0),
        "error": row[3],
        "queued_at": row[4].isoformat() if row[4] else None,
        "started_at": row[5].isoformat() if row[5] else None,
        "finished_at": row[6].isoformat() if row[6] else None,
        "result": row[7],
    }


def queue_depth(db: Session) -> dict:
    """What is outstanding, for the health endpoint."""
    try:
        rows = db.execute(
            text("SELECT state, count(*) FROM govern_doc_index_job GROUP BY state")
        ).fetchall()
        return {str(r[0]): int(r[1]) for r in rows}
    except Exception:  # noqa: BLE001
        return {}


def _claim(db: Session, limit: int) -> list[int]:
    """Atomically take the next documents to index.

    `FOR UPDATE SKIP LOCKED` so two workers — or one worker whose previous pass
    has not finished — never index the same document twice. The advisory lock in
    the scheduler makes that unlikely; this makes it impossible.
    """
    rows = db.execute(
        text(
            """
            WITH nxt AS (
                SELECT id FROM govern_doc_index_job
                 WHERE state = 'queued' AND attempts < :max_attempts
                 ORDER BY queued_at
                 LIMIT :lim
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE govern_doc_index_job j
               SET state = 'running', started_at = NOW(), attempts = j.attempts + 1
              FROM nxt
             WHERE j.id = nxt.id
            RETURNING j.doc_id
            """
        ),
        {"lim": limit, "max_attempts": _MAX_ATTEMPTS},
    ).fetchall()
    db.commit()
    return [int(r[0]) for r in rows]


def _finish(db: Session, doc_id: int, *, state: str, result: dict | None = None,
            error: str | None = None) -> None:
    import json as _json

    try:
        db.execute(
            text(
                """
                UPDATE govern_doc_index_job
                   SET state = :s, finished_at = NOW(), error = :e,
                       result = CAST(:r AS json)
                 WHERE doc_id = :d
                """
            ),
            {"d": doc_id, "s": state, "e": (error or None),
             "r": _json.dumps(result or {})},
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("govern_doc_index_queue: could not record outcome for %s", doc_id, exc_info=True)


def drain(db: Session, *, limit: int = _BATCH) -> dict:
    """Index the next batch. The ONLY caller of `embed_doc` in the codebase.

    Returns a summary rather than raising: this runs on a timer, and one bad
    document must not stop the queue behind it.
    """
    from app.models.governance import GovernKnowledgeDoc
    from app.services.dashboard_ai_bot.govern_doc_embeddings import embed_doc

    doc_ids = _claim(db, limit)
    if not doc_ids:
        return {"claimed": 0, "indexed": 0, "failed": 0, "results": {}}

    indexed = failed = 0
    results: dict[int, str] = {}
    for doc_id in doc_ids:
        doc = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if doc is None:
            # The document was deleted while queued. Not a failure — the work is
            # simply moot, and leaving the job 'running' would strand it.
            _finish(db, doc_id, state="done", result={"status": "doc_deleted"})
            results[doc_id] = "doc_deleted"
            continue
        try:
            outcome = embed_doc(db, doc)
            status = str(outcome.get("status") or "error")
            results[doc_id] = status
            if status in ("embedded", "unchanged", "cleared", "empty", "blocked"):
                _finish(db, doc_id, state="done", result=outcome)
                indexed += 1
            else:
                # 'unavailable' (no key / provider down) and 'error' stay retryable:
                # the queue is exactly the right place for a transient failure.
                _finish(db, doc_id, state="queued",
                        result=outcome, error=str(outcome.get("detail") or status))
                failed += 1
        except Exception as exc:  # noqa: BLE001
            logger.exception("govern_doc_index_queue: indexing doc %s raised", doc_id)
            _finish(db, doc_id, state="queued", error=str(exc)[:500])
            results[doc_id] = "exception"
            failed += 1

    if indexed or failed:
        logger.info("govern_doc_index_queue: %s claimed, %s indexed, %s to retry",
                    len(doc_ids), indexed, failed)
    return {"claimed": len(doc_ids), "indexed": indexed, "failed": failed, "results": results}
