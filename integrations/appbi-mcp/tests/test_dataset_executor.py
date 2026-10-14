"""Dataset execution against a scripted AppBI: concurrency (F4) and fail-closed paths.

The fake implements only the endpoints the Dataset executor calls, with AppBI's
view-version contract (`view_version`, `expected_view_version` → 409 view_stale).
It is not a model of AppBI's validation; live tests cover that.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.appbi_client import AppbiError, BODY_GUARDS, match_route
from appbi_mcp.context import Principal
from appbi_mcp.operations import OperationError, PlanStore, Run
from appbi_mcp.state import StateStore
from appbi_mcp.tools.dataset import run_dataset_plan
from appbi_mcp.tools.runtime import Env


def _version(view: dict[str, Any]) -> str:
    blob = json.dumps({"d": view["dimensions"], "m": view["measures"]}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


class ScriptedAppbi:
    def __init__(self, *, versioned: bool = True) -> None:
        self.versioned = versioned
        self.datasets: dict[int, dict[str, Any]] = {}
        self.views: dict[int, dict[str, Any]] = {}
        self.calls: list[tuple[str, str, Any]] = []
        self.before_put_view: Any = None  # hook: a concurrent writer acting between read and save
        self.refuse_dry_run = False

    def _model(self, ds_id: int) -> dict[str, Any]:
        views = []
        for v in self.views.values():
            if v["dataset_id"] == ds_id:
                out = {k: v[k] for k in ("id", "name", "dataset_table_id", "dimensions", "measures")}
                if self.versioned:
                    out["view_version"] = _version(v)
                views.append(out)
        return {"views": views, "explores": []}

    async def _call(self, method: str, path: str, body: Any = None, params: dict | None = None) -> Any:
        template = match_route(method, path)
        assert template, f"{method} {path} not allowlisted"
        guard = BODY_GUARDS.get((method, template))
        if guard:
            guard(body)
        self.calls.append((method, path, body))
        parts = path.strip("/").split("/")
        if method == "GET" and path == "/datasets/":
            return [dict(d, created_at="2999-01-01T00:00:00") for d in self.datasets.values()]
        if method == "POST" and path == "/datasets/":
            ds_id = len(self.datasets) + 1
            self.datasets[ds_id] = {"id": ds_id, "name": body["name"], "owner_id": "u1", "tables": [], "dictionary": body.get("dictionary")}
            return self.datasets[ds_id]
        ds_id = int(parts[1])
        if method == "POST" and template == "/datasets/{id}/tables":
            tid = 100 + len(self.views)
            self.datasets[ds_id]["tables"].append({"id": tid, "datasource_id": body["datasource_id"], "source_table_name": body["source_table_name"]})
            self.views[tid] = {"id": tid, "dataset_id": ds_id, "name": f"dataset_table_{tid}", "dataset_table_id": tid,
                               "dimensions": [{"name": "amount", "type": "number"}], "measures": []}
            return {"id": tid, "columns_cache": {"columns": [{"name": "amount"}]}}
        if method == "GET" and template == "/datasets/{id}":
            return self.datasets[ds_id]
        if template == "/datasets/{id}/generate-model":
            return {"generated": True}
        if template == "/datasets/{id}/model":
            return self._model(ds_id)
        if template.endswith("/measures/dry-run"):
            if self.refuse_dry_run:
                return {"ok": False, "error": "refused by AppBI"}
            if body.get("type") == "formula":
                # Like the real engine: only ${name} is a measure; any other identifier
                # left in the expression is compiled as a column of the view.
                bare = re.sub(r"\$\{[^}]*\}", " ", body.get("expression") or "")
                unknown = [t for t in re.findall(r"[A-Za-z_]\w*", bare) if t != "amount"]
                if unknown:
                    return {"ok": False, "error": f"Unrecognized name: {unknown[0]}", "compiled_sql": f"SELECT {body['expression']}"}
                # The candidate is checked against the view AS SAVED: a referenced
                # measure that is not on it yet is unknown to the engine.
                saved = {m["name"] for m in self.views[int(parts[-3])]["measures"]}
                missing = [r for r in re.findall(r"\$\{([^}.]+)\}", body["expression"]) if r not in saved]
                if missing:
                    return {"ok": False, "error": f"Unknown semantic field in measure formula: {missing[0]}"}
            return {"ok": True}
        if template.endswith("/measures/preview"):
            return {"ok": True, "rows": [{"v": 1}]}
        if template == "/datasets/{id}/model/health":
            return {"blocking": [], "layers": {"semantic_health": {"status": "pass"}}}
        if method == "PUT" and template == "/datasets/{id}/model/views/{id}":
            view = self.views[int(parts[-1])]
            if self.before_put_view:
                hook, self.before_put_view = self.before_put_view, None
                hook(view)
            if self.versioned and body.get("expected_view_version") != _version(view):
                raise AppbiError(409, "conflict", "stale", {"code": "view_stale", "view_version": _version(view)})
            view["dimensions"], view["measures"] = body["dimensions"], body["measures"]
            return view
        raise AssertionError(f"unexpected {method} {path}")

    async def get(self, path: str, **params: Any) -> Any:
        return await self._call("GET", path, params=params)

    async def post(self, path: str, body: Any = None, **params: Any) -> Any:
        return await self._call("POST", path, body, params)

    async def put(self, path: str, body: Any = None, **params: Any) -> Any:
        return await self._call("PUT", path, body, params)


PLAN = {
    "name": "Sales", "description": None, "overview": "What this dataset is for",
    "tables": [{"key": "orders", "data_source_id": 1, "source_table": "shop.orders", "display_name": None}],
    "joins": [],
    "measures": [{"table": "orders", "name": "revenue", "type": "sum", "column": "amount", "filters": [], "depends_on": []}],
}


@pytest.fixture
def setup(tmp_path):
    store = StateStore(str(tmp_path / "s"), Fernet.generate_key())
    plans = PlanStore(store)

    def make(appbi: ScriptedAppbi):
        plan = plans.create(user_id="u1", grant_id="g", kind="dataset", body=json.loads(json.dumps(PLAN)), summary={}, fingerprint={})

        class App:  # just what Env.link needs
            class settings:
                appbi_public_url = "http://appbi"
                public_url = "http://appbi"
                operation_budget_seconds = 60

        env = Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.author"], "r"), appbi=appbi, plans=plans)  # type: ignore[arg-type]
        return env, Run(plans=plans, plan=plan, deadline=time.time() + 60)

    return make


async def test_dictionary_is_written_with_the_dataset_and_never_put(setup):
    appbi = ScriptedAppbi()
    env, run = setup(appbi)
    result = await run_dataset_plan(env, run)
    assert result["status"] == "draft_ready"
    assert appbi.datasets[1]["dictionary"] == {"overview": "What this dataset is for"}
    assert not [c for c in appbi.calls if c[1].endswith("/dictionary")]


async def test_concurrent_view_edit_is_not_overwritten(setup):
    appbi = ScriptedAppbi()
    env, run = setup(appbi)
    # Between the MCP's read and its save, a user adds a measure in the Visual Model editor.
    appbi.before_put_view = lambda view: view["measures"].append({"name": "users_edit", "type": "count"})
    result = await run_dataset_plan(env, run)
    assert result["status"] == "draft_ready"
    names = [m["name"] for m in next(iter(appbi.views.values()))["measures"]]
    assert names == ["users_edit", "revenue"]  # the user's acknowledged edit survives; ours merged onto it
    puts = [c for c in appbi.calls if c[0] == "PUT"]
    assert len(puts) == 2 and all(c[2]["expected_view_version"] for c in puts)


async def test_unversioned_appbi_fails_closed(setup):
    appbi = ScriptedAppbi(versioned=False)
    env, run = setup(appbi)
    with pytest.raises(OperationError) as err:
        await run_dataset_plan(env, run)
    assert err.value.status == "blocked" and "view_version" in err.value.message
    assert not [c for c in appbi.calls if c[0] == "PUT"]


async def test_persistent_concurrent_edits_end_in_conflict_not_overwrite(setup):
    appbi = ScriptedAppbi()
    env, run = setup(appbi)

    def keep_editing(view):
        view["measures"].append({"name": f"edit_{len(view['measures'])}", "type": "count"})
        appbi.before_put_view = keep_editing

    appbi.before_put_view = keep_editing
    with pytest.raises(OperationError) as err:
        await run_dataset_plan(env, run)
    assert err.value.status == "conflict"
    names = [m["name"] for m in next(iter(appbi.views.values()))["measures"]]
    assert "revenue" not in names and all(n.startswith("edit_") for n in names)


FORMULA_MEASURES = [
    {"table": "orders", "name": "revenue", "type": "sum", "column": "amount", "filters": [], "depends_on": []},
    {"table": "orders", "name": "orders", "type": "count", "column": None, "filters": [], "depends_on": []},
    {"table": "orders", "name": "aov", "type": "formula", "expression": "revenue / orders", "filters": [],
     "depends_on": ["revenue", "orders"]},
    {"table": "orders", "name": "gross_revenue", "type": "formula", "expression": "${revenue} + revenue * 0", "filters": [],
     "depends_on": ["revenue"]},
]


async def test_formula_measures_reach_appbi_as_measure_placeholders(setup):
    """Real Claude Desktop pilot (2026-10-14): 'revenue + freight' reached AppBI verbatim,
    the engine compiled `revenue` as a column and the whole measures step stopped."""
    appbi = ScriptedAppbi()
    env, run = setup(appbi)
    run.plan.body["measures"] = json.loads(json.dumps(FORMULA_MEASURES))
    result = await run_dataset_plan(env, run)
    assert result["status"] == "draft_ready"
    saved = {m["name"]: m for m in next(iter(appbi.views.values()))["measures"]}
    assert saved["aov"]["expression"] == "${revenue} / ${orders}"
    assert saved["gross_revenue"]["expression"] == "${revenue} + ${revenue} * 0"   # existing placeholder kept
    # Bases were saved before the formulas that reference them (one PUT per layer).
    puts = [c[2]["measures"] for c in appbi.calls if c[0] == "PUT"]
    assert [m["name"] for m in puts[0]] == ["revenue", "orders"] and len(puts) == 2


async def test_a_refused_measure_fails_its_step_and_a_rerun_resumes_without_duplicates(setup):
    appbi = ScriptedAppbi()
    env, run = setup(appbi)
    appbi.refuse_dry_run = True
    with pytest.raises(OperationError) as err:
        await run_dataset_plan(env, run)
    assert err.value.status == "blocked"
    assert env.plans.step(run.plan.id, "measures:orders")["status"] == "failed"   # not left `sent`
    appbi.refuse_dry_run = False
    rerun = Run(plans=env.plans, plan=run.plan, deadline=time.time() + 60)
    result = await run_dataset_plan(env, rerun)
    assert result["status"] == "draft_ready"
    assert len(appbi.datasets) == 1 and len([c for c in appbi.calls if c[:2] == ("POST", "/datasets/")]) == 1


# ── adversarial review regressions ──────────────────────────────────────────────


async def test_reconcile_refuses_to_guess_between_same_name_datasets(setup):
    """Two same-name plans raced; AppBI suffixed one. An unconfirmed create must not
    adopt a dataset it cannot prove is its own."""
    appbi = ScriptedAppbi()
    env, run = setup(appbi)
    await appbi.post("/datasets/", {"name": "Sales", "purpose": "reporting"})
    await appbi.post("/datasets/", {"name": "Sales (1)", "purpose": "reporting"})
    env.plans.mark(run.plan.id, "create_dataset", "sent")  # outcome of our own create unknown
    with pytest.raises(OperationError) as err:
        await run_dataset_plan(env, run)
    assert err.value.status == "partially_failed" and "Cannot tell" in err.value.message
    assert len(appbi.datasets) == 2  # nothing adopted, nothing created


async def test_reconcile_skips_datasets_other_plans_already_own(setup):
    appbi = ScriptedAppbi()
    env, run = setup(appbi)
    other = await appbi.post("/datasets/", {"name": "Sales", "purpose": "reporting"})
    other_plan = env.plans.create(user_id="u1", grant_id="g", kind="dataset", body={"x": 1}, summary={}, fingerprint={})
    env.plans.mark(other_plan.id, "create_dataset", "done", result={"dataset_id": other["id"], "name": "Sales"})
    env.plans.mark(run.plan.id, "create_dataset", "sent")
    result = await run_dataset_plan(env, run)
    assert result["status"] == "draft_ready" and result["dataset_id"] != other["id"]


async def test_model_change_after_planning_stops_a_dashboard_plan(setup):
    from appbi_mcp.tools.dashboard import model_fingerprint, run_dashboard_plan

    appbi = ScriptedAppbi()
    env, _ = setup(appbi)
    ds = await appbi.post("/datasets/", {"name": "D", "purpose": "reporting"})
    await appbi.post(f"/datasets/{ds['id']}/tables", {"display_name": "t", "source_kind": "physical_table", "datasource_id": 1, "source_table_name": "s.t"})
    planned = model_fingerprint(appbi._model(ds["id"]))
    next(iter(appbi.views.values()))["measures"].append({"name": "added_in_ui", "type": "count"})  # model changes
    plan = env.plans.create(user_id="u1", grant_id="g", kind="dashboard",
                            body={"dataset_id": ds["id"], "dashboard_id": None, "dashboard_name": "X", "charts": [], "filters": []},
                            summary={}, fingerprint={"model": planned})
    with pytest.raises(OperationError) as err:
        await run_dashboard_plan(env, Run(plans=env.plans, plan=plan, deadline=time.time() + 60))
    assert err.value.status == "stale_plan"
    assert not [c for c in appbi.calls if c[0] in ("POST", "PUT") and "dashboards" in c[1]]


async def test_token_revoked_mid_run_ends_the_connection(setup):
    from appbi_mcp.tools.publish import _run

    appbi = ScriptedAppbi()
    env, run = setup(appbi)
    revoked: list[tuple[str, str]] = []

    class Provider:
        def revoke_grant(self, grant_id: str, reason: str) -> None:
            revoked.append((grant_id, reason))

    env.app.provider = Provider()
    env.plans.start_operation(run.plan)

    async def body(_env, _run):
        raise AppbiError(401, "unauthorized", "Invalid or expired token")

    result = await _run(env, run.plan, body)
    assert result["status"] == "credential_revoked"
    assert revoked == [("g", "appbi_401_during_operation")]
    assert env.plans.operation(run.plan.id)["status"] == "credential_revoked"
