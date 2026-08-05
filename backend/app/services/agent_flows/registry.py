"""Store, read, publish and roll back brains. No execution, no HTTP.

DRAFT / PUBLISHED, NOT EDIT-IN-PLACE
------------------------------------
A brain answers live public links, and one brain can be the head of many. So
saving never changes what is running: it writes a new draft. Publishing is the
only act that changes what a viewer gets, and it demotes the previous version in
the same transaction so there is never a moment with two published rows or none.

`impact()` exists because reuse makes it necessary. Editing a brain used by five
links changes five links, and "who is affected" has to be answerable before the
author presses Publish, not discovered afterwards.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.agent_brain import AgentBrainVersion
from app.services.agent_flows.contract import Brain
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


def _row_dict(row: AgentBrainVersion, *, include_body: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "brain_key": row.brain_key,
        "version": row.version,
        "status": row.status,
        "name": row.name,
        "description": row.description or "",
        "owner_email": row.owner_email,
        "created_by": row.created_by,
        "is_builtin": bool(row.is_builtin),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "published_at": row.published_at.isoformat() if row.published_at else None,
    }
    if include_body:
        out["body"] = _redact_credentials(row.body or {})
        try:
            brain = Brain.model_validate(row.body or {})
        except Exception:  # noqa: BLE001
            # A stored brain too broken to parse is still one an author must be able
            # to open and repair; refusing to list it would make it unreachable.
            out["warnings"] = ["Không đọc được cấu hình bộ não này."]
            out["reads"] = []
            out["step_count"] = 0
        else:
            out["warnings"] = brain.warnings()
            out["reads"] = share_disclosure(brain)
            out["step_count"] = len(brain.steps)
    return out


def _redact_credentials(body: dict[str, Any]) -> dict[str, Any]:
    """The body as the API is allowed to emit it: no key material, in any form.

    Ciphertext is not the secret, but shipping it makes the brain's JSON a thing
    worth stealing and it would ride along in an export file. So each step reports
    `has_api_key` and nothing else, and the builder renders that as "đã lưu".

    Copied, not mutated: `row.body` is the live SQLAlchemy attribute, and stripping
    fields off it in place would write the redaction back to the database on the next
    flush.
    """
    if not isinstance(body, dict):
        return {}
    out = dict(body)
    steps = out.get("steps")
    if not isinstance(steps, list):
        return out
    clean: list[Any] = []
    for step in steps:
        if not isinstance(step, dict):
            clean.append(step)
            continue
        s = dict(step)
        s["has_api_key"] = bool(s.get("api_key_enc"))
        s.pop("api_key_enc", None)
        s.pop("api_key", None)
        s.pop("api_key_clear", None)
        clean.append(s)
    out["steps"] = clean
    return out


def _carry_credentials(db: Session, brain_key: str, body: dict[str, Any]) -> dict[str, Any]:
    """Fold each step's credential into the shape that gets stored.

    Three inputs, one output, and the order matters:

      api_key_clear   → drop the key
      api_key (new)   → encrypt it
      neither         → CARRY FORWARD the key the same step key had in the previous
                        version

    The carry-forward is the whole reason this function exists. The builder is never
    sent the stored key, so it cannot send it back; without carrying, every ordinary
    save — renaming a step, editing a prompt — would wipe every step's credential and
    the brain would start failing on the next question with nothing in the diff to
    explain it.
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
        for step in prior.body.get("steps") or []:
            if isinstance(step, dict) and step.get("api_key_enc"):
                previous[str(step.get("key"))] = str(step["api_key_enc"])

    out = dict(body)
    steps = out.get("steps")
    if not isinstance(steps, list):
        return out

    folded: list[Any] = []
    for step in steps:
        if not isinstance(step, dict):
            folded.append(step)
            continue
        s = dict(step)
        s.pop("has_api_key", None)
        fresh = str(s.pop("api_key", "") or "").strip()
        clear = bool(s.pop("api_key_clear", False))
        if clear:
            s["api_key_enc"] = ""
        elif fresh:
            s["api_key_enc"] = encrypt_value(fresh)
        elif not s.get("api_key_enc"):
            s["api_key_enc"] = previous.get(str(s.get("key")), "")
        folded.append(s)
    out["steps"] = folded
    return out


def list_brains(db: Session, user: Any) -> list[dict[str, Any]]:
    """Every brain this user may use, newest version of each first.

    Filtered through the share mechanism, so the list is exactly what they may put
    on a link — the same set `usable_brains` returns, because two notions of
    "which brains are mine" would eventually disagree.

    Carries `step_count` and `link_count` because a list row that shows only a name
    and a status makes every brain look alike: the two things an author actually
    scans for are how big it is and whether anything is running it. Both are cheap —
    the step count reads the body already loaded, and the link counts are ONE pass
    over active links for the whole list rather than a per-row `impact()` call.
    """
    from app.services.agent_flows.permissions import usable_brains

    rows = usable_brains(db, user).order_by(
        AgentBrainVersion.brain_key, AgentBrainVersion.version.desc()
    ).all()
    counts = _link_counts(db)
    out: list[dict[str, Any]] = []
    for r in rows:
        item = _row_dict(r, include_body=False)
        item["step_count"] = _shallow_step_count(r)
        item["link_count"] = counts.get(r.brain_key, 0)
        out.append(item)
    return out


def _shallow_step_count(row: AgentBrainVersion) -> int:
    """How many steps, without validating the body.

    Deliberately not `Brain.model_validate(...)` — this runs once per row, and a
    brain too broken to parse must still show a plausible size rather than 0, or
    the list makes a repairable brain look empty.
    """
    body = row.body if isinstance(row.body, dict) else {}
    steps = body.get("steps")
    return len(steps) if isinstance(steps, list) else 0


def _link_counts(db: Session) -> dict[str, int]:
    """brain_key → how many active public links point at it.

    One query for the whole list. `impact()` answers the same question for a single
    brain and returns the links themselves; this returns only the tally, because a
    list row needs the number and loading every link's detail per row would make
    opening the list O(brains × links).
    """
    from app.models.models import DashboardPublicLink

    tally: dict[str, int] = {}
    try:
        rows = db.query(DashboardPublicLink).filter(
            DashboardPublicLink.is_active.is_(True)
        ).all()
    except Exception:  # noqa: BLE001
        logger.exception("[brain] link tally failed")
        return tally
    for link in rows:
        cfg = link.appearance_config or {}
        if not isinstance(cfg, dict):
            continue
        key = (cfg.get("ai_bot_flow_key") or "").strip()
        if key:
            tally[key] = tally.get(key, 0) + 1
    return tally


def get_brain(db: Session, brain_key: str, version: int | None = None) -> dict[str, Any]:
    """One version. `version=None` means the published one, or the latest draft."""
    q = db.query(AgentBrainVersion).filter(AgentBrainVersion.brain_key == brain_key)
    if version is not None:
        row = q.filter(AgentBrainVersion.version == version).first()
    else:
        row = (
            q.filter(AgentBrainVersion.status == PUBLISHED).first()
            or q.order_by(AgentBrainVersion.version.desc()).first()
        )
    if row is None:
        raise BrainError(404, "Không tìm thấy bộ não")
    return _row_dict(row)


def resolve_published(db: Session, brain_key: str) -> tuple[AgentBrainVersion, Brain] | None:
    """What a live link runs. Returns None rather than falling back to a draft.

    Deliberately no fallback. The previous module answered with a system default
    when a link's flow was missing, so an operator saw a configured link that was
    quietly running logic nobody had approved. A link pointing at an unpublished
    brain must be told, not covered for.
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
    try:
        return row, Brain.model_validate(row.body or {})
    except Exception:  # noqa: BLE001
        logger.exception("[brain] published '%s' will not parse", brain_key)
        return None


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
    """Validate, check what it may attach, then write a NEW draft version.

    Two checks, in this order: the shape (does this describe a runnable brain) and
    the reach (may THIS person point at those sources). Shape first because a
    permission message about a step that could never run is noise.
    """
    # Credentials are folded BEFORE validation, so the contract validates the step
    # that will actually be stored — including its `_credential_is_usable` rule,
    # which must see a carried-forward key the request did not mention.
    body = _carry_credentials(db, brain_key, body)

    try:
        brain = Brain.model_validate({**body, "key": brain_key, "name": name})
    except Exception as exc:  # noqa: BLE001
        raise BrainError(422, _first_message(exc))

    problems = check_attachments(db, user, brain)
    if problems:
        raise BrainError(403, " ".join(problems))

    latest = (
        db.query(func.max(AgentBrainVersion.version))
        .filter(AgentBrainVersion.brain_key == brain_key)
        .scalar()
    )
    existing_owner = (
        db.query(AgentBrainVersion.owner_email)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .limit(1)
        .scalar()
    )

    row = AgentBrainVersion(
        brain_key=brain_key,
        version=int(latest or 0) + 1,
        status=DRAFT,
        name=name,
        description=description or "",
        body=brain.to_dict(),
        # The owner is set ONCE, on the first version, and later edits do not move
        # it. Ownership is whose reading rights every run carries, so letting a
        # co-editor's save silently re-point it would change what the brain can
        # read without anybody choosing that.
        owner_email=existing_owner or actor_email,
        created_by=actor_email,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _row_dict(row)


def publish(db: Session, brain_key: str, version: int, actor_email: str) -> dict[str, Any]:
    """Make one version the live one. Demotes the previous in the same transaction."""
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

    try:
        Brain.model_validate(row.body or {})
    except Exception as exc:  # noqa: BLE001
        # Publishing is the moment it starts answering viewers. Validating again
        # here rather than trusting the save: the contract may have gained a rule
        # since this draft was written.
        raise BrainError(422, f"Không phát hành được: {_first_message(exc)}")

    db.query(AgentBrainVersion).filter(
        AgentBrainVersion.brain_key == brain_key,
        AgentBrainVersion.status == PUBLISHED,
        AgentBrainVersion.version != version,
    ).update({"status": ARCHIVED}, synchronize_session=False)

    row.status = PUBLISHED
    row.published_at = _now()
    db.commit()
    db.refresh(row)
    logger.info("[brain] %s v%s published by %s", brain_key, version, actor_email)
    return _row_dict(row)


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
    return publish(db, brain_key, prev.version, actor_email)


def delete_version(db: Session, brain_key: str, version: int) -> None:
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
    db.delete(row)
    db.commit()


def impact(db: Session, brain_key: str) -> dict[str, Any]:
    """Which live links this brain is the head of.

    Reuse is what makes this necessary: one edit changes every link pointing here,
    and the author has to see that before Publish rather than after.
    """
    from app.models.models import DashboardPublicLink

    links: list[dict[str, Any]] = []
    # Read off `dashboard_public_links.appearance_config`, which is where a link's
    # bot settings actually live. The first draft of this read
    # `Dashboard.public_appearance_config` — a column that does not exist, guessed
    # from the shape of the surrounding code. It would have returned an empty impact
    # list forever and told every author their brain served nobody.
    try:
        rows = db.query(DashboardPublicLink).filter(
            DashboardPublicLink.is_active.is_(True)
        ).all()
    except Exception:  # noqa: BLE001
        logger.exception("[brain] impact query failed for %s", brain_key)
        return {"links": [], "count": 0}

    for link in rows:
        cfg = link.appearance_config or {}
        if not isinstance(cfg, dict):
            continue
        if (cfg.get("ai_bot_flow_key") or "").strip() != brain_key:
            continue
        links.append({
            "link_id": link.id,
            "link_name": link.name,
            "dashboard_id": link.dashboard_id,
            "token": link.token,
            "bot_enabled": bool(cfg.get("ai_bot_enabled")),
        })
    return {"links": links, "count": len(links)}


def _first_message(exc: Exception) -> str:
    """Pydantic's repr is several lines of type noise; an author needs the sentence."""
    text = str(exc)
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("Value error, "):
            return line[len("Value error, "):]
    return text.splitlines()[-1][:200] if text else "Cấu hình không hợp lệ"
