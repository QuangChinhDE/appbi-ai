"""Export / import a flow as a self-contained bundle.

The point is to move an analysis procedure between deployments — ship a
"retail diagnosis pack", or promote a flow from a staging box to production —
without anyone hand-copying JSON between databases.

The hard part is not serialising the graph; it is being honest about what the
graph DEPENDS on. A flow references agents by `key@version`, tools by name and
handlers by name. On the way in, those may or may not exist. So a bundle
declares its requirements, and the importer checks them BEFORE writing
anything:

  * a missing TOOL or HANDLER is fatal — the flow could never run, and importing
    it would only produce a broken draft somebody has to debug;
  * a missing AGENT is recoverable — agents travel in the bundle, so we create
    them as drafts alongside;
  * anything else missing is a warning, and the flow lands as a Draft so a
    person reviews it before it can serve traffic.

Imported flows are NEVER published automatically, whatever the bundle says.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.ai_intelligence import AiAgentVersion, AiFlowVersion
from app.services.intelligence.tools_catalog import handler_names, tool_names

logger = logging.getLogger(__name__)

BUNDLE_KIND = "appbi.ai_flow_bundle"
BUNDLE_VERSION = 1


def _agent_refs(graph: dict) -> set[str]:
    return {
        n.get("agent") for n in (graph.get("nodes") or {}).values() if n.get("agent")
    }


def _tool_names(graph: dict) -> set[str]:
    out: set[str] = set()
    for n in (graph.get("nodes") or {}).values():
        out.update(n.get("tools") or [])
        if n.get("tool"):
            out.add(n["tool"])
    return out


def _handler_names(graph: dict) -> set[str]:
    out: set[str] = set()
    for n in (graph.get("nodes") or {}).values():
        if n.get("handler"):
            out.add(n["handler"])
        elif n.get("type") == "verify":
            out.add("verify_claims")
    return out


def export_flow(db: Session, flow_key: str, version: int) -> dict[str, Any]:
    from app.services.intelligence.registry.service import RegistryError

    row = (
        db.query(AiFlowVersion)
        .filter(AiFlowVersion.flow_key == flow_key, AiFlowVersion.version == version)
        .first()
    )
    if row is None:
        raise RegistryError(404, "Không tìm thấy luồng")

    graph = row.graph or {}
    refs = _agent_refs(graph)

    agents: list[dict] = []
    for ref in sorted(r for r in refs if r):
        key, _, ver = str(ref).partition("@")
        a = (
            db.query(AiAgentVersion)
            .filter(AiAgentVersion.agent_key == key, AiAgentVersion.version == int(ver or 1))
            .first()
        )
        if a is None:
            continue
        agents.append({
            "agent_key": a.agent_key,
            "version": a.version,
            "display_name": a.display_name,
            "model_policy": a.model_policy,
            "prompt_template": a.prompt_template,
            "input_schema": a.input_schema or {},
            "output_schema": a.output_schema or {},
            "tool_allowlist": a.tool_allowlist or [],
            "writable_state_fields": a.writable_state_fields or [],
            "runtime_config": a.runtime_config or {},
        })

    return {
        "kind": BUNDLE_KIND,
        "bundle_version": BUNDLE_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "flow": {
            "flow_key": row.flow_key,
            "version": row.version,
            "display_name": row.display_name,
            "description": row.description,
            "tags": row.tags or [],
            "graph": graph,
            "limits": row.limits or {},
            "requires_tools": bool(row.requires_tools),
        },
        "agents": agents,
        # Declared so the importer can refuse a bundle this deployment cannot run.
        "requires": {
            "tools": sorted(_tool_names(graph)),
            "handlers": sorted(_handler_names(graph)),
            "agents": sorted(r for r in refs if r),
        },
    }


def check_bundle(db: Session, bundle: dict) -> dict[str, Any]:
    """Dry-run: what would happen, and what is missing. No writes."""
    if bundle.get("kind") != BUNDLE_KIND:
        return {"ok": False, "fatal": ["Tệp không phải gói luồng AppBI."], "warnings": []}

    requires = bundle.get("requires") or {}
    flow = bundle.get("flow") or {}
    graph = flow.get("graph") or {}

    missing_tools = sorted(set(requires.get("tools") or _tool_names(graph)) - tool_names())
    missing_handlers = sorted(
        set(requires.get("handlers") or _handler_names(graph)) - handler_names()
    )

    bundled_agents = {f"{a['agent_key']}@{a['version']}" for a in bundle.get("agents") or []}
    needed_agents = set(requires.get("agents") or _agent_refs(graph))
    have_agents = {
        f"{k}@{v}" for k, v in db.query(AiAgentVersion.agent_key, AiAgentVersion.version).all()
    }
    missing_agents = sorted(needed_agents - bundled_agents - have_agents)

    fatal: list[str] = []
    if missing_tools:
        fatal.append(f"Bản cài này không có công cụ: {', '.join(missing_tools)}")
    if missing_handlers:
        fatal.append(f"Bản cài này không có bước xử lý: {', '.join(missing_handlers)}")

    warnings: list[str] = []
    if missing_agents:
        warnings.append(
            f"Thiếu chuyên gia (sẽ phải chọn lại sau khi nhập): {', '.join(missing_agents)}"
        )

    key = flow.get("flow_key")
    if key and db.query(AiFlowVersion).filter(AiFlowVersion.flow_key == key).first():
        warnings.append(f"Đã có luồng '{key}' — nhập vào sẽ tạo khoá mới.")

    return {
        "ok": not fatal,
        "fatal": fatal,
        "warnings": warnings,
        "flow_key": key,
        "display_name": flow.get("display_name"),
        "node_count": len(graph.get("nodes") or {}),
        "agents_in_bundle": sorted(bundled_agents),
    }


def import_bundle(db: Session, bundle: dict, *, user: str | None,
                  new_key: str | None = None) -> dict[str, Any]:
    from app.services.intelligence.registry.service import RegistryError, _flow_dict

    check = check_bundle(db, bundle)
    if not check["ok"]:
        raise RegistryError(400, " ".join(check["fatal"]))

    flow = bundle["flow"]
    key = (new_key or flow["flow_key"]).strip()
    if db.query(AiFlowVersion).filter(AiFlowVersion.flow_key == key).first():
        base, i = key, 2
        while db.query(AiFlowVersion).filter(AiFlowVersion.flow_key == key).first():
            key = f"{base}_{i}"
            i += 1

    # Agents first: the flow references them, and a draft agent is harmless.
    created_agents: list[str] = []
    for a in bundle.get("agents") or []:
        exists = (
            db.query(AiAgentVersion)
            .filter(
                AiAgentVersion.agent_key == a["agent_key"],
                AiAgentVersion.version == a["version"],
            )
            .first()
        )
        if exists is not None:
            continue
        db.add(AiAgentVersion(
            agent_key=a["agent_key"], version=a["version"], status="draft",
            display_name=a.get("display_name") or a["agent_key"],
            model_policy=a.get("model_policy") or "deep_reason",
            prompt_template=a.get("prompt_template") or "",
            input_schema=a.get("input_schema") or {},
            output_schema=a.get("output_schema") or {},
            tool_allowlist=a.get("tool_allowlist") or [],
            writable_state_fields=a.get("writable_state_fields") or [],
            runtime_config=a.get("runtime_config") or {},
            created_by=user,
        ))
        created_agents.append(f"{a['agent_key']}@{a['version']}")

    row = AiFlowVersion(
        flow_key=key,
        version=1,
        # ALWAYS a draft, whatever the bundle claimed. An imported flow has not
        # been reviewed on THIS deployment, against THIS data.
        status="draft",
        display_name=flow.get("display_name") or key,
        description=flow.get("description"),
        tags=flow.get("tags") or [],
        graph=flow.get("graph") or {},
        limits=flow.get("limits") or {},
        requires_tools=bool(flow.get("requires_tools", True)),
        is_builtin=False,
        created_by=user,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    out = _flow_dict(row)
    out["imported"] = {
        "agents_created": created_agents,
        "warnings": check["warnings"],
        "renamed_to": key if key != flow["flow_key"] else None,
    }
    return out
