"""AI Chat conversations: the one store, and the one rule that makes sharing safe.

    A STORED ANSWER IS SHOWN ONLY TO SOMEONE WHO MAY READ ITS SOURCES NOW.

A turn records what it showed: the Datasets and fields the Data Core read
(`dataset_ids`, `refs`) and the Knowledge documents an extension cited (`doc_ids`).
Every read of a conversation, by anyone (the owner included), re-derives the
viewer's CURRENT data catalog (EXPLORE relation, reporting purpose, GovernAIScope:
data_core.catalog.discover) and readable documents, and returns a turn in full only
when every source is in them. Anything else is `{question, status, redacted}`. So:

  * sharing a conversation never shares a Dataset or a document;
  * `chat: full` oversight sees every conversation but not what it could not read;
  * a revoked grant hides the owner's own stored answer on the next read.

A turn with no recorded source is shown to the person who asked it only, except an
imported flow_v0 turn whose flow had nothing attached (`footprint_known`).

WHO MAY DO WHAT

  owner  started it: read, ask, rename, choose the extension, delete; share through
         /shares (`chat >= edit`)
  full   `chat: full`: read and delete any conversation (still redacted per viewer)
  edit   shared at edit: read and ask; the turn runs as THE CALLER (their grants,
         quota, ledger rows, and their own share of any bound Flow)
  view   shared at view: read
  none   404, never 403: a conversation id is not an oracle for which ids exist
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.chat_conversation import ChatConversation, ChatTurn
from app.services.chat import envelope as env

MODULE = "chat"


def _register() -> None:
    from app.core.share_access import register_share_resource
    from app.models.resource_share import ResourceType

    register_share_resource(ResourceType.CHAT_CONVERSATION, ChatConversation, MODULE, "id")


_register()


# ── access ───────────────────────────────────────────────────────────────────

def access(db: Session, user: Any, conv: ChatConversation) -> str:
    if str(getattr(conv, "user_id", "")) == str(getattr(user, "id", "")):
        return "owner"
    from app.core.dependencies import _normalize_permissions, _sanitize_permission_level

    if _sanitize_permission_level(_normalize_permissions(user).get(MODULE, "none")) == "none":
        return "none"  # a share never survives losing the module (the router floor says the same)
    from app.core.permissions import is_module_admin

    if is_module_admin(user, MODULE):
        return "full"
    from app.core.resource_shares import get_highest_share_for_resource
    from app.models.resource_share import ResourceType

    share = get_highest_share_for_resource(db, user, ResourceType.CHAT_CONVERSATION, str(conv.id))
    if share is None:
        return "none"
    level = getattr(share.permission, "value", share.permission)
    return "edit" if str(level) == "edit" else "view"


def can_ask(level: str) -> bool:
    return level in ("owner", "edit")


def get(db: Session, user: Any, conversation_id: int) -> tuple[Optional[ChatConversation], str]:
    c = (db.query(ChatConversation)
         .filter(ChatConversation.id == conversation_id, ChatConversation.deleted_at.is_(None)).first())
    if c is None:
        return None, "none"
    level = access(db, user, c)
    return (c, level) if level != "none" else (None, "none")


def list_for(db: Session, user: Any, limit: int = 100) -> list[tuple[ChatConversation, str]]:
    from app.core.permissions import is_module_admin

    q = db.query(ChatConversation).filter(ChatConversation.deleted_at.is_(None))
    if not is_module_admin(user, MODULE):
        from app.core.resource_shares import get_shared_resource_ids_query
        from app.models.resource_share import ResourceType

        shared = get_shared_resource_ids_query(db, user, ResourceType.CHAT_CONVERSATION)
        ids = [int(r[0]) for r in shared.all() if str(r[0]).strip().isdigit()]
        own = ChatConversation.user_id == user.id
        q = q.filter(or_(own, ChatConversation.id.in_(ids)) if ids else own)
    rows = q.order_by(ChatConversation.last_active_at.desc()).limit(limit).all()
    return [(c, access(db, user, c)) for c in rows]


def create(db: Session, user: Any, title: Optional[str] = None,
           extension_flow_key: Optional[str] = None) -> ChatConversation:
    c = ChatConversation(user_id=user.id, title=(title or "").strip()[:255] or None,
                         extension_flow_key=(extension_flow_key or None))
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


class AiChoiceRejected(ValueError):
    pass


def set_ai(db: Session, user: Any, c: ChatConversation, *, provider: Optional[str], model: Optional[str],
           api_key: Optional[str] = None, credential_id: Optional[int] = None) -> None:
    """The key and model THIS conversation runs on (PO 2026-10-28: supplied by the
    person, no server default). A pasted key goes to the encrypted store, owned by
    the person; `credential_id` reuses a key they pasted before (theirs only). The
    key is never returned - only its last characters."""
    from app.core.crypto import encrypt_value
    from app.models.ai_provider_credential import AiProviderCredential
    from app.services.ai_runtime import gateway

    from app.core.crypto import decrypt_value

    model = (model or "").strip()
    typed = (api_key or "").strip()
    if typed:
        provider = (provider or "").strip().lower()
        if provider not in ("openai", "anthropic", "gemini"):
            raise AiChoiceRejected("Nhà cung cấp không hợp lệ.")
        if not model or not gateway.answer_model_ok(provider, model):
            raise AiChoiceRejected(f"Model “{model[:60]}” không dùng được với API key {provider}.")
        try:
            secret_enc = encrypt_value(typed)
        except Exception:  # noqa: BLE001
            secret_enc = ""
        if not str(secret_enc).startswith("_enc:"):
            raise AiChoiceRejected("Máy chủ chưa cấu hình mã hoá nên không lưu được API key.")
        name = f"AI Chat · {provider} · …{typed[-4:]}"
        same = (db.query(AiProviderCredential)
                .filter(AiProviderCredential.owner_id == user.id, AiProviderCredential.deleted_at.is_(None),
                        AiProviderCredential.name.like(name + "%")).all())
        cred = next((r for r in same if _decrypts_to(decrypt_value, r.secret_enc, typed)), None)
        if cred is None:  # the same key pasted again is the same stored key
            cred = AiProviderCredential(name=name if not same else f"{name} ({len(same) + 1})", provider=provider,
                                        secret_enc=secret_enc, key_hint=typed[-4:], owner_id=user.id)
            db.add(cred)
            db.flush()
    elif credential_id:
        cred = db.get(AiProviderCredential, int(credential_id))
        if cred is None or cred.deleted_at is not None or str(cred.owner_id) != str(user.id):
            raise AiChoiceRejected("Chỉ dùng được API key do chính bạn đã dán.")
    else:
        cred = db.get(AiProviderCredential, int(c.ai_credential_id)) if c.ai_credential_id else None
        if cred is None:
            raise AiChoiceRejected("Hãy dán API key cho cuộc trò chuyện này.")
    if not model or not gateway.answer_model_ok(str(cred.provider), model):
        raise AiChoiceRejected(f"Model “{model[:60]}” không dùng được với API key {cred.provider}.")
    c.ai_credential_id = int(cred.id)
    c.ai_model = model


def _decrypts_to(decrypt, secret_enc, typed: str) -> bool:
    try:
        return decrypt(secret_enc) == typed
    except Exception:  # noqa: BLE001
        return False


def ai_view(db: Session, c: ChatConversation) -> dict:
    """What anyone reading the conversation may know about its model: provider, model
    and the key's last characters. Never the key."""
    from app.models.ai_provider_credential import AiProviderCredential

    cred = db.get(AiProviderCredential, int(c.ai_credential_id)) if c.ai_credential_id else None
    live = cred is not None and cred.deleted_at is None
    return {"provider": str(cred.provider) if live else None, "model": c.ai_model if live else None,
            "key_hint": str(cred.key_hint or "")[-4:] if live else None,
            "credential_id": c.ai_credential_id if live else None, "ready": bool(live and c.ai_model)}


def my_chat_keys(db: Session, user: Any) -> list[dict]:
    """Keys this person pasted into AI Chat before, to reuse in a new conversation."""
    from app.models.ai_provider_credential import AiProviderCredential

    rows = (db.query(AiProviderCredential)
            .filter(AiProviderCredential.owner_id == user.id, AiProviderCredential.deleted_at.is_(None),
                    AiProviderCredential.name.like("AI Chat · %"))
            .order_by(AiProviderCredential.id.desc()).limit(20).all())
    return [{"credential_id": r.id, "provider": r.provider, "key_hint": str(r.key_hint or "")[-4:]} for r in rows]


def by_legacy(db: Session, user: Any, kind: str, legacy_id: int) -> Optional[ChatConversation]:
    """An imported conversation by its old id, when this person may read it."""
    c = (db.query(ChatConversation)
         .filter(ChatConversation.legacy_kind == kind, ChatConversation.legacy_id == legacy_id,
                 ChatConversation.deleted_at.is_(None)).first())
    return c if c is not None and access(db, user, c) != "none" else None


# ── what a turn showed, and who may see it ───────────────────────────────────

class ViewerScope:
    """What THIS viewer may read right now: {dataset_id: field refs} from their data
    catalog, and the ids of the Knowledge documents they may open."""

    def __init__(self, datasets: dict[int, set[str]], doc_ids: set[int]):
        self.datasets = datasets
        self.doc_ids = doc_ids

    @classmethod
    def of(cls, db: Session, user: Any, catalog=None) -> "ViewerScope":
        if catalog is None:
            catalog = data_catalog(db, user)
        ds: dict[int, set[str]] = {}
        for c in catalog:
            ds.setdefault(int(c.dataset_id), set()).update(f.ref for f in c.fields)
        return cls(ds, readable_doc_ids(db, user))


def data_catalog(db: Session, user: Any):
    from app.services.data_core.catalog import discover
    from app.services.governed_query import AuthorizationContext, EffectivePrincipal

    return discover(AuthorizationContext(db=db, principal=EffectivePrincipal.for_user(user, surface="chat"),
                                         user=user))


def readable_doc_ids(db: Session, user: Any) -> set[int]:
    from app.core.permissions import _owned_or_shared
    from app.models.governance import GovernKnowledgeDoc
    from app.models.resource_share import ResourceType

    try:
        return {int(r.id) for r in _owned_or_shared(db, GovernKnowledgeDoc, ResourceType.KNOWLEDGE_DOC, user).all()}
    except Exception:  # noqa: BLE001 - no Knowledge module here: nothing is readable
        db.rollback()
        return set()


def _plan_refs(plan: Any) -> set[str]:
    if not isinstance(plan, dict):
        return set()
    refs = {*(plan.get("dimensions") or []), *(plan.get("measures") or []),
            *((plan.get("filters") or {}).keys()), *((plan.get("time_grains") or {}).keys())}
    refs.update(s.get("field") for s in plan.get("sorts") or [] if isinstance(s, dict) and s.get("field"))
    return {str(r) for r in refs if r}


def footprint(envelope: dict, catalog) -> tuple[list[int], list[str], list[int]]:
    """The Datasets, fields and documents an envelope shows, resolved with the
    ASKER's catalog."""
    by_explore = {c.explore_id: int(c.dataset_id) for c in catalog}
    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    ds: set[int] = set()
    ev = data.get("evidence") or {}
    ds.update(int(d) for d in ev.get("datasets") or [] if str(d).lstrip("-").isdigit())
    for explore in (ev.get("explore_id"), (data.get("plan") or {}).get("explore_id")):
        if explore is not None and explore in by_explore:
            ds.add(by_explore[explore])
    ds.update(int(o["dataset_id"]) for o in data.get("sources") or [] if isinstance(o, dict)
              and str(o.get("dataset_id", "")).isdigit())
    docs = {int(d["doc_id"]) for d in ((envelope.get("supporting") or {}).get("documents") or [])
            if isinstance(d, dict) and str(d.get("doc_id", "")).isdigit()}
    return sorted(ds), sorted(_plan_refs(data.get("plan"))), sorted(docs)


def visible(turn: ChatTurn, scope: ViewerScope, viewer_id: Any) -> bool:
    ds = [int(d) for d in turn.dataset_ids or []]
    docs = [int(d) for d in turn.doc_ids or []]
    if not ds and not docs:
        if turn.origin == "flow_v0" and (turn.envelope or {}).get("footprint_known"):
            return True  # imported: its flow had nothing attached, so it read nothing governed
        return viewer_id is not None and str(turn.asked_by) == str(viewer_id)
    if any(d not in scope.datasets for d in ds) or any(d not in scope.doc_ids for d in docs):
        return False
    allowed = set().union(*(scope.datasets[d] for d in ds)) if ds else set()
    refs = list(turn.refs or [])
    return all(r in allowed for r in refs) if refs else True


def turn_view(turn: ChatTurn, scope: ViewerScope, viewer_id: Any) -> dict:
    base = {"seq": turn.seq, "turn_id": turn.turn_id, "question": turn.question, "status": turn.status,
            "origin": turn.origin, "asked_at": turn.created_at.isoformat() if turn.created_at else None,
            "asked_by_me": str(turn.asked_by) == str(viewer_id)}
    if turn.status == "running":
        return {**base, "envelope": None, "redacted": False, "redacted_reason": None}
    if visible(turn, scope, viewer_id):
        return {**base, "envelope": env.normalize(turn.envelope, turn.status), "redacted": False,
                "redacted_reason": None}
    reason = "source_access" if (turn.dataset_ids or turn.doc_ids) else "asker_only"
    return {**base, "envelope": None, "redacted": True, "redacted_reason": reason}


def conversation_view(db: Session, user: Any, c: ChatConversation, level: str, scope: Optional[ViewerScope],
                      with_turns: bool = True) -> dict:
    out = {"id": c.id, "title": c.title, "access": level, "can_ask": can_ask(level),
           "is_owner": level == "owner", "extension_flow_key": c.extension_flow_key,
           "created_at": c.created_at.isoformat() if c.created_at else None,
           "last_active_at": c.last_active_at.isoformat() if c.last_active_at else None,
           "ai": ai_view(db, c)}
    if with_turns:
        expire_stale(db, c.id)
        turns = db.query(ChatTurn).filter(ChatTurn.conversation_id == c.id).order_by(ChatTurn.seq).all()
        out["turns"] = [turn_view(t, scope, user.id) for t in turns]
    return out


def expire_stale(db: Session, conversation_id: int) -> None:
    """A turn still `running` long after any turn could (its worker died) is
    `failed/interrupted`, so a reload never shows a spinner forever."""
    from app.core.config import settings

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=int(settings.AI_CHAT_TURN_STALE_SECONDS))
    stale = (db.query(ChatTurn).filter(ChatTurn.conversation_id == conversation_id, ChatTurn.status == "running",
                                       ChatTurn.created_at < cutoff).all())
    for t in stale:
        finish(db, t, env.failed("interrupted", "Câu hỏi bị gián đoạn trước khi có câu trả lời; hãy hỏi lại."),
               [], [], [])


def previous_plan(db: Session, c: ChatConversation, scope: ViewerScope, viewer_id: Any,
                  since_seq: int = 0) -> Optional[dict]:
    """The plan of the last answered turn the CALLER may read in full: a follow-up
    never builds on an answer the caller could not see. Server state, never the
    browser's."""
    turns = (db.query(ChatTurn)
             .filter(ChatTurn.conversation_id == c.id, ChatTurn.status == "answered", ChatTurn.seq > since_seq)
             .order_by(ChatTurn.seq.desc()).limit(20).all())
    for t in turns:
        data = env.normalize(t.envelope, t.status).get("data") or {}
        plan = data.get("plan")
        if isinstance(plan, dict) and visible(t, scope, viewer_id):
            return plan
    return None


def finish(db: Session, turn: ChatTurn, envelope: dict, dataset_ids: list, refs: list, doc_ids: list,
           usage: Optional[dict] = None) -> bool:
    """Move a running turn to its terminal state. Conditional on `running`, so a
    turn is finished exactly once (cancel and answer cannot both win). True when
    THIS call finished it."""
    now = datetime.now(timezone.utc)
    n = (db.query(ChatTurn).filter(ChatTurn.id == turn.id, ChatTurn.status == "running")
         .update({ChatTurn.status: envelope["status"], ChatTurn.envelope: envelope,
                  ChatTurn.dataset_ids: dataset_ids, ChatTurn.refs: refs, ChatTurn.doc_ids: doc_ids,
                  ChatTurn.usage: usage or {}, ChatTurn.completed_at: now}, synchronize_session=False))
    db.query(ChatConversation).filter(ChatConversation.id == turn.conversation_id).update(
        {ChatConversation.last_active_at: now}, synchronize_session=False)
    db.commit()
    return n == 1
