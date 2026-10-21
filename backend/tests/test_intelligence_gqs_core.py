"""PR-1B unit locks for the Governed Query Service core (no database needed).

* bounds are min(policy, requested), never raised by a request (I-8);
* the AI BigQuery bytes limit is its OWN limit, compared with the warehouse
  ceiling, and only a BigQuery job carries it;
* GQS is NOT LIVE: nothing outside its package imports it, so no route, tool or
  Analyst can reach a warehouse through it before PR-1E/1C/1D and the Phase 1
  gate (PO: no new query path before policy, audit, limits and refusal tests).

The behaviour over a real engine and a real source is in
test_intelligence_gqs_execution_pg.py.
"""
from __future__ import annotations

import pathlib
import re
import types

import pytest

from app.services.governed_query import QueryBounds
from app.services.governed_query import bounds as B

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


@pytest.fixture()
def settings(monkeypatch):
    from app.core.config import settings as s

    monkeypatch.setattr(s, "GQS_MAX_ROWS", 5000)
    monkeypatch.setattr(s, "GQS_TIMEOUT_SECONDS", 60)
    monkeypatch.setattr(s, "AI_BQ_MAX_BYTES_PER_QUERY", 1 * 1024**3)
    monkeypatch.setattr(s, "BQ_MAX_BYTES_BILLED", 60 * 1024**3)
    return s


def test_the_ai_bytes_limit_is_its_own_not_the_warehouse_ceiling(settings):
    assert B.policy_bounds().bq_max_bytes == 1 * 1024**3


def test_a_lower_warehouse_ceiling_still_wins(settings):
    settings.BQ_MAX_BYTES_BILLED = 256 * 1024**2
    assert B.policy_bounds().bq_max_bytes == 256 * 1024**2


def test_a_request_only_lowers(settings):
    eff = B.effective_bounds(QueryBounds(max_rows=10**9, timeout_seconds=5, bq_max_bytes=10**15))
    assert eff == QueryBounds(max_rows=5000, timeout_seconds=5, bq_max_bytes=1 * 1024**3)


def test_zero_or_negative_is_one_never_unbounded(settings):
    eff = B.effective_bounds(QueryBounds(max_rows=0, timeout_seconds=-3, bq_max_bytes=0))
    assert eff == QueryBounds(max_rows=1, timeout_seconds=1, bq_max_bytes=1)


@pytest.mark.parametrize("ds_type,expected", [("bigquery", 12345), ("postgresql", None), ("mysql", None)])
def test_only_a_bigquery_job_carries_the_bytes_limit(monkeypatch, ds_type, expected):
    from app.services import relationship_key_guard
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.governed_query.service import GovernedQueryService

    seen = {}

    def fake_execute(**kw):
        seen.update(kw)
        return ["a"], [{"a": 1}], 0.0

    monkeypatch.setattr(DataSourceConnectionService, "execute_query", staticmethod(fake_execute))
    monkeypatch.setattr(relationship_key_guard, "verify_key_probes", lambda *a, **k: None)
    from app.services.governed_query import CancelRegistry

    compiled = types.SimpleNamespace(
        query_id="unit-q1",
        datasource=types.SimpleNamespace(id=1, config={}), ds_type=ds_type, sql="SELECT 1",
        key_probes=(), bounds=QueryBounds(max_rows=10, timeout_seconds=7, bq_max_bytes=12345))
    service = object.__new__(GovernedQueryService)
    service.cancel_registry = CancelRegistry()   # isolated; never the process registry
    GovernedQueryService._run(service, compiled)
    assert seen["maximum_bytes_billed"] == expected
    assert seen["max_rows"] == 11 and seen["timeout_seconds"] == 7 and seen["limit"] is None


#: PR-1G: the ONLY code outside the package that may reach GQS. A new consumer
#: is a reviewed change to this set, not a side effect.
APPROVED_CONSUMERS = {"api/analyst.py", "services/analyst/service.py", "services/analyst/catalog.py"}


def test_only_the_approved_consumers_reach_gqs():
    rx = re.compile(r"\bgoverned_query\b")
    hits = []
    for path in APP.rglob("*.py"):
        rel = path.relative_to(APP).as_posix()
        if rel.startswith("services/governed_query/") or "/__pycache__/" in rel:
            continue
        if rx.search(path.read_text(encoding="utf-8-sig")):
            hits.append(rel)
    assert sorted(set(hits) - APPROVED_CONSUMERS) == [], (
        "GQS is wired into " + ", ".join(sorted(set(hits) - APPROVED_CONSUMERS)) + " outside the approved "
        "consumers. A new query path through GQS is a reviewed PR that extends APPROVED_CONSUMERS.")


def test_the_analyst_is_mounted_only_behind_its_flag():
    text = (APP / "api" / "__init__.py").read_text(encoding="utf-8")
    block = text[text.index("if settings.ANALYST_ENABLED:"):]
    assert "analyst_router" in block.split("\n\n")[0]
    assert text.count("analyst_router") == 2, "the Analyst router is included outside its flag"
