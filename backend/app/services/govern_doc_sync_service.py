"""Orchestrates external-source ingestion for a Govern Knowledge Doc — the
"Source & Sync" tab's backend. Dispatches to the right fetcher
(app.services.govern_doc_sources), writes the fetched text into doc.body,
and records the outcome via GovernanceService.log_doc_run() so the History
tab has something real to show.

Deliberately does NOT create a GovernKnowledgeDocVersion snapshot — that would
bloat version history on every scheduled sync. It DOES re-index after a
successful ingest (see _reindex_after_ingest): content the user never typed is
useless until it is searchable, and a doc sitting at zero vectors is invisible
to the AI with nothing on screen to say so.
"""
from __future__ import annotations

import hashlib
import logging

logger = logging.getLogger(__name__)


def _store_source_payload(db, doc_id: int, *, filename: str, content_type: str, data: bytes,
                          extracted_text_hash: str | None = None, uploaded_by=None) -> None:
    """Upsert the doc's CURRENT source payload — an uploaded file's bytes, or a
    crawled page's html snapshot. One row per doc (doc_id is the PK): content
    history lives in GovernKnowledgeDocVersion, this only answers "what is the
    source payload right now". Caller commits."""
    from datetime import datetime
    from app.models.governance import GovernDocSourceFile

    row = db.query(GovernDocSourceFile).filter(GovernDocSourceFile.doc_id == doc_id).first()
    if row is None:
        row = GovernDocSourceFile(doc_id=doc_id)
        db.add(row)
    row.filename = filename
    row.content_type = content_type or "application/octet-stream"
    row.byte_size = len(data)
    row.data = data
    row.extracted_text_hash = extracted_text_hash
    row.uploaded_at = datetime.utcnow()
    if uploaded_by is not None:
        row.uploaded_by = uploaded_by


def _reindex_after_ingest(db, doc, *, changed_by: str | None = None) -> None:
    """Index freshly ingested content right away.

    Sync and embed stay separate *actions*, but content the user never typed is
    useless until it is searchable — leaving a synced doc at zero vectors makes
    the AI silently blind to it. Hash-gated, so an unchanged re-sync costs
    nothing. Best-effort: ingestion must not fail because indexing did.
    """
    try:
        from app.services.dashboard_ai_bot.govern_doc_embeddings import embed_doc
        from app.services.governance_service import GovernanceService
        result = embed_doc(db, doc)
        GovernanceService.log_doc_run(
            db, doc.id, "embed", trigger="sync", status=result.get("status", "error"),
            detail=result.get("detail"), stats=result, changed_by=changed_by,
        )
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_sync_service: post-ingest reindex failed (doc %s)", getattr(doc, "id", None), exc_info=True)
        db.rollback()


def sync_doc(db, doc, *, trigger: str = "manual", changed_by: str | None = None) -> dict:
    """Fetch fresh content for a google_doc/web source doc and write it into
    doc.body. Returns {ok, status, detail}. File sources have no separate
    "sync" (see save_uploaded_file) — there's nothing external to re-fetch."""
    from app.services.governance_service import GovernanceService

    source_type = (doc.source_type or "").strip().lower()
    config = doc.source_config or {}

    if source_type == "google_doc":
        from app.services.govern_doc_sources.google_doc_fetcher import fetch_google_doc
        result = fetch_google_doc(
            config.get("google_doc_id") or "",
            google_oauth_user_id=config.get("google_oauth_user_id"),
            datasource_id=config.get("datasource_id"),  # legacy docs
        )
    elif source_type == "web":
        from app.services.govern_doc_sources.web_page_fetcher import fetch_web_page
        result = fetch_web_page(config.get("url") or "")
    elif source_type == "file":
        return {"ok": False, "status": "error", "detail": "File sources are refreshed by re-uploading a new file, not by Sync now."}
    else:
        return {"ok": False, "status": "error", "detail": "This document has no connected source yet."}

    if not result.get("ok"):
        doc.last_sync_status = "error"
        db.commit()
        GovernanceService.log_doc_run(
            db, doc.id, "sync", trigger=trigger, status="error",
            detail=result.get("error"), changed_by=changed_by,
        )
        return {"ok": False, "status": "error", "detail": result.get("error")}

    from datetime import datetime
    new_body = result.get("text") or ""
    unchanged = (doc.body or "").strip() == new_body.strip()
    doc.body = new_body
    doc.last_synced_at = datetime.utcnow()
    doc.last_sync_status = "ok"

    # Web sources also keep a SNAPSHOT of the page html so the reader can see
    # the original page, not just the extracted prose. Stored in the same
    # doc_id-keyed "current source payload" table as uploaded files.
    if source_type == "web" and result.get("html"):
        _store_source_payload(
            db, doc.id,
            filename=(config.get("url") or "")[:255] or "page.html",
            content_type="text/html",
            data=result["html"],
        )

    db.commit()

    status = "skipped" if unchanged else "ok"
    detail = "No content changes" if unchanged else f"Fetched {len(new_body):,} characters"
    _reindex_after_ingest(db, doc, changed_by=changed_by)
    GovernanceService.log_doc_run(
        db, doc.id, "sync", trigger=trigger, status=status, detail=detail,
        stats={"chars": len(new_body)}, changed_by=changed_by,
    )
    return {"ok": True, "status": status, "detail": detail}


def save_uploaded_file(db, doc, *, filename: str, content_type: str, data: bytes, changed_by: str | None = None) -> dict:
    """Extract text from an uploaded PDF/DOCX/XLSX, store the blob (current
    version only — see GovernDocSourceFile), and write the extracted text into
    doc.body. This IS the file source's "sync" — there's no separate refresh
    action, re-uploading a new file is how a file-sourced doc updates."""
    from app.services.governance_service import GovernanceService
    from app.services.govern_doc_sources.file_text_extractor import extract_text

    result = extract_text(data, filename)
    if not result.get("ok"):
        doc.last_sync_status = "error"
        db.commit()
        GovernanceService.log_doc_run(
            db, doc.id, "sync", trigger="manual", status="error",
            detail=result.get("error"), changed_by=changed_by,
        )
        return {"ok": False, "status": "error", "detail": result.get("error")}

    from datetime import datetime
    text_hash = hashlib.sha256(result["text"].encode("utf-8")).hexdigest()
    _store_source_payload(
        db, doc.id, filename=filename, content_type=content_type or "application/octet-stream",
        data=data, extracted_text_hash=text_hash,
    )

    doc.body = result["text"]
    doc.last_synced_at = datetime.utcnow()
    doc.last_sync_status = "ok"
    db.commit()

    detail = f"Uploaded {filename} — extracted {len(result['text']):,} characters"
    _reindex_after_ingest(db, doc, changed_by=changed_by)
    GovernanceService.log_doc_run(
        db, doc.id, "sync", trigger="manual", status="ok", detail=detail,
        stats={"chars": len(result["text"]), "filename": filename}, changed_by=changed_by,
    )
    return {"ok": True, "status": "ok", "detail": detail, "filename": filename, "extracted_chars": len(result["text"])}
