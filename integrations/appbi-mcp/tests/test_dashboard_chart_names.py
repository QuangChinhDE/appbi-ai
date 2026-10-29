"""Chart names are unique per owner in AppBI, case-insensitively. Real Claude Desktop pilot
(2026-10-15): the plan kept "Monthly Revenue and Orders" because the owner's existing chart was
"Monthly revenue and orders"; AppBI refused the create and the build stopped mid-run."""
from __future__ import annotations

from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.context import Principal
from appbi_mcp.operations import PlanStore
from appbi_mcp.state import StateStore
from appbi_mcp.tools.dashboard import DashboardPlanInput, plan_dashboard
from appbi_mcp.tools.runtime import Env

MODEL = {"views": [{"name": "dataset_table_1", "dataset_table_id": 1, "dimensions": [{"name": "order_month"}],
                    "measures": [{"name": "revenue", "type": "sum"}]}], "explores": []}


class Fake:
    def __init__(self, existing: list[str]):
        self.existing = existing
        self.dry_names: list[str] = []

    async def get(self, path: str, **params: Any) -> Any:
        if path.endswith("/model"):
            return MODEL
        if path == "/dashboards/":
            return []
        if path == "/charts/":
            return {"items": [{"name": n} for n in self.existing]}
        raise AssertionError(path)

    async def post(self, path: str, body: Any = None, **params: Any) -> Any:
        assert path == "/charts/dry-run-create", path
        self.dry_names.append(body["name"])
        return {"ok": True, "normalized_config": body["config"], "runtime_preview_sample": []}


@pytest.fixture
def env_for(tmp_path):
    def make(fake: Fake) -> Env:
        class App:
            class settings:
                public_url = appbi_public_url = "http://appbi"
                operation_budget_seconds = 60
        return Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.read"], "r"),  # type: ignore[arg-type]
                   appbi=fake, plans=PlanStore(StateStore(str(tmp_path / "s"), Fernet.generate_key())))
    return make


def _plan(*titles: str) -> DashboardPlanInput:
    return DashboardPlanInput.model_validate({"dataset_id": 7, "dashboard_name": "Sales", "charts": [
        {"title": t, "chart_type": "KPI", "dataset_table_id": 1,
         "config": {"roleConfig": {"metrics": [{"field": "dataset_table_1.revenue", "agg": "auto"}]}}} for t in titles]})


async def test_an_existing_name_differing_only_in_case_is_a_clash(env_for):
    fake = Fake(existing=["Monthly revenue and orders"])
    out = await plan_dashboard(env_for(fake), _plan("Monthly Revenue and Orders"))
    assert out["status"] == "awaiting_approval"
    assert fake.dry_names == ["Monthly Revenue and Orders (2)"]


async def test_two_charts_in_one_plan_differing_only_in_case_get_distinct_names(env_for):
    fake = Fake(existing=[])
    await plan_dashboard(env_for(fake), _plan("Revenue", "REVENUE"))
    assert fake.dry_names == ["Revenue", "REVENUE (2)"]
