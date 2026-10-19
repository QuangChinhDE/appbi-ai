"""SEC-02 closure: seeing a table's structure is not reading its rows. Real Postgres, real HTTP.

`GET /api/v1/datasources/{id}/tables/{schema}/{table}` returned column metadata AND
`SELECT * … LIMIT preview_rows` to anyone with `data_sources: view`. PR-0B3 first
capped the rows at 100. That was containment, not closure: a viewer still read
100 raw records of any table on the source, including tables no Dataset grants.

Closure: rows need `use_secret` on the source (the editor level). That is the same
action the stored-credential connection test already requires
(`test_authz_datasource_secret_http_pg.py`). A viewer gets the metadata and an
explicit refusal of the rows.

The data source here is a REAL Postgres connection, pointing back at the test
database's own owner role, with a table holding values a viewer must not see.
Nothing is stubbed.
"""
from __future__ import annotations

import os
import uuid
from urllib.parse import urlparse

import pytest
import sqlalchemy as sa

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

SCHEMA = "sec02_src"
SECRET_VALUE = "LUONG-GIAM-DOC-123456789"


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.models import DataSource, DataSourceType

    url = urlparse(os.environ["AUTHZ_PG_OWNER_URL"])
    engine = sa.create_engine(os.environ["AUTHZ_PG_OWNER_URL"])
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.payroll (employee text, salary text)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.payroll VALUES ('An', :v), ('Binh', 'x')"),
                  {"v": SECRET_VALUE})

    owner = make_user(db, "pv-owner", data_sources="edit")
    viewer = make_user(db, "pv-viewer", data_sources="view")
    editor = make_user(db, "pv-editor", data_sources="edit")
    ds = DataSource(
        name=f"pv-{uuid.uuid4().hex[:8]}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
        config={"host": url.hostname, "port": url.port or 5432, "database": url.path.lstrip("/"),
                "username": url.username, "password": url.password},
    )
    db.add(ds)
    db.commit()
    share(db, "datasource", ds.id, viewer, "view", owner)
    share(db, "datasource", ds.id, editor, "edit", owner)
    try:
        yield dict(ds=ds, viewer=viewer, editor=editor)
    finally:
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        engine.dispose()


def _detail(client, world, who, rows):  # noqa: F811
    r = client.get(f"/api/v1/datasources/{world['ds'].id}/tables/{SCHEMA}/payroll",
                   headers=world[who].headers, params={"preview_rows": rows})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_viewer_sees_the_structure_and_not_one_row(client, world):  # noqa: F811
    body = _detail(client, world, "viewer", 5)
    assert {c["name"] for c in body["columns"]} >= {"employee", "salary"}
    assert body["preview"] == []
    assert body.get("preview_refused")
    assert SECRET_VALUE not in str(body)


def test_an_editor_of_the_source_reads_the_preview(client, world):  # noqa: F811
    """The allow half: the rows are refused for viewers, not removed for everyone."""
    body = _detail(client, world, "editor", 5)
    assert SECRET_VALUE in str(body["preview"])
    assert "preview_refused" not in body


def test_even_an_editor_is_held_to_the_row_ceiling(client, world):  # noqa: F811
    from app.api.datasources import TABLE_PREVIEW_MAX_ROWS

    body = _detail(client, world, "editor", 1_000_000)
    assert len(body["preview"]) <= TABLE_PREVIEW_MAX_ROWS
