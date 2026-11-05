"""Editing an existing data model: AppBI's version contract and guards decide."""

from __future__ import annotations

import time
from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.appbi_client import BODY_GUARDS, FORM_ROUTES, AppbiError, GuardViolation, match_route
from appbi_mcp.context import Principal
from appbi_mcp.operations import OperationError, PlanStore, Run
from appbi_mcp.state import StateStore
from appbi_mcp.tools import model_edit as me
from appbi_mcp.tools.runtime import Env


class Model:
    def __init__(self) -> None:
        self.version = 1
        self.view = {"id": 3, "name": "orders", "dataset_table_id": 9,
                     "dimensions": [{"name": "status", "type": "string"}, {"name": "amount", "type": "number"}],
                     "measures": [{"name": "revenue", "type": "sum", "sql": "amount"}]}
        self.transformations: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str, Any]] = []
        self.used_by_charts = {"revenue"}

    async def _call(self, method: str, path: str, body: Any = None, form: Any = None) -> Any:
        template = match_route(method, path)
        assert template, f"{method} {path}"
        g = BODY_GUARDS.get((method, template))
        if g:
            g(form if (method, template) in FORM_ROUTES else body)
        self.calls.append((method, path, body or form))
        if template == "/datasets/{id}":
            return {"id": 1, "name": "Sales", "tables": [{"id": 9, "transformations": self.transformations}]}
        if template == "/datasets/{id}/model":
            return {"views": [{**self.view, "view_version": f"v{self.version}"}], "explores": []}
        if template.endswith("/measures/dry-run"):
            return {"ok": True, "compiled_sql": "SELECT SUM(amount)"}
        if template.endswith("/measures/preview"):
            return {"ok": True, "rows": [{"v": 2253900}]}
        if template == "/datasets/{id}/tables/{id}/preview":
            return {"columns": [{"name": "amount", "type": "number"}], "rows": [{"amount": 10}, {"amount": 20}]}
        if template == "/dashboards/import-html/preview-calculated":
            return {"rows": [{"amount": 10, "amount_k": 0.01}], "errors": []}
        if template == "/datasets/{id}/model/views/{id}":
            if body["expected_view_version"] != f"v{self.version}":
                raise AppbiError(409, "conflict", "stale", {"code": "view_stale"})
            removed = {m["name"] for m in self.view["measures"]} - {m["name"] for m in body["measures"]}
            if removed & self.used_by_charts:
                raise AppbiError(409, "conflict", "Measure revenue is used by 2 charts")
            self.view.update(dimensions=body["dimensions"], measures=body["measures"])
            self.version += 1
            return {}
        if template == "/datasets/{id}/tables/{id}":
            self.transformations = body["transformations"]
            return {}
        if template == "/datasets/{id}/model/health":
            return {"blocking": []}
        raise AssertionError(path)

    async def get(self, path: str, **_: Any) -> Any:
        return await self._call("GET", path)

    async def post(self, path: str, body: Any = None, **_: Any) -> Any:
        return await self._call("POST", path, body)

    async def put(self, path: str, body: Any = None, **_: Any) -> Any:
        return await self._call("PUT", path, body)

    async def post_form(self, path: str, form: dict[str, Any]) -> Any:
        return await self._call("POST", path, form=form)

    def writes(self) -> list[tuple[str, str, Any]]:
        return [c for c in self.calls if c[0] == "PUT" or c[1].endswith("/tables") or c[1].endswith("/joins")]


@pytest.fixture
def env_for(tmp_path):
    plans = PlanStore(StateStore(str(tmp_path / "s"), Fernet.generate_key()))

    class App:
        class settings:
            appbi_public_url = "http://appbi"
            public_url = "http://mcp"
            operation_budget_seconds = 60

    return lambda m: Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.author"], "r"), appbi=m, plans=plans)  # type: ignore[arg-type]


def _ops(*items: dict[str, Any]) -> list[Any]:
    from pydantic import TypeAdapter

    return TypeAdapter(list[me.ModelOp]).validate_python(list(items))


async def _run(env: Env, plan_id: str) -> dict[str, Any]:
    return await me.run_model_edit(env, Run(plans=env.plans, plan=env.plans.get(plan_id, "u1"), deadline=time.time() + 60))


async def test_plan_previews_real_values_and_writes_nothing(env_for):
    m = Model()
    env = env_for(m)
    out = await me.plan_model_edit(env, 1, _ops(
        {"op": "upsert_measure", "view": "orders", "name": "completed_revenue", "type": "sum", "column": "amount",
         "filters": [{"field": "status", "operator": "eq", "value": "completed"}]},
        {"op": "update_dimension", "view": "orders", "name": "status", "label": "Order status"},
        {"op": "add_calculated_column", "view": "orders", "name": "amount_k", "expression": "amount / 1000"}))
    assert out["status"] == "awaiting_approval" and m.writes() == []
    assert out["previews"][0]["items"][0]["value now"] == 2253900
    assert out["previews"][1]["items"][0]["amount_k"] == 0.01
    res = await _run(env, out["plan_id"])
    assert res["status"] == "draft_ready"
    assert [x["name"] for x in m.view["measures"]] == ["revenue", "completed_revenue"]
    assert m.view["dimensions"][0]["label"] == "Order status"
    assert m.transformations[0]["params"] == {"newField": "amount_k", "expression": "amount / 1000"}
    puts = [c for c in m.calls if c[0] == "PUT" and "/views/" in c[1]]
    assert all(c[2]["expected_view_version"] for c in puts)


async def test_a_concurrent_model_edit_makes_the_plan_stale(env_for):
    m = Model()
    env = env_for(m)
    out = await me.plan_model_edit(env, 1, _ops({"op": "update_dimension", "view": "orders", "name": "status", "hidden": True}))
    m.version += 1  # someone saved the view in the Visual Model editor
    with pytest.raises(OperationError) as err:
        await _run(env, out["plan_id"])
    assert err.value.status == "stale_plan" and m.writes() == []


async def test_removing_a_measure_charts_use_is_refused_never_forced(env_for):
    m = Model()
    env = env_for(m)
    out = await me.plan_model_edit(env, 1, _ops({"op": "remove_measure", "view": "orders", "name": "revenue"}))
    with pytest.raises(OperationError) as err:
        await _run(env, out["plan_id"])
    assert err.value.status == "blocked" and "chart" in err.value.message
    assert [x["name"] for x in m.view["measures"]] == ["revenue"]


async def test_unknown_view_and_field_are_refused(env_for):
    out = await me.plan_model_edit(env_for(Model()), 1, _ops(
        {"op": "update_dimension", "view": "nope", "name": "x", "label": "y"},
        {"op": "remove_measure", "view": "orders", "name": "missing"}))
    assert out["status"] == "invalid" and len(out["errors"]) == 2


def test_table_update_guard_allows_only_transformations():
    g = BODY_GUARDS[("PUT", "/datasets/{id}/tables/{id}")]
    g({"transformations": []})
    for bad in ({"source_query": "select 1"}, {"transformations": [], "display_name": "x"}):
        with pytest.raises(GuardViolation):
            g(bad)
    with pytest.raises(GuardViolation):
        BODY_GUARDS[("POST", "/datasets/{id}/tables/{id}/preview")]({"limit": 50, "refresh_schema": True})
