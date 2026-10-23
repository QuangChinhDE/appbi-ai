"""SEC-13: a chart time grain is interpolated into SQL on Postgres/DuckDB. Real HTTP, real Postgres.

`SemanticQueryEngine` renders a grain as `DATE_TRUNC('<grain>', <col>)` with no
whitelist (Postgres and DuckDB). `POST /charts/preview-data` takes `config` as a
free dict and never runs `check_role_config_shape`, so `roleConfig.timeGrains`
reaches the engine as any string. A caller holding `explore` on ONE Dataset can
then read anything the source credential can read: here a table that is in no
Dataset at all.

The reproduction is executed, not inferred, on a disposable database. It was a
known-defect ledger entry (`xfail(strict=True)`) until the fix landed: #65 (the
grain whitelisted at the SQL render boundary) and #67 (chart config validated at
every write). With both present the ledger XPASSed, so the marker is removed and
the same payload is now a plain regression: preview AND save refuse the grain
and never return the out-of-Dataset value.
"""
from __future__ import annotations

import pytest
import sqlalchemy as sa

from tests.authz_http import client, db, make_user  # noqa: F401
from tests.test_intelligence_gqs_execution_pg import SCHEMA, _owner_url, world  # noqa: F401

pytestmark = pytest.mark.pg

SECRET = "SEC13-OUTSIDE-EVERY-DATASET"


class REPRODUCED(AssertionError):
    """The defect is still there."""


@pytest.fixture()
def secret_table(world):  # noqa: F811
    engine = sa.create_engine(_owner_url())
    with engine.begin() as c:
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.not_in_any_dataset (v text)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.not_in_any_dataset VALUES (:v)"), {"v": SECRET})
    engine.dispose()
    from app.models.dataset import DatasetGrant

    # An ordinary chart author: the Explore module, and `explore` on ONE Dataset.
    author = make_user(world["db"], "sec13-author", datasets="view", explore_charts="edit")
    world["db"].add(DatasetGrant(dataset_id=world["ds"].id, user_id=author.id, verb="explore",
                                 granted_by=world["owner"].id))
    world["db"].commit()
    return {**world, "author": author}


def _table_id(world):  # noqa: F811
    from app.models.dataset import DatasetTable

    return world["db"].query(DatasetTable.id).filter(DatasetTable.dataset_id == world["ds"].id,
                                                     DatasetTable.source_table_name == f"{SCHEMA}.sales").scalar()


def _preview(client, world, grain):  # noqa: F811
    return client.post("/api/v1/charts/preview-data", headers=world["author"].headers, json={
        "dataset_table_id": _table_id(world),
        "chart_type": "BAR",
        "config": {"roleConfig": {"dimension": f"{world['v']}.order_date",
                                  "metrics": [{"field": f"{world['v']}.revenue", "agg": "sum"}],
                                  "timeGrains": {f"{world['v']}.order_date": grain}}},
    })


def test_a_valid_grain_previews(client, secret_table):  # noqa: F811
    r = _preview(client, secret_table, "month")
    assert r.status_code == 200, r.text


def _evil():
    return (f"day', NOW())::text || (SELECT string_agg(v, ',') FROM {SCHEMA}.not_in_any_dataset) "
            f"|| DATE_TRUNC('day")


def test_a_grain_is_never_sql(client, secret_table):  # noqa: F811
    r = _preview(client, secret_table, _evil())
    if SECRET in r.text:
        raise REPRODUCED("a grain read a table that is in no Dataset")
    assert r.status_code in (400, 422), r.text


def test_a_chart_with_such_a_grain_cannot_be_saved(client, secret_table):  # noqa: F811
    """The write ingress (#67): the same grain in a chart someone SAVES is refused
    before anything is stored, so no later render can run it."""
    w = secret_table
    r = client.post("/api/v1/charts/", headers=w["author"].headers, json={
        "name": "sec13", "chart_type": "BAR", "dataset_table_id": _table_id(w),
        "config": {"roleConfig": {"dimension": f"{w['v']}.order_date",
                                  "metrics": [{"field": f"{w['v']}.revenue", "agg": "sum"}],
                                  "timeGrains": {f"{w['v']}.order_date": _evil()}}},
    })
    if SECRET in r.text:
        raise REPRODUCED("a saved grain read a table that is in no Dataset")
    assert r.status_code in (400, 422), r.text
