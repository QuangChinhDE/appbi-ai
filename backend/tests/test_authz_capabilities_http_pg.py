"""The frontend reads BACKEND-computed capabilities (HTTP, Postgres).

Every resource response carries `capabilities` ({action: bool}) computed by the
authz decision for THIS caller - the UI shows controls from it without knowing
owners, shares, teams, grants, PAT caps or module admins. /permissions/schema is
the module/resource manifest generated from the registry.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetGrant
    from app.models.models import Dashboard

    owner = make_user(db, "cap-owner", datasets="edit", dashboards="edit")
    viewer = make_user(db, "cap-viewer", datasets="edit", dashboards="edit")
    builder = make_user(db, "cap-builder", datasets="edit", dashboards="edit")
    ds = Dataset(name=f"cap-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    dash = Dashboard(name=f"cap-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
    db.add_all([ds, dash])
    db.commit()
    db.add(DatasetGrant(dataset_id=ds.id, user_id=viewer.id, verb="view", granted_by=owner.id))
    db.add(DatasetGrant(dataset_id=ds.id, user_id=builder.id, verb="build", granted_by=owner.id))
    db.commit()
    share(db, "dashboard", dash.id, viewer, "edit", owner)
    return dict(owner=owner, viewer=viewer, builder=builder, ds=ds, dash=dash)


def _ds_caps(client, w, who):  # noqa: F811
    rows = client.get("/api/v1/datasets/", headers=w[who].headers).json()
    detail = client.get(f"/api/v1/datasets/{w['ds'].id}", headers=w[who].headers).json()
    listed = next(r for r in rows if r["id"] == w["ds"].id)
    assert listed["capabilities"] == detail["capabilities"], "list and detail disagree"
    return detail["capabilities"]


def test_dataset_capabilities_follow_the_dataset_policy(client, world):  # noqa: F811
    v = _ds_caps(client, world, "viewer")
    assert v["read"] and not v["explore"] and not v["build"] and not v["edit"] and not v["publish"]
    b = _ds_caps(client, world, "builder")
    assert b["read"] and b["explore"] and b["build"] and not b["edit"] and not b["manage"]
    o = _ds_caps(client, world, "owner")
    assert all(o[a] for a in ("read", "explore", "build", "edit", "publish", "manage", "grant"))


def test_dashboard_capabilities_separate_edit_from_publish(client, world):  # noqa: F811
    d = client.get(f"/api/v1/dashboards/{world['dash'].id}", headers=world["viewer"].headers).json()
    assert d["capabilities"]["edit"] is True and d["capabilities"]["publish"] is False
    o = client.get(f"/api/v1/dashboards/{world['dash'].id}", headers=world["owner"].headers).json()
    assert o["capabilities"]["publish"] is True and o["capabilities"]["delete"] is True


def test_permission_schema_is_the_registry(client, world):  # noqa: F811
    from app.core.authz import registry

    r = client.get("/api/v1/permissions/schema", headers=world["viewer"].headers)
    assert r.status_code == 200
    body = r.json()
    assert [m["key"] for m in body["modules"]] == list(registry.MODULE_KEYS)
    assert {x["type"] for x in body["resources"]} == set(registry.RESOURCE_SPECS)
    assert "build" in next(x for x in body["resources"] if x["type"] == "dataset")["actions"]


# ── No N+1: list endpoints decide authorization for a whole page in batch ─────

def _count_statements(fn):
    from sqlalchemy import event

    from app.core import database

    engines = {database.engine, database.app_engine}
    n = {"q": 0, "sql": []}

    def _inc(conn, cursor, statement, *_a, **_k):
        n["q"] += 1
        n["sql"].append(statement.split("FROM", 1)[-1][:90])

    for e in engines:
        event.listen(e, "before_cursor_execute", _inc)
    try:
        fn()
    finally:
        for e in engines:
            event.remove(e, "before_cursor_execute", _inc)
    _count_statements.last = n["sql"]
    return n["q"]


@pytest.mark.parametrize("module,url,factory", [
    ("datasets", "/api/v1/datasets/", "dataset"),
    ("dashboards", "/api/v1/dashboards/", "dashboard"),
    ("workboards", "/api/v1/workboards/", "workboard"),
    ("explore_charts", "/api/v1/charts/", "chart"),
    ("data_sources", "/api/v1/datasources/", "datasource"),
])
def test_list_query_count_does_not_grow_with_rows(client, db, module, url, factory, monkeypatch):  # noqa: F811
    if factory == "chart":
        # The chart list also hydrates each chart's semantic binding
        # (ChartService.hydrate_runtime_config, ~3 statements per chart): a
        # pre-existing semantic-layer cost, NOT authorization, tracked
        # separately. This test measures the AUTHORIZATION cost per page
        # (batched permissions + capabilities), so that loop is taken out.
        from app.services.chart_service import ChartService

        monkeypatch.setattr(ChartService, "hydrate_runtime_config", staticmethod(lambda *a, **k: None))
    from app.models.dataset import Dataset, DatasetGrant
    from app.models.models import Dashboard

    owner = make_user(db, f"nq-{factory}", **{module: "edit"})
    caller = make_user(db, f"nq-{factory}-c", **{module: "edit"})

    def add(n):
        for _ in range(n):
            if factory == "dataset":
                d = Dataset(name=f"nq-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
                db.add(d)
                db.flush()
                db.add(DatasetGrant(dataset_id=d.id, user_id=caller.id, verb="build", granted_by=owner.id))
            elif factory == "workboard":
                from app.models.dataset import DatasetTable
                from app.modules.workboards.models import Workboard

                ds = Dataset(name=f"nqw-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
                db.add(ds)
                db.flush()
                t = DatasetTable(dataset_id=ds.id, display_name="t", source_table_name="t")
                db.add(t)
                db.flush()
                d = Workboard(name="w", slug=f"nq-{uuid.uuid4().hex[:8]}", dataset_id=ds.id,
                              primary_table_id=t.id, owner_id=owner.id, layout_json={})
                db.add(d)
                db.flush()
                share(db, "workboard", d.id, caller, "view", owner)
            elif factory == "chart":
                from app.models.dataset import DatasetTable
                from app.models.models import Chart, ChartType

                ds = Dataset(name=f"nqc-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
                db.add(ds)
                db.flush()
                t = DatasetTable(dataset_id=ds.id, display_name="t", source_table_name="t")
                db.add(t)
                db.flush()
                d = Chart(name=f"nq-{uuid.uuid4().hex[:8]}", chart_type=ChartType.TABLE, dataset_table_id=t.id,
                          config={"roleConfig": {"selectedColumns": ["id"]}}, owner_id=owner.id)
                db.add(d)
                db.flush()
                share(db, "chart", d.id, caller, "view", owner)
            elif factory == "datasource":
                from app.models.models import DataSource, DataSourceType

                d = DataSource(name=f"nq-{uuid.uuid4().hex[:8]}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                               config={"host": "h.invalid", "port": 5432, "database": "d", "username": "u"})
                db.add(d)
                db.flush()
                share(db, "datasource", d.id, caller, "view", owner)
            else:
                d = Dashboard(name=f"nq-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
                db.add(d)
                db.flush()
                share(db, "dashboard", d.id, caller, "view", owner)
        db.commit()

    def get():
        r = client.get(url, headers=caller.headers)
        assert r.status_code == 200, r.text[:300]   # a 500 must not "pass" a count

    add(5)
    small = _count_statements(get)
    add(20)
    large = _count_statements(get)
    # constant per page, not per row (a per-row decision would add >= 20)
    import collections

    top = collections.Counter(_count_statements.last).most_common(3)
    print(f"[query-count] {module}: 5 rows={small} statements, 25 rows={large} statements")
    assert large - small <= 3, (module, small, large, top)
