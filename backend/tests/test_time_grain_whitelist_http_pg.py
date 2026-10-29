"""SEC-13 runtime regression over HTTP on real Postgres: a time grain never becomes SQL.

This is the behavioural counterpart to the structural test_time_grain_whitelist.py.
It drives the real app over HTTP against a real Postgres datasource and proves, on
the FIXED engine, every outcome the PO asked for:

  * a valid grain previews correct numbers;
  * a benign invalid grain is refused HTTP 400, and the query is NOT executed
    (no out-of-scope SQL, no out-of-scope data in the response);
  * a chart saved with an invalid-grain config is refused at RUNTIME when it is
    rendered (GET /charts/{id}/data) — the fix protects stored configs, not only
    the write path;
  * a public link rendering a valid chart works, and rendering the stored
    invalid-grain chart is refused — so the public/embed surface is covered.

The grain used here is a BENIGN non-grain ("not_a_grain"). The whitelist refuses
by exact match, so a benign value and a crafted one are refused through the
identical code path; no exploit payload is in this file. A secret table that is
in no Dataset is present so the test can assert the response never contains data
from outside the caller's scope.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.engine import make_url

from tests.authz_http import OWNER_URL, client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

SCHEMA = "sec13_rt"
SECRET = "SEC13-RUNTIME-OUTSIDE-EVERY-DATASET"
BENIGN_INVALID_GRAIN = "not_a_grain"
# Oracle for gqs_rt.sales, grain=month: Jan = 100+50 = 150, Feb = 30+20 = 50.
ORACLE_MONTH = {150, 50}


@pytest.fixture()
def world(db, monkeypatch):  # noqa: F811
    from app.core.config import settings as _settings
    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import Chart, ChartType, DataSource, DataSourceType
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
    import sqlalchemy as sa

    monkeypatch.setattr(_settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "127.0.0.0/8,::1/128")
    url = make_url(OWNER_URL)
    engine = sa.create_engine(OWNER_URL)
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.sales (order_id int, region text, amount numeric, "
                          f"order_date date)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.sales VALUES (1,'Bac',100,'2026-01-05'),"
                          f"(2,'Bac',50,'2026-01-20'),(3,'Nam',30,'2026-02-03'),(4,'Trung',20,'2026-02-17')"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.not_in_any_dataset (v text)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.not_in_any_dataset VALUES (:v)"), {"v": SECRET})

    tag = uuid.uuid4().hex[:6]
    owner = make_user(db, "rt-owner", data_sources="edit", datasets="edit", explore_charts="edit", dashboards="edit")
    author = make_user(db, "rt-author", datasets="view", explore_charts="edit", dashboards="edit")

    src = DataSource(name=f"rt-{tag}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                     config={"host": url.host, "port": url.port or 5432, "database": url.database,
                             "username": url.username, "password": url.password or ""})
    ds = Dataset(name=f"rt-sales-{tag}", owner_id=owner.id, purpose="reporting")
    db.add_all([src, ds])
    db.flush()
    table = DatasetTable(dataset_id=ds.id, datasource_id=src.id, source_kind="physical_table",
                         source_table_name=f"{SCHEMA}.sales", display_name="Sales", query_mode="live")
    model = SemanticModel(name=f"rt-model-{tag}", dataset_id=ds.id)
    db.add_all([table, model])
    db.flush()
    vname = f"rt_sales_{tag}"
    view = SemanticView(
        name=vname, sql_table_name=f"{SCHEMA}.sales", dataset_table_id=table.id,
        dimensions=[{"name": "region", "type": "string", "sql": "${TABLE}.region"},
                    {"name": "order_date", "type": "date", "sql": "${TABLE}.order_date"}],
        measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}],
    )
    db.add(view)
    db.flush()
    explore = SemanticExplore(name=f"rt_x_{tag}", model_id=model.id, base_view_id=view.id,
                              base_view_name=vname, joins=[])
    db.add(explore)
    db.add(DatasetGrant(dataset_id=ds.id, user_id=author.id, verb="explore", granted_by=owner.id))
    db.commit()
    try:
        yield dict(db=db, ds=ds, src=src, table=table, v=vname, owner=owner, author=author)
    finally:
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        engine.dispose()


def _role_config(world, grain):  # noqa: F811
    v = world["v"]
    return {"roleConfig": {"dimension": f"{v}.order_date", "metrics": [{"field": f"{v}.revenue", "agg": "sum"}],
                           "timeGrains": {f"{v}.order_date": grain}}}


def _preview(client, world, grain, who="author"):  # noqa: F811
    return client.post("/api/v1/charts/preview-data", headers=world[who].headers,
                       json={"dataset_table_id": world["table"].id, "chart_type": "BAR",
                             "config": _role_config(world, grain)})


# 1 + 4: a valid grain previews correct numbers, no secret
def test_a_valid_grain_previews_correct_numbers(client, world):  # noqa: F811
    r = _preview(client, world, "month")
    assert r.status_code == 200, r.text
    assert SECRET not in r.text
    vals = {int(float(v)) for row in r.json().get("data", []) for k, v in row.items()
            if isinstance(v, (int, float)) or (isinstance(v, str) and v.replace('.', '').isdigit())}
    assert ORACLE_MONTH.issubset(vals), r.text


def _is_grain_refusal(resp) -> bool:
    """A time-grain refusal raised BEFORE any SQL runs, distinguished from a
    database execution error. Two layers can raise it and both count:

      * the semantic engine at the render boundary — body names the grain in
        Vietnamese ('Độ chi tiết thời gian không hợp lệ');
      * the write-time role-config guard (defense in depth) — body is
        'role_config shape errors: timeGrains[...] must be one of ...'.

    On the pre-fix engine the malformed grain reaches Postgres instead and the
    body is 'Lỗi chạy chart query ... not recognized' — which this rejects."""
    detail = str((resp.json() or {}).get("detail", "")).lower()
    is_grain = "thời gian" in detail or "time grain" in detail or "timegrains" in detail
    return is_grain and "not recognized" not in detail


# 2 + 3: a benign invalid grain is refused before any SQL runs. Two layers may
# raise it: the write-time role-config guard (422, where present) or the semantic
# engine at the render boundary (400). Either is a grain refusal, not a DB error.
def test_a_benign_invalid_grain_is_refused_before_sql(client, world):  # noqa: F811
    r = _preview(client, world, BENIGN_INVALID_GRAIN)
    assert r.status_code in (400, 422), r.text
    assert _is_grain_refusal(r), r.text          # fails on the pre-fix engine (a DB error)
    assert SECRET not in r.text
    assert "data" not in r.json() or not r.json().get("data")


# 5: a chart STORED with an invalid grain is refused at RUNTIME when rendered
def test_a_stored_invalid_grain_chart_is_refused_at_render(client, world):  # noqa: F811
    from app.models.models import Chart, ChartType

    db = world["db"]
    # Write the bad config straight to the row (a saved chart that bypassed, or
    # pre-dates, write-time validation): the fix must still refuse it at render.
    bad = Chart(name=f"bad-{uuid.uuid4().hex[:6]}", chart_type=ChartType.BAR,
                dataset_table_id=world["table"].id, owner_id=world["owner"].id,
                config=_role_config(world, BENIGN_INVALID_GRAIN))
    good = Chart(name=f"good-{uuid.uuid4().hex[:6]}", chart_type=ChartType.BAR,
                 dataset_table_id=world["table"].id, owner_id=world["owner"].id,
                 config=_role_config(world, "month"))
    db.add_all([bad, good])
    db.commit()
    rbad = client.get(f"/api/v1/charts/{bad.id}/data", headers=world["owner"].headers)
    assert rbad.status_code == 400, rbad.text
    assert _is_grain_refusal(rbad), rbad.text    # refused at render, not a DB error
    assert SECRET not in rbad.text
    rgood = client.get(f"/api/v1/charts/{good.id}/data", headers=world["owner"].headers)
    assert rgood.status_code == 200, rgood.text
    assert SECRET not in rgood.text


# 6: the public surface renders a valid chart and refuses the stored invalid one
def test_public_render_refuses_the_stored_invalid_grain_chart(client, world):  # noqa: F811
    from app.models.models import (
        Chart, ChartType, Dashboard, DashboardChart, DashboardPublicLink,
    )

    db = world["db"]
    bad = Chart(name=f"pbad-{uuid.uuid4().hex[:6]}", chart_type=ChartType.BAR,
                dataset_table_id=world["table"].id, owner_id=world["owner"].id,
                config=_role_config(world, BENIGN_INVALID_GRAIN))
    good = Chart(name=f"pgood-{uuid.uuid4().hex[:6]}", chart_type=ChartType.BAR,
                 dataset_table_id=world["table"].id, owner_id=world["owner"].id,
                 config=_role_config(world, "month"))
    db.add_all([bad, good])
    db.flush()
    dash = Dashboard(name=f"pub-{uuid.uuid4().hex[:6]}", owner_id=world["owner"].id)
    db.add(dash)
    db.flush()
    for cid in (bad.id, good.id):
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=cid, widget_type="chart",
                              layout={"x": 0, "y": 0, "w": 6, "h": 4}))
    token = f"sec13rt-{uuid.uuid4().hex[:10]}"
    db.add(DashboardPublicLink(dashboard_id=dash.id, name="pub", token=token, is_active=True, filters_config=[]))
    db.commit()

    rgood = client.get(f"/api/v1/public/dashboards/{token}/charts/{good.id}/data")
    assert rgood.status_code == 200, rgood.text
    assert SECRET not in rgood.text
    rbad = client.get(f"/api/v1/public/dashboards/{token}/charts/{bad.id}/data")
    assert rbad.status_code >= 400, rbad.text
    assert SECRET not in rbad.text
