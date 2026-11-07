"""Sharing and shared-chart edits: planned, approved separately, AppBI decides."""

from __future__ import annotations

import time
from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.appbi_client import BODY_GUARDS, AppbiError, GuardViolation, match_route
from appbi_mcp.context import Principal
from appbi_mcp.operations import OperationError, PlanStore, Run
from appbi_mcp.state import StateStore
from appbi_mcp.tools import governance as gv
from appbi_mcp.tools.runtime import Env


class Fake:
    def __init__(self, owner: bool = True) -> None:
        self.owner = owner
        self.shares: list[dict[str, Any]] = []
        self.chart = {"id": 4, "name": "Rev", "chart_type": "BAR", "dataset_table_id": 9, "config": {"a": 1}, "updated_at": "t1"}
        self.calls: list[tuple[str, str, Any]] = []

    async def request(self, method: str, path: str, *, params=None, json=None, form=None) -> Any:
        t = match_route(method, path)
        assert t, path
        if BODY_GUARDS.get((method, t)):
            BODY_GUARDS[(method, t)](json)
        self.calls.append((method, path, json))
        if t == "/shares/{seg}/{id}":
            if not self.owner:
                raise AppbiError(403, "forbidden", "only the owner")
            if method == "GET":
                return self.shares
            self.shares.append({"id": len(self.shares) + 1, "permission": json["permission"], "user": {"email": json.get("email")}})
            return self.shares[-1]
        if t == "/shares/{seg}/{id}/entries/{id}":
            self.shares = [s for s in self.shares if s["id"] != int(path.rsplit("/", 1)[1])]
            return None
        if t == "/charts/{id}":
            if method == "PUT":
                self.chart.update(config=json["config"], updated_at="t2")
            return self.chart
        if t == "/charts/{id}/usage":
            return {"reports": [{"id": 1, "name": "Sales"}], "hidden_count": 1}
        if t == "/charts/dry-run-create":
            return {"ok": True, "normalized_config": json["config"], "runtime_preview_sample": [{"x": 1}]}
        if t == "/charts/{id}/data":
            return {"data": [{"x": 1}]}
        raise AssertionError(path)

    async def get(self, path: str, **p: Any) -> Any:
        return await self.request("GET", path)

    async def post(self, path: str, body: Any = None, **p: Any) -> Any:
        return await self.request("POST", path, json=body)

    async def put(self, path: str, body: Any = None, **p: Any) -> Any:
        return await self.request("PUT", path, json=body)


@pytest.fixture
def env_for(tmp_path):
    plans = PlanStore(StateStore(str(tmp_path / "s"), Fernet.generate_key()))

    class App:
        class settings:
            appbi_public_url = "http://appbi"
            public_url = "http://mcp"
            operation_budget_seconds = 60

    return lambda f: Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.author"], "r"), appbi=f, plans=plans)  # type: ignore[arg-type]


async def _run(env: Env, plan_id: str) -> dict[str, Any]:
    return await gv.run_governance(env, Run(plans=env.plans, plan=env.plans.get(plan_id, "u1"), deadline=time.time() + 60))


async def test_share_is_planned_then_granted_once(env_for):
    f = Fake()
    env = env_for(f)
    out = await gv.plan_share(env, "dashboard", 5, "view", email="b@x.com")
    assert out["status"] == "awaiting_approval" and not [c for c in f.calls if c[0] != "GET"]
    page = env.plans.get(out["plan_id"], "u1").summary
    assert any("does not share the dataset" in str(s) for s in page["sections"])
    await _run(env, out["plan_id"])
    await _run(env, out["plan_id"])
    assert len(f.shares) == 1
    un = await gv.plan_unshare(env, "dashboard", 5, 1)
    await _run(env, un["plan_id"])
    assert f.shares == []


async def test_non_owner_cannot_plan_a_share(env_for):
    assert (await gv.plan_share(env_for(Fake(owner=False)), "dataset", 5, "view", email="b@x.com"))["status"] == "forbidden"


async def test_shared_chart_edit_lists_every_affected_report_and_is_stale_checked(env_for):
    f = Fake()
    env = env_for(f)
    out = await gv.plan_chart_edit(env, 4, {"b": 2})
    assert out["affected_reports"] == 2 and out["preview"] == [{"x": 1}]
    f.chart["updated_at"] = "t9"  # someone saved the chart in Explore meanwhile
    with pytest.raises(OperationError) as err:
        await _run(env, out["plan_id"])
    assert err.value.status == "stale_plan" and not [c for c in f.calls if c[0] == "PUT"]


def test_share_guard():
    g = BODY_GUARDS[("POST", "/shares/{seg}/{id}")]
    for bad in ({"permission": "owner", "email": "a@x"}, {"permission": "view"}, {"permission": "view", "email": "a", "team_id": "t"}):
        with pytest.raises(GuardViolation):
            g(bad)
