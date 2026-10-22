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
from app.services.analyst.catalog import datasets_named, discover
from app.services.analyst.planner import (_describe_filter, Clarify, Plan, Unsupported, describe_plan, plan as make_plan, retarget,
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
        ceiling_dataset_ids: Optional[list[int]] = None, consented_plan: Optional[dict] = None,
        dataset_id: Optional[int] = None, value_choice: Optional[dict] = None,
        choice_token: Optional[str] = None) -> dict:
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
    chosen = None
    if choice_token:
        # A metric/source the person picked from THIS server's clarification. The
        # token binds user, question, Dataset, explore, metric and the catalog
        # version, and expires; the pick is re-authorised against THIS turn's
        # catalog, so replaying it can never widen what the person may read.
        chosen, why = verify_choice(choice_token, user_id=str(user.id), question=question, catalog=catalog)
        if chosen is None:
            return {"status": "unsupported", "turn_id": turn_id or uuid.uuid4().hex, "steps": [], "message": why}
        dataset_id = chosen["dataset_id"]
    if dataset_id is not None:
        # The person chose the source (a clarification between datasets): only that
        # Dataset's entries, and only if this turn's catalog still offers it.
        catalog = [c for c in catalog if c.dataset_id == int(dataset_id)]
        if not catalog:
            return {"status": "unsupported", "turn_id": turn_id, "steps": steps,
                    "message": "Nguồn bạn chọn không còn trong phạm vi bạn được dùng."}
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
    elif value_choice is not None:
        # The person picked one of the REAL values offered for a filter that matched
        # none (dogfood: re-asking "<question> — <value>" was refused by grounding on
        # the very word the pick replaced). The echoed plan is untrusted input: it is
        # re-validated against THIS turn's catalog, only the named filter's value
        # changes, and the value is checked against the data again before the query.
        outcome = _apply_value_choice(value_choice, catalog)
    else:
        named = datasets_named(catalog, question) if prev_explore is None and dataset_id is None else set()
        if named and len(named) < len({c.dataset_id for c in catalog}):
            # the person named these Datasets' metrics (or the Dataset): the planner
            # chooses among them only; the rest of the catalog is not offered
            catalog = [c for c in catalog if c.dataset_id in named]
        outcome = make_plan(question, catalog, previous=previous, complete=deps.complete,
                            chosen=({"explore_id": chosen["explore_id"], "measure": chosen["measure"]}
                                    if chosen and chosen.get("measure") else None))
    if isinstance(outcome, Clarify):
        choices = [{"label": c["label"], "token": sign_choice(
                        user_id=str(user.id), question=question, catalog=full_catalog,
                        explore_id=c["explore_id"], measure=c["measure"])} for c in outcome.choices]
        return {"status": "clarify", "turn_id": turn_id, "steps": steps, "message": outcome.question,
                "options": outcome.options, "choices": [c for c in choices if c["token"]]}
    if isinstance(outcome, Unsupported):
        return {"status": "unsupported", "turn_id": turn_id, "steps": steps, "message": outcome.reason}
    p: Plan = retarget(outcome, full_catalog)
    if consented_plan is None and value_choice is None:
        # The plan must answer THE QUESTION, not just use permitted fields.
        from app.services.analyst.grounding import ground

        carried = [*(previous or {}).get("dimensions", []), *(previous or {}).get("measures", []),
                   *((previous or {}).get("filters") or {}).keys()] if isinstance(previous, dict) else []
        p, why = ground(p, question, carried=carried, covered=p.covered,
                        chosen_measure=(chosen or {}).get("measure"),
                        previous=previous if isinstance(previous, dict) else None,
                        value_lookup=lambda q, words, used: _find_value_filter(authz, principal, p, q, words,
                                                                               used, settings, turn_id, deps))
        if p is None:
            return {"status": "unsupported", "turn_id": turn_id, "steps": steps, "message": why}
        from app.services.analyst.grounding import other_source_named
        from app.services.analyst.planner import prompt_catalog

        both = (other_source_named(p, question, prompt_catalog(full_catalog))
                if prev_explore is None and dataset_id is None else [])
        verbatim = {o["dataset_id"] for o in both[1:] if o.get("verbatim")}
        if len(verbatim) == 1 and all(o.get("verbatim") for o in both[1:]):
            # Another Dataset names the metric WORD FOR WORD while this plan reached
            # its metric only through the model's bridge: plan again on that Dataset
            # (holdout set 6: "doanh số" answered from another source's "Revenue").
            return ask(db, user, question, deps, turn_id=turn_id, ceiling_dataset_ids=ceiling_dataset_ids,
                       dataset_id=next(iter(verbatim)))
        if both:
            for o in both[:6]:
                o["token"] = sign_choice(user_id=str(user.id), question=question, catalog=full_catalog,
                                         dataset_id=o["dataset_id"])
            return {"status": "clarify", "turn_id": turn_id, "steps": steps,
                    "options": [o["label"] for o in both[:6]], "sources": both[:6],
                    "message": "Câu hỏi khớp với chỉ số ở nhiều nguồn dữ liệu. Bạn muốn dùng nguồn nào?"}
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
            values_of = lambda ref: gqs.execute(governed([ref], p.measures[:1], {}, [], {}, 200))  # noqa: E731
            checked, options = _check_filter_values(
                p, values_of,
                lambda ref, text: gqs.execute(governed([ref], p.measures[:1],
                                                       {ref: {"operator": "contains", "value": text}}, [], {}, 50)))
            if checked is None:
                moved = _relocate_values(p, values_of)
                if moved is not None:
                    # Sealed set 8: "Laptop 14" written on the product ID; it is a real
                    # value of the product NAME, the one field that has it exactly.
                    steps.append({"step": "verify", "detail": "Giá trị lọc thuộc trường khác: " + "; ".join(
                        f"{labels_of(moved).get(r, r)} = {c['value']}" for r, c in moved.filters.items()
                        if r not in p.filters)})
                    p = moved
                    checked, options = _check_filter_values(p, values_of)
            if checked is None:
                return {"status": "clarify", "turn_id": turn_id, "steps": steps, "plan": p.as_dict(),
                        "message": "Giá trị bạn lọc không có trong dữ liệu. Bạn muốn chọn giá trị nào?",
                        "options": options[:10], "choice_field": _unmatched_filter(p, options)}
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
    order = _ranking_order(p)
    if p.limit and result.truncated:
        # A top N read from a result cut at the row bound is not the top N.
        steps.append({"step": "verify", "detail": "kết quả vượt giới hạn dòng"})
        return {"status": "unsupported", "turn_id": turn_id, "steps": steps, "plan": p.as_dict(),
                "message": "Kết quả vượt giới hạn dòng nên không xếp hạng được chính xác; hãy thu hẹp câu hỏi.",
                "evidence": {"query_id": ev.query_id}}
    if order and not time_ref and len([c for c in columns if c["role"] == "dimension"]) == 1:
        rows = _ordered(rows, columns, p, order)
    story = narrative.describe(columns, rows, time_ref=time_ref, truncated=result.truncated,
                               grain=p.time_grains.get(time_ref) if time_ref else None,
                               period=_asked_period(p, time_ref), order=order, top=p.limit)
    steps.append({"step": "verify", "detail": "; ".join(c["detail"] for c in story["checks"])})
    draft = None if (p.filters or p.limit) else narrative.chart_draft(p, draft_title(question))
    return {
        "status": "answered", "turn_id": turn_id, "steps": steps, "plan": p.as_dict(),
        "answer": story, "columns": columns, "rows": rows, "truncated": result.truncated,
        "evidence": {
            "query_id": ev.query_id, "source": p.explore.dataset_name, "source_type": p.explore.source_type,
            "explore_id": p.explore.explore_id, "datasets": list(ev.datasets), "dialect": ev.dialect,
            "sql_fingerprint": ev.sql_fingerprint[:16], "policy_fingerprint": ev.policy_fingerprint[:16],
            "semantic_epoch": ev.semantic_epoch, "filters_applied": list(ev.filters_applied),
            # the same filters as the person reads them (label, operator, value), not internal refs
            "filters_described": [_describe_filter(labels_of(p).get(r, r), c) for r, c in p.filters.items()],
            "filters_dropped": list(ev.filters_dropped), "bounds": ev.bounds.as_dict(),
            "rows_returned": ev.rows_returned, "duration_ms": ev.duration_ms, "freshness": ev.freshness.mode,
            "measures": [labels.get(m, m) for m in p.measures],
        },
        "chart_draft": draft,
        "can_save": _can_save_chart(authz, user, p),
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
                  and not is_identifier(f)][:8]
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


def _ranking_order(p) -> Optional[str]:
    """'desc'/'asc' when the plan orders its groups by a measure (an asked ranking),
    'desc' for a plain one-breakdown answer (the table reads in ranking order), else None."""
    s = next((s for s in p.sorts if s.get("field") in p.measures), None)
    if s is not None:
        return "asc" if s.get("direction") == "asc" else "desc"
    return "desc" if p.measures and len(p.dimensions) == 1 and not p.time_grains else None


def _ordered(rows: list, columns: list, p, order: str) -> list:
    """Rows ordered by the first measure (a NULL last, never as 0), cut to the asked N."""
    m = next((c["name"] for c in columns if c["role"] == "measure"), None)
    if m is None:
        return rows
    known = [r for r in rows if isinstance(r.get(m), (int, float))]
    unknown = [r for r in rows if not isinstance(r.get(m), (int, float))]
    known.sort(key=lambda r: r[m], reverse=(order == "desc"))
    if p.limit and len(known) > p.limit:
        edge = known[p.limit - 1][m]
        cut = p.limit
        while cut < len(known) and known[cut][m] == edge:
            cut += 1  # a tie at the cut is kept: "top 1" of a tie is every tied group
        known = known[:cut]
        return known
    out = known + unknown
    return out


def _asked_period(p, time_ref):
    """The [from, to) range the question put on the trend's own time field, if any."""
    from datetime import date

    f = (p.filters or {}).get(time_ref) if time_ref else None
    if not isinstance(f, dict) or f.get("operator") != "date_range" or not isinstance(f.get("value"), dict):
        return None
    try:
        return date.fromisoformat(str(f["value"]["from"])), date.fromisoformat(str(f["value"]["to"]))
    except (KeyError, ValueError):
        return None


def _can_save_chart(authz, user, p: Plan) -> bool:
    """What POST /charts will decide for this person, asked BEFORE offering the
    button: `explore_charts: edit` and BUILD on the answer's Dataset (browser
    acceptance: the button was offered and the save failed afterwards). Advisory
    for the UI only - the chart API still enforces both."""
    from app.core.authz.decision import Action
    from app.core.dependencies import _normalize_permissions
    from app.models.dataset import Dataset

    level = _normalize_permissions(user).get("explore_charts", "none")
    if level not in ("edit", "full"):
        return False
    ds = authz.db.get(Dataset, p.explore.dataset_id)
    return bool(ds is not None and authz.decide(Action.BUILD, ds).allowed)


def labels_of(p: Plan) -> dict:
    return {f.ref: f.label for f in p.explore.fields}


CHOICE_TTL_SECONDS = 15 * 60


def _catalog_epoch(entries) -> str:
    """A fingerprint of what the catalog offers for these explores: a renamed,
    removed or retyped field makes an earlier pick stale."""
    import hashlib
    import json as _json

    body = sorted((e.explore_id, e.dataset_id, sorted((f.ref, f.kind, f.type, f.label) for f in e.fields))
                  for e in entries)
    return hashlib.sha256(_json.dumps(body, ensure_ascii=False, default=str).encode()).hexdigest()[:24]


def _qhash(question: str) -> str:
    import hashlib
    import unicodedata

    return hashlib.sha256(unicodedata.normalize("NFC", question.strip()).encode()).hexdigest()[:24]


def _mac(body: bytes) -> str:
    import hashlib
    import hmac

    from app.core.config import settings

    key = ("analyst-choice:" + str(settings.SECRET_KEY)).encode()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def sign_choice(*, user_id: str, question: str, catalog, dataset_id: Optional[int] = None,
                explore_id: Optional[int] = None, measure: Optional[str] = None) -> Optional[str]:
    """A signed, expiring handle for one clarification option."""
    import base64
    import json as _json
    import time

    if explore_id is not None:
        ex = next((c for c in catalog if c.explore_id == explore_id), None)
        if ex is None:
            return None
        dataset_id = ex.dataset_id
        entries = [ex]
    else:
        entries = [c for c in catalog if c.dataset_id == dataset_id]
        if not entries:
            return None
    payload = {"u": user_id, "q": _qhash(question), "d": int(dataset_id), "e": explore_id, "m": measure,
               "v": _catalog_epoch(entries), "x": int(time.time()) + CHOICE_TTL_SECONDS}
    body = base64.urlsafe_b64encode(_json.dumps(payload, separators=(",", ":")).encode())
    return body.decode() + "." + _mac(body)


def verify_choice(token: str, *, user_id: str, question: str, catalog):
    """(choice, None) or (None, reason). Checks signature, owner, question, expiry,
    that the Dataset/explore/metric are still in THIS turn's catalog, and that the
    catalog has not changed since the option was offered."""
    import base64
    import hmac
    import json as _json
    import time

    try:
        body, mac = str(token).rsplit(".", 1)
        if not hmac.compare_digest(mac, _mac(body.encode())):
            raise ValueError
        payload = _json.loads(base64.urlsafe_b64decode(body.encode()))
    except (ValueError, TypeError):
        return None, "Lựa chọn không hợp lệ."
    if payload.get("u") != user_id or payload.get("q") != _qhash(question):
        return None, "Lựa chọn không thuộc câu hỏi này của bạn."
    if int(payload.get("x") or 0) < time.time():
        return None, "Lựa chọn đã hết hạn; hãy hỏi lại."
    if payload.get("e") is not None:
        entries = [c for c in catalog if c.explore_id == payload["e"]]
        if not entries or payload.get("m") not in {f.ref for f in entries[0].fields if f.kind == "measure"}:
            return None, "Nguồn hoặc chỉ số bạn chọn không còn trong phạm vi bạn được dùng."
    else:
        entries = [c for c in catalog if c.dataset_id == payload.get("d")]
        if not entries:
            return None, "Nguồn bạn chọn không còn trong phạm vi bạn được dùng."
    if _catalog_epoch(entries) != payload.get("v"):
        return None, "Mô hình dữ liệu đã thay đổi từ lúc bạn được hỏi lại; hãy hỏi lại."
    return {"dataset_id": int(payload["d"]), "explore_id": payload.get("e"), "measure": payload.get("m")}, None


def _relocate_values(p: Plan, values_of) -> Optional[Plan]:
    """The plan with each text filter whose values are not real on ITS field moved to
    the ONE other text field of the explore where every value is real exactly
    (operator kept), or None. Each field read is governed and bounded."""
    from dataclasses import replace as _replace

    from app.services.analyst.catalog import is_identifier
    from app.services.analyst.grounding import fold

    def real(ref) -> set:
        try:
            res = values_of(ref)
        except GovernedRefusal:
            return set()
        col = next((c.name for c in res.columns if c.ref == ref), None)
        return {fold(str(r.get(col))).strip() for r in res.rows if col and r.get(col) is not None}

    filters, moved_any = {}, False
    for ref, cond in p.filters.items():
        vals = cond.get("value") if isinstance(cond.get("value"), list) else [cond.get("value")]
        if cond.get("operator") not in ("eq", "in", "ne", "not_in") or not all(isinstance(v, str) for v in vals):
            filters[ref] = cond
            continue
        wanted = {fold(v).strip() for v in vals}
        if wanted <= real(ref):
            filters[ref] = cond
            continue
        homes = [f.ref for f in p.explore.fields[:60] if f.kind == "dimension" and f.type == "string"
                 and f.ref != ref and f.ref not in p.filters and not is_identifier(f)][:8]
        hits = [h for h in homes if wanted <= real(h)]
        if len(hits) != 1:
            return None
        filters[hits[0]] = cond
        moved_any = True
    if not moved_any:
        return None
    out = _replace(p, filters=filters, dimensions=[d for d in p.dimensions if d not in p.filters or d in filters])
    out.interpretation = describe_plan(out)
    return out


def _unmatched_filter(p: Plan, real: list) -> Optional[str]:
    """The text filter whose value is not one of `real` (the values offered)."""
    from app.services.analyst.grounding import fold

    folded = {fold(str(x)).strip() for x in real}
    for ref, cond in p.filters.items():
        vals = cond.get("value") if isinstance(cond.get("value"), list) else [cond.get("value")]
        if cond.get("operator") in ("eq", "in", "ne", "not_in") and any(
                isinstance(v, str) and fold(v).strip() not in folded for v in vals):
            return ref
    return None


def _apply_value_choice(choice: dict, catalog):
    """The previous turn's plan with ONE filter set to the value the person picked."""
    plan, field_ref, value = choice.get("plan"), choice.get("field"), choice.get("value")
    if not (isinstance(plan, dict) and isinstance(field_ref, str) and isinstance(value, str)
            and 0 < len(value.strip()) <= 200):
        return Unsupported("Lựa chọn không hợp lệ.")
    outcome = validate({**plan, "status": "plan"}, catalog)
    if not isinstance(outcome, Plan):
        return outcome
    cond = outcome.filters.get(field_ref)
    if not isinstance(cond, dict) or cond.get("operator") not in ("eq", "in", "ne", "not_in"):
        return Unsupported("Lựa chọn không khớp với bộ lọc của câu hỏi trước.")
    op = "ne" if cond.get("operator") in ("ne", "not_in") else "eq"  # an exclusion stays an exclusion
    outcome.filters = {**outcome.filters, field_ref: {"operator": op, "value": value.strip()}}
    outcome.interpretation = describe_plan(outcome)
    return outcome


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
        # An EXCLUSION is checked too (sealed set 8: "ne huỷ" matched no real value,
        # excluded nothing, and the total of ALL orders was reported as the total
        # without cancelled ones).
        if op not in ("eq", "in", "ne", "not_in") or not all(isinstance(v, str) for v in wanted):
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
