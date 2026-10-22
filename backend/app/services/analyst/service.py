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
from app.services.analyst.planner import (Clarify, Plan, Unsupported, describe_plan, plan as make_plan, retarget,
                                          validate)
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
        ceiling_dataset_ids: Optional[list[int]] = None, consented_plan: Optional[dict] = None) -> dict:
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
    consent_enabled = bool(getattr(settings, "ANALYST_DROP_CONSENT_ENABLED", False))
    if not consent_enabled and (drop_consent or consented_plan is not None):
        return {"status": "unsupported", "message": "Chấp nhận bỏ bộ lọc chưa được bật trong giai đoạn thử nghiệm."}
    turn_id = turn_id or uuid.uuid4().hex
    principal = EffectivePrincipal.for_user(user, surface="analyst", request_id=turn_id)
    authz = AuthorizationContext(db=db, principal=principal, user=user,
                                 ceiling=SurfaceCeiling.of(ceiling_dataset_ids))
    steps = []

    catalog = discover(authz)
    full_catalog = list(catalog)
    prev_explore = (previous or {}).get("explore_id") if isinstance(previous, dict) else None
    if prev_explore is not None:
        # A follow-up refines the previous answer. Real-model run: "and by quarter?"
        # jumped to an unrelated dataset. The follow-up is held to the previous
        # explore (still re-authorised: it must be in THIS turn's catalog); a new
        # topic is a new question, not a follow-up.
        prev_ds = next((c.dataset_id for c in catalog if c.explore_id == prev_explore), None)
        same = [c for c in catalog if c.dataset_id == prev_ds]  # the same Dataset, any of its explores
        if not same:
            return {"status": "unsupported", "turn_id": turn_id, "steps": steps,
                    "message": "Nguồn dữ liệu của câu hỏi trước không còn trong phạm vi bạn được dùng."}
        catalog = same
    steps.append({"step": "discovery", "detail": f"{len(catalog)} nguồn ngữ nghĩa bạn được phép khai thác"})
    if consented_plan is not None:
        # Accepting a dropped filter re-runs THE plan the person saw, not a new
        # one: the model is not asked again (it could plan something else and
        # spend the consent on it). The echoed plan is untrusted input, so it is
        # re-validated against THIS turn's catalog (a revoked grant or another
        # explore is refused here) and GQS then binds the consent to the exact
        # query fingerprint (a changed plan or semantic model does not match).
        if not drop_consent:
            return {"status": "unsupported", "turn_id": turn_id, "steps": steps,
                    "message": "Thiếu xác nhận của bạn cho phần bộ lọc không áp được."}
        outcome = validate({**consented_plan, "status": "plan"}, catalog)
    else:
        outcome = make_plan(question, catalog, previous=previous, complete=deps.complete)
    if isinstance(outcome, Clarify):
        return {"status": "clarify", "turn_id": turn_id, "steps": steps, "message": outcome.question,
                "options": outcome.options}
    if isinstance(outcome, Unsupported):
        return {"status": "unsupported", "turn_id": turn_id, "steps": steps, "message": outcome.reason}
    p: Plan = retarget(outcome, full_catalog)
    if consented_plan is None:
        # The plan must answer THE QUESTION, not just use permitted fields.
        from app.services.analyst.grounding import ground

        carried = [*(previous or {}).get("dimensions", []), *(previous or {}).get("measures", []),
                   *((previous or {}).get("filters") or {}).keys()] if isinstance(previous, dict) else []
        p, why = ground(p, question, carried=carried, covered=p.covered,
                        previous=previous if isinstance(previous, dict) else None,
                        value_lookup=lambda q, words, used: _find_value_filter(authz, principal, p, q, words,
                                                                               used, settings, turn_id, deps))
        if p is None:
            return {"status": "unsupported", "turn_id": turn_id, "steps": steps, "message": why}
        from app.services.analyst.grounding import other_source_named
        from app.services.analyst.planner import prompt_catalog

        both = other_source_named(p, question, prompt_catalog(full_catalog)) if prev_explore is None else []
        if both:
            return {"status": "clarify", "turn_id": turn_id, "steps": steps, "options": both[:6],
                    "message": "Câu hỏi khớp với chỉ số ở nhiều nguồn dữ liệu. Bạn muốn dùng chỉ số nào?"}
    steps.append({"step": "plan", "detail": p.interpretation or "Đã chọn chỉ số, chiều và độ chi tiết thời gian.",
                  "source": p.explore.dataset_name})

    def governed(dims, measures, filters, sorts, grains, max_rows):
        return GovernedQueryRequest(
            principal=principal,
            relation=RelationRef(kind="semantic_explore", id=p.explore.explore_id, model_id=p.explore.model_id),
            ask=SemanticAsk(dimensions=tuple(dims), measures=tuple(measures), filters=dict(filters),
                            sorts=tuple(sorts), time_grains=dict(grains)),
            requested_bounds=QueryBounds(max_rows=max_rows, timeout_seconds=60,
                                         bq_max_bytes=int(settings.ANALYST_MAX_BQ_BYTES_PER_USER_DAY)),
            run_id=turn_id,
            drop_consent=drop_consent,
        )

    def main_request(plan):
        return governed(plan.dimensions, plan.measures, plan.filters,
                        plan.sorts or [{"field": t, "direction": "asc"} for t in plan.time_grains],
                        plan.time_grains, int(settings.ANALYST_MAX_ROWS))

    gqs = GovernedQueryService(authz, audit=deps.ledger, cancel_registry=deps.registry)
    try:
        if p.filters and consented_plan is None:
            # A filter value must EXIST in the data before the query runs. The model
            # writes values as the question says them ("bị huỷ", "khách hàng cá nhân");
            # a value that matches nothing returns COUNT 0 / an empty SUM that reads
            # like a fact (holdout set 3: "Số khách hàng: 0"). The field's real values
            # are read through GQS (this person's rights, ledgered): each filter value
            # is replaced by the ONE real value matching it, or the person chooses.
            checked, options = _check_filter_values(
                p, lambda ref: gqs.execute(governed([ref], p.measures[:1], {}, [], {}, 200)),
                lambda ref, text: gqs.execute(governed([ref], p.measures[:1],
                                                       {ref: {"operator": "contains", "value": text}}, [], {}, 50)))
            if checked is None:
                return {"status": "clarify", "turn_id": turn_id, "steps": steps, "plan": p.as_dict(),
                        "message": "Giá trị bạn lọc không có trong dữ liệu. Bạn muốn chọn giá trị nào?",
                        "options": options[:10]}
            if checked.filters != p.filters:
                steps.append({"step": "verify", "detail": "Giá trị bộ lọc được khớp với dữ liệu: " + "; ".join(
                    f"{labels_of(p).get(r, r)} = {c['value']}" for r, c in checked.filters.items())})
            p = checked
        result = gqs.execute(main_request(p))
    except GovernedRefusal as refusal:
        steps.append({"step": "governed_query", "detail": f"Từ chối: {refusal.code}"})
        return {"status": "refused", "turn_id": turn_id, "steps": steps, "code": refusal.code,
                "message": refusal.message_vi, "detail": _safe_detail(refusal), "plan": p.as_dict(),
                "consent_available": consent_enabled and refusal.code == "filter_would_drop"}
    ev = result.evidence
    steps.append({"step": "governed_query", "detail": f"{ev.rows_returned} dòng · {ev.duration_ms} ms",
                  "query_id": ev.query_id})

    labels = {f.ref: f.label for f in p.explore.fields}
    columns = [{"name": c.name, "ref": c.ref, "role": c.role, "label": labels.get(c.ref or "", c.name)}
               for c in result.columns]
    rows = [{c["name"]: _jsonable(r.get(c["name"])) for c in columns} for r in result.rows]
    measure_cols = [c["name"] for c in columns if c["role"] == "measure"]
    no_value = all(r.get(n) is None for r in rows for n in measure_cols)  # SUM over nothing is one NULL row
    if p.filters and (not rows or no_value):
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


def _find_value_filter(authz, principal, p: Plan, question: str, unexplained: set, used: list, settings, turn_id,
                       deps):
    """(ref, real value) when exactly one text field of the explore has a real value
    whose words are in the question and cover an unexplained word; else None.
    Each field's values are read through GQS (this person, ledgered, bounded)."""
    from app.services.analyst.catalog import is_identifier
    from app.services.analyst.grounding import fold, syllables
    from app.services.governed_query import (GovernedQueryRequest, GovernedQueryService, QueryBounds,
                                             RelationRef, SemanticAsk)

    qtext = " " + " ".join(w for w in __import__("re").split(r"[^0-9a-z]+", fold(question)) if w) + " "
    candidates = [f for f in p.explore.fields if f.kind == "dimension" and f.type == "string"
                  and not is_identifier(f) and f.ref not in used][:4]
    if not candidates or len(unexplained) > 4:
        return None  # each lookup is a governed read against the person's budget: kept small
    hits = []
    gqs = GovernedQueryService(authz, audit=deps.ledger, cancel_registry=deps.registry)
    for f in candidates:
        try:
            res = gqs.execute(GovernedQueryRequest(
                principal=principal,
                relation=RelationRef(kind="semantic_explore", id=p.explore.explore_id, model_id=p.explore.model_id),
                ask=SemanticAsk(dimensions=(f.ref,), measures=tuple(p.measures[:1]), filters={}, sorts=(), time_grains={}),
                requested_bounds=QueryBounds(max_rows=200, timeout_seconds=30,
                                             bq_max_bytes=int(settings.ANALYST_MAX_BQ_BYTES_PER_USER_DAY)),
                run_id=turn_id))
        except Exception:  # a refused lookup only means no value from this field
            continue
        col = next((c.name for c in res.columns if c.ref == f.ref), None)
        for r in res.rows if col else []:
            v = r.get(col)
            words = syllables(v) if isinstance(v, str) else set()
            if words and words & unexplained and f" {' '.join(w for w in __import__('re').split(r'[^0-9a-z]+', fold(v)) if w)} " in qtext:
                hits.append((f.ref, v))
    return hits[0] if len({h[0] for h in hits}) == 1 and len(hits) == 1 else None


def labels_of(p: Plan) -> dict:
    return {f.ref: f.label for f in p.explore.fields}


def _check_filter_values(p: Plan, values_of, search_of=None):
    """(plan with every text eq/in filter value replaced by the ONE real value matching
    it after folding case and tone marks; or None and the field's real values when a
    value matches none or several). Non-text and other operators pass unchanged."""
    from dataclasses import replace as _replace

    from app.services.analyst.grounding import fold

    new_filters, options = {}, []
    for ref, cond in p.filters.items():
        op, value = cond.get("operator"), cond.get("value")
        wanted = value if isinstance(value, list) else [value]
        if op not in ("eq", "in") or not all(isinstance(v, str) for v in wanted):
            new_filters[ref] = cond
            continue
        try:
            res = values_of(ref)
        except GovernedRefusal:
            # The lookup could not run (budget, a refusal of its own): the value is
            # kept as written and the empty-result check after the query still holds.
            new_filters[ref] = cond
            continue
        col = next((c.name for c in res.columns if c.ref == ref), None)
        real = {str(r.get(col)) for r in res.rows if r.get(col) is not None} if col else set()
        if search_of is not None and getattr(res, "truncated", False):
            # A field with more values than one bounded read holds (product names,
            # cities): a value past the first page is not "absent". Search for it
            # by the person's own words, as typed and title-cased (the pattern
            # match is case-sensitive), each read bounded and ledgered.
            for v in wanted:
                for text in dict.fromkeys([v.strip(), v.strip().title()]):
                    try:
                        hit = search_of(ref, text)
                    except GovernedRefusal:
                        continue
                    hcol = next((c.name for c in hit.columns if c.ref == ref), None)
                    real |= {str(r.get(hcol)) for r in hit.rows if hcol and r.get(hcol) is not None}
        real = sorted(real)
        fixed = []
        for v in wanted:
            exact = [x for x in real if fold(x).strip() == fold(v).strip()]
            near = exact or [x for x in real if fold(v).strip() and (fold(v).strip() in fold(x) or fold(x) in fold(v))]
            if len(near) != 1:
                return None, real
            fixed.append(near[0])
        new_filters[ref] = {"operator": op, "value": fixed if isinstance(value, list) else fixed[0]}
    if new_filters == p.filters:
        return p, []
    out = _replace(p, filters=new_filters)
    out.interpretation = describe_plan(out)
    return out, []


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
