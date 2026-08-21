"""Indexing is queued, and there is only one path to it."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_index_queue.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import inspect


def test_embed_doc_has_exactly_one_caller():
    """The whole point of the queue. A synchronous indexing path would be the one
    nobody tests and the one that times out on a 500-chunk document — and while
    both existed, every report of a stale index started with "which path ran?".
    """
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    callers = []
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.strip()
            # Only real calls: `embed_doc(db, ...)`. Prose that mentions the
            # function — a docstring explaining the hash gate, a comment about the
            # old behaviour — is not a caller, and a scan that counted those would
            # fail for reasons unrelated to the invariant.
            if "embed_doc(db" not in stripped:
                continue
            if stripped.startswith(("#", "*")) or "def embed_doc(" in stripped:
                continue
            callers.append("%s: %s" % (path.name, stripped[:70]))
    assert len(callers) == 1, "expected only the queue to call embed_doc, found: %s" % callers
    assert callers[0].startswith("govern_doc_index_queue.py"), callers[0]


def test_save_publish_sync_and_the_button_all_enqueue():
    """Four entry points, one behaviour. If any of them indexed directly it would
    be a second path with its own failure modes."""
    from app.modules.metadata_catalog import api
    from app.services import govern_doc_sync_service
    from app.services.governance_service import GovernanceService

    assert "enqueue_index" in inspect.getsource(GovernanceService.upsert_knowledge_doc)
    assert "enqueue_index" in inspect.getsource(GovernanceService.publish_version)
    assert "enqueue" in inspect.getsource(govern_doc_sync_service._reindex_after_ingest)
    assert "enqueue" in inspect.getsource(api.govern_doc_embed_now)


def test_enqueue_is_idempotent_per_document():
    """Ten saves while the worker is busy must leave ONE job, and the tenth save's
    reason is the one that matters."""
    from app.services.govern_doc_index_queue import enqueue

    source = inspect.getsource(enqueue)
    assert "ON CONFLICT (doc_id) DO UPDATE" in source
    assert "attempts = 0" in source


def test_claiming_cannot_double_index_a_document():
    """`FOR UPDATE SKIP LOCKED` so two workers — or one whose previous pass has not
    finished — never index the same document twice. Four uvicorn processes each
    run a poller, so this is load-bearing, not theoretical."""
    from app.services.govern_doc_index_queue import _claim

    assert "FOR UPDATE SKIP LOCKED" in inspect.getsource(_claim)


def test_transient_failures_return_to_the_queue_and_hard_ones_do_not_loop():
    from app.services.govern_doc_index_queue import _MAX_ATTEMPTS, drain

    source = inspect.getsource(drain)
    # An unavailable provider is exactly what a queue is for.
    assert 'state="queued"' in source
    assert "attempts < :max_attempts" in inspect.getsource(
        __import__("app.services.govern_doc_index_queue", fromlist=["_claim"])._claim
    )
    assert _MAX_ATTEMPTS >= 3


def test_a_deleted_document_does_not_strand_its_job():
    from app.services.govern_doc_index_queue import drain

    assert "doc_deleted" in inspect.getsource(drain)


def test_deleting_a_document_removes_its_queue_row():
    from app.services.governance_service import GovernanceService

    assert "DELETE FROM govern_doc_index_job" in inspect.getsource(
        GovernanceService.delete_knowledge_doc
    )


def test_worker_checks_for_work_before_taking_the_lock():
    """Four processes polling every two seconds through the shared scheduler lock
    produced roughly eighty log lines a minute saying nothing happened.
    Observability that buries itself is worse than none."""
    from app.services import govern_doc_index_worker as worker

    source = inspect.getsource(worker._pass)
    assert source.index("_has_pending") < source.index("job_lock")


def test_worker_is_not_reachable_from_a_request():
    """`run_once` exists for tests and shell repair. If a handler called it, the
    synchronous path would be back."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    hits = [
        p.name for p in root.rglob("*.py")
        if "run_once(" in p.read_text(encoding="utf-8")
        and p.name != "govern_doc_index_worker.py"
    ]
    assert hits == [], "run_once must not be called from application code: %s" % hits
