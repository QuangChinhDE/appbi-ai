"""AI provider keys for Agent Flow — stored once, referenced by id, resolved at run time.

THE ONE PLACE A STEP'S CREDENTIAL COMES FROM
-------------------------------------------
Before this module a step's key could come from five places — its own `api_key`
field, the link's `ai_bot_key`, the viewer's pasted header, or the server's
`OPENAI_API_KEY` — and each run entrypoint picked among them differently. A step
pinned to one vendor could be handed another vendor's key. All of that is gone:

    step.credential_id  →  AiProviderCredential row  →  decrypted secret

and nothing else. There is no fallback. A step without a usable key fails with a
message that names the step and the reason, before or during the run.

WHO MAY USE A KEY
-----------------
A key is a per-user resource (`ResourceType.AI_CREDENTIAL`, module `agent_flows`).
Its owner may share it; a share lets the recipient USE it in their own steps and
test it. Only `get_effective_permission` answers "may this user use this key",
the same rule every other shared resource uses.

Assigning a key to a step is the assigner DELEGATING it to everyone who runs the
flow — a public viewer, a chat reader — exactly as a flow delegates its author's
reading rights. So the step records who assigned it (`credential_granted_by`,
server-set, never trusted from the client) and every run re-checks that this
person may still use the key. Unsharing a key, or deleting it, therefore stops
it being spent through someone else's flow immediately, without a republish.

WHAT NEVER LEAVES THIS MODULE
-----------------------------
The secret. No function here returns it except `StoredCredentials.for_node`, whose
caller hands it straight to a provider adapter. Serialised rows carry `key_hint`
(last four characters) and nothing else; vendor errors are sanitised before they
are stored or shown, because some of them echo the key or a `?key=` URL.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.models.ai_provider_credential import AI_CREDENTIAL_PROVIDERS, AiProviderCredential

logger = logging.getLogger(__name__)

MODULE = "agent_flows"

PROVIDER_LABELS: dict[str, str] = {
    "openai": "OpenAI",
    "anthropic": "Anthropic (Claude)",
    "gemini": "Google Gemini",
}

#: Node types whose handler calls a model and therefore needs a key.
MODEL_NODE_TYPES = ("agent", "coordinate")

_NAME_MAX = 120
_SECRET_MAX = 512


# ═══ Errors ═══════════════════════════════════════════════════════════════════
class CredentialError(Exception):
    """A failure with its HTTP status decided here, so routers stay thin."""

    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(detail if isinstance(detail, str) else "credential error")
        self.status = status
        self.detail = detail


class CredentialUnavailable(RuntimeError):
    """A step cannot run because its key cannot be used. Carries WHY, by step."""

    def __init__(self, *, step_key: str, step_name: str, reason: str, message: str) -> None:
        super().__init__(message)
        self.step_key = step_key
        self.step_name = step_name
        self.reason = reason

    def as_dict(self) -> dict[str, str]:
        return {
            "step_key": self.step_key,
            "step_name": self.step_name,
            "reason": self.reason,
            "message": str(self),
        }


# ═══ Small helpers ════════════════════════════════════════════════════════════
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hint(secret: str) -> str:
    s = (secret or "").strip()
    return s[-4:] if len(s) >= 8 else ""


_SECRET_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"AIza[0-9A-Za-z_\-]{10,}"),
    re.compile(r"(?i)(key|api_key|token)=[^&\s\"']+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}"),
)


def sanitize_error(text: Any, *, secret: str = "") -> str:
    """A vendor error as something safe to store and show: no key, no query string."""
    out = str(text or "")
    if secret:
        out = out.replace(secret, "••••")
    for pat in _SECRET_PATTERNS:
        out = pat.sub("••••", out)
    out = re.sub(r"\?[^\s\"']*", "", out)
    out = " ".join(out.split())
    return out[:200]


def provider_label(provider: str) -> str:
    return PROVIDER_LABELS.get(provider, provider)


def _clean_provider(provider: Any) -> str:
    p = str(provider or "").strip().lower()
    if p not in AI_CREDENTIAL_PROVIDERS:
        raise CredentialError(
            400, f"Nhà cung cấp không hỗ trợ: {provider or '(trống)'}. "
                 f"Chọn một trong: {', '.join(PROVIDER_LABELS.values())}.")
    return p


def _clean_name(name: Any) -> str:
    n = " ".join(str(name or "").split())
    if not n:
        raise CredentialError(400, "Tên key không được để trống.")
    if len(n) > _NAME_MAX:
        raise CredentialError(400, f"Tên key tối đa {_NAME_MAX} ký tự.")
    return n


def _clean_secret(secret: Any) -> str:
    s = str(secret or "").strip()
    if not s:
        raise CredentialError(400, "Chưa nhập API key.")
    if len(s) > _SECRET_MAX or any(c.isspace() for c in s):
        raise CredentialError(400, "API key không hợp lệ (có khoảng trắng hoặc quá dài).")
    return s


def _encrypt(secret: str) -> str:
    """Encrypt or refuse. `encrypt_value` returns PLAINTEXT when no key is set."""
    from app.core.crypto import encrypt_value, is_encrypted, is_encryption_configured

    if not is_encryption_configured():
        raise CredentialError(
            409,
            "Máy chủ chưa cấu hình DATASOURCE_ENCRYPTION_KEY nên không thể lưu API key "
            "an toàn. Liên hệ quản trị viên để cấu hình khoá mã hoá rồi thử lại.",
        )
    enc = encrypt_value(secret)
    if not is_encrypted(enc):
        raise CredentialError(409, "Không mã hoá được API key — chưa lưu.")
    return enc


def _decrypt(row: AiProviderCredential) -> str:
    """The secret in the clear, or "" when it will not decrypt."""
    from app.core.crypto import decrypt_value, is_encrypted

    try:
        value = decrypt_value(row.secret_enc or "") or ""
    except Exception:  # noqa: BLE001 — a rotated ENCRYPTION_KEY
        logger.warning("[ai-credential] %s will not decrypt", row.id)
        return ""
    # `decrypt_value` passes ciphertext through unchanged when no key is loaded.
    return "" if is_encrypted(value) else value


def _owner_id_str(row: AiProviderCredential) -> str:
    return str(row.owner_id) if row.owner_id is not None else ""


def permission(db: Session, user: Any, row: AiProviderCredential) -> str:
    """none | view | edit | full — THE rule for this key and this user."""
    from app.core.dependencies import get_effective_permission

    return get_effective_permission(db, user, row, MODULE)


def can_use(db: Session, user: Any, row: AiProviderCredential) -> bool:
    return row.deleted_at is None and permission(db, user, row) != "none"


def _require(db: Session, user: Any, row: AiProviderCredential, level: str) -> str:
    from app.core.permissions import LEVEL_ORDER

    eff = permission(db, user, row)
    if LEVEL_ORDER.get(eff, 0) < LEVEL_ORDER[level]:
        raise CredentialError(403, {
            "view": "Bạn không có quyền dùng key này.",
            "edit": "Bạn không có quyền sửa key này.",
            "full": "Chỉ chủ sở hữu key mới được xoá, chia sẻ hoặc đặt mặc định.",
        }[level])
    return eff


# ═══ Reading ══════════════════════════════════════════════════════════════════
def get_live(db: Session, credential_id: Any) -> AiProviderCredential | None:
    try:
        cid = int(credential_id)
    except (TypeError, ValueError):
        return None
    return (
        db.query(AiProviderCredential)
        .filter(AiProviderCredential.id == cid, AiProviderCredential.deleted_at.is_(None))
        .first()
    )


def get_for(db: Session, user: Any, credential_id: Any, *, level: str = "view") -> AiProviderCredential:
    row = get_live(db, credential_id)
    if row is None:
        raise CredentialError(404, "Không tìm thấy key này (có thể đã bị xoá).")
    _require(db, user, row, level)
    return row


def _owners(db: Session, rows: Iterable[AiProviderCredential]) -> dict[str, dict]:
    from app.models.user import User

    ids = {r.owner_id for r in rows if r.owner_id is not None}
    if not ids:
        return {}
    out: dict[str, dict] = {}
    for u in db.query(User).filter(User.id.in_(ids)).all():
        out[str(u.id)] = {
            "id": str(u.id),
            "email": u.email,
            "name": getattr(u, "full_name", None) or getattr(u, "name", None) or u.email,
        }
    return out


def serialize(
    row: AiProviderCredential, *, user: Any, level: str, usage_count: int | None = None,
    owners: dict[str, dict] | None = None,
) -> dict[str, Any]:
    """The row as any client may see it. There is no field here for the secret."""
    owner = (owners or {}).get(_owner_id_str(row))
    return {
        "id": row.id,
        "name": row.name,
        "provider": row.provider,
        "provider_label": provider_label(row.provider),
        "key_hint": row.key_hint or "",
        "is_default": bool(row.is_default),
        "mine": bool(row.owner_id is not None and str(row.owner_id) == str(getattr(user, "id", ""))),
        "owner": owner,
        "permission": level,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None,
        "last_test_at": row.last_test_at.isoformat() if row.last_test_at else None,
        "last_test_ok": row.last_test_ok,
        "last_test_error": row.last_test_error,
        "usage_count": usage_count,
    }


def list_usable(db: Session, user: Any, *, provider: str = "") -> list[dict[str, Any]]:
    """Every live key this user may use: own, shared with them, or (module `full`) all."""
    from app.core.dependencies import batch_effective_permissions
    from app.core.permissions import _owned_or_shared
    from app.models.resource_share import ResourceType

    q = _owned_or_shared(db, AiProviderCredential, ResourceType.AI_CREDENTIAL, user)
    q = q.filter(AiProviderCredential.deleted_at.is_(None))
    if provider:
        q = q.filter(AiProviderCredential.provider == _clean_provider(provider))
    rows = q.order_by(AiProviderCredential.provider, AiProviderCredential.name).all()
    levels = batch_effective_permissions(db, user, rows, MODULE) if rows else {}
    counts = usage_counts(db)
    owners = _owners(db, rows)
    out = []
    for r in rows:
        level = levels.get(r.id, "none")
        if level == "none":
            continue
        out.append(serialize(r, user=user, level=level, usage_count=counts.get(r.id, 0), owners=owners))
    # Own keys first, then shared, each by provider and name — what a picker wants.
    out.sort(key=lambda d: (not d["mine"], d["provider"], d["name"].lower()))
    return out


# ═══ Writing ══════════════════════════════════════════════════════════════════
def _name_taken(db: Session, owner_id: Any, name: str, *, except_id: int | None = None) -> bool:
    q = db.query(AiProviderCredential).filter(
        AiProviderCredential.owner_id == owner_id,
        AiProviderCredential.deleted_at.is_(None),
        AiProviderCredential.name == name,
    )
    if except_id is not None:
        q = q.filter(AiProviderCredential.id != except_id)
    return db.query(q.exists()).scalar()


def _clear_defaults(db: Session, owner_id: Any, provider: str, *, except_id: int | None = None) -> None:
    q = db.query(AiProviderCredential).filter(
        AiProviderCredential.owner_id == owner_id,
        AiProviderCredential.provider == provider,
        AiProviderCredential.deleted_at.is_(None),
        AiProviderCredential.is_default.is_(True),
    )
    if except_id is not None:
        q = q.filter(AiProviderCredential.id != except_id)
    for r in q.all():
        r.is_default = False
    db.flush()


def _has_default(db: Session, owner_id: Any, provider: str) -> bool:
    q = db.query(AiProviderCredential).filter(
        AiProviderCredential.owner_id == owner_id,
        AiProviderCredential.provider == provider,
        AiProviderCredential.deleted_at.is_(None),
        AiProviderCredential.is_default.is_(True),
    )
    return db.query(q.exists()).scalar()


def create(
    db: Session, user: Any, *, name: Any, provider: Any, secret: Any, is_default: bool | None = None,
) -> dict[str, Any]:
    clean_name = _clean_name(name)
    clean_provider = _clean_provider(provider)
    clean_secret = _clean_secret(secret)
    enc = _encrypt(clean_secret)
    if _name_taken(db, user.id, clean_name):
        raise CredentialError(400, f"Bạn đã có một key tên “{clean_name}”. Đặt tên khác.")
    # The first key of a provider becomes its default, so a new step picks it up
    # without the author having to know defaults exist.
    make_default = bool(is_default) or not _has_default(db, user.id, clean_provider)
    if make_default:
        _clear_defaults(db, user.id, clean_provider)
    row = AiProviderCredential(
        name=clean_name,
        provider=clean_provider,
        secret_enc=enc,
        key_hint=_hint(clean_secret),
        is_default=make_default,
        owner_id=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    _audit(db, "AI_CREDENTIAL_CREATED", row, user)
    return serialize(row, user=user, level=permission(db, user, row), usage_count=0,
                     owners=_owners(db, [row]))


def update(
    db: Session, user: Any, credential_id: Any, *, name: Any = None, secret: Any = None,
    is_default: bool | None = None,
) -> dict[str, Any]:
    row = get_for(db, user, credential_id, level="edit")
    changed: list[str] = []
    if name is not None:
        clean_name = _clean_name(name)
        if clean_name != row.name:
            if _name_taken(db, row.owner_id, clean_name, except_id=row.id):
                raise CredentialError(400, f"Đã có một key tên “{clean_name}”. Đặt tên khác.")
            row.name = clean_name
            changed.append("name")
    # Blank means KEEP — the client was never shown the secret, so it cannot resend it.
    if secret is not None and str(secret).strip():
        clean_secret = _clean_secret(secret)
        row.secret_enc = _encrypt(clean_secret)
        row.key_hint = _hint(clean_secret)
        row.last_test_at = None
        row.last_test_ok = None
        row.last_test_error = None
        changed.append("secret")
    if is_default is not None and bool(is_default) != bool(row.is_default):
        # A default is the OWNER's picker preference, so only the owner sets it.
        _require(db, user, row, "full")
        if is_default:
            _clear_defaults(db, row.owner_id, row.provider, except_id=row.id)
        row.is_default = bool(is_default)
        changed.append("is_default")
    if changed:
        row.updated_at = _now()
        db.commit()
        db.refresh(row)
        _audit(db, "AI_CREDENTIAL_UPDATED", row, user, {"changed": changed})
    return serialize(row, user=user, level=permission(db, user, row),
                     usage_count=usage_counts(db).get(row.id, 0), owners=_owners(db, [row]))


def delete(db: Session, user: Any, credential_id: Any) -> dict[str, Any]:
    row = get_for(db, user, credential_id, level="full")
    affected = usage(db, row.id)
    row.deleted_at = _now()
    row.is_default = False
    # The ciphertext is dropped with the row's life: a deleted key must not be
    # recoverable by un-deleting it, and nothing may ever resolve it again.
    row.secret_enc = "_enc:deleted"
    db.commit()
    _audit(db, "AI_CREDENTIAL_DELETED", row, user, {"affected_steps": len(affected)})
    return {"deleted": True, "affected": affected}


def _audit(db: Session, action: str, row: AiProviderCredential, user: Any, extra: dict | None = None) -> None:
    """Best-effort trail: the key's id, name and provider — never the secret."""
    try:
        from app.models.audit_log import AuditAction
        from app.services.audit_service import audit as write_audit

        write_audit(
            db,
            getattr(AuditAction, action),
            user_id=getattr(user, "id", None),
            resource_type="ai_credential",
            resource_id=str(row.id),
            details={"name": row.name, "provider": row.provider,
                     "actor": getattr(user, "email", None), **(extra or {})},
        )
    except Exception:  # noqa: BLE001
        logger.warning("[ai-credential] audit write failed for %s", row.id, exc_info=True)


# ═══ Where a key is used ══════════════════════════════════════════════════════
def _model_nodes_raw(nodes: Any) -> list[dict]:
    from app.services.agent_flows.contract import raw_child_groups

    found: list[dict] = []
    if not isinstance(nodes, list):
        return found
    for n in nodes:
        if not isinstance(n, dict):
            continue
        if str(n.get("type") or "agent") in MODEL_NODE_TYPES:
            found.append(n)
        for group in raw_child_groups(n):
            found.extend(_model_nodes_raw(group))
    return found


def _current_rows(db: Session) -> list[Any]:
    """The version of each flow that matters: its open draft/latest, and its live one."""
    from app.models.agent_brain import AgentBrainVersion

    rows = (
        db.query(AgentBrainVersion)
        .order_by(AgentBrainVersion.brain_key, AgentBrainVersion.version.desc())
        .all()
    )
    keep: list[Any] = []
    seen_latest: set[str] = set()
    for r in rows:
        if r.brain_key not in seen_latest:
            seen_latest.add(r.brain_key)
            keep.append(r)
        elif r.status == "published":
            keep.append(r)
    return keep


def _cid(value: Any) -> int | None:
    try:
        return int(value) if value not in (None, "", 0) else None
    except (TypeError, ValueError):
        return None


def usage(db: Session, credential_id: int) -> list[dict[str, Any]]:
    """Which flows and steps would lose this key. One entry per (flow, step)."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for r in _current_rows(db):
        for n in _model_nodes_raw((r.body or {}).get("nodes")):
            if _cid(n.get("credential_id")) != credential_id:
                continue
            key = (r.brain_key, str(n.get("key") or ""))
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "brain_key": r.brain_key,
                "flow_name": r.name,
                "step_key": key[1],
                "step_name": str(n.get("name") or key[1]),
            })
    return out


def usage_counts(db: Session) -> dict[int, int]:
    counts: dict[int, set[tuple[str, str]]] = {}
    for r in _current_rows(db):
        for n in _model_nodes_raw((r.body or {}).get("nodes")):
            cid = _cid(n.get("credential_id"))
            if cid is not None:
                counts.setdefault(cid, set()).add((r.brain_key, str(n.get("key") or "")))
    return {k: len(v) for k, v in counts.items()}


# ═══ Testing a key ════════════════════════════════════════════════════════════
#: A read-only request per vendor that proves the key authenticates and spends no
#: tokens. The key travels in a HEADER for every vendor — Gemini accepts
#: `x-goog-api-key`, so it never appears in a URL that httpx would log.
_TEST_REQUESTS: dict[str, tuple[str, Any]] = {
    "openai": ("https://api.openai.com/v1/models",
               lambda k: {"Authorization": f"Bearer {k}"}),
    "anthropic": ("https://api.anthropic.com/v1/models",
                  lambda k: {"x-api-key": k, "anthropic-version": "2023-06-01"}),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/models",
               lambda k: {"x-goog-api-key": k}),
}

_STATUS_MESSAGES = {
    400: "Nhà cung cấp từ chối yêu cầu (400) — key có thể sai định dạng.",
    401: "Key không hợp lệ hoặc đã bị thu hồi (401).",
    403: "Key không có quyền truy cập API này (403).",
    404: "Không tìm thấy dịch vụ của nhà cung cấp (404).",
    429: "Key đã hết hạn mức hoặc bị giới hạn tốc độ (429).",
}


async def probe(provider: str, secret: str) -> dict[str, Any]:
    """Call the vendor once. Returns {ok, error, latency_ms}; never raises."""
    import httpx

    url, headers = _TEST_REQUESTS[provider]
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers(secret))
        latency = int((time.monotonic() - started) * 1000)
        if resp.status_code == 200:
            return {"ok": True, "error": None, "latency_ms": latency}
        body = resp.text or ""
        # Google answers a bad key with 400 API_KEY_INVALID, not 401 — measured
        # against a real invalid key. Named as what it is, not as "bad request".
        if resp.status_code == 400 and ("API_KEY_INVALID" in body or "API key not valid" in body):
            msg = _STATUS_MESSAGES[401]
        else:
            msg = _STATUS_MESSAGES.get(resp.status_code) or f"Nhà cung cấp trả lỗi {resp.status_code}."
        return {"ok": False, "error": sanitize_error(msg, secret=secret), "latency_ms": latency}
    except httpx.TimeoutException:
        return {"ok": False, "error": "Hết thời gian chờ nhà cung cấp phản hồi.",
                "latency_ms": int((time.monotonic() - started) * 1000)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": sanitize_error(f"Không kết nối được: {type(exc).__name__}", secret=secret),
                "latency_ms": int((time.monotonic() - started) * 1000)}


async def test(db: Session, user: Any, credential_id: Any) -> dict[str, Any]:
    row = get_for(db, user, credential_id, level="view")
    secret = _decrypt(row)
    if not secret:
        result = {"ok": False, "error": "Key không giải mã được — hãy nhập lại key.", "latency_ms": 0}
    else:
        result = await probe(row.provider, secret)
    row.last_test_at = _now()
    row.last_test_ok = bool(result["ok"])
    row.last_test_error = None if result["ok"] else sanitize_error(result["error"], secret=secret)
    db.commit()
    return result


# ═══ Saving a flow: who may put which key on which step ═══════════════════════
def _previous_assignments(prior_body: Any) -> dict[str, tuple[int | None, str]]:
    out: dict[str, tuple[int | None, str]] = {}
    if isinstance(prior_body, dict):
        for n in _model_nodes_raw(prior_body.get("nodes")):
            out[str(n.get("key") or "")] = (
                _cid(n.get("credential_id")), str(n.get("credential_granted_by") or ""))
    return out


def apply_assignments(
    db: Session, user: Any, *, prior_body: Any, body: dict[str, Any],
) -> dict[str, Any]:
    """The body as it will be stored, with every step's key checked and attributed.

    For each model step:
      * no key                          → stored without one (a draft may lack it)
      * the same key the step had before → carried unchanged, WITH its original
                                           grantor — so a co-editor who cannot use
                                           the author's key can still edit a prompt
      * a new or changed key            → must exist, be live, match the step's
                                           provider, and be usable by the saver;
                                           the saver becomes its grantor

    `credential_granted_by` is set here and only here. A value sent by the client
    is ignored: accepting it would let anyone attribute a key to its owner.
    """
    from app.services.agent_flows.contract import map_raw_children

    previous = _previous_assignments(prior_body)
    actor = str(getattr(user, "email", "") or "")
    problems: list[str] = []
    forbidden: list[str] = []

    def fold(nodes: Any) -> Any:
        if not isinstance(nodes, list):
            return nodes
        out: list[Any] = []
        for node in nodes:
            if not isinstance(node, dict):
                out.append(node)
                continue
            n = dict(node)
            if str(n.get("type") or "agent") in MODEL_NODE_TYPES:
                label = str(n.get("name") or n.get("key") or "?")
                cid = _cid(n.get("credential_id"))
                n.pop("credential_granted_by", None)
                if cid is None:
                    n["credential_id"] = None
                else:
                    n["credential_id"] = cid
                    before_id, before_by = previous.get(str(n.get("key") or ""), (None, ""))
                    row = db.query(AiProviderCredential).filter(AiProviderCredential.id == cid).first()
                    provider = str(n.get("provider") or "").strip().lower()
                    if row is None:
                        problems.append(f"Bước “{label}”: key #{cid} không tồn tại.")
                    elif row.provider != provider:
                        problems.append(
                            f"Bước “{label}” chạy {provider_label(provider)} nhưng key “{row.name}” "
                            f"là của {provider_label(row.provider)}.")
                    elif before_id == cid:
                        # Unchanged: carried as it was, even if deleted since — the
                        # run will say so by name; silently clearing it would hide why.
                        n["credential_granted_by"] = before_by
                    elif row.deleted_at is not None:
                        problems.append(f"Bước “{label}”: key “{row.name}” đã bị xoá.")
                    elif not can_use(db, user, row):
                        forbidden.append(f"Bước “{label}”: bạn không có quyền dùng key “{row.name}”.")
                    else:
                        n["credential_granted_by"] = actor
            out.append(map_raw_children(n, fold))
        return out

    new_body = dict(body)
    new_body["nodes"] = fold(body.get("nodes"))
    if problems:
        raise CredentialError(422, " ".join(problems[:5]))
    if forbidden:
        raise CredentialError(403, " ".join(forbidden[:5]))
    return new_body


def strip_assignments(body: dict[str, Any]) -> dict[str, Any]:
    """A body with every step's key removed — for a copy that leaves this account."""
    from app.services.agent_flows.contract import map_raw_children

    def fold(nodes: Any) -> Any:
        if not isinstance(nodes, list):
            return nodes
        out: list[Any] = []
        for node in nodes:
            if not isinstance(node, dict):
                out.append(node)
                continue
            n = dict(node)
            if str(n.get("type") or "agent") in MODEL_NODE_TYPES:
                n["credential_id"] = None
                n.pop("credential_granted_by", None)
            out.append(map_raw_children(n, fold))
        return out

    out = dict(body or {})
    out["nodes"] = fold(out.get("nodes"))
    return out


# ═══ Running: the one resolver ════════════════════════════════════════════════
@dataclass(frozen=True)
class ResolvedCredential:
    provider: str
    model: str
    api_key: str
    credential_id: int | None = None
    name: str = ""


_REASON_TEXT = {
    "none": "chưa có AI key",
    "deleted": "dùng key “{name}” đã bị xoá",
    "provider_mismatch": "dùng key “{name}” của {key_provider}, không phải {provider}",
    "not_shared": "dùng key “{name}” không còn được chia sẻ cho người đã gán nó",
    "undecryptable": "có key “{name}” không giải mã được — cần nhập lại key",
}


def _unavailable(node: Any, reason: str, row: AiProviderCredential | None = None) -> CredentialUnavailable:
    name = str(getattr(node, "name", "") or getattr(node, "key", "") or "?")
    detail = _REASON_TEXT[reason].format(
        name=getattr(row, "name", "") or "",
        key_provider=provider_label(getattr(row, "provider", "") or ""),
        provider=provider_label(str(getattr(node, "provider", "") or "")),
    )
    return CredentialUnavailable(
        step_key=str(getattr(node, "key", "") or ""),
        step_name=name,
        reason=reason,
        message=f"Bước “{name}” {detail}. Mở AI Keys trong Agent Flow để gán key cho bước này.",
    )


class StoredCredentials:
    """Resolves each step's key from the store. One instance per run.

    Rows and grantor checks are cached for the run; `last_used_at` is stamped once
    per key per run, in its own session so it never commits the run's work.
    """

    def __init__(self, db: Session) -> None:
        self.db = db
        self._rows: dict[int, AiProviderCredential | None] = {}
        self._grants: dict[tuple[int, str], bool] = {}
        self._touched: set[int] = set()

    def _row(self, cid: int) -> AiProviderCredential | None:
        if cid not in self._rows:
            self._rows[cid] = (
                self.db.query(AiProviderCredential).filter(AiProviderCredential.id == cid).first()
            )
        return self._rows[cid]

    def _grantor_may_use(self, row: AiProviderCredential, email: str) -> bool:
        key = (row.id, email.strip().lower())
        if key not in self._grants:
            ok = False
            if email:
                from sqlalchemy import func

                from app.models.user import User

                grantor = (
                    self.db.query(User)
                    .filter(func.lower(User.email) == email.strip().lower())
                    .first()
                )
                ok = bool(grantor is not None and permission(self.db, grantor, row) != "none")
            self._grants[key] = ok
        return self._grants[key]

    def check(self, node: Any) -> tuple[AiProviderCredential | None, str | None]:
        """(row, problem reason or None) without decrypting anything."""
        cid = _cid(getattr(node, "credential_id", None))
        if cid is None:
            return None, "none"
        row = self._row(cid)
        if row is None or row.deleted_at is not None:
            return row, "deleted"
        if row.provider != str(getattr(node, "provider", "") or ""):
            return row, "provider_mismatch"
        if not self._grantor_may_use(row, str(getattr(node, "credential_granted_by", "") or "")):
            return row, "not_shared"
        return row, None

    def for_node(self, node: Any) -> ResolvedCredential:
        row, reason = self.check(node)
        if reason is not None:
            raise _unavailable(node, reason, row)
        secret = _decrypt(row)
        if not secret:
            raise _unavailable(node, "undecryptable", row)
        self._touch(row.id)
        return ResolvedCredential(
            provider=row.provider,
            model=str(getattr(node, "model", "") or ""),
            api_key=secret,
            credential_id=row.id,
            name=row.name,
        )

    def problems(self, flow: Any) -> list[dict[str, str]]:
        """Every model step of `flow` whose key cannot be used, and why."""
        out: list[dict[str, str]] = []
        for node in model_steps(flow):
            row, reason = self.check(node)
            if reason is not None:
                out.append(_unavailable(node, reason, row).as_dict())
        return out

    def _touch(self, cid: int) -> None:
        if cid in self._touched:
            return
        self._touched.add(cid)
        try:
            from app.core.database import SessionLocal

            with SessionLocal() as s:
                s.query(AiProviderCredential).filter(AiProviderCredential.id == cid).update(
                    {AiProviderCredential.last_used_at: _now()}, synchronize_session=False)
                s.commit()
        except Exception:  # noqa: BLE001 — bookkeeping must never fail a run
            logger.debug("[ai-credential] last_used_at not stamped for %s", cid, exc_info=True)


def model_steps(flow: Any) -> list[Any]:
    """Every step of `flow`, anywhere in the tree, that calls a model."""
    return [n for n in flow.all_nodes() if getattr(n, "type", "") in MODEL_NODE_TYPES]


def missing_message(problems: list[dict[str, str]], *, action: str) -> str:
    """The sentence every entrypoint refuses with when a flow lacks usable keys."""
    lines = "".join("\n• " + p["message"] for p in problems[:8])
    return f"Chưa {action} được — có bước chưa có AI key dùng được:{lines}"


def require_usable(db: Session, flow: Any, *, action: str) -> None:
    """Raise 409 naming every model step whose key cannot be used."""
    problems = StoredCredentials(db).problems(flow)
    if problems:
        raise CredentialError(409, missing_message(problems, action=action))


def _register_for_sharing() -> None:
    """A key is shared through the generic `/shares/ai_credential/{id}` endpoints.

    Registered from here, not listed in `core/share_access.py`: core may not import
    a feature's model. `require_share_access` then asks `get_effective_permission`
    — owner or module administrator — exactly as for every other resource.
    """
    from app.core.share_access import register_share_resource
    from app.models.resource_share import ResourceType

    register_share_resource(ResourceType.AI_CREDENTIAL, AiProviderCredential, MODULE, "id")


_register_for_sharing()
