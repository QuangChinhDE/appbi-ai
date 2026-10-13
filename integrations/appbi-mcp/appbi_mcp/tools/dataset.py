"""Dataset planning and execution (spec §5.2).

Validity is AppBI's: the join fan-out guard, measure dry-run (the real semantic
engine against the source) and model health decide. This module only checks
that what the plan references exists, records the plan, and runs the steps in
order — each write at most once.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Plan, Run
from .runtime import Env, tool

MAX_TABLES = 12
MAX_JOINS = 20
MAX_MEASURES = 40

Cardinality = Literal["many_to_one", "one_to_one", "one_to_many", "many_to_many"]
MeasureType = Literal["sum", "count", "avg", "min", "max", "count_distinct", "formula"]
_IDENT = r"^[A-Za-z_][A-Za-z0-9_]{0,62}$"


class TableSpec(BaseModel):
    key: str = Field(pattern=_IDENT, description="Short alias you use for this table in joins and measures, e.g. 'orders'")
    data_source_id: int
    source_table: str = Field(min_length=1, description="Table name exactly as inspect_data_source lists it in source_table_name, e.g. 'shop.orders'")
    display_name: str | None = Field(default=None, max_length=200)


class JoinSpec(BaseModel):
    from_table: str = Field(description="Table key of the MANY side (usually the fact)")
    to_table: str = Field(description="Table key of the ONE side (usually the dimension)")
    from_columns: list[str] = Field(min_length=1, max_length=4)
    to_columns: list[str] = Field(min_length=1, max_length=4)
    cardinality: Cardinality = "many_to_one"

    @model_validator(mode="after")
    def _same_arity(self) -> "JoinSpec":
        if len(self.from_columns) != len(self.to_columns):
            raise ValueError("from_columns and to_columns must have the same length")
        return self


class MeasureFilterSpec(BaseModel):
    field: str
    operator: Literal["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "between", "contains", "starts_with", "ends_with", "is_null", "is_not_null"]
    value: Any = None


class MeasureSpec(BaseModel):
    table: str = Field(description="Table key the measure lives on")
    name: str = Field(pattern=_IDENT)
    type: MeasureType
    column: str | None = Field(default=None, description="Column aggregated (not needed for count of rows or formula)")
    label: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    filters: list[MeasureFilterSpec] = Field(default_factory=list, max_length=8)
    depends_on: list[str] = Field(default_factory=list, description="formula only: names of measures on the same table it uses")
    expression: str | None = Field(default=None, max_length=500, description="formula only, e.g. 'revenue / orders'")
    format_kind: Literal["number", "currency", "percent"] | None = None
    decimals: int | None = Field(default=None, ge=0, le=6)
    currency: str | None = Field(default=None, max_length=8)

    @model_validator(mode="after")
    def _shape(self) -> "MeasureSpec":
        if self.type == "formula":
            if not self.expression or not self.depends_on:
                raise ValueError("a formula measure needs expression and depends_on")
        else:
            if self.expression:
                raise ValueError("expression is only allowed for formula measures")
            if self.type != "count" and not self.column:
                raise ValueError(f"a {self.type} measure needs a column")
        return self


class DatasetPlanInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    tables: list[TableSpec] = Field(min_length=1, max_length=MAX_TABLES)
    joins: list[JoinSpec] = Field(default_factory=list, max_length=MAX_JOINS)
    measures: list[MeasureSpec] = Field(default_factory=list, max_length=MAX_MEASURES)
    overview: str | None = Field(default=None, max_length=2000, description="Plain-language note for the dataset dictionary")

    @field_validator("tables")
    @classmethod
    def _unique_keys(cls, v: list[TableSpec]) -> list[TableSpec]:
        keys = [t.key for t in v]
        if len(keys) != len(set(keys)):
            raise ValueError("table keys must be unique")
        return v


def _measure_body(m: dict[str, Any]) -> dict[str, Any]:
    """The AppBI MeasureDefinition for a plan measure (structured fields only)."""
    body: dict[str, Any] = {"name": m["name"], "type": m["type"]}
    if m.get("column"):
        body["sql"] = m["column"]
    if m["type"] == "count" and not m.get("column"):
        body["sql"] = None
    if m.get("label"):
        body["label"] = m["label"]
    if m.get("description"):
        body["description"] = m["description"]
    if m.get("filters"):
        body["filters"] = m["filters"]
    if m["type"] == "formula":
        body["expression"] = m["expression"]
        body["depends_on"] = m["depends_on"]
    if m.get("format_kind"):
        fmt: dict[str, Any] = {"kind": m["format_kind"]}
        if m.get("decimals") is not None:
            fmt["decimals"] = m["decimals"]
        if m.get("currency"):
            fmt["currency"] = m["currency"]
        body["format"] = fmt
    return body


async def _source_columns(env: Env, ds_id: int, table: str) -> list[str]:
    res = await env.appbi.get(f"/datasets/datasources/{ds_id}/tables/columns", table=table)
    return [str(c.get("name")) for c in (res or {}).get("columns", [])]


@tool(scope=sc.READ, title="Plan a dataset", read_only=True)
async def plan_dataset(env: Env, plan: DatasetPlanInput) -> dict[str, Any]:
    """Validate a Dataset plan against AppBI and return an approval link. Writes nothing.

    Physical tables only. Joins go from the MANY side (fact) to the ONE side
    (dimension). AppBI refuses a join whose 'one' side key is not unique (fan-out),
    and the plan reports that before anything is created. Measures are checked
    again by AppBI's semantic engine when the plan runs.
    """
    p = plan
    errors: list[str] = []
    warnings: list[str] = []
    columns: dict[str, list[str]] = {}
    sources: dict[int, dict[str, Any]] = {}
    for t in p.tables:
        if t.data_source_id not in sources:
            try:
                sources[t.data_source_id] = await env.appbi.get(f"/datasources/{t.data_source_id}")
            except AppbiError as exc:
                errors.append(f"data source {t.data_source_id}: {exc.message}")
                continue
        try:
            listed = await env.appbi.get(f"/datasets/datasources/{t.data_source_id}/tables", search=t.source_table.split(".")[-1])
            names = {str(x.get("name")) for x in listed or []}
            if t.source_table not in names:
                errors.append(f"table '{t.source_table}' not found in data source {t.data_source_id} (available: {', '.join(sorted(names)[:15]) or 'none'})")
                continue
            columns[t.key] = await _source_columns(env, t.data_source_id, t.source_table)
        except AppbiError as exc:
            errors.append(f"table '{t.source_table}': {exc.message}")

    keys = {t.key for t in p.tables}
    for j in p.joins:
        for side, key, cols in (("from", j.from_table, j.from_columns), ("to", j.to_table, j.to_columns)):
            if key not in keys:
                errors.append(f"join {side}_table '{key}' is not one of the plan's tables")
            elif key in columns:
                missing = [c for c in cols if c not in columns[key]]
                if missing:
                    errors.append(f"join {j.from_table}→{j.to_table}: column(s) {missing} not in {key}")
        if j.cardinality == "many_to_many":
            warnings.append(f"{j.from_table}→{j.to_table} is many-to-many: totals across it can double count. Prefer a bridge table.")
    names_per_table: dict[str, set[str]] = {}
    for m in p.measures:
        if m.table not in keys:
            errors.append(f"measure '{m.name}': table '{m.table}' is not in the plan")
            continue
        seen = names_per_table.setdefault(m.table, set())
        if m.name in seen:
            errors.append(f"measure '{m.name}' is defined twice on {m.table}")
        seen.add(m.name)
        if m.column and m.table in columns and m.column not in columns[m.table]:
            errors.append(f"measure '{m.name}': column '{m.column}' not in {m.table}")
        for f in m.filters:
            if m.table in columns and f.field not in columns[m.table]:
                errors.append(f"measure '{m.name}': filter field '{f.field}' not in {m.table}")
    for m in p.measures:
        if m.type == "formula":
            missing = [d for d in m.depends_on if d not in names_per_table.get(m.table, set())]
            if missing:
                errors.append(f"formula '{m.name}' depends on measures not in this plan's {m.table}: {missing}")

    if errors:
        return {"status": "invalid", "errors": errors, "warnings": warnings}

    body = p.model_dump(mode="json")
    body["source_columns"] = columns
    summary = {
        "sections": [
            {"title": "Dataset", "items": [{"name": p.name, "description": p.description or "", "visibility": "Private draft (only you) until you publish it"}]},
            {"title": "Tables", "items": [
                {"key": t.key, "source": f"{sources.get(t.data_source_id, {}).get('name', t.data_source_id)} › {t.source_table}", "columns": len(columns.get(t.key, []))}
                for t in p.tables
            ]},
            {"title": "Relationships", "items": [
                {"from (many)": f"{j.from_table}.{', '.join(j.from_columns)}", "to (one)": f"{j.to_table}.{', '.join(j.to_columns)}", "cardinality": j.cardinality}
                for j in p.joins
            ] or ["None"]},
            {"title": "Measures", "items": [
                {"table": m.table, "name": m.name, "aggregation": m.type, "of": m.expression or m.column or "rows",
                 "filters": "; ".join(f"{f.field} {f.operator} {f.value}" for f in m.filters) or "—"}
                for m in p.measures
            ] or ["None"]},
            {"title": "What happens", "items": [
                "AppBI creates a draft dataset you own and adds the tables.",
                "AppBI builds the semantic model, checks every relationship key and runs every measure against the source.",
                "Anything AppBI refuses stops the run and is reported; nothing is forced and nothing is deleted.",
                "Nothing is published. Publishing is a separate approval.",
            ]},
        ],
        "warnings": warnings,
    }
    saved = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="dataset", body=body, summary=summary, fingerprint={})
    return {
        "status": "awaiting_approval",
        "plan_id": saved.id,
        "plan_hash": saved.plan_hash,
        "approval_url": env.approval_url(saved.id),
        "warnings": warnings,
        "next": "Ask the user to open approval_url and approve, then call execute_plan(plan_id).",
    }


# ── execution ───────────────────────────────────────────────────────────────────


async def run_dataset_plan(env: Env, run: Run) -> dict[str, Any]:
    plan: Plan = run.plan
    p = plan.body
    me = env.principal.user_id

    async def find_dataset(since: float) -> dict[str, Any] | None:
        """Adopt the dataset an unconfirmed create produced — only when that is certain.

        AppBI auto-suffixes a taken name ("Sales (1)"), so candidates are the exact
        name or name + " (n)", owned by this user, created after the attempt, and not
        already recorded as another plan's dataset. More than one candidate (e.g. two
        same-name plans racing) is ambiguous: fail closed instead of guessing.
        """
        import re

        pattern = re.compile(rf"^{re.escape(p['name'])}( \(\d+\))?$")
        claimed = env.plans.claimed_resource_ids("create_dataset", "dataset_id", exclude_plan=plan.id)
        rows = await env.appbi.get("/datasets/", skip=0, limit=500)
        found = [
            d for d in rows or []
            if str(d.get("owner_id")) == str(me) and pattern.match(str(d.get("name", "")))
            and (_ts(d.get("created_at")) or 0) >= since and int(d["id"]) not in claimed
        ]
        if len(found) > 1:
            raise OperationError(
                "partially_failed",
                f"Cannot tell which of {len(found)} new datasets named like '{p['name']}' this plan created; "
                "nothing was adopted or created. Check the datasets in AppBI.",
                step="create_dataset", detail=[{"id": d["id"], "name": d["name"]} for d in found],
            )
        return {"dataset_id": found[0]["id"], "name": found[0]["name"]} if found else None

    async def create_dataset() -> dict[str, Any]:
        body: dict[str, Any] = {"name": p["name"], "description": p.get("description"), "purpose": "reporting"}
        if p.get("overview"):
            # Written WITH the dataset: the dictionary PUT is last-write-wins with
            # no version, so this service never uses it (F4).
            body["dictionary"] = {"overview": p["overview"]}
        d = await env.appbi.post("/datasets/", body)
        return {"dataset_id": d["id"], "name": d["name"]}

    ds = await run.write("create_dataset", create_dataset, reconcile=find_dataset)
    dataset_id = int(ds["dataset_id"])
    run.resources.append({"type": "dataset", "id": dataset_id, "name": ds["name"], "url": env.link(f"/datasets/{dataset_id}?tab=model"), "state": "draft"})
    if ds["name"] != p["name"]:
        run.notes.append(f"AppBI named the dataset '{ds['name']}' because '{p['name']}' was already taken.")

    table_ids: dict[str, int] = {}
    for t in p["tables"]:
        async def add_table(t: dict[str, Any] = t) -> dict[str, Any]:
            res = await env.appbi.post(f"/datasets/{dataset_id}/tables", {
                "display_name": t.get("display_name") or t["source_table"].split(".")[-1],
                "source_kind": "physical_table",
                "datasource_id": t["data_source_id"],
                "source_table_name": t["source_table"],
                "enabled": True,
            })
            return {"dataset_table_id": res["id"], "columns": len(((res.get("columns_cache") or {}).get("columns")) or [])}

        async def find_table(_since: float, t: dict[str, Any] = t) -> dict[str, Any] | None:
            d = await env.appbi.get(f"/datasets/{dataset_id}")
            for row in d.get("tables", []):
                if row.get("datasource_id") == t["data_source_id"] and row.get("source_table_name") == t["source_table"]:
                    return {"dataset_table_id": row["id"], "columns": len(((row.get("columns_cache") or {}).get("columns")) or [])}
            return None

        res = await run.write(f"add_table:{t['key']}", add_table, reconcile=find_table)
        table_ids[t["key"]] = int(res["dataset_table_id"])
        if not res.get("columns"):
            raise OperationError("blocked", f"AppBI added table '{t['source_table']}' but could not read its columns.", step=f"add_table:{t['key']}")

    await run.write("generate_model", lambda: env.appbi.post(f"/datasets/{dataset_id}/generate-model"))
    model = await env.appbi.get(f"/datasets/{dataset_id}/model")
    view_by_table = {int(v["dataset_table_id"]): v for v in model.get("views", []) if v.get("dataset_table_id") is not None}
    missing_views = [k for k, tid in table_ids.items() if tid not in view_by_table]
    if missing_views:
        raise OperationError("blocked", f"AppBI did not create semantic views for: {missing_views}", step="generate_model")

    # ── relationships ──
    join_results: list[dict[str, Any]] = []
    for j in p["joins"]:
        key = f"join:{j['from_table']}->{j['to_table']}"
        fv = view_by_table[table_ids[j["from_table"]]]
        tv = view_by_table[table_ids[j["to_table"]]]
        existing = _existing_join(model, fv["name"], tv["name"], j["from_columns"], j["to_columns"])
        if existing is not None:
            have = existing.get("cardinality") or existing.get("relationship")
            if have != j["cardinality"] and not (have == "many_to_one" and j["cardinality"] == "one_to_many"):
                raise OperationError(
                    "blocked",
                    f"AppBI already has {j['from_table']}→{j['to_table']} as {have} (from {existing.get('origin', 'an earlier edit')}); "
                    f"the plan says {j['cardinality']}. Not changed — review it in AppBI.",
                    step=key,
                )
            join_results.append({"join": f"{j['from_table']}→{j['to_table']}", "result": "already_present", "origin": existing.get("origin")})
            continue
        evidence = await env.appbi.post(f"/datasets/{dataset_id}/model/joins/suggestion", {
            "from_view_id": fv["id"], "to_view_id": tv["id"], "from_columns": j["from_columns"], "to_columns": j["to_columns"],
        })
        if not evidence.get("can_create", True):
            raise OperationError("blocked", evidence.get("message") or "AppBI cannot create this relationship.", step=key, detail=evidence)

        async def add_join(fv: dict[str, Any] = fv, tv: dict[str, Any] = tv, j: dict[str, Any] = j) -> dict[str, Any]:
            await env.appbi.post(f"/datasets/{dataset_id}/model/joins", {
                "from_view_id": fv["id"], "to_view_id": tv["id"],
                "from_columns": j["from_columns"], "to_columns": j["to_columns"],
                "cardinality": j["cardinality"],
            })
            return {"cardinality": j["cardinality"]}

        async def find_join(_since: float, fv: dict[str, Any] = fv, tv: dict[str, Any] = tv, j: dict[str, Any] = j) -> dict[str, Any] | None:
            fresh = await env.appbi.get(f"/datasets/{dataset_id}/model")
            return {"cardinality": j["cardinality"]} if _existing_join(fresh, fv["name"], tv["name"], j["from_columns"], j["to_columns"]) else None

        try:
            await run.write(key, add_join, reconcile=find_join)
        except AppbiError as exc:
            raise OperationError(
                "blocked",
                f"AppBI refused {j['from_table']}→{j['to_table']} ({j['cardinality']}): {exc.message}",
                step=key,
                detail={"appbi": exc.as_dict(), "key_profile": {k: evidence.get(k) for k in ("from_unique", "to_unique", "from_distinct_count", "to_distinct_count", "relationship")}},
            ) from exc
        join_results.append({"join": f"{j['from_table']}→{j['to_table']}", "result": "created", "cardinality": j["cardinality"]})

    # ── measures: dry-run each through AppBI's semantic engine, then save per view ──
    measure_checks: list[dict[str, Any]] = []
    by_table: dict[str, list[dict[str, Any]]] = {}
    for m in p["measures"]:
        by_table.setdefault(m["table"], []).append(m)
    for table_key, measures in by_table.items():
        tid = table_ids[table_key]
        key = f"measures:{table_key}"
        if (rec := env.plans.step(plan.id, key)) and rec["status"] == "done":
            measure_checks.extend(rec["result"].get("checks", []))
            continue
        validated: dict[str, dict[str, Any]] = {}

        async def save_measures(tid: int = tid, measures: list[dict[str, Any]] = measures,
                                validated: dict[str, dict[str, Any]] = validated, key: str = key) -> dict[str, Any]:
            # Read → merge onto what is there → save QUOTING the version read. A
            # concurrent edit makes AppBI answer 409 view_stale; we re-read and merge
            # onto THAT state once, so nobody's acknowledged change is replaced (F4).
            for attempt in range(2):
                model = await env.appbi.get(f"/datasets/{dataset_id}/model")
                view = next(v for v in model["views"] if v.get("dataset_table_id") == tid)
                version = view.get("view_version")
                if not version:
                    raise OperationError(
                        "blocked",
                        "This AppBI version cannot protect a semantic view from concurrent edits (no view_version), "
                        "so no measures were written. Add them in AppBI, or upgrade AppBI.",
                        step=key,
                    )
                existing = {str(x.get("name")): x for x in view.get("measures", []) or []}
                new_bodies: list[dict[str, Any]] = []
                checks: list[dict[str, Any]] = []
                for m in measures:
                    body = _measure_body(m)
                    if m["name"] in existing:
                        checks.append({"measure": f"{view['name']}.{m['name']}", "result": "already_present"})
                        continue
                    if m["name"] not in validated:
                        dry = await env.appbi.post(f"/datasets/{dataset_id}/model/views/{view['id']}/measures/dry-run", body)
                        if not dry.get("ok"):
                            raise OperationError("blocked", f"AppBI rejected measure '{m['name']}': {dry.get('error')}", step=key,
                                                 detail={"compiled_sql": dry.get("compiled_sql")})
                        validated[m["name"]] = body
                    new_bodies.append(body)
                    checks.append({"measure": f"{view['name']}.{m['name']}", "result": "validated"})
                if not new_bodies:
                    return {"checks": checks}
                try:
                    await env.appbi.put(f"/datasets/{dataset_id}/model/views/{view['id']}", {
                        "dimensions": view.get("dimensions", []),
                        "measures": list(existing.values()) + new_bodies,
                        "expected_view_version": version,
                    })
                    return {"checks": checks}
                except AppbiError as exc:
                    stale = exc.status == 409 and isinstance(exc.detail, dict) and exc.detail.get("code") == "view_stale"
                    if stale and attempt == 0:
                        continue
                    if exc.status == 409:
                        raise OperationError("conflict", f"The semantic view kept changing while measures were added: {exc.message}",
                                             step=key, detail=exc.detail) from exc
                    raise
            raise OperationError("conflict", "Could not save measures.", step=key)

        async def find_view(_since: float, tid: int = tid, measures: list[dict[str, Any]] = measures) -> dict[str, Any] | None:
            fresh = await env.appbi.get(f"/datasets/{dataset_id}/model")
            v = next((x for x in fresh["views"] if x.get("dataset_table_id") == tid), {})
            names = {str(x.get("name")) for x in v.get("measures", []) or []}
            if all(m["name"] in names for m in measures):
                return {"checks": [{"measure": f"{v.get('name')}.{m['name']}", "result": "present"} for m in measures]}
            return None

        result = await run.write(key, save_measures, reconcile=find_view)
        measure_checks.extend(result.get("checks", []))

    # ── AppBI's verdict on the whole model ──
    health = await env.appbi.get(f"/datasets/{dataset_id}/model/health", execute="true")
    blocking = health.get("blocking") or []
    if blocking:
        raise OperationError("blocked", "AppBI's semantic health check reports blocking problems.", step="health", detail=blocking)

    # A sample of each new measure, computed by AppBI, so the user can sanity-check numbers.
    samples = []
    model = await env.appbi.get(f"/datasets/{dataset_id}/model")
    for m in p["measures"][:8]:
        view = next(v for v in model["views"] if v.get("dataset_table_id") == table_ids[m["table"]])
        try:
            prev = await env.appbi.post(f"/datasets/{dataset_id}/model/views/{view['id']}/measures/preview", {"measure": _measure_body(m)})
            rows = prev.get("rows") or []
            samples.append({"measure": f"{view['name']}.{m['name']}", "value": next(iter(rows[0].values())) if rows else None, "ok": prev.get("ok")})
        except AppbiError as exc:
            samples.append({"measure": f"{view['name']}.{m['name']}", "ok": False, "error": exc.message})

    return {
        "status": "draft_ready",
        "dataset_id": dataset_id,
        "tables": [{"key": k, "dataset_table_id": v, "view": view_by_table[v]["name"]} for k, v in table_ids.items()],
        "relationships": join_results,
        "measures": measure_checks,
        "measure_totals": samples,
        "semantic_health": (health.get("layers") or {}).get("semantic_health", {}).get("status"),
        "field_reference_hint": "Charts reference fields as '<view>.<field>', e.g. "
        + (f"'{view_by_table[next(iter(table_ids.values()))]['name']}.<column>'" if table_ids else "'dataset_table_1.amount'"),
    }


def _existing_join(model: dict[str, Any], from_view: str, to_view: str, from_cols: list[str], to_cols: list[str]) -> dict[str, Any] | None:
    for e in model.get("explores", []) or []:
        if e.get("base_view_name") != from_view:
            continue
        for j in e.get("joins", []) or []:
            if (j.get("view") or j.get("name")) == to_view and list(j.get("from_columns") or []) == list(from_cols) and list(j.get("to_columns") or []) == list(to_cols):
                return j
    return None


def _ts(value: Any) -> float | None:
    if not value:
        return None
    from datetime import datetime, timezone

    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()

