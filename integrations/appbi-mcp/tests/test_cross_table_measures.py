"""P5 (real Claude Desktop pilot, 2026-10-14): a measure filtered by a column of a JOINED
table ("revenue of delivered orders": order_items.price where orders.order_status =
'delivered') could not be planned. AppBI's engine supports it (a qualified filter field is
applied through the relationship); the MCP validator refused every qualified field."""
from __future__ import annotations

import json
import time
from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.context import Principal
from appbi_mcp.operations import PlanStore, Run
from appbi_mcp.state import StateStore
from appbi_mcp.tools.dataset import DatasetPlanInput, _measure_body, plan_dataset
from appbi_mcp.tools.runtime import Env

COLUMNS = {
    "shop.order_items": ["order_id", "price"],
    "shop.orders": ["order_id", "order_status"],
}


class SourceOnly:
    """Just the read routes plan_dataset uses."""

    async def get(self, path: str, **params: Any) -> Any:
        if path.startswith("/datasources/"):
            return {"id": 1, "name": "src", "type": "postgresql"}
        if path.endswith("/tables"):
            return [{"name": n} for n in COLUMNS]
        if path.endswith("/tables/columns"):
            return {"columns": [{"name": c} for c in COLUMNS[params["table"]]]}
        raise AssertionError(path)


@pytest.fixture
def env(tmp_path):
    store = StateStore(str(tmp_path / "s"), Fernet.generate_key())

    class App:
        class settings:
            public_url = appbi_public_url = "http://appbi"
            operation_budget_seconds = 60

    return Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.read"], "r"),  # type: ignore[arg-type]
               appbi=SourceOnly(), plans=PlanStore(store))


def _plan(joins: list[dict[str, Any]], field: str = "orders.order_status") -> DatasetPlanInput:
    return DatasetPlanInput.model_validate({
        "name": "Sales",
        "tables": [{"key": "order_items", "data_source_id": 1, "source_table": "shop.order_items"},
                   {"key": "orders", "data_source_id": 1, "source_table": "shop.orders"}],
        "joins": joins,
        "measures": [{"table": "order_items", "name": "delivered_revenue", "type": "sum", "column": "price",
                      "filters": [{"field": field, "operator": "eq", "value": "delivered"}]}],
    })


JOIN = [{"from_table": "order_items", "from_columns": ["order_id"], "to_table": "orders", "to_columns": ["order_id"]}]


async def test_a_filter_on_a_joined_table_is_planned(env):
    out = await plan_dataset(env, _plan(JOIN))
    assert out["status"] == "awaiting_approval", out


async def test_a_filter_on_a_table_the_plan_does_not_join_is_refused(env):
    out = await plan_dataset(env, _plan([]))
    assert out["status"] == "invalid"
    assert any("needs the plan to join" in e for e in out["errors"])


@pytest.mark.parametrize("field,why", [("customers.state", "not another table"), ("orders.no_such", "not in orders")])
async def test_unknown_table_or_column_in_a_qualified_filter_is_refused(env, field, why):
    out = await plan_dataset(env, _plan(JOIN, field))
    assert out["status"] == "invalid" and any(why in e for e in out["errors"]), out


def test_the_filter_reaches_appbi_as_a_semantic_view_reference():
    m = _plan(JOIN).model_dump(mode="json")["measures"][0]
    body = _measure_body(m, {"order_items": "dataset_table_704", "orders": "dataset_table_705"})
    assert body["filters"] == [{"field": "dataset_table_705.order_status", "operator": "eq", "value": "delivered"}]
    assert "where_sql" not in body and "expression" not in body   # structured filter only, never raw SQL
