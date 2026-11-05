"""Editing an existing dashboard: every change goes to the caller's DRAFT endpoint.

The fake records calls and answers the dashboard shape AppBI returns; it is not a
model of the Builder's validation (the live rig covers that).
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.appbi_client import BODY_GUARDS, AppbiError, GuardViolation, _REQUIRED_PARAMS, match_route
from appbi_mcp.context import Principal
from appbi_mcp.operations import OperationError, PlanStore, Run
from appbi_mcp.state import StateStore
from appbi_mcp.tools import dashboard_edit as de
from appbi_mcp.tools.runtime import Env


class Builder:
    def __init__(self, permission: str = "edit") -> None:
        self.d = {
            "id": 5, "name": "Sales", "user_permission": permission, "has_draft": False,
            "shared_draft": {"rev": "r1"}, "pages_config": [{"id": "overview"}], "responsive_layouts": None,
            "draft_layouts": None, "slicers_config": [{"id": "f-region", "label": "Region"}],
            "dashboard_charts": [
                {"id": 11, "chart_id": 101, "chart": {"name": "Revenue", "chart_type": "KPI", "dataset_table_id": 9},
                 "widget_type": None, "layout": {"x": 0, "y": 0, "w": 6, "h": 4, "pageId": "overview", "_v": 2}},
                {"id": 12, "chart_id": None, "chart": None, "widget_type": "text", "widget_config": {"text": "old"},
                 "layout": {"x": 6, "y": 0, "w": 6, "h": 2, "pageId": "overview", "_v": 1}},
            ],
        }
        self.calls: list[tuple[str, str, Any, Any]] = []
        self.dry_ok = True

    async def request(self, method: str, path: str, *, params=None, json=None, form=None) -> Any:
        template = match_route(method, path)
        assert template, f"{method} {path} not allowlisted"
        for k, v in _REQUIRED_PARAMS.get((method, template), {}).items():
            if str((params or {}).get(k, "")).lower() != v:
                raise GuardViolation("live write")
        guard = BODY_GUARDS.get((method, template))
        if guard:
            guard(json)
        self.calls.append((method, path, params, json))
        if method == "GET" and template == "/dashboards/{id}":
            return self.d
        if template == "/charts/{id}":
            return {"id": 101, "dataset_table_id": 9, "chart_type": "KPI", "name": "Other"}
        if template == "/charts/dry-run-create":
            return {"ok": self.dry_ok, "normalized_config": json["config"], "runtime_preview_sample": [{"revenue": 123}],
                    "validation_errors": None if self.dry_ok else ["bad field"]}
        if template == "/dashboards/{id}/draft-layout":
            self.d["draft_layouts"] = {str(e["id"]): e["layout"] for e in json["chart_layouts"]}
        if template == "/dashboards/{id}/draft-filters" and json["base_rev"] != self.d["shared_draft"]["rev"]:
            raise AppbiError(409, "conflict", "stale")
        self.d["has_draft"] = True
        return self.d

    async def get(self, path: str, **params: Any) -> Any:
        return await self.request("GET", path, params=params or None)

    async def post(self, path: str, body: Any = None, **params: Any) -> Any:
        return await self.request("POST", path, json=body, params=params or None)

    async def put(self, path: str, body: Any = None, **params: Any) -> Any:
        return await self.request("PUT", path, json=body, params=params or None)

    def writes(self) -> list[tuple[str, str, Any, Any]]:
        return [c for c in self.calls if c[0] != "GET" and not c[1].endswith("dry-run-create")]


@pytest.fixture
def env_for(tmp_path):
    plans = PlanStore(StateStore(str(tmp_path / "s"), Fernet.generate_key()))

    class App:
        class settings:
            appbi_public_url = "http://appbi"
            public_url = "http://mcp"
            operation_budget_seconds = 60

    return lambda b: Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.author"], "r"), appbi=b, plans=plans)  # type: ignore[arg-type]


def _ops(*items: dict[str, Any]) -> list[Any]:
    from pydantic import TypeAdapter

    return TypeAdapter(list[de.EditOp]).validate_python(list(items))


async def _run(env: Env, plan_id: str) -> dict[str, Any]:
    plan = env.plans.get(plan_id, "u1")
    return await de.run_dashboard_edit(env, Run(plans=env.plans, plan=plan, deadline=time.time() + 60))


async def test_every_edit_goes_to_the_draft_endpoint(env_for):
    b = Builder()
    env = env_for(b)
    out = await de.plan_dashboard_edit(env, 5, _ops(
        {"op": "layout", "tile_id": 11, "w": 12, "title": "Revenue (VND)"},
        {"op": "widget", "tile_id": 12, "widget_config": {"text": "new"}},
        {"op": "remove", "tile_id": 12},
        {"op": "edit_chart", "tile_id": 11, "config": {"roleConfig": {"metrics": []}}},
        {"op": "responsive", "page_id": "overview", "breakpoint": "xs", "items": {"11": {"x": 0, "y": 0, "w": 36, "h": 4}}},
        {"op": "remove_filter", "filter_id": "f-region"},
    ))
    assert out["status"] == "awaiting_approval" and b.writes() == []
    assert out["previews"][0]["rows"] == [{"revenue": 123}]  # real dry-run numbers on the approval page
    res = await _run(env, out["plan_id"])
    assert res["status"] == "draft_ready"
    routes = [(m, p, (pr or {}).get("draft")) for m, p, pr, _ in b.writes()]
    assert routes == [
        ("PUT", "/dashboards/5/draft-layout", None), ("PATCH", "/dashboards/5/widgets/12", "true"),
        ("DELETE", "/dashboards/5/charts/12", "true"), ("POST", "/dashboards/5/charts/11/fork-chart", None),
        ("PUT", "/dashboards/5/draft-responsive", None), ("PUT", "/dashboards/5/draft-filters", None)]
    layout = b.writes()[0][3]["chart_layouts"][0]["layout"]
    assert layout["w"] == 12 and layout["custom_title"] == "Revenue (VND)" and "_v" not in layout


async def test_resume_does_not_repeat_steps(env_for):
    b = Builder()
    env = env_for(b)
    out = await de.plan_dashboard_edit(env, 5, _ops({"op": "remove", "tile_id": 12}))
    await _run(env, out["plan_id"])
    await _run(env, out["plan_id"])
    assert len(b.writes()) == 1


async def test_a_co_author_change_after_planning_stops_the_run(env_for):
    b = Builder()
    env = env_for(b)
    out = await de.plan_dashboard_edit(env, 5, _ops({"op": "layout", "tile_id": 11, "x": 3}))
    b.d["dashboard_charts"][0]["layout"]["_v"] = 3  # a co-author published this tile
    with pytest.raises(OperationError) as err:
        await _run(env, out["plan_id"])
    assert err.value.status == "stale_plan" and b.writes() == []


async def test_viewer_cannot_plan_and_bad_ops_are_refused(env_for):
    assert (await de.plan_dashboard_edit(env_for(Builder("view")), 5, _ops({"op": "remove", "tile_id": 11})))["status"] == "forbidden"
    b = Builder()
    b.dry_ok = False
    out = await de.plan_dashboard_edit(env_for(b), 5, _ops(
        {"op": "remove", "tile_id": 999}, {"op": "widget", "tile_id": 11, "widget_config": {}},
        {"op": "edit_chart", "tile_id": 11, "config": {}}, {"op": "layout", "tile_id": 11, "x": 30, "w": 12},
        {"op": "responsive", "page_id": "nope", "breakpoint": "md", "auto": True}))
    assert out["status"] == "invalid" and len(out["errors"]) == 5


def test_draft_layout_guard_refuses_draft_row_keys():
    with pytest.raises(GuardViolation):
        BODY_GUARDS[("PUT", "/dashboards/{id}/draft-layout")]({"chart_layouts": [{"id": 1, "layout": {"draftOnly": True}}]})
