"""Chart custom SQL, report forks and field swaps stay inside the caller's authority (HTTP).

Regressions from the independent adversarial review of security/authz-remediation:

* P1-A  a dataset EXPLORE grant ran arbitrary SQL on the whole datasource through
        a chart in custom-SQL mode (``POST /charts/preview-data``, create, update).
        Custom SQL is now datasource authority (edit on the datasource), checked
        where it is written AND every time a saved chart runs (its owner's right).
* P1-B  ``POST /dashboards/{id}/charts/{tile}/fork-chart`` bound the copy to any
        dataset table named in the body, with no check on that dataset.
* P2-A  ``GET /charts/{id}/data?overrides=`` let anyone who can view a chart
        re-query it on ANY field of the dataset.
* sibling: a ``sql_query`` dataset table (arbitrary SQL on the connection) needed
        only VIEW on the datasource, to create or to rewrite.

The datasource points at this test's own Postgres, so the positive controls run
real SQL end to end (loopback admitted for datasources, as in the dev/CI stacks).
"""
from __future__ import annotations

import json
import uuid

import pytest

from tests.authz_http import OWNER_URL, client, db, make_user, set_permissions, share  # noqa: F401

pytestmark = pytest.mark.pg

SECRET_SQL = "SELECT current_user AS who"


@pytest.fixture()
def world(db, monkeypatch):  # noqa: F811
    from sqlalchemy.engine import make_url

    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import Chart, ChartType, Dashboard, DashboardChart, DataSource, DataSourceType

    monkeypatch.setenv("DATASOURCE_ALLOW_LOOPBACK", "true")
    url = make_url(OWNER_URL)
    work = dict(datasets="edit", explore_charts="edit", dashboards="edit")
    owner = make_user(db, "sql-owner", data_sources="edit", **work)
    explorer = make_user(db, "sql-explorer", **work)          # explore grant, no datasource right
    builder = make_user(db, "sql-builder", **work)            # build grant, no datasource right
    viewer = make_user(db, "sql-viewer", **work)              # chart view share only
    ds_viewer = make_user(db, "sql-dsviewer", data_sources="view", **work)  # datasource VIEW share

    src = DataSource(name=f"pg-{uuid.uuid4().hex[:8]}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                     config={"host": url.host, "port": url.port or 5432, "database": url.database,
                             "username": url.username, "password": url.password or ""})
    victim = Dataset(name=f"victim-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
    db.add_all([src, victim])
    db.flush()
    table = DatasetTable(dataset_id=victim.id, display_name="users", source_table_name="users",
                         datasource_id=src.id)
    db.add(table)
    db.flush()
    db.add(DatasetGrant(dataset_id=victim.id, user_id=explorer.id, verb="explore", granted_by=owner.id))
    db.add(DatasetGrant(dataset_id=victim.id, user_id=builder.id, verb="build", granted_by=owner.id))
    db.add(DatasetGrant(dataset_id=victim.id, user_id=ds_viewer.id, verb="edit", granted_by=owner.id))

    # The attacker's own dataset, chart and report (for the fork).
    own_ds = Dataset(name=f"own-{uuid.uuid4().hex[:8]}", owner_id=explorer.id)
    db.add(own_ds)
    db.flush()
    own_table = DatasetTable(dataset_id=own_ds.id, display_name="mine", source_table_name="mine",
                             datasource_id=src.id)
    db.add(own_table)
    db.flush()
    own_chart = Chart(name=f"own-{uuid.uuid4().hex[:6]}", chart_type=ChartType.TABLE, dataset_table_id=own_table.id,
                      config={"roleConfig": {"selectedColumns": ["id"]}}, owner_id=explorer.id)
    dash = Dashboard(name=f"rep-{uuid.uuid4().hex[:8]}", owner_id=explorer.id)
    db.add_all([own_chart, dash])
    db.flush()
    tile = DashboardChart(dashboard_id=dash.id, chart_id=own_chart.id, layout={"x": 0, "y": 0, "w": 6, "h": 4})
    db.add(tile)
    db.commit()
    share(db, "datasource", src.id, ds_viewer, "view", owner)
    return dict(owner=owner, explorer=explorer, builder=builder, viewer=viewer, ds_viewer=ds_viewer,
                src=src, table=table, victim=victim, own_table=own_table, dash=dash, tile=tile)


def _custom(sql: str = SECRET_SQL) -> dict:
    return {"queryMode": "custom", "customSql": sql, "customRoleConfig": {}}


def _preview(client, who, table_id, config):  # noqa: F811
    return client.post("/api/v1/charts/preview-data", headers=who.headers,
                       json={"dataset_table_id": table_id, "chart_type": "TABLE", "config": config,
                             "include_source_sample": True})


# ── P1-A ─────────────────────────────────────────────────────────────────────

def test_explore_grant_cannot_preview_custom_sql(client, world):  # noqa: F811
    r = _preview(client, world["explorer"], world["table"].id, _custom())
    assert r.status_code == 403, r.text
    assert "appbi" not in r.text


def test_datasource_editor_previews_custom_sql_positive_control(client, world):  # noqa: F811
    r = _preview(client, world["owner"], world["table"].id, _custom())
    assert r.status_code == 200, r.text


def test_build_grant_cannot_save_or_rewrite_custom_sql(client, world):  # noqa: F811
    b = world["builder"]
    body = {"name": f"c-{uuid.uuid4().hex[:6]}", "chart_type": "TABLE",
            "dataset_table_id": world["table"].id, "config": _custom()}
    assert client.post("/api/v1/charts/", headers=b.headers, json=body).status_code == 403
    # a plain chart is still fine for a builder ...
    plain = {**body, "config": {"roleConfig": {"selectedColumns": ["id"]}}}
    r = client.post("/api/v1/charts/", headers=b.headers, json=plain)
    assert r.status_code == 201, r.text
    # ... but turning it into custom SQL is not
    r2 = client.put(f"/api/v1/charts/{r.json()['id']}", headers=b.headers, json={"config": _custom()})
    assert r2.status_code == 403, r2.text


def test_saved_custom_sql_runs_only_while_its_owner_holds_the_datasource(client, world, db):  # noqa: F811
    o = world["owner"]
    body = {"name": f"c-{uuid.uuid4().hex[:6]}", "chart_type": "TABLE",
            "dataset_table_id": world["table"].id, "config": _custom("SELECT 1 AS one")}
    r = client.post("/api/v1/charts/", headers=o.headers, json=body)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    share(db, "chart", cid, world["viewer"], "view", o)
    assert client.get(f"/api/v1/charts/{cid}/data", headers=world["viewer"].headers).status_code == 200
    # the owner loses the datasource right -> the chart stops for every viewer
    set_permissions(db, o, data_sources="none", datasets="edit", explore_charts="edit", dashboards="edit")
    r3 = client.get(f"/api/v1/charts/{cid}/data", headers=world["viewer"].headers)
    assert r3.status_code == 400, r3.text
    assert "custom SQL is not authorized" in r3.text


# ── P1-B ─────────────────────────────────────────────────────────────────────

def _fork(client, world, table_id, config=None):  # noqa: F811
    return client.post(
        f"/api/v1/dashboards/{world['dash'].id}/charts/{world['tile'].id}/fork-chart",
        headers=world["explorer"].headers,
        json={"name": "x", "chart_type": "TABLE", "dataset_table_id": table_id,
              "config": config or {"roleConfig": {"selectedColumns": ["id"]}}})


def test_fork_cannot_bind_a_dataset_the_caller_cannot_build(client, world, db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable

    foreign = Dataset(name=f"foreign-{uuid.uuid4().hex[:8]}", owner_id=world["owner"].id)
    db.add(foreign)
    db.flush()
    t = DatasetTable(dataset_id=foreign.id, display_name="secret", source_table_name="secret",
                     datasource_id=world["src"].id)
    db.add(t)
    db.commit()
    r = _fork(client, world, t.id)
    assert r.status_code in (403, 404), r.text
    # explore (not build) on the victim is not enough either
    assert _fork(client, world, world["table"].id).status_code in (403, 404)


def test_fork_cannot_smuggle_custom_sql(client, world):  # noqa: F811
    r = _fork(client, world, world["own_table"].id, _custom())
    assert r.status_code == 403, r.text


def test_fork_on_the_source_table_positive_control(client, world):  # noqa: F811
    r = _fork(client, world, world["own_table"].id)
    assert r.status_code == 200, r.text


# ── P2-A ─────────────────────────────────────────────────────────────────────

def test_chart_viewer_cannot_swap_to_any_field(client, world, db):  # noqa: F811
    from app.models.models import Chart, ChartType

    c = Chart(name=f"v-{uuid.uuid4().hex[:6]}", chart_type=ChartType.TABLE, dataset_table_id=world["table"].id,
              config={"roleConfig": {"selectedColumns": ["id"]}}, owner_id=world["owner"].id)
    db.add(c)
    db.commit()
    share(db, "chart", c.id, world["viewer"], "view", world["owner"])
    q = {"overrides": json.dumps({"dimension": "password_hash"})}
    r = client.get(f"/api/v1/charts/{c.id}/data", headers=world["viewer"].headers, params=q)
    assert r.status_code == 403, r.text
    # an explorer of the dataset may swap (the check is passed; the query itself may refuse)
    share(db, "chart", c.id, world["explorer"], "view", world["owner"])
    r2 = client.get(f"/api/v1/charts/{c.id}/data", headers=world["explorer"].headers, params=q)
    assert r2.status_code != 403, r2.text


# ── sibling: sql_query dataset tables ────────────────────────────────────────

def test_datasource_view_cannot_add_or_rewrite_a_sql_table(client, world):  # noqa: F811
    v = world["ds_viewer"]
    r = client.post(f"/api/v1/datasets/{world['victim'].id}/tables", headers=v.headers,
                    json={"datasource_id": world["src"].id, "source_kind": "sql_query",
                          "source_query": SECRET_SQL, "display_name": "q"})
    assert r.status_code == 403, r.text


# ── Snapshot import: a table id sent as a STRING skipped the dataset check ─────
# (third review pass, F1 - confirmed over HTTP: "1305" bound a chart to a
# victim's table, while the integer form was refused with 422).

@pytest.mark.parametrize("as_text", [False, True])
def test_snapshot_import_checks_the_table_however_its_id_is_spelled(world, db, as_text):  # noqa: F811
    from app.models.models import Chart
    from app.models.user import User
    from app.services.dashboard_html_import_service import APPBI_SNAPSHOT_VERSION, rebuild_dashboard_from_snapshot

    victim_table = world["table"].id
    snapshot = {"version": APPBI_SNAPSHOT_VERSION, "dashboard": {"name": "x"},
                "charts": [{"chart": {"name": "stolen", "chart_type": "TABLE",
                                      "dataset_table_id": str(victim_table) if as_text else victim_table,
                                      "config": {"roleConfig": {"selectedColumns": ["id"]}}},
                            "layout": {"x": 0, "y": 0, "w": 6, "h": 4}}]}
    viewer = db.get(User, world["viewer"].id)          # no grant on the victim dataset
    before = db.query(Chart).filter(Chart.dataset_table_id == victim_table).count()
    with pytest.raises(ValueError, match="not accessible to you"):
        rebuild_dashboard_from_snapshot(db, snapshot=snapshot, current_user=viewer)
    db.rollback()
    assert db.query(Chart).filter(Chart.dataset_table_id == victim_table).count() == before


def test_snapshot_import_refuses_a_non_numeric_table_id(world, db):  # noqa: F811
    from app.models.user import User
    from app.services.dashboard_html_import_service import APPBI_SNAPSHOT_VERSION, rebuild_dashboard_from_snapshot

    for bad in ("1 OR 1=1", True, 1.5):
        snap = {"version": APPBI_SNAPSHOT_VERSION, "dashboard": {"name": "x"},
                "charts": [{"chart": {"name": "c", "chart_type": "TABLE", "dataset_table_id": bad, "config": {}},
                            "layout": {}}]}
        with pytest.raises(ValueError):
            rebuild_dashboard_from_snapshot(db, snapshot=snap, current_user=db.get(User, world["owner"].id))
        db.rollback()
