"""Observability native monitors, end to end on a REAL Postgres source (H01).

Before: no code path created an ObservabilityMonitor - freshness, volume and
schema never ran for anyone, while "Set up dataset" implied monitoring.

Here a dataset editor configures monitors through the API, the dataset scan
queries the live source table, and the source is then changed underneath it:
rows go stale (freshness), rows disappear (volume), a column is dropped
(schema) - each must breach, open ONE incident, and recover / stay honest.
"""
from __future__ import annotations

import uuid

import pytest
import sqlalchemy as sa

from tests.authz_http import OWNER_URL, client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

SCHEMA = f"obsmon_{uuid.uuid4().hex[:6]}"


@pytest.fixture(scope="module")
def source():
    eng = sa.create_engine(OWNER_URL)
    with eng.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.orders (id int, amount numeric, loaded_at timestamp)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.orders SELECT g, g, now() AT TIME ZONE 'utc' "
                          f"FROM generate_series(1, 100) g"))
    yield eng
    with eng.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA {SCHEMA} CASCADE"))


@pytest.fixture()
def world(db, source):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource, DataSourceType

    url = sa.engine.make_url(OWNER_URL)
    owner = make_user(db, "mon-owner", observability="edit", datasets="edit", data_sources="edit")
    viewer = make_user(db, "mon-viewer", observability="edit", datasets="view")
    src = DataSource(name=f"pg-{uuid.uuid4().hex[:8]}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                     config={"host": url.host, "port": url.port or 5432, "database": url.database,
                             "username": url.username, "password": url.password or ""})
    ds = Dataset(name=f"mon-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add_all([src, ds])
    db.flush()
    tbl = DatasetTable(dataset_id=ds.id, display_name="orders", source_table_name=f"{SCHEMA}.orders",
                       datasource_id=src.id,
                       columns_cache={"columns": [{"name": "id", "type": "integer"},
                                                  {"name": "amount", "type": "numeric"},
                                                  {"name": "loaded_at", "type": "timestamp"}]})
    db.add(tbl)
    db.commit()
    share(db, "dataset", ds.id, viewer, "view", owner)
    return dict(owner=owner, viewer=viewer, ds=ds, tbl=tbl)


def _put(client, w, who, **body):  # noqa: F811
    return client.put(f"/api/v1/observability/datasets/{w['ds'].id}/monitors",
                      headers=w[who].headers, json={"table_id": w["tbl"].id, **body})


def _scan(client, w):  # noqa: F811
    r = client.post(f"/api/v1/observability/datasets/{w['ds'].id}/scan", headers=w["owner"].headers)
    assert r.status_code == 200, r.text
    return r.json()


def _monitors(client, w):  # noqa: F811
    r = client.get(f"/api/v1/observability/datasets/{w['ds'].id}/monitors", headers=w["owner"].headers)
    return {m["kind"]: m for m in r.json()["monitors"]}


def _open(client, w, pillar):  # noqa: F811
    r = client.get("/api/v1/observability/incidents", headers=w["owner"].headers,
                   params={"dataset_id": w["ds"].id, "status": "open", "pillar": pillar})
    return r.json()["items"]


def test_setup_offers_the_tables_time_columns_and_needs_dataset_edit(client, world):  # noqa: F811
    r = client.get(f"/api/v1/observability/datasets/{world['ds'].id}/monitors", headers=world["viewer"].headers)
    assert r.status_code == 200 and r.json()["capabilities"]["configure"] is False
    [t] = r.json()["tables"]
    assert t["timeColumns"] == ["loaded_at"] and t["kinds"] == ["freshness", "volume", "schema"]
    assert _put(client, world, "viewer", kind="schema").status_code == 403


def test_invalid_configuration_is_refused_not_saved(client, world):  # noqa: F811
    assert _put(client, world, "owner", kind="freshness", config={"time_column": "nope"}).status_code == 422
    assert _put(client, world, "owner", kind="freshness",
                config={"time_column": "loaded_at", "max_lag_hours": 0}).status_code == 422
    assert _put(client, world, "owner", kind="volume", config={"z_threshold": 50}).status_code == 422
    assert _put(client, world, "owner", kind="banana").status_code == 422
    assert _monitors(client, world) == {}


def test_freshness_breaches_on_stale_data_and_recovers(client, world, source):  # noqa: F811
    assert _put(client, world, "owner", kind="freshness",
                config={"time_column": "loaded_at", "max_lag_hours": 2}).status_code == 200
    _scan(client, world)
    assert _monitors(client, world)["freshness"]["lastStatus"] == "ok"
    with source.begin() as c:
        c.execute(sa.text(f"UPDATE {SCHEMA}.orders SET loaded_at = loaded_at - interval '30 hours'"))
    _scan(client, world)
    _scan(client, world)                         # repeated scans: still ONE incident
    m = _monitors(client, world)["freshness"]
    assert m["lastStatus"] == "breached" and m["lastValue"] >= 29
    assert len(_open(client, world, "freshness")) == 1
    with source.begin() as c:
        c.execute(sa.text(f"UPDATE {SCHEMA}.orders SET loaded_at = now() AT TIME ZONE 'utc'"))
    _scan(client, world)
    assert _monitors(client, world)["freshness"]["lastStatus"] == "ok"
    assert _open(client, world, "freshness") == []


def test_volume_learns_then_breaches_on_a_drop_and_stays_breached(client, world, source):  # noqa: F811
    with source.begin() as c:
        c.execute(sa.text(f"TRUNCATE {SCHEMA}.orders"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.orders SELECT g, g, now() AT TIME ZONE 'utc' "
                          f"FROM generate_series(1, 100) g"))
    assert _put(client, world, "owner", kind="volume", config={"z_threshold": 3}).status_code == 200
    statuses = []
    for _ in range(5):
        _scan(client, world)
        statuses.append(_monitors(client, world)["volume"]["lastStatus"])
    assert statuses[0] == "unknown", "a monitor with no history must not read healthy"
    with source.begin() as c:
        c.execute(sa.text(f"DELETE FROM {SCHEMA}.orders WHERE id > 10"))
    for _ in range(3):
        _scan(client, world)
        assert _monitors(client, world)["volume"]["lastStatus"] == "breached"
    assert len(_open(client, world, "volume")) == 1


def test_schema_change_breaches_and_query_failure_is_error_not_ok(client, world, source):  # noqa: F811
    with source.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {SCHEMA}.orders ADD COLUMN IF NOT EXISTS note text"))
    assert _put(client, world, "owner", kind="schema").status_code == 200
    _scan(client, world)
    assert _monitors(client, world)["schema"]["lastStatus"] == "ok"
    with source.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {SCHEMA}.orders DROP COLUMN note"))
    _scan(client, world)
    m = _monitors(client, world)["schema"]
    assert m["lastStatus"] == "breached" and "note" in m["lastDetail"]["removed"]
    with source.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {SCHEMA}.orders RENAME TO orders_gone"))
    try:
        out = _scan(client, world)
        assert _monitors(client, world)["schema"]["lastStatus"] == "error"
        assert out["monitor_errors"] >= 1
        usage = {r["datasetId"]: r for r in client.get("/api/v1/observability/usage",
                                                        headers=world["owner"].headers).json()}
        assert usage[world["ds"].id]["health"] != "healthy"
    finally:
        with source.begin() as c:
            c.execute(sa.text(f"ALTER TABLE {SCHEMA}.orders_gone RENAME TO orders"))


def test_pausing_or_deleting_a_monitor_resolves_its_incident(client, world, source):  # noqa: F811
    assert _put(client, world, "owner", kind="freshness",
                config={"time_column": "loaded_at", "max_lag_hours": 1}).status_code == 200
    with source.begin() as c:
        c.execute(sa.text(f"UPDATE {SCHEMA}.orders SET loaded_at = loaded_at - interval '5 hours'"))
    _scan(client, world)
    assert len(_open(client, world, "freshness")) == 1
    assert _put(client, world, "owner", kind="freshness", is_active=False,
                config={"time_column": "loaded_at", "max_lag_hours": 1}).status_code == 200
    assert _open(client, world, "freshness") == []
    usage = {r["datasetId"]: r for r in client.get("/api/v1/observability/usage", headers=world["owner"].headers).json()}
    assert usage[world["ds"].id]["checks"]["active"] == 0, "a paused monitor was counted as coverage"
    mid = _monitors(client, world)["freshness"]["id"]
    assert client.delete(f"/api/v1/observability/monitors/{mid}", headers=world["viewer"].headers).status_code == 403
    assert client.delete(f"/api/v1/observability/monitors/{mid}", headers=world["owner"].headers).status_code == 204
    assert "freshness" not in _monitors(client, world)
    with source.begin() as c:
        c.execute(sa.text(f"UPDATE {SCHEMA}.orders SET loaded_at = now() AT TIME ZONE 'utc'"))
