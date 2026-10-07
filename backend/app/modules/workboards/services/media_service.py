"""Workboard media store.

Image / file / signature / audio binaries uploaded from a mini-app form are
stored here in the app DB (``workboard_media``) and referenced by a short URL
from the business store. This is what lets an operational dataset backed by
Google Sheets carry images: a Sheets cell caps at 50,000 chars and cannot hold a
base64 blob, so the cell holds only ``/api/v1/public/media/<id>`` and the binary
lives in the app DB. Works identically for a Postgres/MySQL store later.
"""

from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.workboards.models import WorkboardMedia

# Hard ceiling per upload. Generous for field photos/attachments, bounded so the
# app DB doesn't take arbitrarily large blobs.
MAX_MEDIA_BYTES = 25 * 1024 * 1024  # 25 MB


def store_media(
    db: Session,
    *,
    workboard_id: Optional[int],
    filename: Optional[str],
    content_type: Optional[str],
    data: bytes,
    created_by=None,
    commit: bool = True,
) -> WorkboardMedia:
    if not data:
        raise ValueError("Empty file.")
    if len(data) > MAX_MEDIA_BYTES:
        raise ValueError(f"File too large (max {MAX_MEDIA_BYTES // (1024 * 1024)} MB).")
    media = WorkboardMedia(
        id=uuid.uuid4(),
        workboard_id=workboard_id,
        filename=(filename or None),
        content_type=safe_content_type(content_type),
        byte_size=len(data),
        data=data,
        created_by=created_by,
    )
    db.add(media)
    if commit:
        db.commit()
        db.refresh(media)
    else:
        db.flush()
    return media


# Types a browser may render INLINE from /public/media. Everything else is stored
# and served as an octet-stream download: the endpoint is public and same-origin,
# so a client-declared text/html or image/svg+xml would run script on the app
# origin (authz review, fourth pass - stored XSS). SVG is deliberately absent.
INLINE_SAFE_TYPES = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif",
    "application/pdf", "video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "audio/webm",
})


def safe_content_type(content_type: Optional[str]) -> str:
    """The declared type when it is inline-safe, else application/octet-stream."""
    base = (content_type or "").split(";", 1)[0].strip().lower()
    return base if base in INLINE_SAFE_TYPES else "application/octet-stream"


def get_media(db: Session, media_id: str) -> Optional[WorkboardMedia]:
    try:
        mid = uuid.UUID(str(media_id))
    except (ValueError, TypeError, AttributeError):
        return None
    return db.query(WorkboardMedia).filter(WorkboardMedia.id == mid).first()


def media_url(media_id) -> str:
    """The stable public URL written into the business store (Sheet cell etc.)."""
    return f"/api/v1/public/media/{media_id}"
