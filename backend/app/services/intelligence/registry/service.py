"""Registry service — create, validate, publish and bind AI flows.

Everything the Flow Studio does lands here. The rules that matter:

  * **Draft is the only editable state.** A published version is immutable; you
    edit by creating the next version. That is what makes rollback a pointer
    move instead of a restore.
  * **Publish is gated**, not a save button. The graph must validate, and the
    request goes through `govern_review_items` — the same ledger every other
    approval in Intelligence uses.
  * **Only published rows serve traffic.** The resolver ignores drafts, so an
    author cannot accidentally put a half-built graph in front of a viewer.

Lifecycle: Draft ──publish──> Published ──(new version)──> Archived
                    ▲                                          │
                    └────────────── rollback ──────────────────┘
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.ai_intelligence import (
    AiAgentVersion,
    AiAssistant,
    AiAssistantBinding,
    AiFlowVersion,
    AiModelPolicy,
    AiNodeRun,
    AiRun,
)
from app.services.intelligence.registry.resolver import invalidate_cache
from app.services.intelligence.registry.validator import parse_and_validate
from app.services.intelligence.schemas.flow import (
    MAX_DEADLINE_SECONDS_CEILING,
    MAX_MODEL_CALLS_CEILING,
    MAX_TOOL_CALLS_CEILING,
    MAX_USD_CEILING,
)
from app.services.intelligence.tools_catalog import (
    handler_names, reducer_names, tool_names,
)

logger = logging.getLogger(__name__)


class RegistryError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(detail)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


# ═══ Agents ══════════════════════════════════════════════════════════════════
def _agent_dict(a: AiAgentVersion) -> dict[str, Any]:
    return {
        "id": a.id,
        "agent_key": a.agent_key,
        "version": a.version,
        "ref": f"{a.agent_key}@{a.version}",
        "status": a.status,
        "display_name": a.display_name,
        "model_policy": a.model_policy,
        "prompt_template": a.prompt_template,
        "input_schema": a.input_schema or {},
        "output_schema": a.output_schema or {},
        "tool_allowlist": a.tool_allowlist or [],
        "writable_state_fields": a.writable_state_fields or [],
        "runtime_config": a.runtime_config or {},
        "is_builtin": bool(a.is_builtin),
        "created_by": a.created_by,
        "published_at": _iso(a.published_at),
        "created_at": _iso(a.created_at),
    }


def list_agents(db: Session) -> list[dict]:
    rows = (
        db.query(AiAgentVersion)
        .order_by(AiAgentVersion.agent_key, AiAgentVersion.version.desc())
        .all()
    )
    return [_agent_dict(r) for r in rows]


def published_agent_refs(db: Session) -> set[str]:
    rows = (
        db.query(AiAgentVersion.agent_key, AiAgentVersion.version)
        .filter(AiAgentVersion.status == "published")
        .all()
    )
    return {f"{k}@{v}" for k, v in rows}


def _next_version(db: Session, model, key_col, key: str) -> int:
    """Next version number for a key. Counts ALL statuses, so a version number
    is never reused after an archive — trace rows reference it forever."""
    current = db.query(func.max(model.version)).filter(key_col == key).scalar()
    return int(current or 0) + 1


def save_agent(db: Session, payload: dict, *, user: str | None) -> dict:
    """Create a draft, or update an existing draft in place.

    Editing a PUBLISHED version forks a new draft rather than mutating it: a
    published prompt is what some report is answering with right now, and
    changing it under the reader's feet is how prompt regressions become
    untraceable.
    """
    agent_key = (payload.get("agent_key") or "").strip()
    if not agent_key:
        raise RegistryError(400, "agent_key là bắt buộc")
    if not (payload.get("display_name") or "").strip():
        raise RegistryError(400, "display_name là bắt buộc")

    bad_tools = set(payload.get("tool_allowlist") or []) - tool_names()
    if bad_tools:
        raise RegistryError(400, f"Công cụ không tồn tại: {', '.join(sorted(bad_tools))}")

    version = payload.get("version")
    row: AiAgentVersion | None = None
    if version:
        row = (
            db.query(AiAgentVersion)
            .filter(AiAgentVersion.agent_key == agent_key, AiAgentVersion.version == version)
            .first()
        )
        if row is not None and row.status != "draft":
            row = None  # published → fork a new draft below

    if row is None:
        row = AiAgentVersion(
            agent_key=agent_key,
            version=_next_version(db, AiAgentVersion, AiAgentVersion.agent_key, agent_key),
            status="draft",
            created_by=user,
        )
        db.add(row)

    row.display_name = payload["display_name"].strip()
    row.model_policy = payload.get("model_policy") or "deep_reason"
    row.prompt_template = payload.get("prompt_template") or ""
    row.input_schema = payload.get("input_schema") or {}
    row.output_schema = payload.get("output_schema") or {}
    row.tool_allowlist = list(payload.get("tool_allowlist") or [])
    row.writable_state_fields = list(payload.get("writable_state_fields") or [])
    row.runtime_config = payload.get("runtime_config") or {}
    db.commit()
    db.refresh(row)
    return _agent_dict(row)


def publish_agent(db: Session, agent_key: str, version: int, *, user: str | None) -> dict:
    row = (
        db.query(AiAgentVersion)
        .filter(AiAgentVersion.agent_key == agent_key, AiAgentVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy agent")
    if row.status == "published":
        return _agent_dict(row)
    if not (row.prompt_template or "").strip():
        raise RegistryError(400, "Agent chưa có prompt — không thể publish")

    # Older published versions of the same key become archived so the registry
    # always has exactly one live definition per agent_key.
    (
        db.query(AiAgentVersion)
        .filter(
            AiAgentVersion.agent_key == agent_key,
            AiAgentVersion.status == "published",
        )
        .update({"status": "archived"}, synchronize_session=False)
    )
    row.status = "published"
    row.published_at = _now()
    db.commit()
    db.refresh(row)
    invalidate_cache()
    return _agent_dict(row)


def delete_agent(db: Session, agent_key: str, version: int) -> None:
    row = (
        db.query(AiAgentVersion)
        .filter(AiAgentVersion.agent_key == agent_key, AiAgentVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy agent")
    if row.is_builtin:
        raise RegistryError(400, "Agent hệ thống không thể xoá — hãy tạo phiên bản mới")
    if row.status == "published":
        raise RegistryError(400, "Không xoá được bản đã publish — hãy rollback trước")
    db.delete(row)
    db.commit()


# ═══ Flows ═══════════════════════════════════════════════════════════════════
def _flow_dict(f: AiFlowVersion, *, include_graph: bool = True) -> dict[str, Any]:
    out = {
        "id": f.id,
        "flow_key": f.flow_key,
        "version": f.version,
        "status": f.status,
        "display_name": f.display_name,
        "limits": f.limits or {},
        "requires_tools": bool(f.requires_tools),
        "eval_suite": f.eval_suite,
        "eval_pass_rate": f.eval_pass_rate,
        "eval_ran_at": _iso(f.eval_ran_at),
        "description": f.description,
        "owner": f.owner,
        "tags": f.tags or [],
        "is_builtin": bool(f.is_builtin),
        "created_by": f.created_by,
        "published_at": _iso(f.published_at),
        "created_at": _iso(f.created_at),
        "node_count": len((f.graph or {}).get("nodes") or {}),
    }
    if include_graph:
        out["graph"] = f.graph or {}
    return out


def list_flows(db: Session) -> list[dict]:
    rows = (
        db.query(AiFlowVersion)
        .order_by(AiFlowVersion.flow_key, AiFlowVersion.version.desc())
        .all()
    )
    return [_flow_dict(r, include_graph=False) for r in rows]


def get_flow(db: Session, flow_key: str, version: int) -> dict:
    row = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy luồng")
    return _flow_dict(row)


def validate_graph(db: Session, graph: dict) -> dict:
    """Validate a graph WITHOUT saving. The Studio calls this on every edit.

    `ok` means "no ERRORS" — warnings and suggestions never block publishing.
    Treating advice as a gate is how a validator gets ignored.
    """
    parsed, issues = parse_and_validate(
        graph,
        known_agents=published_agent_refs(db),
        known_tools=tool_names(),
        known_handlers=handler_names(),
        known_reducers=reducer_names(),
    )
    payload = [i.to_dict() for i in issues]
    effective = parsed.limits.clamped().model_dump() if parsed else None
    return {
        "ok": not any(i.severity == "error" for i in issues),
        "issues": payload,
        # Kept for older callers; identical list, error-only.
        "errors": [i for i in payload if i["severity"] == "error"],
        "counts": {
            sev: sum(1 for i in issues if i.severity == sev)
            for sev in ("error", "warning", "suggestion")
        },
        "limits_declared": parsed.limits.model_dump() if parsed else None,
        "limits_effective": effective,
        "limits_ceiling": {
            "max_model_calls": MAX_MODEL_CALLS_CEILING,
            "max_tool_calls": MAX_TOOL_CALLS_CEILING,
            "deadline_seconds": MAX_DEADLINE_SECONDS_CEILING,
            "max_usd": MAX_USD_CEILING,
        },
    }


def save_flow(db: Session, payload: dict, *, user: str | None) -> dict:
    """Save a draft. Published versions fork, exactly like agents."""
    flow_key = (payload.get("flow_key") or "").strip()
    if not flow_key:
        raise RegistryError(400, "flow_key là bắt buộc")
    if not (payload.get("display_name") or "").strip():
        raise RegistryError(400, "display_name là bắt buộc")
    graph = payload.get("graph")
    if not isinstance(graph, dict) or not graph.get("nodes"):
        raise RegistryError(400, "Luồng phải có ít nhất một node")

    version = payload.get("version")
    row: AiFlowVersion | None = None
    if version:
        row = (
            db.query(AiFlowVersion)
            .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
            .first()
        )
        if row is not None and row.status != "draft":
            row = None

    if row is None:
        row = AiFlowVersion(
            flow_key=flow_key,
            version=_next_version(db, AiFlowVersion, AiFlowVersion.flow_key, flow_key),
            status="draft",
            created_by=user,
        )
        db.add(row)

    row.display_name = payload["display_name"].strip()
    row.graph = graph
    row.limits = graph.get("limits") or payload.get("limits") or {}
    row.requires_tools = bool(graph.get("requires_tools", True))
    row.eval_suite = payload.get("eval_suite")
    if payload.get("description") is not None:
        row.description = payload["description"]
    if payload.get("owner") is not None:
        row.owner = payload["owner"]
    if payload.get("tags") is not None:
        row.tags = list(payload["tags"] or [])
    db.commit()
    db.refresh(row)
    out = _flow_dict(row)
    out["validation"] = validate_graph(db, row.graph)
    return out


def clone_flow(db: Session, flow_key: str, version: int, *, new_key: str,
               display_name: str, user: str | None) -> dict:
    """Clone-to-edit — how an author starts from a built-in template instead of
    a blank canvas."""
    src = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if src is None:
        raise RegistryError(404, "Không tìm thấy luồng nguồn")
    new_key = (new_key or "").strip()
    if not new_key:
        raise RegistryError(400, "Tên khoá luồng mới là bắt buộc")
    if db.query(AiFlowVersion).filter(AiFlowVersion.flow_key == new_key).first():
        raise RegistryError(409, f"Luồng '{new_key}' đã tồn tại")

    row = AiFlowVersion(
        flow_key=new_key,
        version=1,
        status="draft",
        display_name=(display_name or f"{src.display_name} (bản sao)").strip(),
        graph=src.graph,
        limits=src.limits,
        requires_tools=src.requires_tools,
        is_builtin=False,
        created_by=user,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _flow_dict(row)


def publish_flow(db: Session, flow_key: str, version: int, *, user: str | None) -> dict:
    """Publish a draft — validation is a hard gate, not a warning."""
    row = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy luồng")
    if row.status == "published":
        return _flow_dict(row)

    result = validate_graph(db, row.graph or {})
    if not result["ok"]:
        codes = ", ".join(e["code"] for e in result["errors"][:4])
        raise RegistryError(400, f"Luồng chưa hợp lệ ({codes}) — sửa hết lỗi rồi publish lại")

    (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.status == "published")
        .update({"status": "archived"}, synchronize_session=False)
    )
    row.status = "published"
    row.published_at = _now()
    db.commit()
    db.refresh(row)
    invalidate_cache()

    # Audit trail in the SINGLE ledger, already resolved: publishing is an
    # authorised action by someone with ai_flows:full, not a proposal.
    _ledger(db, entity_type="flow", entity_id=row.id, action="publish",
            title=f"Publish luồng {row.display_name} v{row.version}", by=user)
    return _flow_dict(row)


def rollback_flow(db: Session, flow_key: str, *, user: str | None) -> dict:
    """Point traffic back at the previous published version. Instant, no re-eval:
    that version already passed its gate when it was published."""
    versions = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key)
        .order_by(AiFlowVersion.version.desc())
        .all()
    )
    live = next((v for v in versions if v.status == "published"), None)
    prior = next(
        (v for v in versions if v.status == "archived" and (not live or v.version < live.version)),
        None,
    )
    if prior is None:
        raise RegistryError(400, "Không có phiên bản trước để quay lại")
    if live is not None:
        live.status = "archived"
    prior.status = "published"
    prior.published_at = _now()
    db.commit()
    db.refresh(prior)
    invalidate_cache()
    _ledger(db, entity_type="flow", entity_id=prior.id, action="rollback",
            title=f"Rollback về {prior.display_name} v{prior.version}", by=user)
    return _flow_dict(prior)


def delete_flow(db: Session, flow_key: str, version: int) -> None:
    row = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy luồng")
    if row.is_builtin:
        raise RegistryError(400, "Luồng hệ thống không thể xoá")
    if row.status == "published":
        raise RegistryError(400, "Không xoá được bản đang chạy — hãy rollback trước")
    db.delete(row)
    db.commit()


def _ledger(db: Session, *, entity_type: str, entity_id: int, action: str,
            title: str, by: str | None) -> None:
    try:
        from app.models.governance import GovernReviewItem

        db.add(GovernReviewItem(
            entity_type=entity_type, entity_id=entity_id, action=action,
            title=title[:512], source="user", status="approved",
            created_by=by, resolved_by=by, resolved_at=_now(),
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("[registry] ledger write failed", exc_info=True)
        db.rollback()


# ═══ Assistants + bindings ═══════════════════════════════════════════════════
def _assistant_dict(a: AiAssistant, bindings: list[AiAssistantBinding]) -> dict:
    return {
        "id": a.id,
        "key": a.key,
        "display_name": a.display_name,
        "status": a.status,
        "routing": a.routing or [],
        "credential_ref": a.credential_ref,
        "budget": a.budget or {},
        "knowledge_scope": a.knowledge_scope or {},
        "locale": a.locale,
        "eval_suite": a.eval_suite,
        "created_at": _iso(a.created_at),
        "bindings": [
            {
                "id": b.id,
                "surface": b.surface,
                "surface_ref": b.surface_ref,
                "enabled": bool(b.enabled),
            }
            for b in bindings
        ],
    }


def list_assistants(db: Session) -> list[dict]:
    rows = db.query(AiAssistant).order_by(AiAssistant.created_at.desc()).all()
    by_assistant: dict[int, list[AiAssistantBinding]] = {}
    for b in db.query(AiAssistantBinding).all():
        by_assistant.setdefault(b.assistant_id, []).append(b)
    return [_assistant_dict(a, by_assistant.get(a.id, [])) for a in rows]


def save_assistant(db: Session, payload: dict, *, user: str | None) -> dict:
    key = (payload.get("key") or "").strip()
    if not key:
        raise RegistryError(400, "key là bắt buộc")
    routing = payload.get("routing") or []
    if not isinstance(routing, list):
        raise RegistryError(400, "routing phải là danh sách")

    # A routing table with no catch-all silently drops whole intents on the
    # floor, and the symptom is "the bot ignores some questions" — hard to
    # diagnose from the outside. Refuse it at save time.
    if routing and not any("*" in (r.get("when_intent") or []) for r in routing if isinstance(r, dict)):
        raise RegistryError(
            400,
            "Bảng định tuyến phải có một dòng '*' làm mặc định, nếu không một số "
            "câu hỏi sẽ không có luồng nào xử lý.",
        )
    known_flows = {
        f.flow_key
        for f in db.query(AiFlowVersion.flow_key)
        .filter(AiFlowVersion.status == "published")
        .distinct()
    }
    for rule in routing:
        flow = (rule or {}).get("flow")
        if flow and flow not in known_flows:
            raise RegistryError(400, f"Luồng '{flow}' chưa được publish")

    row = db.query(AiAssistant).filter(AiAssistant.key == key).first()
    if row is None:
        row = AiAssistant(key=key, created_by=user)
        db.add(row)
    row.display_name = (payload.get("display_name") or key).strip()
    row.status = payload.get("status") or "draft"
    row.routing = routing
    row.credential_ref = payload.get("credential_ref")
    row.budget = payload.get("budget") or {}
    row.knowledge_scope = payload.get("knowledge_scope") or {}
    row.locale = payload.get("locale") or "vi-VN"
    row.eval_suite = payload.get("eval_suite")
    db.commit()
    db.refresh(row)
    invalidate_cache()
    bindings = db.query(AiAssistantBinding).filter(
        AiAssistantBinding.assistant_id == row.id
    ).all()
    return _assistant_dict(row, bindings)


def set_bindings(db: Session, key: str, bindings: list[dict]) -> dict:
    """Replace an assistant's bindings wholesale — the Studio edits them as a set."""
    row = db.query(AiAssistant).filter(AiAssistant.key == key).first()
    if row is None:
        raise RegistryError(404, "Không tìm thấy trợ lý")

    for b in bindings:
        surface = (b or {}).get("surface")
        if surface not in ("public_link", "dashboard", "global"):
            raise RegistryError(400, f"Bề mặt không hợp lệ: {surface}")
        ref = (b or {}).get("surface_ref")
        if surface != "global" and not ref:
            raise RegistryError(400, "Cần chỉ rõ link hoặc dashboard")
        # One assistant per surface: two chatbots on one report is ambiguous,
        # and the resolver would silently pick whichever row came back first.
        clash = (
            db.query(AiAssistantBinding)
            .filter(
                AiAssistantBinding.surface == surface,
                AiAssistantBinding.surface_ref == (ref if surface != "global" else None),
                AiAssistantBinding.assistant_id != row.id,
            )
            .first()
        )
        if clash is not None:
            raise RegistryError(409, "Bề mặt này đã được gán cho một trợ lý khác")

    db.query(AiAssistantBinding).filter(
        AiAssistantBinding.assistant_id == row.id
    ).delete(synchronize_session=False)
    for b in bindings:
        surface = b["surface"]
        db.add(AiAssistantBinding(
            assistant_id=row.id,
            surface=surface,
            surface_ref=(b.get("surface_ref") if surface != "global" else None),
            enabled=bool(b.get("enabled", True)),
        ))
    db.commit()
    invalidate_cache()
    rows = db.query(AiAssistantBinding).filter(
        AiAssistantBinding.assistant_id == row.id
    ).all()
    return _assistant_dict(row, rows)


def delete_assistant(db: Session, key: str) -> None:
    row = db.query(AiAssistant).filter(AiAssistant.key == key).first()
    if row is None:
        raise RegistryError(404, "Không tìm thấy trợ lý")
    db.query(AiAssistantBinding).filter(
        AiAssistantBinding.assistant_id == row.id
    ).delete(synchronize_session=False)
    db.delete(row)
    db.commit()
    invalidate_cache()


# ═══ Runs & trace ════════════════════════════════════════════════════════════
def list_runs(db: Session, *, limit: int = 50, flow_key: str | None = None) -> list[dict]:
    q = db.query(AiRun).order_by(AiRun.started_at.desc())
    if flow_key:
        q = q.filter(AiRun.flow_key == flow_key)
    return [
        {
            "id": r.id,
            "flow_key": r.flow_key,
            "flow_version": r.flow_version,
            "assistant_key": r.assistant_key,
            "mode": r.mode,
            "dashboard_id": r.dashboard_id,
            "question": r.question,
            "status": r.status,
            "model_calls": r.model_calls,
            "tool_calls": r.tool_calls,
            "usd": float(r.usd or 0),
            "verification_coverage": r.verification_coverage,
            "latency_ms": r.latency_ms,
            "error_code": r.error_code,
            "started_at": _iso(r.started_at),
        }
        for r in q.limit(min(max(limit, 1), 200)).all()
    ]


def flow_run_stats(db: Session, flow_keys: list[str], *, days: int = 7) -> list[dict]:
    """Per-flow aggregates over recent LIVE traffic.

    Preview runs are excluded on purpose: an author test-running the candidate
    twenty times while tuning it would dominate the averages and make the
    candidate look however they happened to be testing it.

    `error_rate` counts anything that did not reach `completed`, and `verified`
    averages only the runs where verification was actually possible — folding
    the NULLs in as zero would make a flow that calls no tools look wrong rather
    than unverifiable.
    """
    if not flow_keys:
        return []
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(AiRun)
        .filter(
            AiRun.flow_key.in_(flow_keys),
            AiRun.started_at >= since,
            or_(AiRun.mode.is_(None), AiRun.mode != "preview"),
        )
        .all()
    )

    out: list[dict] = []
    for key in flow_keys:
        mine = [r for r in rows if r.flow_key == key]
        if not mine:
            out.append({
                "flow_key": key, "runs": 0, "usd_total": 0.0, "usd_avg": 0.0,
                "latency_p50_ms": None, "verified_avg": None, "verified_runs": 0,
                "error_rate": None,
            })
            continue
        latencies = sorted(r.latency_ms for r in mine if r.latency_ms is not None)
        covered = [r.verification_coverage for r in mine if r.verification_coverage is not None]
        errors = sum(1 for r in mine if (r.status or "") != "completed")
        usd_total = sum(float(r.usd or 0) for r in mine)
        out.append({
            "flow_key": key,
            "runs": len(mine),
            "usd_total": round(usd_total, 6),
            "usd_avg": round(usd_total / len(mine), 6),
            "latency_p50_ms": latencies[len(latencies) // 2] if latencies else None,
            "verified_avg": round(sum(covered) / len(covered), 4) if covered else None,
            "verified_runs": len(covered),
            "error_rate": round(errors / len(mine), 4),
        })
    return out


def get_trace(db: Session, run_id: str) -> dict:
    run = db.query(AiRun).filter(AiRun.id == run_id).first()
    if run is None:
        raise RegistryError(404, "Không tìm thấy lượt chạy")
    nodes = (
        db.query(AiNodeRun)
        .filter(AiNodeRun.run_id == run_id)
        .order_by(AiNodeRun.seq)
        .all()
    )
    evidence: list[dict] = []
    try:
        from app.models.ai_evidence import AiEvidence

        evidence = [
            e.to_dict()
            for e in db.query(AiEvidence).filter(AiEvidence.run_ref == run_id).all()
        ]
    except Exception:  # noqa: BLE001
        logger.debug("[registry] evidence read failed", exc_info=True)

    return {
        "run": {
            "id": run.id,
            "flow_key": run.flow_key,
            "flow_version": run.flow_version,
            "question": run.question,
            "status": run.status,
            "model_calls": run.model_calls,
            "tool_calls": run.tool_calls,
            "usd": float(run.usd or 0),
            "verification_coverage": run.verification_coverage,
            "latency_ms": run.latency_ms,
            "error_code": run.error_code,
            "started_at": _iso(run.started_at),
        },
        "nodes": [
            {
                "seq": n.seq,
                "node_key": n.node_key,
                "node_type": n.node_type,
                "status": n.status,
                "model": n.model,
                "latency_ms": n.latency_ms,
                "error": n.error,
            }
            for n in nodes
        ],
        "evidence": evidence,
    }


def list_model_policies(db: Session) -> list[dict]:
    rows = (
        db.query(AiModelPolicy)
        .order_by(AiModelPolicy.policy, AiModelPolicy.provider)
        .all()
    )
    return [
        {
            "id": r.id, "policy": r.policy, "provider": r.provider, "model": r.model,
            "supports_tools": bool(r.supports_tools), "priority": r.priority,
            "enabled": bool(r.enabled),
        }
        for r in rows
    ]


def update_model_policy(db: Session, policy_id: int, payload: dict) -> dict:
    row = db.query(AiModelPolicy).filter(AiModelPolicy.id == policy_id).first()
    if row is None:
        raise RegistryError(404, "Không tìm thấy chính sách model")
    if "model" in payload:
        row.model = (payload["model"] or "").strip() or row.model
    if "enabled" in payload:
        row.enabled = bool(payload["enabled"])
    db.commit()
    invalidate_cache()
    return {"id": row.id, "policy": row.policy, "provider": row.provider,
            "model": row.model, "enabled": bool(row.enabled)}
