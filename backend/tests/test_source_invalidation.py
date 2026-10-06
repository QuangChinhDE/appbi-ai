"""Source hardening Phase B — invalidation (F10).

Locks, at domain level: a Dataset that cached schema/sample from source A loses
those caches when A's connection changes (config_version + 1), the live query
cache misses, the BigQuery client built for the old credential is not reused,
Sheets workbook caches for the old/new spreadsheet are dropped — for THIS source
only. A failed update invalidates nothing and persists nothing. A rename is not
a connection change. Delete invalidates too. `invalidate_source` is the only
entry point (no scattered eviction in the router / CRUD service).
"""
from __future__ import annotations

import inspect

import pytest

from source_phase_b_support import OWNER, make_db, no_network, pg_config

SA_A = '{"type": "service_account", "private_key": "KEY-A"}'
SA_B = '{"type": "service_account", "private_key": "KEY-B"}'


@pytest.fixture()
def S(monkeypatch):
    return make_db(monkeypatch)


def _source(S, name, ds_type="postgresql", config=None):
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    with S() as s:
        return DataSourceCRUDService.create(
            s, DataSourceCreate(name=name, type=ds_type, config=config or pg_config()), owner_id=OWNER).id


def _dataset_with_cached_table(S, ds_id, name):
    from app.models.dataset import Dataset, DatasetTable
    with S() as s:
        d = Dataset(name=name, owner_id=OWNER)
        s.add(d)
        s.flush()
        t = DatasetTable(dataset_id=d.id, datasource_id=ds_id, source_kind="physical_table",
                         source_table_name="public.orders", display_name="orders",
                         columns_cache={"columns": [{"name": "a"}]}, sample_cache=[{"a": 1}])
        s.add(t)
        s.commit()
        return d.id, t.id


def _table(S, tid):
    from app.models.dataset import DatasetTable
    with S() as s:
        t = s.get(DatasetTable, tid)
        return t.columns_cache, t.sample_cache


def _qc_put(ds_id):
    from app.services import query_cache
    query_cache.set_cached(ds_id, "t", "BAR", {}, [], {"rows": [1]})


def _qc_get(ds_id):
    from app.services import query_cache
    return query_cache.get_cached(ds_id, "t", "BAR", {}, [])


def test_connection_change_clears_this_sources_caches_only(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    a = _source(S, "A")
    b = _source(S, "B", config=pg_config(host="db-b.example.com"))
    _, ta = _dataset_with_cached_table(S, a, "DA")
    _, tb = _dataset_with_cached_table(S, b, "DB")
    _qc_put(a)
    _qc_put(b)
    with S() as s:
        ds = DataSourceCRUDService.update(s, a, DataSourceUpdate(config=pg_config(host="db-a2.example.com")))
        assert ds.config_version == 2
    assert _table(S, ta) == (None, None)
    assert _qc_get(a) is None, "query cache must miss after the source changed"
    assert _table(S, tb) != (None, None) and _qc_get(b) is not None, "other sources untouched"


def test_rename_is_not_a_connection_change(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    a = _source(S, "A")
    _, ta = _dataset_with_cached_table(S, a, "DA")
    _qc_put(a)
    with S() as s:
        DataSourceCRUDService.update(s, a, DataSourceUpdate(name="A renamed", config=pg_config()))
    assert _table(S, ta) != (None, None) and _qc_get(a) is not None


@pytest.mark.parametrize("failure", ["invalid", "connection"])
def test_failed_update_invalidates_nothing_and_persists_nothing(S, monkeypatch, failure):
    from app.models.models import DataSource
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    a = _source(S, "A")
    _, ta = _dataset_with_cached_table(S, a, "DA")
    _qc_put(a)
    no_network(monkeypatch, ok=False)
    cfg = {"port": 0} if failure == "invalid" else pg_config(host="db-z.example.com")
    with S() as s, pytest.raises(SourceConfigError):
        DataSourceCRUDService.update(s, a, DataSourceUpdate(name="X", config=cfg), test_connection=True)
    assert _table(S, ta) != (None, None) and _qc_get(a) is not None
    with S() as s:
        row = s.get(DataSource, a)
        assert row.name == "A" and row.config_version == 1


def test_bigquery_credential_change_never_reuses_the_old_client(S):
    import app.services.datasource_service as dsm
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    dsm._BQ_CLIENT_CACHE.clear()
    a = _source(S, "BQ-A", "bigquery", {"project_id": "p", "credentials_json": SA_A})
    other = _source(S, "BQ-O", "bigquery", {"project_id": "other", "credentials_json": SA_A})

    class _C:
        closed = False

        def close(self):
            self.closed = True
    from app.models.models import DataSource
    with S() as s:
        key_a = dsm._bigquery_client_cache_key(dict(s.get(DataSource, a).config))
        key_o = dsm._bigquery_client_cache_key(dict(s.get(DataSource, other).config))
    old, kept = _C(), _C()
    dsm._BQ_CLIENT_CACHE[key_a] = (10**12, old)
    dsm._BQ_CLIENT_CACHE[key_o] = (10**12, kept)
    with S() as s:
        ds = DataSourceCRUDService.update(s, a, DataSourceUpdate(config={"project_id": "p", "credentials_json": SA_B}))
        new_key = dsm._bigquery_client_cache_key(dict(ds.config))
    assert key_a not in dsm._BQ_CLIENT_CACHE and old.closed
    assert new_key != key_a
    assert dsm._BQ_CLIENT_CACHE.get(key_o, (0, None))[1] is kept and not kept.closed
    dsm._BQ_CLIENT_CACHE.clear()


def test_sheets_change_drops_old_and_new_workbook_caches(S, monkeypatch):
    from app.schemas import DataSourceUpdate
    from app.services import google_sheets_cache
    from app.services.datasource_crud_service import DataSourceCRUDService
    dropped = []
    monkeypatch.setattr(google_sheets_cache, "invalidate", lambda sid: dropped.append(sid))
    a = _source(S, "GS", "google_sheets", {"spreadsheet_id": "sheet-old", "credentials_json": SA_A})
    with S() as s:
        DataSourceCRUDService.update(s, a, DataSourceUpdate(config={"spreadsheet_id": "sheet-new"}))
    assert set(dropped) == {"sheet-old", "sheet-new"}


def test_delete_invalidates_the_query_cache(S):
    from app.services.datasource_crud_service import DataSourceCRUDService
    a = _source(S, "A")
    _qc_put(a)
    with S() as s:
        assert DataSourceCRUDService.delete(s, a)
    assert _qc_get(a) is None


def test_invalidate_source_is_the_only_entry_point():
    import app.api.datasources as api
    import app.services.datasource_crud_service as crud
    for mod in (api, crud):
        src = inspect.getsource(mod)
        for forbidden in ("evict_bigquery_client_cache", "query_cache.invalidate_datasource",
                          "'columns_cache': None", '"columns_cache": None', "google_sheets_cache.invalidate"):
            assert forbidden not in src, f"{mod.__name__} still invalidates directly: {forbidden}"
    assert "invalidate_source(" in inspect.getsource(crud)
