"""AppBI Analyst (M2 MVP): question -> discovery -> plan -> GQS -> verified answer.

The first consumer of the Governed Query Service. It holds no query path of its
own: every read is `GovernedQueryService.execute` with a request-bound
principal on the `analyst` surface, the durable ledger as its audit sink, the
server's budgets and the server's bounds. A refusal from GQS is shown as a
refusal; nothing is answered around it.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from app.services.analyst import narrative
from app.services.analyst.catalog import discover
from app.services.analyst.planner import Clarify, Plan, Unsupported, plan as make_plan
from app.services.governed_query.principal import GovernedRefusal


@dataclass
class AnalystDeps:
    """What a turn runs against; production builds it from settings."""

    ledger: Any
    registry: Any = None
    complete: Optional[Callable[..., Optional[dict]]] = None  # the model; None = LLMClient


def ledger_from_settings():
    from app.core.config import settings
    from app.core.database import app_engine
    from app.services.governed_query.ledger import LedgerBudgets, PostgresLedger

    def n(v):
        return int(v) if v and int(v) > 0 else None

    return PostgresLedger(app_engine, budgets=LedgerBudgets(
        max_queries_per_user_day=n(settings.ANALYST_MAX_QUERIES_PER_USER_DAY),
        max_concurrent_per_datasource=n(settings.ANALYST_MAX_CONCURRENT_PER_DATASOURCE),
        max_bq_bytes_per_user_day=n(settings.ANALYST_MAX_BQ_BYTES_PER_USER_DAY),
    ))


def ask(db, user, question: str, deps: AnalystDeps, *, previous: Optional[dict] = None,
        drop_consent: Optional[str] = None, turn_id: Optional[str] = None,
        ceiling_dataset_ids: Optional[list[int]] = None) -> dict:
    """One turn. `ceiling_dataset_ids` scopes the Analyst to a set of Datasets
    (a workspace); it can only NARROW what the person may read, never widen it."""
    from app.core.config import settings
    from app.services.governed_query import (
        AuthorizationContext, EffectivePrincipal, GovernedQueryRequest, GovernedQueryService, QueryBounds,
        RelationRef, SemanticAsk, SurfaceCeiling,
    )

    question = (question or "").strip()
    if not question:
        return {"status": "unsupported", "message": "Hãy nhập câu hỏi."}
    turn_id = turn_id or uuid.uuid4().hex
    principal = EffectivePrincipal.for_user(user, surface="analyst", request_id=turn_id)
    authz = AuthorizationContext(db=db, principal=principal, user=user,
                                 ceiling=SurfaceCeiling.of(ceiling_dataset_ids))
    steps = []

    catalog = discover(authz)
    prev_explore = (previous or {}).get("explore_id") if isinstance(previous, dict) else None
    if prev_explore is not None:
        # A follow-up refines the previous answer. Real-model run: "and by quarter?"
        # jumped to an unrelated dataset. The follow-up is held to the previous
        # explore (still re-authorised: it must be in THIS turn's catalog); a new
        # topic is a new question, not a follow-up.
        same = [c for c in catalog if c.explore_id == prev_explore]
        if not same:
            return {"status": "unsupported", "turn_id": turn_id, "steps": steps,
                    "message": "Nguồn dữ liệu của câu hỏi trước không còn trong phạm vi bạn được dùng."}
        catalog = same
    steps.append({"step": "discovery", "detail": f"{len(catalog)} nguồn ngữ nghĩa bạn được phép khai thác"})
    outcome = make_plan(question, catalog, previous=previous, complete=deps.complete)
    if isinstance(outcome, Clarify):
        return {"status": "clarify", "turn_id": turn_id, "steps": steps, "message": outcome.question,
                "options": outcome.options}
    if isinstance(outcome, Unsupported):
        return {"status": "unsupported", "turn_id": turn_id, "steps": steps, "message": outcome.reason}
    p: Plan = outcome
    steps.append({"step": "plan", "detail": p.interpretation or "Đã chọn chỉ số, chiều và độ chi tiết thời gian.",
                  "source": p.explore.dataset_name})

    request = GovernedQueryRequest(
        principal=principal,
        relation=RelationRef(kind="semantic_explore", id=p.explore.explore_id, model_id=p.explore.model_id),
        ask=SemanticAsk(dimensions=tuple(p.dimensions), measures=tuple(p.measures), filters=dict(p.filters),
                        sorts=tuple(p.sorts) or tuple({"field": t, "direction": "asc"} for t in p.time_grains),
                        time_grains=dict(p.time_grains)),
        requested_bounds=QueryBounds(max_rows=int(settings.ANALYST_MAX_ROWS), timeout_seconds=60,
                                     bq_max_bytes=int(settings.ANALYST_MAX_BQ_BYTES_PER_USER_DAY)),
        run_id=turn_id,
        drop_consent=drop_consent,
    )
    gqs = GovernedQueryService(authz, audit=deps.ledger, cancel_registry=deps.registry)
    try:
        result = gqs.execute(request)
    except GovernedRefusal as refusal:
        steps.append({"step": "governed_query", "detail": f"Từ chối: {refusal.code}"})
        return {"status": "refused", "turn_id": turn_id, "steps": steps, "code": refusal.code,
                "message": refusal.message_vi, "detail": _safe_detail(refusal), "plan": p.as_dict()}
    ev = result.evidence
    steps.append({"step": "governed_query", "detail": f"{ev.rows_returned} dòng · {ev.duration_ms} ms",
                  "query_id": ev.query_id})

    labels = {f.ref: f.label for f in p.explore.fields}
    columns = [{"name": c.name, "ref": c.ref, "role": c.role, "label": labels.get(c.ref or "", c.name)}
               for c in result.columns]
    rows = [{c["name"]: _jsonable(r.get(c["name"])) for c in columns} for r in result.rows]
    if not rows and p.filters:
        # Zero rows under a filter is not "the answer is nothing": the model may
        # have put the question's words on a field that does not mean them
        # (real-model eval: ad channels written into seller_id). Say exactly what
        # was filtered and draw no conclusion; the read stays in the ledger.
        steps.append({"step": "verify", "detail": "0 dòng khớp bộ lọc"})
        return {"status": "unsupported", "turn_id": turn_id, "steps": steps, "plan": p.as_dict(),
                "message": no_match_message(p), "evidence": {"query_id": ev.query_id}}
    time_ref = next(iter(p.time_grains), None)
    story = narrative.describe(columns, rows, time_ref=time_ref, truncated=result.truncated,
                               grain=p.time_grains.get(time_ref) if time_ref else None)
    steps.append({"step": "verify", "detail": "; ".join(c["detail"] for c in story["checks"])})
    draft = None if p.filters else narrative.chart_draft(p, draft_title(question))
    return {
        "status": "answered", "turn_id": turn_id, "steps": steps, "plan": p.as_dict(),
        "answer": story, "columns": columns, "rows": rows, "truncated": result.truncated,
        "evidence": {
            "query_id": ev.query_id, "source": p.explore.dataset_name, "source_type": p.explore.source_type,
            "explore_id": p.explore.explore_id, "datasets": list(ev.datasets), "dialect": ev.dialect,
            "sql_fingerprint": ev.sql_fingerprint[:16], "policy_fingerprint": ev.policy_fingerprint[:16],
            "semantic_epoch": ev.semantic_epoch, "filters_applied": list(ev.filters_applied),
            "filters_dropped": list(ev.filters_dropped), "bounds": ev.bounds.as_dict(),
            "rows_returned": ev.rows_returned, "duration_ms": ev.duration_ms, "freshness": ev.freshness.mode,
            "measures": [labels.get(m, m) for m in p.measures],
        },
        "chart_draft": draft,
        "chart_draft_unavailable": (None if draft else
                                    "Câu trả lời có bộ lọc; bản nháp biểu đồ chưa mang được bộ lọc nên không đề xuất lưu."),
    }


def draft_title(question: str, now=None) -> str:
    """A chart name is unique per owner; the same question asked twice must still
    be savable twice (acceptance run: the second save was refused as a duplicate)."""
    import datetime as _dt

    stamp = (now or _dt.datetime.now()).strftime("%Y-%m-%d %H:%M:%S")
    return f"{question.strip()[:100]} · {stamp}"


def no_match_message(p: Plan) -> str:
    labels = {f.ref: f.label for f in p.explore.fields}
    parts = []
    for ref, cond in p.filters.items():
        value = cond.get("value")
        shown = ", ".join(str(v) for v in value) if isinstance(value, list) else str(value)
        parts.append(f"{labels.get(ref, ref)} {cond.get('operator')} {shown}")
    return ("Không có dòng nào khớp bộ lọc: " + "; ".join(parts) + ". Có thể trường này không mang nghĩa như "
            "trong câu hỏi; hệ thống không suy diễn thêm. Hãy kiểm tra lại cách hiểu câu hỏi.")


def _safe_detail(refusal: GovernedRefusal) -> dict:
    """What a person may see of a refusal: codes and field refs, never SQL."""
    keep = ("dropped", "query_fingerprint", "budget", "limit", "used", "reason", "columns", "fields",
            "timeout_seconds", "query_id", "allowed")
    return {k: v for k, v in refusal.detail.items() if k in keep}


def _jsonable(v: Any) -> Any:
    import datetime as _dt
    import decimal

    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (_dt.date, _dt.datetime)):
        return v.isoformat()
    return v
