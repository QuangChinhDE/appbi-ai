"""Store, read, publish and roll back flows. No execution, no HTTP.

ONE OPEN DRAFT, NOT ONE VERSION PER SAVE
----------------------------------------
This used to write a NEW VERSION on every save. Editing a prompt twenty times left
twenty rows, the version list became unreadable, and the number in the builder's
title bar changed while the author was still typing. A draft is now UPSERTED: saving
an open draft edits it, and a new version is cut only when the newest version is
already published. Publishing is still the only act that changes what viewers get.

PUBLISHING IS NOW CHECKED AGAINST EVERY LINK
--------------------------------------------
A flow serves many links, and once flows declare REQUIREMENTS a new version can be
incompatible with a link that has not been re-mapped. So `publish` runs the binding
preflight for each active binding and, rather than breaking them, PINS the ones that
would break to the version they are already running. The author is told which and
why. Without that, nobody would dare edit a flow that anything depends on.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.agent_brain import AgentBrainVersion
from app.services.agent_flows.contract import Flow, upgrade_body
from app.services.agent_flows.permissions import check_attachments, share_disclosure

logger = logging.getLogger(__name__)

DRAFT = "draft"
PUBLISHED = "published"
ARCHIVED = "archived"


class BrainError(Exception):
    """A failure with an HTTP status already decided, so the API layer stays thin."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc)


def parse_flow(row: AgentBrainVersion) -> Flow | None:
    """The stored body as a Flow, upgrading a v1 body on the way through."""
    try:
        body = upgrade_body(row.body or {}, key=row.brain_key, name=row.name)
        return Flow.model_validate(body)
    except Exception:  # noqa: BLE001
        logger.warning("[flow] %s v%s will not parse", row.brain_key, row.version)
        return None


def _assign_flow_id(db: Session, row: AgentBrainVersion) -> None:
    """Give a new version row its flow's number: the key's existing one, or its own id.

    Called with the row added but not committed. The flush is what turns an id
    into a real number — without it the first version of a brand-new flow would
    be handed `None` and become unaddressable by link until its next save.
    """
    existing = (
        db.query(AgentBrainVersion.flow_id)
        .filter(
            AgentBrainVersion.brain_key == row.brain_key,
            AgentBrainVersion.flow_id.isnot(None),
        )
        .order_by(AgentBrainVersion.flow_id)
        .first()
    )
    if existing and existing[0]:
        row.flow_id = int(existing[0])
        return
    db.flush()
    row.flow_id = row.id


def flow_id_to_key(db: Session, flow_id: int) -> str | None:
    """The `brain_key` a link's number refers to, or None.

    Resolution happens here and nowhere else: every other function in this module
    — and every permission check — still takes a key, so the number never becomes
    a second identity the rest of the system has to agree about.
    """
    row = (
        db.query(AgentBrainVersion.brain_key)
        .filter(AgentBrainVersion.flow_id == flow_id)
        .first()
    )
    return row[0] if row else None


def _row_dict(row: AgentBrainVersion, *, include_body: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "brain_key": row.brain_key,
        # What a link carries. Callers keep using brain_key for every request.
        "flow_id": row.flow_id,
        "version": row.version,
        "status": row.status,
        "name": row.name,
        "description": row.description or "",
        "owner_email": row.owner_email,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "published_at": row.published_at.isoformat() if row.published_at else None,
    }
    if include_body:
        upgraded = upgrade_body(row.body or {}, key=row.brain_key, name=row.name)
        out["body"] = _redact_credentials(upgraded)
        flow = parse_flow(row)
        if flow is None:
            # A stored flow too broken to parse is still one an author must be able
            # to open and repair; refusing to return it would make it unreachable.
            out["warnings"] = ["Không đọc được cấu hình flow này."]
            out["reads"] = []
            out["node_count"] = 0
            out["requirements"] = {"items": [], "capabilities": []}
        else:
            out["warnings"] = flow.warnings()
            out["reads"] = share_disclosure(flow)
            out["node_count"] = len(flow.all_nodes())
            out["requirements"] = flow.requirements.model_dump(mode="json")
            out["answer_node"] = flow.answering_key()
    return out


def _redact_credentials(body: dict[str, Any]) -> dict[str, Any]:
    """The body as the API may emit it: no key material, in any form.

    Ciphertext is not the secret, but shipping it makes the flow's JSON worth
    stealing and it would ride along in an export file. Each agent node reports
    `has_api_key` instead, and the builder renders that as "đã lưu".

    Walks the TREE, not a flat list — a credential on an agent inside a loop inside
    a branch is exactly as sensitive as one at the top level, and the old flat pass
    would have emitted it.
    """
    if not isinstance(body, dict):
        return {}

    def clean_nodes(nodes: Any) -> Any:
        if not isinstance(nodes, list):
            return nodes
        out: list[Any] = []
        for node in nodes:
            if not isinstance(node, dict):
                out.append(node)
                continue
            n = dict(node)
            if n.get("type", "agent") == "agent":
                n["has_api_key"] = bool(n.get("api_key_enc"))
            n.pop("api_key_enc", None)
            n.pop("api_key", None)
            n.pop("api_key_clear", None)
            if isinstance(n.get("body"), list):
                n["body"] = clean_nodes(n["body"])
            if isinstance(n.get("fallback"), list):
                n["fallback"] = clean_nodes(n["fallback"])
            for group in ("paths", "cases"):
                if isinstance(n.get(group), list):
                    n[group] = [
                        {**p, "body": clean_nodes(p.get("body"))}
                        if isinstance(p, dict) else p
                        for p in n[group]
                    ]
            out.append(n)
        return out

    out = dict(body)
    out["nodes"] = clean_nodes(out.get("nodes"))
    return out


def _carry_credentials(db: Session, brain_key: str, body: dict[str, Any]) -> dict[str, Any]:
    """Fold each agent node's credential into the shape that gets stored.

      api_key_clear → drop it
      api_key (new) → encrypt it
      neither       → CARRY FORWARD what the same node key had before

    The carry-forward is the whole reason this exists. The builder is never sent the
    stored key, so it cannot send it back; without carrying, every ordinary save —
    renaming a node, editing a prompt — would wipe every credential and the flow
    would start failing with nothing in the diff to explain it.
    """
    from app.core.crypto import encrypt_value

    previous: dict[str, str] = {}
    prior = (
        db.query(AgentBrainVersion)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .order_by(AgentBrainVersion.version.desc())
        .first()
    )
    if prior is not None and isinstance(prior.body, dict):
        for node in _walk_raw(upgrade_body(prior.body).get("nodes") or []):
            if node.get("api_key_enc"):
                previous[str(node.get("key"))] = str(node["api_key_enc"])

    def fold(nodes: Any) -> Any:
        if not isinstance(nodes, list):
            return nodes
        out: list[Any] = []
        for node in nodes:
            if not isinstance(node, dict):
                out.append(node)
                continue
            n = dict(node)
            n.pop("has_api_key", None)
            fresh = str(n.pop("api_key", "") or "").strip()
            clear = bool(n.pop("api_key_clear", False))
            if n.get("type", "agent") == "agent":
                if clear:
                    n["api_key_enc"] = ""
                elif fresh:
                    n["api_key_enc"] = encrypt_value(fresh)
                elif not n.get("api_key_enc"):
                    n["api_key_enc"] = previous.get(str(n.get("key")), "")
            if isinstance(n.get("body"), list):
                n["body"] = fold(n["body"])
            if isinstance(n.get("fallback"), list):
                n["fallback"] = fold(n["fallback"])
            for group in ("paths", "cases"):
                if isinstance(n.get(group), list):
                    n[group] = [
                        {**p, "body": fold(p.get("body"))} if isinstance(p, dict) else p
                        for p in n[group]
                    ]
            out.append(n)
        return out

    out = dict(body)
    out["nodes"] = fold(out.get("nodes"))
    return out


def _walk_raw(nodes: Any) -> list[dict]:
    """Every node dict in a raw (unvalidated) tree."""
    found: list[dict] = []
    if not isinstance(nodes, list):
        return found
    for n in nodes:
        if not isinstance(n, dict):
            continue
        found.append(n)
        found.extend(_walk_raw(n.get("body")))
        found.extend(_walk_raw(n.get("fallback")))
        for group in ("paths", "cases"):
            for p in n.get(group) or []:
                if isinstance(p, dict):
                    found.extend(_walk_raw(p.get("body")))
    return found


# ═══ Reading ══════════════════════════════════════════════════════════════════
def list_brains(db: Session, user: Any) -> list[dict[str, Any]]:
    """Every flow this user may use, newest version of each first."""
    from app.services.agent_flows.permissions import usable_brains

    rows = usable_brains(db, user).order_by(
        AgentBrainVersion.brain_key, AgentBrainVersion.version.desc()
    ).all()
    counts = _link_counts(db)
    out: list[dict[str, Any]] = []
    for r in rows:
        item = _row_dict(r, include_body=False)
        item["node_count"] = _shallow_node_count(r)
        item["link_count"] = counts.get(r.brain_key, 0)
        out.append(item)
    return out


def _shallow_node_count(row: AgentBrainVersion) -> int:
    """How many nodes, without validating the body — a flow too broken to parse must
    still show a plausible size rather than 0."""
    body = upgrade_body(row.body if isinstance(row.body, dict) else {})
    return len(_walk_raw(body.get("nodes")))


def _link_counts(db: Session) -> dict[str, int]:
    """brain_key → how many links are bound to it.

    One grouped query. This used to load EVERY active public link and parse its
    appearance JSON, for every row of the list.
    """
    from app.models.agent_flow_binding import AgentFlowBinding

    try:
        rows = (
            db.query(AgentFlowBinding.brain_key, func.count(AgentFlowBinding.id))
            .group_by(AgentFlowBinding.brain_key)
            .all()
        )
        return {k: int(c) for k, c in rows}
    except Exception:  # noqa: BLE001
        logger.exception("[flow] link tally failed")
        return {}


def get_brain(db: Session, brain_key: str, version: int | None = None) -> dict[str, Any]:
    """One version. `version=None` means the open draft, else the published one."""
    q = db.query(AgentBrainVersion).filter(AgentBrainVersion.brain_key == brain_key)
    if version is not None:
        row = q.filter(AgentBrainVersion.version == version).first()
    else:
        # The DRAFT first, because opening a flow means opening what you are editing.
        # Falling back to published matched the old save-every-time model, where a
        # draft was whatever you saved last.
        row = (
            q.filter(AgentBrainVersion.status == DRAFT)
            .order_by(AgentBrainVersion.version.desc())
            .first()
            or q.filter(AgentBrainVersion.status == PUBLISHED).first()
            or q.order_by(AgentBrainVersion.version.desc()).first()
        )
    if row is None:
        raise BrainError(404, "Không tìm thấy flow")
    out = _row_dict(row)
    published = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.status == PUBLISHED,
        )
        .first()
    )
    # The title bar says "Nháp v6 · Published v5 · 3 links" — three facts that used
    # to need three round trips.
    out["published_version"] = published.version if published else None
    out["link_count"] = _link_counts(db).get(brain_key, 0)
    return out


def resolve_published(db: Session, brain_key: str) -> tuple[AgentBrainVersion, Flow] | None:
    """What a live link runs. Returns None rather than falling back to a draft.

    Deliberately no fallback. The previous module answered with a system default when
    a link's flow was missing, so an operator saw a configured link quietly running
    logic nobody had approved.
    """
    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.status == PUBLISHED,
        )
        .first()
    )
    if row is None:
        return None
    flow = parse_flow(row)
    return (row, flow) if flow else None


def resolve_version(
    db: Session, brain_key: str, version: int | None
) -> tuple[AgentBrainVersion, Flow] | None:
    """A pinned version if the binding names one, otherwise the published one."""
    if version is None:
        return resolve_published(db, brain_key)
    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == version,
        )
        .first()
    )
    if row is None:
        return None
    flow = parse_flow(row)
    return (row, flow) if flow else None


# ═══ Writing ══════════════════════════════════════════════════════════════════
def save_draft(
    db: Session,
    user: Any,
    *,
    brain_key: str,
    name: str,
    description: str,
    body: dict,
    actor_email: str,
) -> dict[str, Any]:
    """Validate, check what it may attach, then UPSERT the open draft."""
    body = upgrade_body(body, key=brain_key, name=name)
    # Credentials are folded BEFORE validation, so the contract validates the node
    # that will actually be stored — including `_credential_is_usable`, which must
    # see a carried-forward key the request never mentioned.
    body = _carry_credentials(db, brain_key, body)

    try:
        flow = Flow.model_validate({**body, "key": brain_key, "name": name})
    except Exception as exc:  # noqa: BLE001
        raise BrainError(422, _first_message(exc))

    problems = check_attachments(db, user, flow)
    if problems:
        raise BrainError(403, " ".join(problems))

    latest = (
        db.query(AgentBrainVersion)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .order_by(AgentBrainVersion.version.desc())
        .first()
    )
    existing_owner = latest.owner_email if latest is not None else None
    # Captured BEFORE the row is mutated: the activity summary diffs against what
    # was there a moment ago, and once `row.body` is reassigned the "before" is gone.
    # The base is the previous version whether this save edits the open draft or cuts
    # a new one — reading None for a new version made every post-publish edit report
    # itself as "flow created".
    previous_body = latest.body if latest is not None else None

    if latest is not None and latest.status == DRAFT:
        # Editing the version already open. This is the ordinary case, and making it
        # an UPDATE is what stopped the version list growing by one per keystroke.
        row = latest
        row.name = name
        row.description = description or ""
        row.body = flow.to_dict()
        row.created_by = actor_email
        action = "updated"
    else:
        row = AgentBrainVersion(
            brain_key=brain_key,
            version=(latest.version if latest else 0) + 1,
            status=DRAFT,
            name=name,
            description=description or "",
            body=flow.to_dict(),
            # Set ONCE, on the first version. Ownership is whose reading rights every
            # run carries, so letting a co-editor's save re-point it would change what
            # the flow can read without anybody choosing that.
            owner_email=existing_owner or actor_email,
            created_by=actor_email,
        )
        db.add(row)
        _assign_flow_id(db, row)
        action = "created"

    db.commit()
    db.refresh(row)
    _audit(
        db, "AGENT_FLOW_SAVED", brain_key, actor_email,
        {"version": row.version, "action": action,
         "summary": _summarise(previous_body, flow.to_dict())},
    )
    return _row_dict(row)


def publish(
    db: Session, brain_key: str, version: int, actor_email: str, *, pin_incompatible: bool = True
) -> dict[str, Any]:
    """Make one version live, pinning the links it would break.

    Validated again here rather than trusting the save: this is the moment it starts
    answering viewers, and the contract may have gained a rule since the draft was
    written.
    """
    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == version,
        )
        .first()
    )
    if row is None:
        raise BrainError(404, "Không tìm thấy phiên bản này")

    flow = parse_flow(row)
    if flow is None:
        raise BrainError(422, "Không phát hành được: cấu hình flow không hợp lệ")

    previous = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.status == PUBLISHED,
        )
        .first()
    )
    pinned = _pin_incompatible(db, flow, previous, enabled=pin_incompatible)

    db.query(AgentBrainVersion).filter(
        AgentBrainVersion.brain_key == brain_key,
        AgentBrainVersion.status == PUBLISHED,
        AgentBrainVersion.version != version,
    ).update({"status": ARCHIVED}, synchronize_session=False)

    row.status = PUBLISHED
    row.published_at = _now()
    db.commit()
    db.refresh(row)
    logger.info("[flow] %s v%s published by %s", brain_key, version, actor_email)
    _audit(
        db, "AGENT_FLOW_PUBLISHED", brain_key, actor_email,
        {"version": version, "pinned_links": pinned},
    )
    out = _row_dict(row)
    out["pinned_links"] = pinned
    return out


def _pin_incompatible(
    db: Session, flow: Flow, previous: AgentBrainVersion | None, *, enabled: bool
) -> list[dict[str, Any]]:
    """Freeze links the new version would break, at the version they already run.

    This is what makes publishing safe when one flow serves many dashboards. Without
    it a new requirement takes down every link that has not been re-mapped, so the
    rational move is never to edit a flow anyone uses — and then the module is a
    museum.
    """
    if not enabled or previous is None:
        return []
    from app.models.agent_flow_binding import AgentFlowBinding
    from app.models.models import Dashboard
    from app.models.models import DashboardPublicLink
    from app.services.agent_flows import binding as binding_service

    pinned: list[dict[str, Any]] = []
    rows = (
        db.query(AgentFlowBinding, DashboardPublicLink)
        .join(DashboardPublicLink, DashboardPublicLink.id == AgentFlowBinding.link_id)
        .filter(
            AgentFlowBinding.brain_key == flow.key,
            AgentFlowBinding.pinned_version.is_(None),
        )
        .all()
    )
    for bind, link in rows:
        dashboard = db.query(Dashboard).filter(Dashboard.id == link.dashboard_id).first()
        if dashboard is None:
            continue
        reasons: list[str] = []
        if bind.status == "needs_review":
            # A migrated binding has never had its scope declared. Handing it a NEW
            # version is exactly what the review is for.
            reasons.append("link chưa được review phạm vi dữ liệu")
        else:
            result = binding_service.preflight(
                db,
                flow=flow,
                contract=binding_service.contract_of(bind),
                dashboard=dashboard,
                link=link,
            )
            reasons = [e["message"] for e in result["errors"]]
        if reasons:
            bind.pinned_version = previous.version
            pinned.append({
                "binding_id": bind.id,
                "link_id": link.id,
                "link_name": link.name,
                "pinned_to": previous.version,
                "reasons": reasons,
            })
    return pinned


def rollback(db: Session, brain_key: str, actor_email: str) -> dict[str, Any]:
    """Re-publish the most recent previously-published version."""
    prev = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.status == ARCHIVED,
            AgentBrainVersion.published_at.isnot(None),
        )
        .order_by(AgentBrainVersion.published_at.desc())
        .first()
    )
    if prev is None:
        raise BrainError(409, "Chưa có phiên bản nào từng phát hành để quay lại")
    out = publish(db, brain_key, prev.version, actor_email, pin_incompatible=False)
    _audit(db, "AGENT_FLOW_ROLLED_BACK", brain_key, actor_email, {"version": prev.version})
    return out


def restore_to_draft(
    db: Session, brain_key: str, version: int, actor_email: str
) -> dict[str, Any]:
    """Load an old version's body into the OPEN DRAFT.

    Different from `rollback`, and the difference matters: rollback re-publishes an
    old version to viewers; this puts it back on the author's canvas to work from,
    changing nothing that is live. The version list's "Nạp lại" button is this one.
    """
    source = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == version,
        )
        .first()
    )
    if source is None:
        raise BrainError(404, "Không tìm thấy phiên bản này")

    latest = (
        db.query(AgentBrainVersion)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .order_by(AgentBrainVersion.version.desc())
        .first()
    )
    body = upgrade_body(source.body or {}, key=brain_key, name=source.name)
    if latest is not None and latest.status == DRAFT:
        row = latest
        row.body = body
        row.name = source.name
        row.description = source.description or ""
        row.created_by = actor_email
    else:
        row = AgentBrainVersion(
            brain_key=brain_key,
            version=(latest.version if latest else 0) + 1,
            status=DRAFT,
            name=source.name,
            description=source.description or "",
            body=body,
            owner_email=latest.owner_email if latest else actor_email,
            created_by=actor_email,
        )
        db.add(row)
        _assign_flow_id(db, row)
    db.commit()
    db.refresh(row)
    _audit(
        db, "AGENT_FLOW_RESTORED", brain_key, actor_email,
        {"from_version": version, "into_version": row.version},
    )
    return _row_dict(row)


def delete_version(db: Session, brain_key: str, version: int, actor_email: str = "") -> None:
    """Remove a draft. A published version is refused — deleting what is answering
    viewers right now should be an explicit unpublish, not a delete."""
    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == version,
        )
        .first()
    )
    if row is None:
        raise BrainError(404, "Không tìm thấy phiên bản này")
    if row.status == PUBLISHED:
        raise BrainError(409, "Phiên bản đang phát hành — hãy phát hành bản khác trước")

    # A DELETE MAY NOT LEAVE A LINK POINTING AT NOTHING.
    #
    # This checked only the row it was removing. Deleting the LAST version of a
    # flow therefore made the flow cease to exist while every binding naming it
    # stayed behind, and nothing anywhere said so: the link kept its bot, the
    # dispatcher answered `not_published` on each question, and the author who
    # deleted the version was never the person who found out. One such binding is
    # in this deployment right now, pointing at a `brain_key` with zero versions.
    #
    # Refused rather than cascaded. Deleting somebody's binding as a side effect
    # of tidying a draft is a bigger surprise than being told to unassign it
    # first, and `impact()` already exists to show exactly who is affected.
    from app.services.agent_flows import binding as binding_service

    users = binding_service.list_for_flow(db, brain_key)
    if users:
        pinned = [u for u in users if u.get("pinned_version") == version]
        if pinned:
            names = ", ".join(str(u["link_name"] or u["link_id"]) for u in pinned[:3])
            raise BrainError(
                409,
                f"{len(pinned)} link đang ghim đúng phiên bản v{version} ({names}"
                f"{'…' if len(pinned) > 3 else ''}). Hãy đổi hoặc bỏ ghim trước khi xoá.",
            )
        remaining = (
            db.query(AgentBrainVersion)
            .filter(
                AgentBrainVersion.brain_key == brain_key,
                AgentBrainVersion.version != version,
            )
            .count()
        )
        if remaining == 0:
            names = ", ".join(str(u["link_name"] or u["link_id"]) for u in users[:3])
            raise BrainError(
                409,
                f"Đây là phiên bản cuối cùng của flow, mà {len(users)} link vẫn đang "
                f"dùng nó ({names}{'…' if len(users) > 3 else ''}). Hãy gỡ flow khỏi "
                f"các link đó trước — xoá bây giờ sẽ để lại link trỏ vào chỗ trống.",
            )

    db.delete(row)
    db.commit()
    _audit(db, "AGENT_FLOW_DELETED", brain_key, actor_email, {"version": version})


def has_any_version(db: Session, brain_key: str) -> bool:
    """Does this flow exist at all?

    Distinct from "is anything published". A flow with drafts but no published
    version is between states; a flow with no rows has been deleted, and a binding
    naming it can never resolve again. The two need opposite handling, so the
    caller has to be able to tell them apart.
    """
    return (
        db.query(AgentBrainVersion.id)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .first()
        is not None
    )


def impact(db: Session, brain_key: str) -> dict[str, Any]:
    """Which links this flow serves, and whether each one is healthy.

    Read before Publish, because one edit changes every link pointing here.
    """
    from app.services.agent_flows import binding as binding_service

    links = binding_service.list_for_flow(db, brain_key)
    return {
        "links": links,
        "count": len(links),
        "broken": sum(1 for x in links if x["status"] == "broken"),
        "needs_review": sum(1 for x in links if x["status"] == "needs_review"),
    }


# ═══ Activity ═════════════════════════════════════════════════════════════════
def _audit(
    db: Session, action_name: str, brain_key: str, actor_email: str, details: dict
) -> None:
    """Best-effort trail. Never fails the operation it is describing."""
    try:
        from app.models.audit_log import AuditAction
        from app.services.audit_service import audit as write_audit

        write_audit(
            db,
            getattr(AuditAction, action_name),
            resource_type="agent_flow",
            resource_id=brain_key,
            details={**details, "actor": actor_email},
        )
    except Exception:  # noqa: BLE001
        logger.warning("[flow] audit write failed for %s", brain_key, exc_info=True)


def activity(db: Session, brain_key: str, limit: int = 100) -> dict[str, Any]:
    """Who changed what, in the order it happened."""
    from app.models.audit_log import AuditLog

    rows = (
        db.query(AuditLog)
        .filter(AuditLog.resource_type == "agent_flow", AuditLog.resource_id == brain_key)
        .order_by(AuditLog.timestamp.desc())
        .limit(limit)
        .all()
    )
    return {
        "events": [
            {
                "at": r.timestamp.isoformat() if r.timestamp else None,
                "action": r.action.value if hasattr(r.action, "value") else str(r.action),
                "actor": (r.details or {}).get("actor"),
                "version": (r.details or {}).get("version"),
                "summary": (r.details or {}).get("summary") or "",
                "details": r.details or {},
            }
            for r in rows
        ]
    }


def _summarise(old_body: Any, new_body: dict) -> str:
    """A human sentence describing what changed between two bodies.

    Generated by diffing the node trees, because "Flow changed" on every row of an
    activity feed is the same as no activity feed.
    """
    def keys(body: Any) -> dict[str, str]:
        if not isinstance(body, dict):
            return {}
        return {
            str(n.get("key")): str(n.get("type") or "agent")
            for n in _walk_raw(upgrade_body(body).get("nodes"))
        }

    before, after = keys(old_body), keys(new_body)
    if not before:
        return f"Tạo flow với {len(after)} bước."
    added = [k for k in after if k not in before]
    removed = [k for k in before if k not in after]
    parts: list[str] = []
    if added:
        parts.append(f"thêm {len(added)} bước ({', '.join(added[:3])})")
    if removed:
        parts.append(f"bỏ {len(removed)} bước ({', '.join(removed[:3])})")
    if not parts:
        return "Chỉnh sửa cấu hình các bước."
    return "Đã " + " và ".join(parts) + "."


def _first_message(exc: Exception) -> str:
    """Pydantic's repr is several lines of type noise; an author needs the sentence."""
    text = str(exc)
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("Value error, "):
            return line[len("Value error, "):]
    return text.splitlines()[-1][:200] if text else "Cấu hình không hợp lệ"
