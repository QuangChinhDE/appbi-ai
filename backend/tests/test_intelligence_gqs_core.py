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


@pytest.mark.parametrize("outcome", ["ok", "error"])
def test_a_bigquery_read_records_the_bytes_it_scanned(monkeypatch, outcome):
    """Acceptance on the real stack (2026-10-27): every BigQuery read was finished
    with bytes_processed=None, so the per-user daily byte budget charged each one
    its full reservation (1 GiB) - a user was refused after ~20 questions on tables
    of a few KB. The job's own byte count is recorded, in the ledger and in the
    evidence, whatever the outcome once the job has run."""
    from app.services import relationship_key_guard
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.governed_query import CancelRegistry
    from app.services.governed_query.service import GovernedQueryService

    def fake_execute(**kw):
        kw["on_job_stats"]({"bytes_processed": 4321})
        if outcome == "error":
            raise RuntimeError("the rows could not be read")
        return ["a"], [{"a": 1}], 0.0

    monkeypatch.setattr(DataSourceConnectionService, "execute_query", staticmethod(fake_execute))
    monkeypatch.setattr(relationship_key_guard, "verify_key_probes", lambda *a, **k: None)
    finished = {}
    compiled = types.SimpleNamespace(
        query_id="unit-q2", datasource=types.SimpleNamespace(id=1, config={}), ds_type="bigquery",
        sql="SELECT 1", key_probes=(), bounds=QueryBounds(max_rows=10, timeout_seconds=7, bq_max_bytes=12345),
        request=types.SimpleNamespace(principal=types.SimpleNamespace(surface="chat", ref="user:u"), relation="r"),
        columns=(types.SimpleNamespace(name="a", ref="v.a", role="measure"),), dataset_ids=(1,),
        semantic_epoch="e", dialect="bigquery", sql_fingerprint="s", policy_fingerprint="p",
        filters_applied=(), filters_dropped=(), freshness=None, warnings=())
    service = object.__new__(GovernedQueryService)
    service.cancel_registry = CancelRegistry()
    service.audit = types.SimpleNamespace(begin=lambda c: None,
                                          finish=lambda qid, **kw: finished.update(kw))
    service.plan = lambda request: compiled
    if outcome == "ok":
        result = GovernedQueryService.execute(service, object())
        assert result.evidence.bytes_processed == 4321
    else:
        with pytest.raises(RuntimeError):
            GovernedQueryService.execute(service, object())
    assert finished["bytes_processed"] == 4321 and finished["status"] == outcome


#: PR-1G: the ONLY code outside the package that may reach GQS. A new consumer
#: is a reviewed change to this set, not a side effect.
#: Since the unified AI Chat the consumer is Chat: its API (consents), its
#: conversation store (the viewer's catalog) and orchestrator (ledger, cancel), and
#: the Data Core that plans and executes.
APPROVED_CONSUMERS = {"api/chat.py", "services/chat/conversations.py", "services/chat/orchestrator.py",
                      "services/data_core/service.py", "services/data_core/catalog.py"}


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


def test_the_one_chat_router_is_the_only_gqs_answer_router():
    """Since the unified AI Chat (contract C2) the Analyst router is gone and the
    chat router is mounted once, unconditionally: AI_CHAT_ENABLED is checked per
    turn (503), so no flag can mount a second answering path."""
    text = (APP / "api" / "__init__.py").read_text(encoding="utf-8")
    assert "analyst_router" not in text and not (APP / "api" / "analyst.py").exists()
    assert text.count("include_router(chat_router)") == 1
