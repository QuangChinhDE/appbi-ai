"""Version history, diff, impact, review gate and eval for flows.

Split from `service.py` because these answer a different question. CRUD is
"what does this flow contain"; this module is "what changes if I ship it, and
who does it change things for" — the reviewer's questions, not the author's.

The reason a diff exists at all: approving a publish without seeing what moved
is a rubber stamp, and a rubber stamp on something that alters what the AI tells
customers is worse than no review.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.ai_intelligence import AiAssistant, AiAssistantBinding, AiFlowVersion
from app.services.intelligence.schemas.flow import MAX_USD_CEILING

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def flow_versions(db: Session, flow_key: str) -> list[dict]:
    """Every version of a flow, newest first — the rollback picker's data."""
    from app.services.intelligence.registry.service import _flow_dict

    rows = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key)
        .order_by(AiFlowVersion.version.desc())
        .all()
    )
    return [_flow_dict(r, include_graph=False) for r in rows]


def _behavioural(node: dict) -> dict:
    """The part of a node that changes BEHAVIOUR.

    Position and description are excluded: moving a card or fixing a typo is not
    a change a reviewer needs to weigh, and listing it would bury the ones that
    are.
    """
    return {k: v for k, v in (node or {}).items() if k not in ("position", "description")}


def flow_diff(
    db: Session, flow_key: str, version: int, against: int | None = None
) -> dict[str, Any]:
    """What changed between two versions, in reviewer terms.

    Defaults to comparing against the version currently PUBLISHED, because the
    reviewer's real question is "what changes for the people using this right
    now", not "what changed since some arbitrary draft".
    """
    from app.services.intelligence.registry.service import RegistryError

    target = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if target is None:
        raise RegistryError(404, "Không tìm thấy phiên bản luồng")

    q = db.query(AiFlowVersion).filter(AiFlowVersion.flow_key == flow_key)
    if against is not None:
        base = q.filter(AiFlowVersion.version == against).first()
    else:
        base = (
            q.filter(
                AiFlowVersion.status == "published",
                AiFlowVersion.version != version,
            )
            .order_by(AiFlowVersion.version.desc())
            .first()
        )

    tgt_nodes: dict = (target.graph or {}).get("nodes") or {}
    base_nodes: dict = ((base.graph or {}).get("nodes") if base else {}) or {}

    changed = sorted(
        k for k in (set(tgt_nodes) & set(base_nodes))
        if _behavioural(tgt_nodes[k]) != _behavioural(base_nodes[k])
    )

    def _agents(nodes: dict) -> set[str]:
        return {n.get("agent") for n in nodes.values() if n.get("agent")}

    tgt_limits = (target.graph or {}).get("limits") or target.limits or {}
    base_limits = (((base.graph or {}).get("limits") if base else None)
                   or (base.limits if base else None) or {})
    limit_changes = {
        k: {"from": base_limits.get(k), "to": v}
        for k, v in tgt_limits.items() if base_limits.get(k) != v
    }

    return {
        "flow_key": flow_key,
        "target_version": version,
        "base_version": base.version if base else None,
        "is_first_publish": base is None,
        "nodes_added": sorted(set(tgt_nodes) - set(base_nodes)),
        "nodes_removed": sorted(set(base_nodes) - set(tgt_nodes)),
        "nodes_changed": changed,
        "agents_added": sorted(_agents(tgt_nodes) - _agents(base_nodes)),
        "agents_removed": sorted(_agents(base_nodes) - _agents(tgt_nodes)),
        "limit_changes": limit_changes,
        "eval": {
            "target": target.eval_pass_rate,
            "base": base.eval_pass_rate if base else None,
        },
    }


def flow_impact(db: Session, flow_key: str) -> dict[str, Any]:
    """Who is affected if this flow changes.

    "2 assistants, 6 links" in front of a reviewer is the difference between a
    considered approval and a reflex.
    """
    assistants = db.query(AiAssistant).all()
    using = [
        a for a in assistants
        if any((r or {}).get("flow") == flow_key for r in (a.routing or []))
    ]
    ids = [a.id for a in using]
    bindings = (
        db.query(AiAssistantBinding)
        .filter(AiAssistantBinding.assistant_id.in_(ids or [-1]))
        .all()
    )
    by_id = {a.id: a for a in using}
    return {
        "assistants": [
            {"key": a.key, "display_name": a.display_name, "status": a.status}
            for a in using
        ],
        "bindings": [
            {
                "surface": b.surface,
                "surface_ref": b.surface_ref,
                "enabled": bool(b.enabled),
                "assistant_key": by_id[b.assistant_id].key if b.assistant_id in by_id else None,
            }
            for b in bindings
        ],
        "assistant_count": len(using),
        "binding_count": len(bindings),
    }


def set_flow_status(
    db: Session, flow_key: str, version: int, status: str, *, user: str | None
) -> dict:
    """Move a draft along the review lifecycle.

    `in_review` is separate from publish on purpose: it parks a flow for a
    reviewer WITHOUT letting it serve traffic, which is what makes "send for
    review" a real state rather than a label.
    """
    from app.services.intelligence.registry.service import (
        RegistryError, _flow_dict, validate_graph,
    )

    if status not in ("draft", "ready", "in_review"):
        raise RegistryError(400, "Trạng thái không hợp lệ")
    row = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy luồng")
    if row.status in ("published", "archived"):
        raise RegistryError(400, "Chỉ đổi được trạng thái của bản nháp")

    if status == "in_review":
        result = validate_graph(db, row.graph or {})
        if not result["ok"]:
            raise RegistryError(400, "Luồng còn lỗi — sửa hết trước khi gửi duyệt")
        _queue_review(db, row, flow_impact(db, flow_key), user)

    row.status = status
    db.commit()
    db.refresh(row)
    return _flow_dict(row)


def _queue_review(db: Session, row: AiFlowVersion, impact: dict, by: str | None) -> None:
    """Queue the publish request in the SINGLE ledger, PENDING.

    Unlike the audit row `publish` writes, this one is genuinely awaiting a
    human, so it appears in /ai-inbox beside every other Intelligence approval.
    """
    try:
        from app.models.governance import GovernReviewItem

        db.add(GovernReviewItem(
            entity_type="flow", entity_id=row.id, action="suggest",
            title=f"Duyệt publish luồng {row.display_name} v{row.version}"[:512],
            payload={
                "flow_key": row.flow_key,
                "version": row.version,
                "impact": impact,
                "eval_pass_rate": row.eval_pass_rate,
            },
            evidence=(
                f"Ảnh hưởng {impact['assistant_count']} trợ lý · "
                f"{impact['binding_count']} bề mặt đang phục vụ."
            ),
            source="user", status="pending", created_by=by,
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("[registry] review request failed", exc_info=True)
        db.rollback()


def run_flow_eval(db: Session, flow_key: str, version: int) -> dict[str, Any]:
    """Score a flow against the release gate.

    Runs the DETERMINISTIC checks only — graph shape, safety posture, budget. A
    full answer-quality suite costs real provider money per case, so it belongs
    behind an explicit budgeted action rather than a button an author taps while
    iterating. The result says plainly what it did and did not check, because an
    eval that overstates its coverage is worse than none.
    """
    from app.services.intelligence.registry.service import RegistryError, validate_graph

    row = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy luồng")

    graph = row.graph or {}
    nodes: dict = graph.get("nodes") or {}
    validation = validate_graph(db, graph)
    limits = validation.get("limits_effective") or {}

    llm_nodes = [
        k for k, n in nodes.items()
        if n.get("type") in ("agent", "legacy") and not n.get("disabled")
    ]
    has_guard = any(n.get("type") == "guard" for n in nodes.values())
    has_verify = any(
        n.get("type") == "verify"
        or (n.get("type") == "function" and str(n.get("handler") or "").startswith("verify"))
        for n in nodes.values()
    )
    max_usd = float(limits.get("max_usd") or 0)
    max_calls = int(limits.get("max_model_calls") or 0)
    deadline = int(limits.get("deadline_seconds") or 0)

    checks = [
        {"key": "graph_valid", "label_vi": "Cấu trúc luồng hợp lệ", "hard": True,
         "passed": validation["ok"],
         "detail": f"{validation['counts']['error']} lỗi"},
        {"key": "guard_present", "label_vi": "Có lớp chặn đầu vào", "hard": True,
         "passed": has_guard, "detail": ""},
        {"key": "verifier_present", "label_vi": "Có bước kiểm chứng số liệu", "hard": True,
         "passed": has_verify or not llm_nodes,
         "detail": "" if has_verify else "luồng không sinh số"},
        {"key": "budget_within_ceiling", "label_vi": "Ngân sách trong trần hệ thống",
         "hard": True, "passed": max_usd <= MAX_USD_CEILING,
         "detail": f"${max_usd}"},
        {"key": "llm_within_budget", "label_vi": "Số bước AI nằm trong trần lượt gọi",
         "hard": False, "passed": len(llm_nodes) <= max_calls,
         "detail": f"{len(llm_nodes)} bước / {max_calls} lượt"},
        {"key": "deadline_reasonable", "label_vi": "Thời gian chờ hợp lý (≤120s)",
         "hard": False, "passed": deadline <= 120, "detail": f"{deadline}s"},
    ]
    hard_failed = [c for c in checks if c["hard"] and not c["passed"]]
    passed = sum(1 for c in checks if c["passed"])

    row.eval_pass_rate = round(passed / len(checks), 4)
    row.eval_ran_at = _now()
    db.commit()

    return {
        "flow_key": flow_key,
        "version": version,
        "pass_rate": row.eval_pass_rate,
        "passed": passed,
        "total": len(checks),
        "can_publish": not hard_failed,
        "checks": checks,
        "note": (
            "Kiểm tra tĩnh về cấu trúc, an toàn và ngân sách. Bộ kiểm thử chất lượng "
            "câu trả lời chạy riêng vì tốn chi phí model."
        ),
    }
