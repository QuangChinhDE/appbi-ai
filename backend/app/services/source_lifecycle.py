"""Source lifecycle: the ONE place a Source's config is resolved, its caches
invalidated and its delete dependencies found (spec: domain invariants).

  resolve_config()     merge → restore masked secrets ONCE → auth-mode rules →
                       validate the FINAL config with the provider schema →
                       claim a Google consent handle → platform-GCP policy
  invalidate_source()  the only invalidation entry point (this source only)
  find_delete_blockers()  structured reasons a Source cannot be deleted

Errors are typed (SourceConfigError / SourceInUseError) so routers map them to
HTTP and internal callers can handle them without parsing strings.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.logging import get_logger

logger = get_logger(__name__)

# The credential fields that belong to ONE auth mode. On an auth-mode switch
# none of them is inherited from the stored config: the new mode's credential
# must be supplied fresh (or claimed from a new Google consent).
GCP_CREDENTIAL_FIELDS = frozenset({
    "credentials_json", "service_account_json", "private_key", "client_secret",
    "google_oauth_user_id", "google_oauth_credentials", "google_oauth_email",
    "google_oauth_scopes",
})
# Fields that decide WHERE a stored secret is sent (single definition — the
# draft test and the update chokepoint both use it). A stored secret is reused
# only when every one of these the caller sends equals the persisted value.
DESTINATION_FIELDS = (
    "host", "port", "database", "username", "schema_name", "schema",
    "project_id", "spreadsheet_id", "default_dataset", "auth_mode",
    "google_oauth_email", "google_oauth_user_id",
)


def norm_destination(value: Any) -> str:
    return "" if value is None else str(value).strip()


# Subset of DESTINATION_FIELDS that only picks a namespace INSIDE the same
# server/project with the same principal. The draft test (which can be driven by
# someone without the secret) treats them as destination; a saved update by an
# object editor does not force re-entering the secret for them.
NAMESPACE_ONLY_FIELDS = frozenset({"schema_name", "schema", "default_dataset"})


def changed_destination_fields(
    incoming: Dict[str, Any], stored: Dict[str, Any], *, include_namespace: bool = True,
) -> List[str]:
    """Destination fields present in `incoming` whose value differs from `stored`."""
    return [
        f for f in DESTINATION_FIELDS
        if f in incoming and norm_destination(incoming.get(f)) != norm_destination(stored.get(f))
        and (include_namespace or f not in NAMESPACE_ONLY_FIELDS)
    ]


_OAUTH_FIELDS = ("google_oauth_user_id", "google_oauth_email", "google_oauth_credentials",
                 "google_oauth_scopes", "google_pending_id")


class SourceConfigError(ValueError):
    """A Source config / domain rule was violated. `status_code` is the HTTP
    status a router should use; `code` is a stable machine code."""

    def __init__(self, message: str, *, code: str = "invalid_config", status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class SourceInUseError(Exception):
    """A Source cannot be deleted: something still depends on it."""

    code = "source_in_use"

    def __init__(self, source_name: str, blockers: List[Dict[str, Any]]):
        self.source_name = source_name
        self.blockers = blockers
        super().__init__(f"Data source \"{source_name}\" đang được sử dụng và không thể xóa.")

    def to_detail(self) -> Dict[str, Any]:
        return {"code": self.code, "message": str(self), "blockers": self.blockers}


def _type_value(ds_type: Any) -> str:
    return str(getattr(ds_type, "value", ds_type) or "").strip().lower()


def _auth_mode(config: Dict[str, Any] | None) -> str:
    return str((config or {}).get("auth_mode") or "").strip().lower()


# ── secrets ──────────────────────────────────────────────────────────────────

def restore_masked_secrets(config: Dict[str, Any], stored: Dict[str, Any] | None) -> Dict[str, Any]:
    """Rehydrate masked/blank secret fields from the stored config — the ONE
    implementation (create/update chokepoint and the draft test both use it).

    On an auth-MODE switch (service_account ↔ google_oauth) the previous mode's
    credential is irrelevant: it is NOT restored, so a stale Service-Account JSON
    never rides into an OAuth config (or an old OAuth owner into an SA config)."""
    from app.core.crypto import MASKED_PLACEHOLDER, _SENSITIVE_FIELDS

    restored = dict(config or {})
    stored = dict(stored or {})
    new_auth, old_auth = _auth_mode(config), _auth_mode(stored)
    auth_mode_changed = bool(new_auth) and bool(old_auth) and new_auth != old_auth
    for field in _SENSITIVE_FIELDS:
        if auth_mode_changed and field in GCP_CREDENTIAL_FIELDS:
            if restored.get(field) in ("", None, MASKED_PLACEHOLDER):
                restored.pop(field, None)
            continue
        val = restored.get(field, None)
        if val in ("", None, MASKED_PLACEHOLDER):
            if stored.get(field):
                restored[field] = stored[field]
            else:
                restored.pop(field, None)
    return restored


# ── Google OAuth claim + identity ────────────────────────────────────────────

def claim_google_connection(
    db: Session,
    config: Dict[str, Any],
    *,
    actor: Any,
    existing_config: Dict[str, Any] | None = None,
    allow_claim: bool = True,
    consume: bool = True,
) -> Dict[str, Any]:
    """Resolve the Google credential this SOURCE uses (moved from the router).

    `google_pending_id` (the consent popup's handle) survives validation and is
    claimed HERE: the pending row is deleted in the caller's transaction (no
    commit), so a later failure rolls the claim back; the handle itself is never
    persisted. A non-OAuth config drops every OAuth field."""
    from app.core.crypto import decrypt_config

    normalized = dict(config or {})
    if _auth_mode(normalized) != "google_oauth":
        for k in _OAUTH_FIELDS:
            normalized.pop(k, None)
        return normalized

    existing = decrypt_config(existing_config or {})
    pending_id = str(normalized.pop("google_pending_id", "") or "").strip()

    if pending_id and allow_claim and db is not None and actor is not None:
        from app.models.models import GoogleOAuthPending
        from app.services.google_data_access_service import peek_pending_connection

        import uuid as _uuid
        try:
            pending_key = _uuid.UUID(pending_id)
        except ValueError:
            pending_key = None
        claimed = peek_pending_connection(db, pending_key, actor) if pending_key else None
        if claimed is None:
            raise SourceConfigError(
                "That Google connection expired. Press Connect Google again.",
                code="google_connection_expired",
            )
        if consume:  # a draft test only PEEKS; a save consumes (in the caller's txn)
            db.query(GoogleOAuthPending).filter(GoogleOAuthPending.id == pending_key).delete(
                synchronize_session=False
            )
        normalized["google_oauth_credentials"] = claimed["credentials"]
        normalized["google_oauth_email"] = claimed["email"]
        normalized["google_oauth_scopes"] = claimed["scopes"]
        normalized["google_oauth_user_id"] = str(actor.id)  # who attached it
        return normalized

    # No new consent in this save — keep whatever this source already had,
    # unless the auth mode just switched (then nothing stale is inherited).
    same_mode = _auth_mode(existing) == "google_oauth"
    if same_mode and existing.get("google_oauth_credentials"):
        normalized["google_oauth_credentials"] = existing["google_oauth_credentials"]
        normalized["google_oauth_email"] = existing.get("google_oauth_email")
        normalized["google_oauth_scopes"] = existing.get("google_oauth_scopes") or []
        normalized["google_oauth_user_id"] = existing.get("google_oauth_user_id") or (
            str(actor.id) if actor is not None else None)
        return normalized

    existing_user_id = str(existing.get("google_oauth_user_id") or "").strip()
    existing_email = str(existing.get("google_oauth_email") or "").strip().lower()
    desired_email = str(normalized.get("google_oauth_email") or "").strip().lower()

    # Legacy source (credential still lives on the AppBI user) — leave as is.
    if same_mode and existing_user_id and existing_email and (not desired_email or desired_email == existing_email):
        normalized["google_oauth_user_id"] = existing_user_id
        normalized["google_oauth_email"] = existing_email
        return normalized

    # An INTERNAL caller (no requesting user) may pass a credential it already
    # holds. A request never can: its credential comes only from a consent claim.
    if normalized.get("google_oauth_credentials") and (actor is None or not allow_claim):
        return normalized
    normalized.pop("google_oauth_credentials", None)

    if actor is not None:
        from app.services.google_data_access_service import get_google_data_access_status
        status_payload = get_google_data_access_status(actor)
        if not status_payload["configured"]:
            raise SourceConfigError(
                "Google data access is not configured yet. Ask an admin to set "
                "AUTH_GOOGLE_CLIENT_SECRET and AUTH_GOOGLE_DATA_REDIRECT_URI.",
                code="google_not_configured", status_code=503,
            )
    raise SourceConfigError(
        "Press \"Connect Google\" on this data source to choose the Google "
        "account it should use.",
        code="google_connection_required",
    )


def google_credential_identity(config: Dict[str, Any]) -> Optional[str]:
    """A stable, NON-SECRET identity of the Google credential a config uses.

    Per-source credential: `email|sub|client_id` plus a SHA-256 fingerprint of
    the refresh token (never the token). Reconnecting (new refresh token) or
    switching account changes it. Legacy user-held credential: the AppBI user id
    + email (the token lives on the user row). None when there is no credential.
    """
    from app.core.crypto import decrypt_config

    dc = decrypt_config(config or {})
    raw = dc.get("google_oauth_credentials")
    if raw:
        try:
            payload = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except Exception:  # noqa: BLE001
            payload = {}
        refresh = str(payload.get("refresh_token") or "")
        material = refresh or str(raw)
        fp = hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]
        who = str(dc.get("google_oauth_email") or payload.get("account") or "").strip().lower()
        client = str(payload.get("client_id") or "")
        return f"src:{who}:{client}:{fp}"
    owner = str(dc.get("google_oauth_user_id") or "").strip()
    if owner:
        email = str(dc.get("google_oauth_email") or "").strip().lower()
        return f"user:{owner}:{email}"
    return None


# ── platform GCP policy (moved from the router) ──────────────────────────────

def is_platform_admin(user: Any) -> bool:
    """An administrator in this codebase = `settings: full`."""
    if user is None:
        return False
    from app.core.dependencies import _normalize_permissions
    try:
        return _normalize_permissions(user).get("settings") == "full"
    except Exception:  # noqa: BLE001 — anything odd is not an admin
        return False


def enforce_platform_gcp_policy(
    ds_type: str,
    config: Dict[str, Any],
    actor: Any,
    existing_config: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """F5: the platform GCP credential is usable only for an allow-listed project
    or a target an administrator approved. The approval marker can never be set
    by the request; it is (re)stamped here for admins and carried over only while
    the target is unchanged."""
    from app.services.datasource_service import (
        PLATFORM_GCP_APPROVAL_FIELD,
        platform_gcp_target,
        platform_gcp_target_allowed,
        uses_platform_gcp_credential,
    )
    cfg = dict(config or {})
    cfg.pop(PLATFORM_GCP_APPROVAL_FIELD, None)
    if not uses_platform_gcp_credential(ds_type, cfg):
        return cfg
    target = platform_gcp_target(cfg)
    previous = str((existing_config or {}).get(PLATFORM_GCP_APPROVAL_FIELD) or "").strip()
    if target and previous == target:
        cfg[PLATFORM_GCP_APPROVAL_FIELD] = previous
        return cfg
    if platform_gcp_target_allowed(cfg):
        return cfg
    if is_platform_admin(actor) and target:
        cfg[PLATFORM_GCP_APPROVAL_FIELD] = target
        return cfg
    raise SourceConfigError(
        "The platform Google service account is not enabled for this project. "
        "Provide this source's own credentials, or ask an administrator.",
        code="policy_blocked",
    )


# ── the resolve pipeline ─────────────────────────────────────────────────────

def _refuse_stored_secret_at_new_destination(
    incoming: Dict[str, Any], stored: Dict[str, Any], auth_mode_changed: bool,
) -> None:
    """S4: a stored secret is never re-sent to a destination the caller changed.
    If any destination field differs from the persisted value and a secret
    would be inherited (masked, blank or omitted), the caller must re-enter it
    — at every permission level."""
    from app.core.crypto import MASKED_PLACEHOLDER, _SENSITIVE_FIELDS

    if incoming.get("google_pending_id"):
        return  # a fresh Google consent supplies the new credential
    reused = [
        f for f in _SENSITIVE_FIELDS
        if stored.get(f)
        and incoming.get(f, None) in ("", None, MASKED_PLACEHOLDER)
        and not (auth_mode_changed and f in GCP_CREDENTIAL_FIELDS)
    ]
    if not reused:
        return
    # A masked/blank value is "unchanged", not a new destination.
    changed = [
        f for f in changed_destination_fields(incoming, stored, include_namespace=False)
        if incoming.get(f) not in ("", None, MASKED_PLACEHOLDER) or f not in _SENSITIVE_FIELDS
    ]
    if changed:
        raise SourceConfigError(
            "The connection details changed (" + ", ".join(changed) + "), so the stored "
            "credential cannot be reused. Enter the password / credential again.",
            code="credential_required",
        )


def resolve_config(  # noqa: C901
    db: Session,
    ds_type: str,
    incoming: Dict[str, Any],
    *,
    stored: Dict[str, Any] | None,
    actor: Any,
    enforce_policy: bool,
) -> Dict[str, Any]:
    """merge → restore secrets (once) → auth-mode rules → provider-schema
    validation of the FINAL config → Google claim → platform policy.
    Returns a PLAINTEXT config (caller encrypts at persist)."""
    from app.core.crypto import decrypt_config
    from app.schemas.datasource_config import validate_datasource_config
    from app.services.datasource_service import PLATFORM_GCP_APPROVAL_FIELD

    incoming = dict(incoming or {})
    incoming.pop(PLATFORM_GCP_APPROVAL_FIELD, None)  # never from a request
    plain_stored = decrypt_config(stored or {}) if stored else None
    if plain_stored is not None and ds_type != "manual":
        # MERGE: a key the request omits keeps its stored value — except on an
        # auth-mode switch, where nothing of the previous mode's credential is
        # inherited (no stale SA JSON / OAuth token under the new mode).
        old_auth = _auth_mode(plain_stored)
        new_auth = _auth_mode(incoming) or old_auth
        _refuse_stored_secret_at_new_destination(incoming, plain_stored, old_auth != new_auth)
        cfg = dict(plain_stored)
        cfg.pop(PLATFORM_GCP_APPROVAL_FIELD, None)
        if old_auth and new_auth != old_auth:
            for f in GCP_CREDENTIAL_FIELDS:
                cfg.pop(f, None)
            cfg.pop("google_pending_id", None)
        cfg.update(incoming)
        cfg = restore_masked_secrets(cfg, plain_stored)
    elif plain_stored is not None:
        cfg = restore_masked_secrets(incoming, plain_stored)
    else:
        cfg = incoming
    try:
        cfg = validate_datasource_config(ds_type, cfg)
    except ValueError as exc:
        raise SourceConfigError(str(exc), code="invalid_config") from exc
    cfg.pop(PLATFORM_GCP_APPROVAL_FIELD, None)
    if ds_type in ("bigquery", "google_sheets", "google_docs"):
        cfg = claim_google_connection(db, cfg, actor=actor, existing_config=plain_stored)
    if enforce_policy:
        cfg = enforce_platform_gcp_policy(ds_type, cfg, actor, existing_config=plain_stored)
    elif plain_stored and plain_stored.get(PLATFORM_GCP_APPROVAL_FIELD):
        cfg[PLATFORM_GCP_APPROVAL_FIELD] = plain_stored[PLATFORM_GCP_APPROVAL_FIELD]
    return cfg


def connection_fields_changed(old_plain: Dict[str, Any], new_plain: Dict[str, Any]) -> List[str]:
    """Names of config fields whose value changed (names only — for audit)."""
    keys = set(old_plain or {}) | set(new_plain or {})
    return sorted(k for k in keys if (old_plain or {}).get(k) != (new_plain or {}).get(k))


# ── invalidation ─────────────────────────────────────────────────────────────

def invalidate_source(db: Session, data_source: Any, previous_config: Dict[str, Any] | None = None) -> Dict[str, int]:
    """The ONLY invalidation entry point for a Source (this source only):

      * DatasetTable.columns_cache / sample_cache of this source's tables (DB, committed)
      * the live query cache (query_cache.invalidate_datasource — local + shared)
      * BigQuery client(s) keyed by the previous AND the current credential identity
      * Google Sheets workbook/result + header caches for the old and new spreadsheet

    Call it AFTER the change is committed. Each step is independent and
    best-effort beyond the DB step, so one failing cache never leaves another
    one stale."""
    from app.models.dataset import DatasetTable

    ds_id = data_source.id
    ds_type = _type_value(getattr(data_source, "type", ""))
    current = dict(getattr(data_source, "config", None) or {})
    counts = {"dataset_tables": 0, "query_cache": 0, "bq_clients": 0, "sheets": 0}

    counts["dataset_tables"] = (
        db.query(DatasetTable)
        .filter(DatasetTable.datasource_id == ds_id)
        .update({"columns_cache": None, "sample_cache": None}, synchronize_session=False)
    )
    db.commit()

    try:
        from app.services import query_cache
        counts["query_cache"] = int(query_cache.invalidate_datasource(ds_id) or 0)
    except Exception:  # noqa: BLE001
        logger.warning("source.invalidate.query_cache_failed source_id=%s", ds_id)

    configs = [c for c in (previous_config, current) if c]
    if ds_type == "bigquery" or any(_auth_mode(c) == "google_oauth" for c in configs):
        try:
            from app.services.datasource_service import evict_bigquery_client_cache
            if configs:
                counts["bq_clients"] = evict_bigquery_client_cache(*configs)
        except Exception:  # noqa: BLE001
            logger.warning("source.invalidate.bq_failed source_id=%s", ds_id)

    if ds_type == "google_sheets":
        sheet_ids = {str(c.get("spreadsheet_id") or "").strip() for c in configs} - {""}
        for sid in sheet_ids:
            try:
                from app.services import google_sheets_cache
                from app.services.google_sheets_connector import _invalidate_header_cache
                google_sheets_cache.invalidate(sid)
                _invalidate_header_cache(sid)
                counts["sheets"] += 1
            except Exception:  # noqa: BLE001
                logger.warning("source.invalidate.sheets_failed source_id=%s", ds_id)

    # S8: the resolved BigQuery location is per source and depends on its
    # project/credential — a changed connection must re-resolve it.
    try:
        from app.services import snapshot_service
        snapshot_service._location_cache.pop(ds_id, None)
    except Exception:  # noqa: BLE001
        logger.warning("source.invalidate.location_failed source_id=%s", ds_id)

    logger.info("source.invalidated source_id=%s version=%s counts=%s",
                ds_id, getattr(data_source, "config_version", None), counts)
    return counts


# ── delete dependencies ──────────────────────────────────────────────────────

def find_delete_blockers(db: Session, data_source_id: int) -> List[Dict[str, Any]]:
    """Everything that still depends on this Source, as {kind, id, name}.

      dataset            a non-draft Dataset with a table on this source
      dataset_snapshot   a Dataset whose current snapshot is HOSTED on this source
      knowledge_doc      a Knowledge Doc whose external source is this Source

    Hidden import drafts are not blockers (they are purged on delete)."""
    from app.models.dataset import Dataset, DatasetTable, DatasetTableSnapshot

    blockers: List[Dict[str, Any]] = []
    seen = set()
    rows = (
        db.query(Dataset.id, Dataset.name)
        .join(DatasetTable, DatasetTable.dataset_id == Dataset.id)
        .filter(DatasetTable.datasource_id == data_source_id, Dataset.is_draft.is_(False))
        .distinct()
        .all()
    )
    for did, name in rows:
        seen.add(("dataset", did))
        blockers.append({"kind": "dataset", "id": did, "name": name})

    hosted = (
        db.query(Dataset.id, Dataset.name)
        .join(DatasetTableSnapshot, DatasetTableSnapshot.dataset_id == Dataset.id)
        .filter(
            DatasetTableSnapshot.host_datasource_id == data_source_id,
            DatasetTableSnapshot.retired_at.is_(None),
            DatasetTableSnapshot.status.in_(("ready", "building")),
            Dataset.is_draft.is_(False),
        )
        .distinct()
        .all()
    )
    for did, name in hosted:
        if ("dataset", did) in seen:
            continue
        blockers.append({"kind": "dataset_snapshot", "id": did, "name": name})

    from app.models.governance import GovernKnowledgeDoc
    docs = (
        db.query(GovernKnowledgeDoc.id, GovernKnowledgeDoc.title, GovernKnowledgeDoc.source_config)
        .filter(GovernKnowledgeDoc.source_type.isnot(None))
        .all()
    )
    for doc_id, title, source_config in docs:
        try:
            ref = (source_config or {}).get("datasource_id")
            if ref is not None and int(ref) == int(data_source_id):
                blockers.append({"kind": "knowledge_doc", "id": doc_id, "name": title})
        except (TypeError, ValueError, AttributeError):
            continue
    return blockers


# ── audit ────────────────────────────────────────────────────────────────────

def audit_source_event(db: Session, action: Any, data_source: Any, actor_id: Any,
                       details: Dict[str, Any] | None = None) -> None:
    """Structured audit for the Source lifecycle. Details carry ids, provider,
    changed field NAMES, auth modes and error categories — never a value."""
    payload = {
        "provider": _type_value(getattr(data_source, "type", "")),
        "name": getattr(data_source, "name", None),
        "config_version": getattr(data_source, "config_version", None),
        **(details or {}),
    }
    logger.info("source.audit action=%s source_id=%s details=%s",
                getattr(action, "value", action), getattr(data_source, "id", None), payload)
    try:
        from app.services.audit_service import audit
        audit(db, action, user_id=actor_id, resource_type="datasource",
              resource_id=str(getattr(data_source, "id", "")), details=payload)
    except Exception:  # noqa: BLE001 — audit never breaks the operation
        logger.debug("source audit write failed", exc_info=True)
