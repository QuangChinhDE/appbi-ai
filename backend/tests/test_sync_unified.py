"""
Comprehensive tests for the unified sync + fetch pipeline.

Covers:
  - _sanitize()
  - extract_sheet_name_from_sql()
  - rewrite_sql_for_duckdb()
  - fetch_table_data()
  - get_synced_view()
  - _sync_one_table() strategy dispatch

Run:
    cd backend
    pytest tests/test_sync_unified.py -v
"""
import sys
import types
import importlib
import importlib.util
from pathlib import Path
import pytest
from unittest.mock import MagicMock, patch, call

# ---------------------------------------------------------------------------
# Bootstrap: create lightweight package stubs for `app` and `app.services`
# so that Python can find service modules on the filesystem WITHOUT running
# the heavy __init__.py files (which pull in FastAPI, SQLAlchemy, etc.).
# ---------------------------------------------------------------------------

_BACKEND = Path(__file__).parent.parent          # .../backend
_APP_DIR = str(_BACKEND / "app")
_SVC_DIR = str(_BACKEND / "app" / "services")


def _make_pkg(name: str, path: str):
    """Create a minimal package stub with __path__ set so sub-imports work."""
    mod = types.ModuleType(name)
    mod.__path__ = [path]
    mod.__package__ = name
    sys.modules[name] = mod
    return mod


def _stub_module(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


# Register app and app.services as lightweight package stubs (no __init__.py run)
_app_pkg = _make_pkg("app", _APP_DIR)
_svc_pkg = _make_pkg("app.services", _SVC_DIR)
_app_pkg.services = _svc_pkg

# Also need app.core, app.models as package stubs so sub-imports resolve
_core_pkg = _make_pkg("app.core", str(_BACKEND / "app" / "core"))
_models_pkg = _make_pkg("app.models", str(_BACKEND / "app" / "models"))
_app_pkg.core = _core_pkg
_app_pkg.models = _models_pkg

# ---------------------------------------------------------------------------
# Stub heavy 3rd-party and internal deps
# ---------------------------------------------------------------------------

# Third-party libs
_stub_module("psycopg2")
_stub_module("pymysql")
_stub_module("google")
_stub_module("google.cloud", bigquery=MagicMock())
_stub_module("google.cloud.bigquery")
_stub_module("google.oauth2", service_account=MagicMock())
_stub_module("google.oauth2.service_account")
_stub_module("pyarrow", Table=MagicMock(), array=MagicMock(), string=MagicMock())
_stub_module("pyarrow.parquet")

# App core stubs (leaf modules, loaded by service modules at import time)
_stub_module("app.core.logging", get_logger=lambda n: MagicMock())
_stub_module("app.core.database", SessionLocal=MagicMock())
_stub_module("app.core.crypto", decrypt_config=lambda c: c)
_stub_module("app.services.sql_validator", validate_select_only=lambda s: None)
_stub_module("app.services.google_sheets_connector",
             create_google_sheets_connector=MagicMock())
_stub_module("app.services.ingestion_engine", DATA_DIR=MagicMock())

# Stub app.models with a real DataSourceType class so .value comparisons work
class _DSType:
    POSTGRESQL = MagicMock(value="postgresql")
    MYSQL = MagicMock(value="mysql")
    BIGQUERY = MagicMock(value="bigquery")
    GOOGLE_SHEETS = MagicMock(value="google_sheets")
    MANUAL = MagicMock(value="manual")

_models_mod = _stub_module("app.models.models", DataSource=MagicMock())
_stub_module("app.models",
             DataSource=MagicMock(), SyncJob=MagicMock(),
             DataSourceType=_DSType)

# ---------------------------------------------------------------------------
# Import real service modules under test (now possible without FastAPI / DB)
# ---------------------------------------------------------------------------
from app.services.manual_table_connector import (  # noqa: E402
    extract_sheet_name_from_sql,
    ManualTableConnector,
)


# ---------------------------------------------------------------------------
# _sanitize
# ---------------------------------------------------------------------------

def _get_sanitize():
    """Import _sanitize lazily after stubs are in place."""
    import app.services.sync_engine as se
    return se._sanitize


class TestSanitize:
    def setup_method(self):
        self._san = _get_sanitize()

    def test_lowercase(self):
        assert self._san("Orders") == "orders"

    def test_spaces_become_underscores(self):
        assert self._san("Sales Data") == "sales_data"

    def test_hyphens_become_underscores(self):
        assert self._san("my-table") == "my_table"

    def test_adjacent_hyphens_become_double_underscore(self):
        # "a--b" → "a__b" (important: view suffix search must NOT split on __)
        assert self._san("a--b") == "a__b"

    def test_spreadsheet_id_with_hyphens(self):
        sid = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
        result = self._san(sid)
        assert "-" not in result
        assert result == result.lower()

    def test_mixed_special_chars(self):
        assert self._san("My Table!@#") == "my_table___"

    def test_already_clean(self):
        assert self._san("public") == "public"


# ---------------------------------------------------------------------------
# extract_sheet_name_from_sql
# ---------------------------------------------------------------------------

class TestExtractSheetName:
    def test_bare_name(self):
        assert extract_sheet_name_from_sql("SELECT * FROM Sheet1") == "Sheet1"

    def test_double_quoted_name(self):
        assert extract_sheet_name_from_sql('SELECT * FROM "Sales Data"') == "Sales Data"

    def test_backtick_name(self):
        assert extract_sheet_name_from_sql("SELECT * FROM `Orders`") == "Orders"

    def test_single_quoted_name(self):
        assert extract_sheet_name_from_sql("SELECT * FROM 'Sheet1'") == "Sheet1"

    def test_schema_qualified_bare(self):
        assert extract_sheet_name_from_sql("SELECT * FROM manual.Sheet1") == "Sheet1"

    def test_schema_qualified_quoted_table(self):
        assert extract_sheet_name_from_sql('SELECT * FROM public."Sales Data"') == "Sales Data"

    def test_spreadsheet_id_with_hyphens_as_schema(self):
        # Spreadsheet IDs contain hyphens — old \w+ schema prefix would break here
        sql = 'SELECT * FROM "1BxiMVs0XRA5nFMd-KvBd"."Sheet1"'
        assert extract_sheet_name_from_sql(sql) == "Sheet1"

    def test_spacey_sheet_with_schema(self):
        sql = 'SELECT * FROM "my_spreadsheet"."Revenue by Region"'
        assert extract_sheet_name_from_sql(sql) == "Revenue by Region"

    def test_with_limit_clause(self):
        assert extract_sheet_name_from_sql('SELECT * FROM "Sheet1" LIMIT 100') == "Sheet1"

    def test_no_match_returns_manual_data(self):
        assert extract_sheet_name_from_sql("SELECT 1") == "manual_data"

    def test_case_insensitive_from(self):
        assert extract_sheet_name_from_sql("select * from Sheet1") == "Sheet1"


# ---------------------------------------------------------------------------
# ManualTableConnector
# ---------------------------------------------------------------------------

class TestManualTableConnector:
    def _make(self, config):
        return ManualTableConnector(config)

    def test_new_format_list_sheets(self):
        cfg = {"sheets": {"Sheet1": {"columns": [], "rows": []},
                          "Sheet2": {"columns": [], "rows": []}}}
        conn = self._make(cfg)
        assert set(conn.list_sheets()) == {"Sheet1", "Sheet2"}

    def test_legacy_format_wrapped(self):
        cfg = {"columns": [{"name": "id"}], "rows": [{"id": 1}]}
        conn = self._make(cfg)
        data = conn.get_table_data()
        assert data["rows"] == [{"id": 1}]

    def test_get_sheet_data_exact(self):
        cfg = {"sheets": {"Revenue": {"columns": [{"name": "amount"}], "rows": [{"amount": 100}]}}}
        conn = self._make(cfg)
        data = conn.get_sheet_data("Revenue")
        assert data["rows"] == [{"amount": 100}]

    def test_get_sheet_data_case_insensitive(self):
        cfg = {"sheets": {"revenue": {"columns": [], "rows": [{"x": 1}]}}}
        conn = self._make(cfg)
        data = conn.get_sheet_data("REVENUE")
        assert data["rows"] == [{"x": 1}]

    def test_get_sheet_data_fallback_first_sheet(self):
        cfg = {"sheets": {"OnlySheet": {"columns": [], "rows": [{"v": 42}]}}}
        conn = self._make(cfg)
        # Request a name that doesn't exist → fall back to first sheet
        data = conn.get_sheet_data("nonexistent")
        assert data["rows"] == [{"v": 42}]


# ---------------------------------------------------------------------------
# rewrite_sql_for_duckdb
# ---------------------------------------------------------------------------

def _make_rewrite_test(synced_views):
    """
    Patch _get_synced_view_set to return synced_views and return the function.
    """
    import app.services.sync_engine as se
    with patch.object(se, "_get_synced_view_set", return_value=set(synced_views)):
        yield se.rewrite_sql_for_duckdb


import contextlib

@contextlib.contextmanager
def _rewrite_ctx(synced_views):
    import app.services.sync_engine as se
    with patch.object(se, "_get_synced_view_set", return_value=set(synced_views)):
        yield se.rewrite_sql_for_duckdb


class TestRewriteSqlForDuckdb:
    def test_bare_table_rewritten(self):
        views = {"synced_ds1__public__orders"}
        with _rewrite_ctx(views) as rw:
            result = rw(1, "SELECT * FROM orders")
        assert result == "SELECT * FROM synced_ds1__public__orders"

    def test_quoted_spacey_table_rewritten(self):
        views = {"synced_ds1__public__sales_data"}
        with _rewrite_ctx(views) as rw:
            result = rw(1, 'SELECT * FROM "Sales Data"')
        assert result is not None
        assert "synced_ds1__public__sales_data" in result

    def test_schema_qualified_rewritten(self):
        views = {"synced_ds2__reporting__revenue"}
        with _rewrite_ctx(views) as rw:
            result = rw(2, 'SELECT * FROM "reporting"."revenue"')
        assert result is not None
        assert "synced_ds2__reporting__revenue" in result

    def test_spreadsheet_id_schema_with_hyphens(self):
        # _sanitize("1BxiMVs0XRA5nFMd") → "1bximvs0xra5nfmd" (only lowercased, no underscores added)
        views = {"synced_ds3__1bximvs0xra5nfmd__sheet1"}
        with _rewrite_ctx(views) as rw:
            result = rw(3, 'SELECT * FROM "1BxiMVs0XRA5nFMd"."Sheet1"')
        assert result is not None
        assert "synced_ds3__1bximvs0xra5nfmd__sheet1" in result

    def test_double_underscore_in_schema_does_not_break_suffix_match(self):
        # Schema "a--b" sanitizes to "a__b"; suffix endswith search must still find it
        views = {"synced_ds4__a__b__orders"}
        with _rewrite_ctx(views) as rw:
            result = rw(4, "SELECT * FROM orders")
        assert result is not None
        assert "synced_ds4__a__b__orders" in result

    def test_no_synced_views_returns_none(self):
        with _rewrite_ctx([]) as rw:
            assert rw(1, "SELECT * FROM orders") is None

    def test_table_not_synced_returns_none(self):
        views = {"synced_ds1__public__other_table"}
        with _rewrite_ctx(views) as rw:
            assert rw(1, "SELECT * FROM orders") is None

    def test_join_both_tables_rewritten(self):
        views = {"synced_ds1__public__orders", "synced_ds1__public__customers"}
        with _rewrite_ctx(views) as rw:
            result = rw(1, "SELECT * FROM orders JOIN customers ON orders.id = customers.order_id")
        assert result is not None
        assert "synced_ds1__public__orders" in result
        assert "synced_ds1__public__customers" in result

    def test_quoted_spacey_names_in_join(self):
        views = {"synced_ds1__public__sales_data", "synced_ds1__public__product_list"}
        with _rewrite_ctx(views) as rw:
            result = rw(1, 'SELECT * FROM "Sales Data" JOIN "Product List" ON "Sales Data".id = "Product List".sid')
        assert result is not None
        assert "synced_ds1__public__sales_data" in result
        assert "synced_ds1__public__product_list" in result

    def test_partial_sync_only_replaces_synced(self):
        # Only orders is synced; customers is not
        views = {"synced_ds1__public__orders"}
        with _rewrite_ctx(views) as rw:
            result = rw(1, "SELECT * FROM orders JOIN customers ON orders.id = customers.order_id")
        # At least orders replaced → not None
        assert result is not None
        assert "synced_ds1__public__orders" in result
        assert "customers" in result  # left as-is


# ---------------------------------------------------------------------------
# fetch_table_data
# ---------------------------------------------------------------------------

class TestFetchTableData:
    """Unit-tests for fetch_table_data — patch the private _execute_* helpers."""

    def _svc(self):
        from app.services.datasource_service import DataSourceConnectionService
        return DataSourceConnectionService

    def test_postgresql_basic(self):
        svc = self._svc()
        with patch.object(svc, "_execute_postgresql", return_value=(["id"], [{"id": 1}])) as mock_pg:
            cols, rows = svc.fetch_table_data("postgresql", {}, "public", "orders")
        mock_pg.assert_called_once()
        call_sql = mock_pg.call_args[0][1]
        assert '"public"."orders"' in call_sql
        assert cols == ["id"]

    def test_postgresql_default_schema_resolves_to_public(self):
        svc = self._svc()
        with patch.object(svc, "_execute_postgresql", return_value=([], [])) as mock_pg:
            svc.fetch_table_data("postgresql", {}, "default", "orders")
        call_sql = mock_pg.call_args[0][1]
        assert '"public"."orders"' in call_sql

    def test_postgresql_default_schema_resolves_to_configured_schema(self):
        svc = self._svc()
        with patch.object(svc, "_execute_postgresql", return_value=([], [])) as mock_pg:
            svc.fetch_table_data("postgresql", {"schema_name": "reporting"}, "default", "orders")
        call_sql = mock_pg.call_args[0][1]
        assert '"reporting"."orders"' in call_sql

    def test_mysql_basic(self):
        svc = self._svc()
        with patch.object(svc, "_execute_mysql", return_value=(["id"], [])) as mock_my:
            svc.fetch_table_data("mysql", {}, "mydb", "users")
        call_sql = mock_my.call_args[0][1]
        assert "`mydb`.`users`" in call_sql

    def test_mysql_default_schema_resolves_to_database(self):
        svc = self._svc()
        with patch.object(svc, "_execute_mysql", return_value=([], [])) as mock_my:
            svc.fetch_table_data("mysql", {"database": "appdb"}, "default", "users")
        call_sql = mock_my.call_args[0][1]
        assert "`appdb`.`users`" in call_sql

    def test_gsheets_uses_native_api_not_fake_sql(self):
        svc = self._svc()
        fake_connector = MagicMock()
        fake_connector.get_sheet_data.return_value = {
            "columns": [{"name": "A"}, {"name": "B"}],
            "rows": [{"A": 1, "B": 2}],
        }
        with patch("app.services.google_sheets_connector.create_google_sheets_connector",
                   return_value=fake_connector):
            cols, rows = svc.fetch_table_data(
                "google_sheets",
                {"spreadsheet_id": "abc123"},
                "abc123",
                "Sheet1",
            )
        fake_connector.get_sheet_data.assert_called_once_with("abc123", sheet_name="Sheet1")
        assert cols == ["A", "B"]
        assert rows == [{"A": 1, "B": 2}]

    def test_manual_uses_native_api_not_fake_sql(self):
        svc = self._svc()
        fake_connector = MagicMock()
        fake_connector.get_sheet_data.return_value = {
            "columns": [{"name": "col1"}],
            "rows": [{"col1": "hello"}],
        }
        with patch("app.services.manual_table_connector.create_manual_table_connector",
                   return_value=fake_connector):
            cols, rows = svc.fetch_table_data("manual", {}, "manual", "MySheet")
        fake_connector.get_sheet_data.assert_called_once_with("MySheet")
        assert cols == ["col1"]

    def test_limit_applied_postgresql(self):
        svc = self._svc()
        with patch.object(svc, "_execute_postgresql", return_value=([], [])) as mock_pg:
            svc.fetch_table_data("postgresql", {}, "public", "orders", limit=1000)
        call_sql = mock_pg.call_args[0][1]
        assert "LIMIT 1000" in call_sql

    def test_limit_applied_gsheets_slices_rows(self):
        svc = self._svc()
        fake_connector = MagicMock()
        fake_connector.get_sheet_data.return_value = {
            "columns": [{"name": "x"}],
            "rows": [{"x": i} for i in range(50)],
        }
        with patch("app.services.google_sheets_connector.create_google_sheets_connector",
                   return_value=fake_connector):
            cols, rows = svc.fetch_table_data(
                "google_sheets", {"spreadsheet_id": "s"}, "s", "Sheet1", limit=10
            )
        assert len(rows) == 10

    def test_limit_applied_manual_slices_rows(self):
        svc = self._svc()
        fake_connector = MagicMock()
        fake_connector.get_sheet_data.return_value = {
            "columns": [{"name": "x"}],
            "rows": [{"x": i} for i in range(100)],
        }
        with patch("app.services.manual_table_connector.create_manual_table_connector",
                   return_value=fake_connector):
            cols, rows = svc.fetch_table_data("manual", {}, "manual", "Sheet1", limit=5)
        assert len(rows) == 5

    def test_unsupported_type_raises(self):
        from app.services.datasource_service import DataSourceConnectionService
        with pytest.raises(ValueError, match="unsupported datasource type"):
            DataSourceConnectionService.fetch_table_data("unknown_type", {}, "s", "t")


# ---------------------------------------------------------------------------
# get_synced_view
# ---------------------------------------------------------------------------

def _mock_duckdb_engine_read_conn(rows_or_exception, *, is_fetchone=False):
    """
    Build a context-manager-compatible mock for DuckDBEngine.read_conn().
    Stubs duckdb_engine into sys.modules so lazy imports inside sync_engine work.
    """
    mock_conn = MagicMock()
    mock_conn.__enter__ = lambda s: s
    mock_conn.__exit__ = MagicMock(return_value=False)
    if isinstance(rows_or_exception, Exception):
        mock_conn.execute.side_effect = rows_or_exception
    elif is_fetchone:
        mock_conn.execute.return_value.fetchone.return_value = rows_or_exception
    else:
        mock_conn.execute.return_value.fetchall.return_value = rows_or_exception

    mock_engine = MagicMock()
    mock_engine.read_conn.return_value = mock_conn

    duckdb_stub = _stub_module("app.services.duckdb_engine", DuckDBEngine=mock_engine)
    return mock_engine, duckdb_stub


class TestGetSyncedView:
    def _se(self):
        # Force re-import so our duckdb_engine stub is picked up
        if "app.services.sync_engine" in sys.modules:
            del sys.modules["app.services.sync_engine"]
        import app.services.sync_engine as se
        return se

    def test_bare_name_found_via_like(self):
        _mock_duckdb_engine_read_conn([("synced_ds1__public__orders",)])
        se = self._se()
        result = se.get_synced_view(1, "orders")
        assert result == "synced_ds1__public__orders"

    def test_bare_name_not_found_returns_none(self):
        _mock_duckdb_engine_read_conn([])
        se = self._se()
        result = se.get_synced_view(1, "nonexistent")
        assert result is None

    def test_schema_qualified_found_exact(self):
        _mock_duckdb_engine_read_conn((1,), is_fetchone=True)
        se = self._se()
        result = se.get_synced_view(2, "reporting.revenue")
        assert result == "synced_ds2__reporting__revenue"

    def test_schema_qualified_not_found_returns_none(self):
        _mock_duckdb_engine_read_conn((0,), is_fetchone=True)
        se = self._se()
        result = se.get_synced_view(2, "reporting.missing")
        assert result is None

    def test_exception_returns_none(self):
        _mock_duckdb_engine_read_conn(Exception("duckdb gone"))
        se = self._se()
        result = se.get_synced_view(1, "orders")
        assert result is None


# ---------------------------------------------------------------------------
# _sync_one_table — strategy dispatch
# ---------------------------------------------------------------------------

class TestSyncOneTable:
    def _make_ds(self, type_="postgresql"):
        ds = MagicMock()
        ds.id = 1
        ds.type = type_
        ds.config = {}
        return ds

    def _import_se(self):
        import app.services.sync_engine as se
        return se

    def test_full_refresh_uses_fetch_table_data(self):
        se = self._import_se()
        ds = self._make_ds()
        with (
            patch.object(se.DataSourceConnectionService, "fetch_table_data",
                         return_value=(["id"], [{"id": 1}])) as mock_fetch,
            patch.object(se, "_write_parquet", return_value=1),
            patch.object(se, "_register_duckdb_view"),
            patch.object(se, "_delta_dir", return_value=MagicMock(exists=lambda: False)),
            patch.object(se, "_parquet_path", return_value=MagicMock()),
        ):
            count = se._sync_one_table(ds, "public", "orders", {"strategy": "full_refresh"})

        mock_fetch.assert_called_once_with(ds.type, ds.config, "public", "orders")
        assert count == 1

    def test_append_only_uses_fetch_table_data(self):
        se = self._import_se()
        ds = self._make_ds()
        with (
            patch.object(se.DataSourceConnectionService, "fetch_table_data",
                         return_value=(["id"], [{"id": 1}, {"id": 2}])) as mock_fetch,
            patch.object(se, "_write_parquet", return_value=2),
            patch.object(se, "_register_duckdb_view"),
            patch.object(se, "_delta_dir", return_value=MagicMock(exists=lambda: False)),
        ):
            count = se._sync_one_table(ds, "public", "orders", {"strategy": "append_only"})

        mock_fetch.assert_called_once_with(ds.type, ds.config, "public", "orders")
        assert count == 2

    def test_incremental_with_watermark_uses_execute_query_not_fetch(self):
        se = self._import_se()
        ds = self._make_ds()
        with (
            patch.object(se, "_get_watermark_max", return_value="2024-01-01"),
            patch.object(se.DataSourceConnectionService, "execute_query",
                         return_value=(["id", "ts"], [{"id": 1, "ts": "2024-02-01"}], 10)) as mock_exec,
            patch.object(se.DataSourceConnectionService, "fetch_table_data") as mock_fetch,
            patch.object(se, "_write_parquet", return_value=1),
            patch.object(se, "_register_duckdb_view"),
            patch.object(se, "_delta_dir", return_value=MagicMock(
                exists=lambda: False,
                __truediv__=lambda s, o: MagicMock(),
            )),
        ):
            count = se._sync_one_table(ds, "public", "orders", {
                "strategy": "incremental",
                "watermark_column": "ts",
            })

        # incremental with watermark uses execute_query (has a WHERE clause)
        mock_exec.assert_called_once()
        mock_fetch.assert_not_called()
        # The SQL should contain the WHERE clause
        call_sql = mock_exec.call_args[0][2]
        assert "WHERE" in call_sql
        assert '"ts"' in call_sql

    def test_incremental_first_run_falls_through_to_full_refresh(self):
        """When no watermark exists yet, incremental falls through to full_refresh."""
        se = self._import_se()
        ds = self._make_ds()
        with (
            patch.object(se, "_get_watermark_max", return_value=None),
            patch.object(se.DataSourceConnectionService, "fetch_table_data",
                         return_value=(["id"], [{"id": 1}])) as mock_fetch,
            patch.object(se.DataSourceConnectionService, "execute_query") as mock_exec,
            patch.object(se, "_write_parquet", return_value=1),
            patch.object(se, "_register_duckdb_view"),
            patch.object(se, "_delta_dir", return_value=MagicMock(exists=lambda: False)),
            patch.object(se, "_parquet_path", return_value=MagicMock()),
        ):
            se._sync_one_table(ds, "public", "orders", {
                "strategy": "incremental",
                "watermark_column": "ts",
            })

        # No watermark → falls through to full_refresh → uses fetch_table_data
        mock_fetch.assert_called_once()
        mock_exec.assert_not_called()

    def test_gsheets_full_refresh_uses_fetch_table_data(self):
        """GSheets should also go through fetch_table_data, not execute_query."""
        se = self._import_se()
        ds = self._make_ds(type_="google_sheets")
        with (
            patch.object(se.DataSourceConnectionService, "fetch_table_data",
                         return_value=(["A"], [{"A": "v"}])) as mock_fetch,
            patch.object(se.DataSourceConnectionService, "execute_query") as mock_exec,
            patch.object(se, "_write_parquet", return_value=1),
            patch.object(se, "_register_duckdb_view"),
            patch.object(se, "_delta_dir", return_value=MagicMock(exists=lambda: False)),
            patch.object(se, "_parquet_path", return_value=MagicMock()),
        ):
            se._sync_one_table(ds, "spreadsheet_id_123", "Sheet1", {"strategy": "full_refresh"})

        mock_fetch.assert_called_once_with(ds.type, ds.config, "spreadsheet_id_123", "Sheet1")
        mock_exec.assert_not_called()

    def test_manual_full_refresh_uses_fetch_table_data(self):
        se = self._import_se()
        ds = self._make_ds(type_="manual")
        with (
            patch.object(se.DataSourceConnectionService, "fetch_table_data",
                         return_value=(["col1"], [{"col1": 1}])) as mock_fetch,
            patch.object(se.DataSourceConnectionService, "execute_query") as mock_exec,
            patch.object(se, "_write_parquet", return_value=1),
            patch.object(se, "_register_duckdb_view"),
            patch.object(se, "_delta_dir", return_value=MagicMock(exists=lambda: False)),
            patch.object(se, "_parquet_path", return_value=MagicMock()),
        ):
            se._sync_one_table(ds, "manual", "MySheet", {"strategy": "full_refresh"})

        mock_fetch.assert_called_once()
        mock_exec.assert_not_called()
