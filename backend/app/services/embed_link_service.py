"""Embed-link integration service.

Turns an authenticated request ("give me an embed link for dashboard X
scoped to these filters") into:

  1. a STABLE managed DashboardPublicLink (deduped: 1 filter set = 1 link,
     filters LOCKED server-side so the embedded viewer can't change/escape them
     — RLS-style), and
  2. a fresh ROTATING opaque embed grant (256 chars, ~1h) that points at that
     link without exposing the link's own token.

The grant token flows through the existing public endpoints via a small
additive guard in api/public.py:_get_dashboard_by_token — no public-link
behavior changes.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.models import DashboardPublicLink, EmbedGrant, Dashboard

# Grant tokens are recognizable by this prefix so the shared public resolver can
# route them without ambiguity (normal link/share tokens never start with it).
# Total length = 4 (prefix) + 252 hex = 256 chars.
EMBED_GRANT_PREFIX = "emb_"
EMBED_GRANT_HEX_CHARS = 252  # 126 random bytes
EMBED_LINK_SOURCE = "embed_api"
DEFAULT_TTL_SECONDS = 3600
_ALLOWED_OPS = {
    "eq", "neq", "ne", "in", "not_in", "gt", "gte", "lt", "lte",
    "between", "contains", "not_contains", "starts_with", "is_null", "is_not_null",
}


# ---------------------------------------------------------------------------
# Filter canonicalization + dedup hash
# ---------------------------------------------------------------------------

def _canonical_value(value):
    if isinstance(value, (list, tuple)):
        # order-independent for set-style operators
        return sorted(str(v) for v in value)
    return value


def canonicalize_filters(filters: list[dict]) -> list[dict]:
    """Normalize incoming filters into a stable, comparable shape so equivalent
    filter sets hash identically (the crux of '1 filter = 1 link')."""
    out: list[dict] = []
    for f in filters or []:
        if not isinstance(f, dict):
            continue
        field = str(f.get("semanticField") or f.get("field") or "").strip()
        if not field:
            continue
        op = str(f.get("operator") or "in").strip().lower()
        entry = {
            "field": str(f.get("field") or field).strip(),
            "semanticField": str(f.get("semanticField") or field).strip(),
            "datasetId": f.get("datasetId"),
            "operator": op,
            "value": _canonical_value(f.get("value")),
        }
        out.append(entry)
    # order-independent across filters
    out.sort(key=lambda e: (str(e.get("datasetId")), e["semanticField"], e["operator"]))
    return out


def compute_filter_hash(dashboard_id: int, canonical_filters: list[dict]) -> str:
    payload = json.dumps(
        {"dashboard_id": dashboard_id, "filters": canonical_filters},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Validation against the dashboard's real filterable fields
# ---------------------------------------------------------------------------

def validate_and_lock_filters(db: Session, dash: Dashboard, filters: list[dict]) -> list[dict]:
    """Validate incoming filters against the dashboard's allowed public filter
    fields and return LOCKED link entries (value-bearing, not hidden).

    Rejects unknown fields / bad operators / empty values with 400 so a caller
    can't inject a field that isn't part of the report. Enriches each entry with
    the canonical (datasetId, semanticField, type) so enforcement is reliable.

    Empty ``filters`` returns ``[]`` (an unscoped / full-report link). The
    *decision* to allow a full report is made by the caller (the resolve
    endpoint requires an explicit ``full_report`` flag) — this function only
    validates whatever filters are supplied.
    """
    if not filters:
        return []

    # Lazy import to avoid a circular import (public.py imports this module).
    from app.api.public import _build_public_filter_fields

    allowed = _build_public_filter_fields(db, dash, [])
    by_sem = {}
    by_field = {}
    for item in allowed:
        sem = str(item.get("semanticField") or "").strip()
        fld = str(item.get("field") or "").strip()
        if sem:
            by_sem[sem.lower()] = item
        if fld:
            by_field.setdefault(fld.lower(), item)

    locked: list[dict] = []
    for f in filters:
        if not isinstance(f, dict):
            continue
        raw_ref = str(f.get("semanticField") or f.get("field") or "").strip()
        if not raw_ref:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Filter is missing 'field'.")
        op = str(f.get("operator") or "in").strip().lower()
        if op not in _ALLOWED_OPS:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported operator '{op}'.")
        value = f.get("value")
        value_ops_need_value = op not in ("is_null", "is_not_null")
        if value_ops_need_value:
            empty = value is None or (isinstance(value, (list, tuple, dict, str)) and len(value) == 0)
            if empty:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Filter '{raw_ref}' has no value.")

        match = by_sem.get(raw_ref.lower()) or by_field.get(raw_ref.lower())
        if not match:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Field '{raw_ref}' is not filterable on this dashboard.",
            )
        locked.append({
            "field": match.get("field") or match.get("semanticField"),
            "semanticField": match.get("semanticField"),
            "datasetId": match.get("datasetId"),
            "operator": "in" if isinstance(value, (list, tuple)) and op in ("in", "not_in", "eq") else op,
            "value": list(value) if isinstance(value, (list, tuple)) else value,
            # value-bearing + not hidden => locked (link_managed_field_keys strips
            # the interactive slicer; _build_public_chart_filters enforces it).
        })
    return locked


# ---------------------------------------------------------------------------
# Get-or-create the stable managed link
# ---------------------------------------------------------------------------

def get_or_create_embed_link(
    db: Session,
    dash: Dashboard,
    locked_filters: list[dict],
    filter_hash: str,
) -> DashboardPublicLink:
    existing = (
        db.query(DashboardPublicLink)
        .filter(
            DashboardPublicLink.dashboard_id == dash.id,
            DashboardPublicLink.filter_hash == filter_hash,
            DashboardPublicLink.source == EMBED_LINK_SOURCE,
        )
        .first()
    )
    if existing:
        # Keep it usable + config fresh (dashboard fields may have shifted).
        if not existing.is_active:
            existing.is_active = True
        existing.filters_config = locked_filters
        db.commit()
        return existing

    link = DashboardPublicLink(
        dashboard_id=dash.id,
        name=f"embed:{dash.id}:{filter_hash[:8]}",
        token=secrets.token_urlsafe(32),
        filter_hash=filter_hash,
        filters_config=locked_filters,
        appearance_config={},
        is_active=True,
        source=EMBED_LINK_SOURCE,
    )
    db.add(link)
    try:
        db.commit()
        db.refresh(link)
        return link
    except IntegrityError:
        # Concurrent create for the same (dashboard, filter_hash) — reuse the winner.
        db.rollback()
        winner = (
            db.query(DashboardPublicLink)
            .filter(
                DashboardPublicLink.dashboard_id == dash.id,
                DashboardPublicLink.filter_hash == filter_hash,
                DashboardPublicLink.source == EMBED_LINK_SOURCE,
            )
            .first()
        )
        if not winner:
            raise
        return winner


# ---------------------------------------------------------------------------
# Rotating opaque grant
# ---------------------------------------------------------------------------

def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def mint_embed_grant(
    db: Session,
    link: DashboardPublicLink,
    created_by,
    ttl_seconds: int,
) -> tuple[str, EmbedGrant]:
    raw = f"{EMBED_GRANT_PREFIX}{secrets.token_hex(EMBED_GRANT_HEX_CHARS // 2)}"
    grant = EmbedGrant(
        id=uuid.uuid4(),
        link_id=link.id,
        token_hash=_hash_token(raw),
        created_by=created_by,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds),
    )
    db.add(grant)
    db.commit()
    return raw, grant


def resolve_embed_grant_link(token: str, db: Session) -> DashboardPublicLink | None:
    """Resolve a grant token to its active managed link, enforcing
    expiry/revocation. Returns None when the token is not a grant token (so the
    caller falls through to normal link resolution). Raises 410/404 for an
    invalid/expired/revoked grant.
    """
    if not token or not token.startswith(EMBED_GRANT_PREFIX):
        return None
    grant = (
        db.query(EmbedGrant)
        .filter(EmbedGrant.token_hash == _hash_token(token))
        .first()
    )
    if not grant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Embed link not found.")
    now = datetime.now(timezone.utc)
    if grant.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="This embed link has been revoked.")
    exp = grant.expires_at
    if exp is not None and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp is not None and now >= exp:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="This embed link has expired.")

    link = (
        db.query(DashboardPublicLink)
        .filter(DashboardPublicLink.id == grant.link_id, DashboardPublicLink.is_active == True)
        .first()
    )
    if not link:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="This embed link is no longer available.")

    grant.use_count = (grant.use_count or 0) + 1
    grant.last_used_at = now
    db.commit()
    return link
