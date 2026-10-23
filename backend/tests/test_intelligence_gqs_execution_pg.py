"""PR-1B: the Governed Query Service core, executed. Real Postgres, real engine.

Metadata (users, grants, Dataset, semantic model) and the DATA SOURCE are both a
real Postgres: the source is a connection back to the test database's owner role,
holding a table whose values are hand-countable. Nothing in the decision, the
engine or the executor is stubbed. The one seam used is the audit sink (the
durable ledger is PR-1E) and, for I-6 only, a wrapper that adds one drop record
to the REAL engine's output in the engine's own shape.

GQS is not live: no route calls it. These tests are how it is exercised.

Hand-computed oracle (gqs_src.sales):

    order  region  amount
      1    Bắc       100
      2    Bắc        50
      3    Nam        30
      4    Trung      20        → Bắc 150, Nam 30, Trung 20; total 200; 4 orders
"""
from __future__ import annotations

import os
import uuid
from decimal import Decimal
from urllib.parse import urlparse

import pytest
import sqlalchemy as sa

from tests.authz_http import db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

SCHEMA = "gqs_src"
ORACLE = {"Bắc": 150, "Nam": 30, "Trung": 20}


class Sink:
    """An AuditSink that records what GQS asked of it (the PR-1E ledger's role)."""

    def __init__(self, fail_begin: bool = False):
        self.fail_begin = fail_begin
        self.begun, self.finished, self.refusals = [], [], []

    def begin(self, compiled):
        if self.fail_begin:
            raise RuntimeError("ledger down")
        self.begun.append(compiled.query_id)

    def finish(self, query_id, **kw):
        self.finished.append((query_id, kw))

    def refused(self, **kw):
        self.refusals.append(kw)


def _owner_url():
    url = os.environ.get("AUTHZ_PG_OWNER_URL") or os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_intelligence_gqs_execution_pg executes SQL; it needs Postgres. Not a unit test.")
    return url


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    raw = _owner_url()
    url = urlparse(raw)
    engine = sa.create_engine(raw)
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.sales (order_id int, region text, amount numeric, "
                          f"customer_phone text, cost numeric, order_date date)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.sales VALUES (1,'Bắc',100,'0901',60,'2026-01-05'),"
                          f"(2,'Bắc',50,'0902',30,'2026-01-20'),(3,'Nam',30,'0903',10,'2026-02-03'),"
                          f"(4,'Trung',20,'0904',5,'2026-02-17')"))
        # Slow at the SOURCE (a database view), so the SQL GQS sends holds no
        # sleep call the validator would refuse: only the time bound can stop it.
        c.execute(sa.text(f"CREATE VIEW {SCHEMA}.slow_sales AS SELECT s.* FROM {SCHEMA}.sales s "
                          f"CROSS JOIN LATERAL (SELECT pg_sleep(2)) AS z"))

    tag = uuid.uuid4().hex[:6]
    owner = make_user(db, "gqs-owner", datasets="edit", data_sources="edit")
    analyst = make_user(db, "gqs-analyst", datasets="edit")
    viewer = make_user(db, "gqs-viewer", datasets="edit")
    stranger = make_user(db, "gqs-stranger", datasets="edit")

    src = DataSource(name=f"gqs-{tag}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                     config={"host": url.hostname, "port": url.port or 5432, "database": url.path.lstrip("/"),
                             "username": url.username, "password": url.password})
    ds = Dataset(name=f"gqs-sales-{tag}", owner_id=owner.id, purpose="reporting")
    db.add_all([src, ds])
    db.flush()
    table = DatasetTable(dataset_id=ds.id, datasource_id=src.id, source_kind="physical_table",
                         source_table_name=f"{SCHEMA}.sales", display_name="Sales", query_mode="live")
    model = SemanticModel(name=f"gqs-model-{tag}", dataset_id=ds.id)
    db.add_all([table, model])
    db.flush()
    vname = f"gqs_sales_{tag}"
    view = SemanticView(
        name=vname, sql_table_name=f"{SCHEMA}.sales", dataset_table_id=table.id,
        dimensions=[{"name": "region", "type": "string", "sql": "${TABLE}.region"},
                    {"name": "order_id", "type": "number", "sql": "${TABLE}.order_id"},
                    {"name": "phone", "type": "string", "sql": "${TABLE}.customer_phone"},
                    {"name": "order_date", "type": "date", "sql": "${TABLE}.order_date"},
                    # review 3d: the excluded column read bare inside a larger expression
                    {"name": "has_phone", "type": "string",
                     "sql": "CASE WHEN customer_phone IS NULL THEN 'no' ELSE 'yes' END"},
                    # review 3d: bare ${col}
                    {"name": "cost_band", "type": "string", "sql": "CASE WHEN ${cost} > 20 THEN 'hi' END"}],
        measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"},
                  {"name": "orders", "type": "count", "sql": "*"},
                  {"name": "cost_total", "type": "sum", "sql": "${TABLE}.cost"},
                  # review 3a: `expression`, not `sql`, reads the excluded column
                  {"name": "margin", "type": "sum", "sql": "", "expression": "${TABLE}.amount - ${TABLE}.cost"},
                  # review 3b: a formula over an excluded measure
                  {"name": "margin2", "type": "sum", "expression": "${revenue} - ${cost_total}",
                   "depends_on": ["revenue", "cost_total"]},
                  # review 3c: a conditional aggregate on an excluded column
                  {"name": "vip_rev", "type": "sum", "sql": "${TABLE}.amount",
                   "filters": [{"field": "phone", "operator": "eq", "value": "0901"}]}],
    )
    slow_table = DatasetTable(dataset_id=ds.id, datasource_id=src.id, source_kind="physical_table",
                              source_table_name=f"{SCHEMA}.slow_sales", display_name="Slow", query_mode="live")
    db.add_all([view, slow_table])
    db.flush()
    slow_view = SemanticView(name=f"{vname}_slow", sql_table_name=f"{SCHEMA}.slow_sales",
                             dataset_table_id=slow_table.id, dimensions=[],
                             measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}])
    db.add(slow_view)
    db.flush()
    slow_explore = SemanticExplore(name=f"gqs_slow_{tag}", model_id=model.id, base_view_id=slow_view.id,
                                   base_view_name=slow_view.name, joins=[])
    db.add(slow_explore)
    explore = SemanticExplore(name=f"gqs_x_{tag}", model_id=model.id, base_view_id=view.id,
                              base_view_name=vname, joins=[])
    db.add(explore)
    db.add(DatasetGrant(dataset_id=ds.id, user_id=analyst.id, verb="explore", granted_by=owner.id))
    db.add(DatasetGrant(dataset_id=ds.id, user_id=viewer.id, verb="view", granted_by=owner.id))
    db.commit()
    try:
        yield dict(db=db, ds=ds, src=src, model=model, view=view, explore=explore, v=vname,
                   slow_explore=slow_explore, slow_view=slow_view,
                   owner=owner, analyst=analyst, viewer=viewer, stranger=stranger)
    finally:
        from app.models.governance import GovernAIScope

        db.rollback()
        db.query(GovernAIScope).filter(GovernAIScope.dataset_id == ds.id).delete()
        db.query(SemanticExplore).filter(SemanticExplore.id.in_([explore.id, slow_explore.id])).delete()
        db.query(SemanticView).filter(SemanticView.id.in_([view.id, slow_view.id])).delete()
        db.query(SemanticModel).filter(SemanticModel.id == model.id).delete()
        db.query(DatasetGrant).filter(DatasetGrant.dataset_id == ds.id).delete()
        db.query(DatasetTable).filter(DatasetTable.dataset_id == ds.id).delete()
        db.query(Dataset).filter(Dataset.id == ds.id).delete()
        db.query(DataSource).filter(DataSource.id == src.id).delete()
        db.commit()
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        engine.dispose()


def _gqs(w, who="analyst", surface="analyst", sink=None, ceiling=None, registry=None):
    from app.models.user import User
    from app.services.governed_query import (
        AuthorizationContext, EffectivePrincipal, GovernedQueryService, SurfaceCeiling,
    )

    user = w["db"].get(User, w[who].id)
    p = EffectivePrincipal.for_user(user, surface=surface)
    ctx = AuthorizationContext(db=w["db"], principal=p, user=user,
                               ceiling=SurfaceCeiling.of(ceiling) if ceiling is not None else SurfaceCeiling())
    return GovernedQueryService(ctx, audit=sink, cancel_registry=registry), p


def _req(w, p, *, dims=(), measures=(), filters=None, bounds=None, consent=None, explore_id=None,
         view=None, **ask):
    from app.services.governed_query import GovernedQueryRequest, RelationRef, SemanticAsk

    v = view or w["v"]
    return GovernedQueryRequest(
        principal=p,
        relation=RelationRef(kind="semantic_explore", id=explore_id or w["explore"].id),
        ask=SemanticAsk(dimensions=tuple(f"{v}.{d}" for d in dims),
                        measures=tuple(f"{v}.{m}" for m in measures),
                        filters={f"{v}.{k}": c for k, c in (filters or {}).items()}, **ask),
        requested_bounds=bounds,
        drop_consent=consent,
    )


def _by_region(w, result):
    v = w["v"]
    col = {c.ref: c.name for c in result.columns}
    return {r[col[f"{v}.region"]]: int(Decimal(str(r[col[f"{v}.revenue"]]))) for r in result.rows}


def _refused(fn, code):
    from app.services.governed_query import GovernedRefusal

    with pytest.raises(GovernedRefusal) as exc:
        fn()
    assert exc.value.code == code, (exc.value.code, exc.value.detail)
    return exc.value


# ── correctness: a NEW query, compiled by the existing engine, executed ─────
def test_a_new_question_returns_the_hand_computed_answer_with_evidence(world):
    sink = Sink()
    gqs, p = _gqs(world, sink=sink)
    result = gqs.execute(_req(world, p, dims=["region"], measures=["revenue"]))
    assert _by_region(world, result) == ORACLE
    ev = result.evidence
    assert ev.datasets == (world["ds"].id,) and ev.datasource_id == world["src"].id
    assert ev.dialect == "postgresql" and ev.filters_dropped == () and not result.truncated
    assert ev.rows_returned == 3 and ev.principal_ref == p.ref and ev.freshness.mode == "live"
    assert len(ev.sql_fingerprint) == 64 and ev.semantic_epoch and ev.policy_fingerprint
    assert {c.role for c in result.columns} == {"dimension", "measure"}
    # I-7: written BEFORE, finalized AFTER, for the same query id.
    assert sink.begun == [ev.query_id]
    assert sink.finished[0][0] == ev.query_id and sink.finished[0][1]["status"] == "ok"


def test_a_user_filter_is_applied_and_recorded(world):
    gqs, p = _gqs(world, sink=Sink())
    result = gqs.execute(_req(world, p, dims=["region"], measures=["revenue"],
                              filters={"region": {"operator": "eq", "value": "Bắc"}}))
    assert _by_region(world, result) == {"Bắc": 150}
    assert result.evidence.filters_applied == (f"{world['v']}.region",)


def test_rows_are_bounded_and_truncation_is_reported_not_assumed(world):
    from app.services.governed_query import QueryBounds

    gqs, p = _gqs(world, sink=Sink())
    small = gqs.execute(_req(world, p, dims=["order_id"], measures=["revenue"],
                             bounds=QueryBounds(max_rows=2, timeout_seconds=60, bq_max_bytes=1)))
    assert len(small.rows) == 2 and small.truncated and small.evidence.bounds.max_rows == 2
    whole = gqs.execute(_req(world, p, dims=["order_id"], measures=["revenue"]))
    assert len(whole.rows) == 4 and not whole.truncated


def test_a_request_never_raises_a_bound(world):
    """I-8."""
    from app.core.config import settings
    from app.services.governed_query import QueryBounds

    gqs, p = _gqs(world, sink=Sink())
    huge = QueryBounds(max_rows=10**9, timeout_seconds=10**6, bq_max_bytes=10**15)
    b = gqs.plan(_req(world, p, measures=["revenue"], bounds=huge)).bounds
    assert b.max_rows == settings.GQS_MAX_ROWS and b.timeout_seconds == settings.GQS_TIMEOUT_SECONDS
    assert b.bq_max_bytes == min(settings.AI_BQ_MAX_BYTES_PER_QUERY, settings.BQ_MAX_BYTES_BILLED)


def test_same_question_same_fingerprint_and_a_definition_edit_moves_the_epoch(world):
    """I-9: same spec + principal + epoch → same SQL fingerprint."""
    from sqlalchemy.orm.attributes import flag_modified

    gqs, p = _gqs(world, sink=Sink())
    a = gqs.plan(_req(world, p, dims=["region"], measures=["revenue"]))
    b = gqs.plan(_req(world, p, dims=["region"], measures=["revenue"]))
    assert (a.sql_fingerprint, a.semantic_epoch) == (b.sql_fingerprint, b.semantic_epoch)
    view = world["view"]
    view.measures = list(view.measures) + [{"name": "half", "type": "sum", "sql": "${TABLE}.amount / 2"}]
    flag_modified(view, "measures")
    world["db"].commit()
    c = gqs.plan(_req(world, p, dims=["region"], measures=["revenue"]))
    assert c.semantic_epoch != a.semantic_epoch


# ── authorization: the caller's live rights, nothing else ───────────────────
def test_view_is_not_enough_and_nothing_reaches_the_warehouse(world, monkeypatch):
    from app.services.datasource_service import DataSourceConnectionService

    calls = []
    monkeypatch.setattr(DataSourceConnectionService, "execute_query",
                        staticmethod(lambda *a, **k: calls.append(1) or ([], [], 0.0)))
    sink = Sink()
    gqs, p = _gqs(world, who="viewer", sink=sink)
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "not_authorized")
    assert calls == [] and sink.begun == [] and sink.refusals[0]["code"] == "not_authorized"


def test_a_stranger_and_a_missing_explore_get_the_same_refusal(world):
    gqs, p = _gqs(world, who="stranger", sink=Sink())
    a = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "not_authorized")
    gqs2, p2 = _gqs(world, who="analyst", sink=Sink())
    b = _refused(lambda: gqs2.execute(_req(world, p2, measures=["revenue"], explore_id=2_000_000_000)),
                 "not_authorized")
    assert a.message_vi == b.message_vi


def test_the_owner_queries_their_own_dataset(world):
    gqs, p = _gqs(world, who="owner", sink=Sink())
    assert _by_region(world, gqs.execute(_req(world, p, dims=["region"], measures=["revenue"]))) == ORACLE


def test_a_surface_ceiling_narrows_even_the_owner(world):
    gqs, p = _gqs(world, who="owner", surface="studio_test", sink=Sink(), ceiling=[])
    err = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "not_authorized")
    assert err.detail["via"] == "surface_ceiling"


# ── data policy ─────────────────────────────────────────────────────────────
def _hide(world, columns=(), measures=()):
    from app.models.governance import GovernAIScope

    world["db"].add(GovernAIScope(dataset_id=world["ds"].id, excluded_columns=list(columns),
                                  excluded_measures=list(measures)))
    world["db"].commit()


@pytest.mark.parametrize("how", ["select", "filter"])
def test_an_ai_surface_cannot_select_or_filter_on_an_excluded_column(world, how):
    """`phone` reads the physical `customer_phone`, which GovernAIScope hides."""
    _hide(world, columns=["customer_phone"])
    gqs, p = _gqs(world, sink=Sink())
    req = (_req(world, p, dims=["phone"], measures=["revenue"]) if how == "select" else
           _req(world, p, measures=["revenue"], filters={"phone": {"operator": "eq", "value": "0901"}}))
    err = _refused(lambda: gqs.execute(req), "column_excluded")
    assert err.detail["fields"] == [f"{world['v']}.phone"]


def test_an_excluded_measure_is_refused_and_the_rest_still_answers(world):
    _hide(world, measures=["revenue"])
    gqs, p = _gqs(world, sink=Sink())
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "column_excluded")
    assert gqs.execute(_req(world, p, measures=["orders"])).rows[0]


def test_ai_scope_is_not_applied_to_a_persons_own_chart_render(world):
    _hide(world, columns=["customer_phone"])
    gqs, p = _gqs(world, surface="chart", sink=Sink())
    assert len(gqs.execute(_req(world, p, dims=["phone"], measures=["revenue"])).rows) == 4


def test_a_failed_ai_scope_lookup_refuses(world, monkeypatch):
    from app.services.governance_ai_service import GovernanceAIService

    monkeypatch.setattr(GovernanceAIService, "scope_exclusions",
                        staticmethod(lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down"))))
    gqs, p = _gqs(world, sink=Sink())
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "policy_unavailable")


def test_operational_data_is_refused_rather_than_read_without_its_row_rules(world):
    world["ds"].purpose = "operational"
    world["db"].commit()
    gqs, p = _gqs(world, who="owner", sink=Sink())
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "policy_unenforceable")


def test_an_explore_outside_any_dataset_is_refused_even_for_its_models_owner(world):
    """No Dataset owns it, so no one's `explore` can be decided: refused, and with
    the same refusal a stranger gets (review #5: existence is not disclosed)."""
    world["model"].dataset_id = None
    world["db"].commit()
    gqs, p = _gqs(world, who="owner", sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "not_authorized")
    assert sorted(err.detail) == ["relation_id"]


@pytest.mark.parametrize("hatch", ["calculated_fields", "window_functions", "measure_agg_overrides"])
def test_sql_escape_hatches_are_refused_by_name(world, hatch):
    value = {"measure_agg_overrides": {f"{world['v']}.revenue": "max"}}.get(
        hatch, ({"name": "x", "sql": "1"},))
    gqs, p = _gqs(world, who="owner", sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"], **{hatch: value})),
                   "unsupported_expression")
    assert err.detail["fields"] == [hatch]


# ── I-6: a dropped filter is a refusal unless the USER accepted it ──────────
@pytest.fixture()
def one_drop(world, monkeypatch):
    """The REAL engine compiles; one structured drop is added in the engine's own
    record shape (`field`, `reason`, `detail`) — as `_build_where_clause` does for
    `unreachable_view`."""
    from app.services.semantic_query_engine import SemanticQueryEngine

    real = SemanticQueryEngine.run
    field = f"{world['v']}.region"

    def run(self, spec):
        out = real(self, spec)
        self._propagation_drops = list(self._propagation_drops) + [
            {"field": field, "reason": "unreachable_view", "detail": "test"}]
        return out

    monkeypatch.setattr(SemanticQueryEngine, "run", run)
    return field


def test_a_dropped_filter_refuses_and_names_the_filter(world, one_drop):
    sink = Sink()
    gqs, p = _gqs(world, sink=sink)
    err = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"],
                                            filters={"region": {"operator": "eq", "value": "Bắc"}})),
                   "filter_would_drop")
    assert err.detail["dropped"] == [{"field": one_drop, "reason": "unreachable_view"}]
    assert sink.begun == []


def _consent_for(err, p, fields=None, **kw):
    from app.services.governed_query import consent

    return consent.issue(user_id=p.user_id, query_fp=err.detail["query_fingerprint"],
                         fields=fields or [d["field"] for d in err.detail["dropped"]], **kw)


def test_a_drop_the_user_accepted_runs_and_is_in_the_evidence(world, one_drop):
    gqs, p = _gqs(world, sink=Sink())
    ask = dict(measures=["revenue"], filters={"region": {"operator": "eq", "value": "Bắc"}})
    err = _refused(lambda: gqs.execute(_req(world, p, **ask)), "filter_would_drop")
    result = gqs.execute(_req(world, p, consent=_consent_for(err, p), **ask))
    assert result.evidence.filters_dropped == (
        {"field": one_drop, "reason": "unreachable_view", "accepted_by_user": True},)
    assert one_drop not in result.evidence.filters_applied


# ── I-7 and execution bounds ────────────────────────────────────────────────
def test_without_a_ledger_nothing_executes(world, monkeypatch):
    from app.services.datasource_service import DataSourceConnectionService

    calls = []
    monkeypatch.setattr(DataSourceConnectionService, "execute_query",
                        staticmethod(lambda *a, **k: calls.append(1) or ([], [], 0.0)))
    gqs, p = _gqs(world, who="owner", sink=None)
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "audit_unavailable")
    assert calls == []


def test_a_failed_audit_write_refuses_before_the_warehouse(world, monkeypatch):
    from app.services.datasource_service import DataSourceConnectionService

    calls = []
    monkeypatch.setattr(DataSourceConnectionService, "execute_query",
                        staticmethod(lambda *a, **k: calls.append(1) or ([], [], 0.0)))
    gqs, p = _gqs(world, who="owner", sink=Sink(fail_begin=True))
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "audit_unavailable")
    assert calls == []


def test_a_query_over_its_time_bound_is_refused_and_audited_as_timeout(world):
    from app.services.governed_query import QueryBounds

    sink = Sink()
    gqs, p = _gqs(world, who="owner", sink=sink)
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"], view=world["slow_view"].name,
                                      explore_id=world["slow_explore"].id,
                                      bounds=QueryBounds(max_rows=10, timeout_seconds=1, bq_max_bytes=1))),
             "timeout")
    assert sink.finished[-1][1]["status"] == "timeout"



# ── regressions from the independent review of 96472cd6 ─────────────────────
def _no_warehouse(monkeypatch):
    from app.services.datasource_service import DataSourceConnectionService

    calls = []
    monkeypatch.setattr(DataSourceConnectionService, "execute_query",
                        staticmethod(lambda *a, **k: calls.append(1) or ([], [], 0.0)))
    return calls


def test_r1_a_time_grain_is_one_of_five_words_never_sql(world, monkeypatch):
    """A grain reached `DATE_TRUNC('<grain>', ...)` unvalidated (Postgres/DuckDB)."""
    calls = _no_warehouse(monkeypatch)
    v = world["v"]
    gqs, p = _gqs(world, who="owner", sink=Sink())
    evil = "day', NOW()) || (SELECT string_agg(usename, ',') FROM pg_user) || DATE_TRUNC('day"
    _refused(lambda: gqs.execute(_req(world, p, dims=["order_date"], measures=["revenue"],
                                      time_grains={f"{v}.order_date": evil})), "invalid_time_grain")
    assert calls == []


def test_r1_a_valid_grain_still_answers(world):
    v = world["v"]
    gqs, p = _gqs(world, who="owner", sink=Sink())
    r = gqs.execute(_req(world, p, dims=["order_date"], measures=["revenue"],
                         time_grains={f"{v}.order_date": "month"}))
    measure = next(c.name for c in r.columns if c.role == "measure")
    assert sorted(int(Decimal(str(row[measure]))) for row in r.rows) == [50, 150]


@pytest.fixture()
def parent(world):
    """A Dataset the analyst holds nothing on, composed INTO the queried one."""
    from app.models.dataset import Dataset, DatasetTable

    db = world["db"]
    p = Dataset(name=f"gqs-parent-{uuid.uuid4().hex[:6]}", owner_id=world["owner"].id, purpose="reporting")
    db.add(p)
    db.flush()
    ref = DatasetTable(dataset_id=world["ds"].id, datasource_id=None, source_kind="dataset",
                       parent_dataset_id=p.id, display_name="Parent ref", query_mode="synced")
    db.add(ref)
    db.commit()
    try:
        yield p
    finally:
        from app.models.dataset import DatasetGrant
        from app.models.governance import GovernAIScope

        db.rollback()
        db.query(GovernAIScope).filter(GovernAIScope.dataset_id == p.id).delete()
        db.query(DatasetGrant).filter(DatasetGrant.dataset_id == p.id).delete()
        db.query(DatasetTable).filter(DatasetTable.id == ref.id).delete()
        db.query(Dataset).filter(Dataset.id == p.id).delete()
        db.commit()


def test_r2_a_composed_dataset_needs_explore_on_every_parent(world, parent, monkeypatch):
    calls = _no_warehouse(monkeypatch)
    gqs, p = _gqs(world, sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "not_authorized")
    assert err.detail["via"] == "composition_parent" and calls == []


def test_r2_a_parents_ai_scope_applies_to_the_child(world, parent):
    from app.models.dataset import DatasetGrant
    from app.models.governance import GovernAIScope

    db = world["db"]
    db.add(DatasetGrant(dataset_id=parent.id, user_id=world["analyst"].id, verb="explore",
                        granted_by=world["owner"].id))
    db.add(GovernAIScope(dataset_id=parent.id, excluded_columns=["customer_phone"], excluded_measures=[]))
    db.commit()
    gqs, p = _gqs(world, sink=Sink())
    _refused(lambda: gqs.execute(_req(world, p, dims=["phone"], measures=["revenue"])), "column_excluded")
    assert gqs.plan(_req(world, p, dims=["region"], measures=["revenue"])).dataset_ids == (
        world["ds"].id, parent.id)


@pytest.mark.parametrize("field,hide_cols,hide_fields", [
    ("margin", ["cost"], []),                  # 3a expression
    ("margin2", [], ["cost_total"]),           # 3b formula over an excluded measure
    ("vip_rev", ["customer_phone"], []),       # 3c measure filter on an excluded column
    ("has_phone", ["customer_phone"], []),     # 3d bare column inside an expression
    ("cost_band", ["cost"], []),               # 3d bare ${col}
    ("phone", ["Customer Phone"], []),         # label-authored exclusion
])
def test_r3_ai_scope_follows_what_a_field_reads(world, monkeypatch, field, hide_cols, hide_fields):
    calls = _no_warehouse(monkeypatch)
    _hide(world, columns=hide_cols, measures=hide_fields)
    gqs, p = _gqs(world, sink=Sink())
    is_measure = field in {"margin", "margin2", "vip_rev"}
    req = _req(world, p, measures=[field]) if is_measure else _req(world, p, dims=[field], measures=["orders"])
    _refused(lambda: gqs.execute(req), "column_excluded")
    assert calls == []


def test_r3_a_role_play_alias_and_an_unqualified_ref_cannot_skip_the_walk(world, monkeypatch):
    from app.models.semantic import SemanticExplore
    from app.services.governed_query import GovernedQueryRequest, RelationRef, SemanticAsk

    _no_warehouse(monkeypatch)
    db = world["db"]
    aliased = SemanticExplore(name=f"gqs_alias_{uuid.uuid4().hex[:6]}", model_id=world["model"].id,
                              base_view_id=world["view"].id, base_view_name=world["v"],
                              joins=[{"view": world["v"], "alias": "buyer"}])
    db.add(aliased)
    db.commit()
    try:
        _hide(world, columns=["customer_phone"])
        gqs, p = _gqs(world, sink=Sink())

        def ask(dims):
            return GovernedQueryRequest(principal=p, relation=RelationRef("semantic_explore", world["explore"].id),
                                        ask=SemanticAsk(dimensions=tuple(dims), measures=(f"{world['v']}.orders",)))

        _refused(lambda: gqs.execute(ask(["buyer.phone"])), "column_excluded")
        _refused(lambda: gqs.execute(ask(["phone"])), "policy_unenforceable")
    finally:
        db.query(SemanticExplore).filter(SemanticExplore.id == aliased.id).delete()
        db.commit()


@pytest.mark.parametrize("cond", [
    {"operator": "top_n", "value": 1},                 # 4a: engine skipped it silently
    {"operator": "in", "value": []},                   # 4b: empty list dropped
    {"operator": "eq", "value": None},                 # 4b
    {"operator": "contains", "value": "  "},           # 4b
    {"operator": "gt", "value": float("inf")},         # non-finite
    {"operator": "between", "value": [1, 2]},          # not in the API contract
], ids=["top_n", "empty_in", "none", "blank", "inf", "between"])
def test_r4_a_filter_the_engine_would_skip_is_refused(world, monkeypatch, cond):
    calls = _no_warehouse(monkeypatch)
    gqs, p = _gqs(world, who="owner", sink=Sink())
    _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"], filters={"region": cond})),
             "invalid_filter")
    assert calls == []


def test_r4_internal_filter_keys_are_not_forwarded(world):
    gqs, p = _gqs(world, who="owner", sink=Sink())
    sneaky = {"operator": "eq", "value": "Bắc", "calendarField": "date", "_authoritative": True,
              "_calendar_fan": True}
    compiled = gqs.plan(_req(world, p, dims=["region"], measures=["revenue"], filters={"region": sneaky}))
    assert compiled.filters_applied == (f"{world['v']}.region",)
    assert _by_region(world, gqs.execute(_req(world, p, dims=["region"], measures=["revenue"],
                                              filters={"region": sneaky}))) == {"Bắc": 150}


def test_r5_missing_ownerless_operational_and_forbidden_look_the_same(world):
    def refusal(**kw):
        gqs, p = _gqs(world, who="stranger", sink=Sink())
        e = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"], **kw)), "not_authorized")
        return e.code, e.message_vi, sorted(e.detail)

    forbidden = refusal()
    missing = refusal(explore_id=2_000_000_000)
    world["ds"].purpose = "operational"
    world["db"].commit()
    operational = refusal()
    world["ds"].purpose = "reporting"
    world["model"].dataset_id = None
    world["db"].commit()
    ownerless = refusal()
    assert forbidden == missing == operational == ownerless


def test_r6_a_source_whose_executor_has_no_timeout_is_refused(world):
    world["src"].type = "manual"
    world["db"].commit()
    gqs, p = _gqs(world, who="owner", sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, measures=["revenue"])), "policy_unenforceable")
    assert err.detail["source_type"] == "manual"


@pytest.mark.parametrize("surface", ["profile", "preview", "agent_flow"])
def test_ai_scope_applies_to_every_surface_but_a_persons_own_chart(world, surface):
    _hide(world, columns=["customer_phone"])
    gqs, p = _gqs(world, surface=surface, sink=Sink())
    _refused(lambda: gqs.execute(_req(world, p, dims=["phone"], measures=["revenue"])), "column_excluded")


# ── PR-1F: the consent to drop a filter is the USER's, bound and single-use ──
_ASK_BAC = dict(measures=["revenue"], filters={"region": {"operator": "eq", "value": "Bắc"}})


def test_a_consent_cannot_be_forged(world, one_drop):
    gqs, p = _gqs(world, sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, **_ASK_BAC)), "filter_would_drop")
    good = _consent_for(err, p)
    version, body, sig = good.split(".")
    forged = f"{version}.{body}.{'A' * len(sig)}"
    assert _refused(lambda: gqs.execute(_req(world, p, consent=forged, **_ASK_BAC)),
                    "consent_invalid").detail["reason"] == "signature"
    assert _refused(lambda: gqs.execute(_req(world, p, consent="not_a_token", **_ASK_BAC)),
                    "consent_invalid").detail["reason"] == "malformed"


def test_a_consent_is_bound_to_its_user(world, one_drop):
    gqs, p = _gqs(world, who="analyst", sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, **_ASK_BAC)), "filter_would_drop")
    gqs_o, p_o = _gqs(world, who="owner", sink=Sink())
    owners = _consent_for(err, p_o)  # the owner's consent, for the analyst's identical question
    assert _refused(lambda: gqs.execute(_req(world, p, consent=owners, **_ASK_BAC)),
                    "consent_invalid").detail["reason"] == "other_user"


def test_a_consent_is_bound_to_the_exact_query(world, one_drop):
    gqs, p = _gqs(world, sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, **_ASK_BAC)), "filter_would_drop")
    token = _consent_for(err, p)
    other = dict(measures=["orders"], filters=_ASK_BAC["filters"])
    assert _refused(lambda: gqs.execute(_req(world, p, consent=token, **other)),
                    "consent_invalid").detail["reason"] == "other_query"


def test_a_consent_expires(world, one_drop):
    import time as _t

    gqs, p = _gqs(world, sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, **_ASK_BAC)), "filter_would_drop")
    stale = _consent_for(err, p, now=_t.time() - 3600)
    assert _refused(lambda: gqs.execute(_req(world, p, consent=stale, **_ASK_BAC)),
                    "consent_invalid").detail["reason"] == "expired"


def test_a_consent_covers_exactly_the_filters_it_names(world, one_drop):
    gqs, p = _gqs(world, sink=Sink())
    err = _refused(lambda: gqs.execute(_req(world, p, **_ASK_BAC)), "filter_would_drop")
    wrong = _consent_for(err, p, fields=[f"{world['v']}.order_id"])
    assert _refused(lambda: gqs.execute(_req(world, p, consent=wrong, **_ASK_BAC)),
                    "consent_invalid").detail["reason"] == "other_filters"


def test_the_model_cannot_pass_bare_filter_ids():
    from app.services.governed_query import GovernedQueryRequest

    assert "accept_dropped_filters" not in GovernedQueryRequest.__dataclass_fields__
