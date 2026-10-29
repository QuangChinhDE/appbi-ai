"""A public link's Agent Flow as an OPTIONAL add-on of the Answer Core (contract ext.v1).

The Core owns the public bot's turn and every number in it. When a link has a flow
bound AND `chat.extension.decide` says the question needs it (it asks for
documents/policies, or the Core could not answer from data), the Core calls the
flow ONCE, bounded, for supporting evidence:

  data       none: `data_reads_forbidden` - every chart/data tool refuses before
             any scope or cache is read. A number the flow mentions is listed as
             not verified; a metric/table/chart block it returns is dropped.
  knowledge  the link's own ceiling (`permissions.public_run_scope`: what the
             binding attached ∩ what the assigner may still read) - the same
             ceiling the link always had; nothing widens it.
  budget     the flow's contract, capped by the turn; every model call goes
             through the Model Gateway under the LINK's billing.
  memory     none (stateless).
  failure    any failure (no binding, unpublished, missing key, timeout, error,
             invalid or out-of-scope output) leaves the Core's answer standing,
             with a notice. Nothing answers around the Core.

The same validator as AI Chat's add-on (`chat.extension.accept`) decides what of
the flow's output reaches the viewer.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Callable, Optional

logger = logging.getLogger("app.public_answer")


async def invoke_for_link(*, link_id: int, turn_id: str, reason: str, question: str, core_env: dict,
                          resolve: Callable, appearance: dict,
                          is_cancelled: Callable[[], bool]) -> tuple[dict, list[dict]]:
    """Run the link's flow once as a documents-only add-on; return (supporting, notices)."""
    from app.core.config import settings
    from app.core.database import SessionLocal
    from app.models.models import DashboardPublicLink
    from app.services.agent_flows import binding as binding_service
    from app.services.agent_flows import registry as reg
    from app.services.agent_flows.dispatch import EXTENSION_PROMPT, chat_base_prompt, run_for_link
    from app.services.ai_runtime import gateway
    from app.services.chat.extension import VERSION, _WHY, _notice, accept, verified_numbers
    from app.services.dashboard_ai_bot.budget import resolve_usd_limit

    invocation_id = uuid.uuid4().hex
    timeout = max(1, int(settings.AI_CHAT_EXTENSION_TIMEOUT_SECONDS))
    status, code, out, name, flow_key = "failed", None, None, "", None
    allowed: set[int] = set()
    db = SessionLocal()
    try:
        link_ctx = resolve(db)
        ctx = link_ctx.ctx
        ctx.data_reads_forbidden = True     # documents only: no chart, no dataset, from here
        link = db.get(DashboardPublicLink, int(link_id))
        bind = binding_service.get_for_link(db, int(link_id)) if link is not None else None
        flow_key = getattr(bind, "brain_key", None)
        # the viewer reads the flow's NAME in a notice, never its internal key
        published = reg.resolve_published(db, flow_key) if flow_key else None
        name = str(getattr(published[0], "name", "") or "") if published else ""
        data = core_env.get("data") if isinstance(core_env.get("data"), dict) else {}
        note = str(((data.get("answer") or {}).get("headline")) or core_env.get("message") or "")[:600]
        base = chat_base_prompt(ctx) + EXTENSION_PROMPT
        bill = gateway.Billing(purpose="public_extension", link_id=int(link_id),
                               link_usd_per_day=resolve_usd_limit(appearance), turn_ref=turn_id,
                               credential=None)
        started = time.monotonic()
        replay = str(getattr(settings, "AI_CHAT_EXTENSION_REPLAY_PATH", "") or "")
        with gateway.billing(bill):
            gen = _replayed(db, link=link, ctx=ctx, flow_key=flow_key, question=question) if replay else \
                run_for_link(db, link=link, dashboard=ctx.dashboard, ctx=ctx, question=question,
                             history=[{"role": "assistant", "content": "Lõi dữ liệu đã trả lời: " + note}]
                             if note else [],
                             session_key="", filters=list(ctx.public_filters or []), base_system_prompt=base)
            pending: Optional[asyncio.Future] = None
            try:
                while True:
                    if is_cancelled():
                        status = code = "cancelled"
                        break
                    if time.monotonic() - started > timeout:
                        status = code = "timeout"
                        break
                    if pending is None:
                        pending = asyncio.ensure_future(gen.__anext__())
                    finished, _ = await asyncio.wait({pending}, timeout=1.0)
                    if not finished:
                        continue
                    try:
                        ev = pending.result()
                    except StopAsyncIteration:
                        pending = None
                        break
                    pending = None
                    if getattr(ev, "type", None) == "result":
                        out = (ev.extra or {}).get("envelope") or {}
            except Exception:  # noqa: BLE001 - the Core's answer stands; the reason is recorded
                logger.warning("[public_answer] add-on failed for turn %s", turn_id, exc_info=True)
                status, code, out = "failed", "failed", None
            finally:
                if pending is not None:
                    pending.cancel()
                try:
                    await gen.aclose()
                except Exception:  # noqa: BLE001
                    pass
        allowed = {int(d) for d in (getattr(ctx, "knowledge_scope", None) or {}).get("doc_ids") or []}
    except Exception:  # noqa: BLE001 - the link closed, the binding is gone: the Core's answer stands
        logger.warning("[public_answer] add-on not started for turn %s", turn_id, exc_info=True)
        status, code, out = "failed", "failed", None
    finally:
        db.close()

    documents: list = []
    findings: list = []
    warnings: list = []
    if out is not None and not isinstance(out, dict) and status not in ("cancelled", "timeout"):
        status, code, warnings, out = "failed", "invalid_output", [{"code": "invalid_output"}], None
    if out is not None and status not in ("cancelled", "timeout"):
        run_status = out.get("status")
        if run_status == "blocked":
            status = "unavailable"
            code = next((n.get("code") for n in out.get("notices") or [] if isinstance(n, dict)), None) \
                or "not_published"
        else:
            try:
                documents, findings, warnings = accept(out, allowed_doc_ids=allowed,
                                                       verified=verified_numbers(core_env))
                status = "ok" if run_status in ("ok", "partial") else "failed"
                code = None if status == "ok" else "failed"
            except Exception:  # noqa: BLE001 - a malformed result is the flow's failure, not the turn's
                documents, findings, warnings = [], [], [{"code": "invalid_output"}]
                status, code = "failed", "invalid_output"
            if status == "ok" and not (documents or findings):
                code = "no_evidence"

    supporting = {"v": VERSION, "invocation_id": invocation_id, "flow_key": flow_key, "flow_name": name,
                  "reason": reason, "status": status, "code": code, "documents": documents, "findings": findings,
                  "warnings": warnings}
    notices: list[dict] = []
    if status != "ok" or code == "no_evidence":
        notices.append(_notice("extension_unavailable", name=name or "luồng hỗ trợ",
                               why=_WHY.get(code or status, code or status)))
    elif documents and core_env.get("status") == "answered":
        notices.append(_notice("sources_separate"))
    return supporting, notices


async def _replayed(db, *, link, ctx, flow_key: Optional[str], question: str):
    """TEST-ONLY (AI_CHAT_EXTENSION_REPLAY_PATH, refused in production): the link's
    flow with its MODEL replaced by a recorded output. Every gate still runs - the
    binding, the published version, the link's knowledge ceiling - and the output
    goes through the same validator as a live run."""
    from app.services import llm_test_budget as _budget
    from app.services.agent_flows import binding as binding_service
    from app.services.agent_flows.dispatch import build_report_info, new_run_id, resolve_for_link
    from app.services.agent_flows.envelope import FlowOutput, blocked
    from app.services.agent_flows.permissions import public_run_scope
    from app.services.dashboard_ai_bot.events import AgentEvent

    run_id = new_run_id()
    bind, row, flow, problem = resolve_for_link(db, link=link, dashboard=ctx.dashboard)
    if problem or flow is None or row is None:
        out = blocked(run_id, "", problem or "not_configured")
    else:
        info = binding_service.build_binding_info(bind, flow=flow, report=build_report_info(ctx.dashboard, ctx),
                                                  link_token=getattr(link, "token", ""), version=row.version, ctx=ctx)
        ctx.knowledge_scope = public_run_scope(db, row, flow, info.knowledge.model_dump(),
                                               getattr(bind, "created_by", None))
        hit = _budget.extension_replay_lookup(flow_key or "", question)
        out = (FlowOutput.model_validate({**hit, "run_id": run_id}) if hit is not None
               else blocked(run_id, "", "replay_missing"))
    yield AgentEvent(type="result", extra={"envelope": out.to_reader_dict()})
    yield AgentEvent(type="done")


def bound_flow_key(db, link_id: int) -> Optional[str]:
    """The flow bound to this link, if any (it is an add-on; None is the normal case)."""
    try:
        from app.services.agent_flows import binding as binding_service

        b = binding_service.get_for_link(db, int(link_id))
        return getattr(b, "brain_key", None) if b is not None else None
    except Exception:  # noqa: BLE001
        return None

