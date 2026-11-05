"""Edit an EXISTING dataset's data model through AppBI's own model endpoints.

Same rules as the Visual Model editor, enforced by AppBI: edit access on the
dataset, the join fan-out guard and key evidence, the measure dry-run, the
cascade guard that refuses removing a measure charts still use (never forced),
`expected_view_version` on every view save (409 instead of overwriting a
concurrent edit), the transformation compiler's expression validation.

Preview before approval, all computed by AppBI on real data:
* a new or changed measure: its dry-run SQL and its value (`measures/preview`);
* a calculated column: AppBI's calculated-field preview over real sample rows;
* a relationship: AppBI's key evidence (`model/joins/suggestion`).
"""

import hashlib
import json
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Run
from .dataset import Cardinality, MeasureFilterSpec, MeasureType, _IDENT, _formula_expression, _measure_body
from .discovery import model_digest
from .runtime import Env, tool

MAX_OPS = 30


class AddTableOp(BaseModel):
    op: Literal["add_table"]
    data_source_id: int
    source_table: str = Field(min_length=1, description="As inspect_data_source lists it, e.g. 'shop.orders'")
    display_name: str | None = Field(default=None, max_length=200)


class AddJoinOp(BaseModel):
    op: Literal["add_join"]
    from_view: str = Field(description="View of the MANY side (as get_dataset lists it)")
    to_view: str
    from_columns: list[str] = Field(min_length=1, max_length=4)
    to_columns: list[str] = Field(min_length=1, max_length=4)
    cardinality: Cardinality = "many_to_one"


class UpsertMeasureOp(BaseModel):
    op: Literal["upsert_measure"]
    view: str
    name: str = Field(pattern=_IDENT)
    type: MeasureType
    column: str | None = None
    label: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    filters: list[MeasureFilterSpec] = Field(default_factory=list, max_length=8)
    depends_on: list[str] = Field(default_factory=list)
    expression: str | None = Field(default=None, max_length=500)
    format_kind: Literal["number", "currency", "percent"] | None = None
    decimals: int | None = Field(default=None, ge=0, le=6)
    currency: str | None = Field(default=None, max_length=8)


class RemoveMeasureOp(BaseModel):
    op: Literal["remove_measure"]
    view: str
    name: str


class UpdateDimensionOp(BaseModel):
    op: Literal["update_dimension"]
    view: str
    name: str
    label: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    hidden: bool | None = None
    type: Literal["string", "number", "date", "datetime", "yesno"] | None = None
    parent: str | None = Field(default=None, description="Drill-down parent dimension on the same view")


class CalculatedColumnOp(BaseModel):
    op: Literal["add_calculated_column"]
    view: str
    name: str = Field(pattern=_IDENT)
    expression: str = Field(min_length=1, max_length=1000, description="AppBI calculated-column expression over the table's columns")


ModelOp = Annotated[Union[AddTableOp, AddJoinOp, UpsertMeasureOp, RemoveMeasureOp, UpdateDimensionOp, CalculatedColumnOp],
                    Field(discriminator="op")]


def _h(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:16]


async def _state(env: Env, dataset_id: int) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    ds = await env.appbi.get(f"/datasets/{dataset_id}")
    model = await env.appbi.get(f"/datasets/{dataset_id}/model")
    views = {v["name"]: v for v in model.get("views", []) or []}
    return ds, model, views


def _fingerprint(ds: dict[str, Any], model: dict[str, Any], touched_views: set[str]) -> dict[str, Any]:
    views = {v["name"]: v for v in model.get("views", []) or []}
    tables = {str(t.get("id")): _h(t.get("transformations") or []) for t in ds.get("tables", []) or []}
    return {"views": {n: (views.get(n) or {}).get("view_version") for n in sorted(touched_views)},
            "joins": _h(model_digest(model).get("relationships") or model.get("explores")), "transformations": tables}


@tool(scope=sc.READ, title="Plan data model edits", read_only=True)
async def plan_model_edit(env: Env, dataset_id: int, operations: Annotated[list[ModelOp], Field(min_length=1, max_length=MAX_OPS)]) -> dict[str, Any]:
    """Plan edits to an EXISTING dataset's model (Visual Model editor parity). Writes nothing.

    Operations: add_table (physical table), add_join (relationship, AppBI checks keys
    and fan-out), upsert_measure (add or change; AppBI dry-runs it and computes its
    value), remove_measure (AppBI refuses if charts use it), update_dimension (label,
    description, hidden, type, drill parent), add_calculated_column (a per-row
    expression on the table, previewed by AppBI on real rows). Operations on a table
    added in the same plan are not possible: plan them after it exists.
    """
    ds, model, views = await _state(env, dataset_id)
    if str(ds.get("user_permission") or "edit") not in ("edit", "full", "owner"):
        return {"status": "forbidden", "message": "Your AppBI account can view this dataset but not edit it."}
    errors: list[str] = []
    warnings: list[str] = []
    rows: list[dict[str, Any]] = []
    steps: list[dict[str, Any]] = []
    previews: list[dict[str, Any]] = []
    touched: set[str] = set()

    for i, op in enumerate(operations):
        o = op.model_dump()
        if "view" in o:
            if o["view"] not in views:
                errors.append(f"op {i}: view '{o['view']}' is not in dataset {dataset_id} (views: {sorted(views)})")
                continue
            touched.add(o["view"])
        v = views.get(o.get("view")) if o.get("view") else None
        if op.op == "add_table":
            steps.append({"op": "add_table", "body": {"datasource_id": o["data_source_id"], "source_kind": "physical_table",
                                                       "source_table_name": o["source_table"],
                                                       **({"display_name": o["display_name"]} if o["display_name"] else {})}})
            rows.append({"change": "add table", "target": o["source_table"], "detail": o["display_name"] or "—"})
        elif op.op == "add_join":
            fv, tv = views.get(o["from_view"]), views.get(o["to_view"])
            if not fv or not tv:
                errors.append(f"op {i}: unknown view in relationship {o['from_view']}→{o['to_view']}")
                continue
            if len(o["from_columns"]) != len(o["to_columns"]):
                errors.append(f"op {i}: from_columns and to_columns differ in length")
                continue
            evidence = await env.appbi.post(f"/datasets/{dataset_id}/model/joins/suggestion", {
                "from_view_id": fv["id"], "to_view_id": tv["id"], "from_columns": o["from_columns"], "to_columns": o["to_columns"]})
            if not evidence.get("can_create", True):
                errors.append(f"op {i}: AppBI: {evidence.get('message') or 'cannot create this relationship'}")
                continue
            steps.append({"op": "add_join", "body": {"from_view_id": fv["id"], "to_view_id": tv["id"], "from_columns": o["from_columns"],
                                                      "to_columns": o["to_columns"], "cardinality": o["cardinality"]}})
            rows.append({"change": "add relationship", "target": f"{o['from_view']} → {o['to_view']}",
                         "detail": f"{o['cardinality']} on {o['from_columns']}={o['to_columns']}"})
            previews.append({"title": f"Key evidence {o['from_view']}→{o['to_view']} (AppBI)",
                             "items": [{k: evidence.get(k) for k in ("relationship", "from_unique", "to_unique", "from_distinct_count", "to_distinct_count") if k in evidence}]})
        elif op.op == "upsert_measure":
            if o["type"] == "formula" and not (o["expression"] and o["depends_on"]):
                errors.append(f"op {i}: a formula measure needs expression and depends_on")
                continue
            body = _measure_body({**o, "filters": o["filters"]}, {})
            dry = await env.appbi.post(f"/datasets/{dataset_id}/model/views/{v['id']}/measures/dry-run", body)
            if not dry.get("ok"):
                errors.append(f"op {i}: AppBI rejected measure '{o['name']}': {dry.get('error')}")
                continue
            value: Any = None
            try:
                prev = await env.appbi.post(f"/datasets/{dataset_id}/model/views/{v['id']}/measures/preview", {"measure": body})
                r = prev.get("rows") or []
                value = next(iter(r[0].values())) if r else None
            except AppbiError as exc:
                warnings.append(f"{o['name']}: AppBI could not compute a preview value ({exc.message})")
            existing = next((m for m in v.get("measures", []) or [] if m.get("name") == o["name"]), None)
            steps.append({"op": "upsert_measure", "view": o["view"], "body": body})
            rows.append({"change": "change measure" if existing else "add measure", "target": f"{o['view']}.{o['name']}",
                         "detail": f"{body.get('type')} {body.get('sql') or body.get('expression') or ''}".strip()})
            previews.append({"title": f"Measure {o['view']}.{o['name']} computed by AppBI", "items": [
                {"value now": value, "previous definition": json.dumps(existing, ensure_ascii=False)[:200] if existing else "—",
                 "compiled SQL": str(dry.get("compiled_sql") or "")[:400]}]})
        elif op.op == "remove_measure":
            if o["name"] not in {m.get("name") for m in v.get("measures", []) or []}:
                errors.append(f"op {i}: measure '{o['name']}' is not on view {o['view']}")
                continue
            steps.append({"op": "remove_measure", "view": o["view"], "name": o["name"]})
            rows.append({"change": "remove measure", "target": f"{o['view']}.{o['name']}",
                         "detail": "AppBI refuses if a chart still uses it (never forced)"})
        elif op.op == "update_dimension":
            dim = next((d for d in v.get("dimensions", []) or [] if d.get("name") == o["name"]), None)
            if dim is None:
                errors.append(f"op {i}: dimension '{o['name']}' is not on view {o['view']}")
                continue
            changes = {k: o[k] for k in ("label", "description", "hidden", "type", "parent") if o[k] is not None}
            if not changes:
                errors.append(f"op {i}: nothing to change on {o['name']}")
                continue
            steps.append({"op": "update_dimension", "view": o["view"], "name": o["name"], "changes": changes})
            rows.append({"change": "update dimension", "target": f"{o['view']}.{o['name']}",
                         "detail": ", ".join(f"{k}: {dim.get(k)!r} → {val!r}" for k, val in changes.items())})
        elif op.op == "add_calculated_column":
            table_id = v.get("dataset_table_id")
            table = next((t for t in ds.get("tables", []) or [] if t.get("id") == table_id), None)
            if table is None:
                errors.append(f"op {i}: view {o['view']} has no editable table")
                continue
            if o["name"] in {d.get("name") for d in v.get("dimensions", []) or []}:
                errors.append(f"op {i}: column '{o['name']}' already exists on {o['view']}")
                continue
            sample: list[Any] = []
            try:
                pv = await env.appbi.post(f"/datasets/{dataset_id}/tables/{table_id}/preview", {"limit": 50})
                rows_in = pv.get("rows") or pv.get("data") or []
                cols = [{"name": c.get("name"), "type": c.get("type")} for c in (pv.get("columns") or []) if isinstance(c, dict)] \
                    or [{"name": k, "type": "string"} for k in (rows_in[0].keys() if rows_in else [])]
                calc = await env.appbi.post_form("/dashboards/import-html/preview-calculated", {
                    "sample_rows_json": json.dumps(rows_in, default=str), "columns_json": json.dumps(cols),
                    "calculated_fields_json": json.dumps([{"name": o["name"], "expression": o["expression"]}]), "row_limit": 50})
                if calc.get("errors"):
                    errors.append(f"op {i}: AppBI rejected the expression: {calc['errors']}")
                    continue
                sample = [{k: r.get(k) for k in list(r)[:3] + [o["name"]]} for r in (calc.get("rows") or [])[:5]]
            except AppbiError as exc:
                warnings.append(f"{o['name']}: AppBI preview unavailable for this account ({exc.message}); AppBI still validates on save")
            steps.append({"op": "add_calculated_column", "view": o["view"], "table_id": table_id,
                          "step": {"type": "add_column", "enabled": True, "params": {"newField": o["name"], "expression": o["expression"]}}})
            rows.append({"change": "add calculated column", "target": f"{o['view']}.{o['name']}", "detail": o["expression"]})
            previews.append({"title": f"Calculated column {o['name']} on real rows (AppBI)", "items": sample or ["(no preview)"]})

    if errors:
        return {"status": "invalid", "errors": errors, "warnings": warnings}

    summary = {
        "sections": [
            {"title": "Dataset", "items": [{"name": ds.get("name"), "id": dataset_id, "state": ds.get("publish_state") or "draft"}]},
            {"title": "Changes", "items": rows},
            *previews,
            {"title": "Open the model in AppBI", "links": [env.link(f"/datasets/{dataset_id}")]},
            {"title": "What happens", "items": [
                "AppBI applies each change through the same endpoints as the Visual Model editor and validates it again.",
                "Every view save quotes the version read now; a concurrent edit makes AppBI refuse instead of overwriting it.",
                "Published dashboards keep reading the last published snapshot until you publish the dataset separately.",
            ]},
        ],
        "warnings": warnings,
    }
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="model_edit",
                            body={"dataset_id": dataset_id, "steps": steps}, summary=summary, fingerprint=_fingerprint(ds, model, touched))
    return {"status": "awaiting_approval", "plan_id": plan.id, "plan_hash": plan.plan_hash, "approval_url": env.approval_url(plan.id),
            "changes": rows, "previews": previews, "warnings": warnings,
            "next": "Ask the user to approve in the browser, then call execute_plan(plan_id)."}


async def _save_view(env: Env, dataset_id: int, view_name: str, mutate: Any, key: str) -> dict[str, Any]:
    """Read the view, apply `mutate(dims, measures)`, save quoting the version read."""
    for attempt in range(2):
        model = await env.appbi.get(f"/datasets/{dataset_id}/model")
        view = next((v for v in model.get("views", []) or [] if v.get("name") == view_name), None)
        if view is None or not view.get("view_version"):
            raise OperationError("blocked", f"View {view_name} is missing or not version-protected; nothing written.", step=key)
        dims, measures = [dict(d) for d in view.get("dimensions", []) or []], [dict(m) for m in view.get("measures", []) or []]
        mutate(dims, measures)
        try:
            await env.appbi.put(f"/datasets/{dataset_id}/model/views/{view['id']}",
                                {"dimensions": dims, "measures": measures, "expected_view_version": view["view_version"]})
            return {"view": view_name}
        except AppbiError as exc:
            if exc.status == 409 and isinstance(exc.detail, dict) and exc.detail.get("code") == "view_stale" and attempt == 0:
                continue
            if exc.status == 409:
                raise OperationError("blocked" if "chart" in exc.message.lower() else "conflict", f"AppBI refused: {exc.message}",
                                     step=key, detail=exc.detail) from exc
            raise
    raise OperationError("conflict", "The view kept changing; try again.", step=key)


async def run_model_edit(env: Env, run: Run) -> dict[str, Any]:
    body = run.plan.body
    did = int(body["dataset_id"])
    touched = {s["view"] for s in body["steps"] if s.get("view")}
    if env.plans.step(run.plan.id, "start_check") is None:
        ds, model, _ = await _state(env, did)
        if _fingerprint(ds, model, touched) != run.plan.fingerprint:
            raise OperationError("stale_plan", "The dataset's model changed after the plan was approved. Plan again.", step="start_check")
        env.plans.mark(run.plan.id, "start_check", "done", result={"ok": True})

    done: list[str] = []
    for i, s in enumerate(body["steps"]):
        key = f"{s['op']}:{i}"
        if s["op"] == "add_table":
            async def find_table(_since: float, s: dict[str, Any] = s) -> dict[str, Any] | None:
                d = await env.appbi.get(f"/datasets/{did}")
                t = next((t for t in d.get("tables", []) or [] if t.get("source_table_name") == s["body"]["source_table_name"]
                          and t.get("datasource_id") == s["body"]["datasource_id"]), None)
                return {"table_id": t["id"]} if t else None
            res = await run.write(key, lambda s=s: env.appbi.post(f"/datasets/{did}/tables", s["body"]), reconcile=find_table)
            done.append(f"table {s['body']['source_table_name']} (#{res.get('id') or res.get('table_id')})")
        elif s["op"] == "add_join":
            try:
                await run.write(key, lambda s=s: env.appbi.post(f"/datasets/{did}/model/joins", s["body"]))
            except AppbiError as exc:
                raise OperationError("blocked", f"AppBI refused the relationship: {exc.message}", step=key, detail=exc.detail) from exc
            done.append("relationship")
        elif s["op"] == "add_calculated_column":
            async def add_col(s: dict[str, Any] = s) -> dict[str, Any]:
                d = await env.appbi.get(f"/datasets/{did}")
                t = next(t for t in d.get("tables", []) or [] if t.get("id") == s["table_id"])
                if _h(t.get("transformations") or []) != run.plan.fingerprint["transformations"].get(str(s["table_id"])) and \
                        not any((x.get("params") or {}).get("newField") == s["step"]["params"]["newField"] for x in t.get("transformations") or []):
                    raise OperationError("stale_plan", "The table's transformations changed after approval; plan again.", step=key)
                steps_now = list(t.get("transformations") or [])
                if any((x.get("params") or {}).get("newField") == s["step"]["params"]["newField"] for x in steps_now):
                    return {"column": s["step"]["params"]["newField"], "already": True}
                await env.appbi.put(f"/datasets/{did}/tables/{s['table_id']}", {"transformations": steps_now + [s["step"]]})
                return {"column": s["step"]["params"]["newField"]}
            try:
                await run.write(key, add_col)
            except AppbiError as exc:
                raise OperationError("blocked", f"AppBI refused the calculated column: {exc.message}", step=key, detail=exc.detail) from exc
            done.append(f"calculated column {s['step']['params']['newField']}")
        elif s["op"] == "upsert_measure":
            def up(dims: list, measures: list, s: dict[str, Any] = s) -> None:
                idx = next((k for k, m in enumerate(measures) if m.get("name") == s["body"]["name"]), None)
                if idx is None:
                    measures.append(s["body"])
                else:
                    measures[idx] = {**measures[idx], **s["body"]}
            await run.write(key, lambda s=s, up=up: _save_view(env, did, s["view"], up, key))
            done.append(f"measure {s['view']}.{s['body']['name']}")
        elif s["op"] == "remove_measure":
            await run.write(key, lambda s=s: _save_view(env, did, s["view"], lambda d, m, s=s: m.__setitem__(slice(None), [x for x in m if x.get("name") != s["name"]]), key))
            done.append(f"removed {s['view']}.{s['name']}")
        elif s["op"] == "update_dimension":
            def upd(dims: list, measures: list, s: dict[str, Any] = s) -> None:
                for d in dims:
                    if d.get("name") == s["name"]:
                        d.update(s["changes"])
            await run.write(key, lambda s=s, upd=upd: _save_view(env, did, s["view"], upd, key))
            done.append(f"dimension {s['view']}.{s['name']}")

    health = await env.appbi.get(f"/datasets/{did}/model/health", execute="true")
    if health.get("blocking"):
        raise OperationError("blocked", "AppBI's semantic health check reports blocking problems after the edit.", step="health", detail=health["blocking"])
    run.resources.append({"type": "dataset", "id": did, "url": env.link(f"/datasets/{did}")})
    return {"status": "draft_ready", "dataset_id": did, "applied": done, "url": env.link(f"/datasets/{did}"),
            "semantic_health": (health.get("layers") or {}).get("semantic_health", {}).get("status"),
            "next": "Dashboards read the published snapshot: request_publish(resource_type='dataset') to make model changes live."}
