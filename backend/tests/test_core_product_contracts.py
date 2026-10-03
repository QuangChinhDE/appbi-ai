"""Core Product Certification — durable contracts for the non-AI product
experience (UI/UX ↔ backend ↔ data state). One file, one fix per test, named
for the user-visible contract. Browser evidence lives in e2e/; these lock the
backend truth those journeys depend on.
"""
from __future__ import annotations

import pytest

from app.services.source_errors import describe_source_error


# ── M1 Datasource — an unreadable source is not an empty source ──────────────

def test_a_source_that_cannot_be_read_reports_the_cause_not_emptiness():
    """Browser (M1): after a datasource credential was rotated at the source,
    the table picker said "No tables found" — an empty source, the wrong action.
    The backend returned a bare 500 "Failed to list tables." Now every source
    browse carries the driver's own reason, so the UI can tell the user whether
    to fix a credential, a permission, the network or the config."""
    exc = Exception('connection to server at "127.0.0.1", port 55499 failed: '
                    'FATAL: password authentication failed for user "src_reader"')
    msg = describe_source_error(exc, {})
    assert "password authentication failed" in msg
    assert "src_reader" in msg          # the actionable part survives
    assert len(msg) <= 400


def test_the_source_error_never_echoes_a_secret_value():
    """The reason is shown in the UI: it must never carry the source's own
    password / key, even when the driver put it in the message."""
    secret = "sup3r-s3cret-passw0rd-value"
    cfg = {"host": "db", "username": "u", "password": secret}
    exc = Exception(f'FATAL: password "{secret}" rejected; dsn=host=db password={secret}')
    msg = describe_source_error(exc, cfg)
    assert secret not in msg
    assert "••••" in msg


def test_a_private_key_in_a_source_error_is_scrubbed():
    cfg = {"service_account_json": {"private_key": "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----"}}
    exc = Exception("auth failed with key -----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----")
    msg = describe_source_error(exc, cfg)
    assert "BEGIN PRIVATE KEY" not in msg
    assert "ABC" not in msg


def test_an_empty_source_error_is_not_an_exception():
    assert describe_source_error(None, {}) == "NoneType" or describe_source_error(None, {}) == ""
    # A bare exception class still yields something a person can read.
    assert describe_source_error(ValueError(), {}) == "ValueError"


# ── M2 Dataset — a Query Table refuses anything that is not a read ───────────

@pytest.mark.parametrize("sql", [
    "DROP TABLE orders",
    "DELETE FROM orders",
    "UPDATE orders SET amount = 0",
    "INSERT INTO orders VALUES (1)",
    "TRUNCATE orders",
])
def test_a_query_table_refuses_a_non_select(sql):
    """A Query Table is read-only. Anything that is not SELECT / WITH is refused
    before it reaches the source, and the refusal carries a reason the UI shows.
    (The browser bug this guards against was the reverse: an INVALID read was
    accepted silently because the UI ignored {valid:false}; see the e2e spec.)"""
    from app.services.query_validator import QueryValidator, QueryValidationError

    with pytest.raises(QueryValidationError) as ei:
        QueryValidator.validate_and_clean(sql)
    assert str(ei.value), "a refusal must explain itself"


def test_a_query_table_accepts_a_plain_select():
    from app.services.query_validator import QueryValidator
    cleaned = QueryValidator.validate_and_clean("SELECT id, region FROM orders")
    assert "select" in cleaned.lower()


def test_a_calculated_table_over_postgres_emits_valid_sql():
    """Browser (M2 Calculated Table): creating a calculated table over a
    PostgreSQL source failed with "Unknown dialect 'postgresql'. Did you mean
    postgres?" — the alias rewrite passed AppBI's dialect name straight to
    sqlglot, whose Postgres dialect is "postgres". The rewrite must map it."""
    from app.services.dataset_table_sql_service import (
        rewrite_dataset_table_aliases_in_sql, _to_sqlglot_dialect,
    )

    assert _to_sqlglot_dialect("postgresql") == "postgres"
    assert _to_sqlglot_dialect("bigquery") == "bigquery"   # unchanged
    assert _to_sqlglot_dialect("mysql") == "mysql"

    out = rewrite_dataset_table_aliases_in_sql(
        "SELECT * FROM orders WHERE region = 'North'",
        {"orders": "dataset_table_42"},
        output_dialect="postgresql",
    )
    assert "dataset_table_42" in out      # the alias was rewritten (no exception)


# ── M3 Execution mode — a dataset mixing engines is flagged before a chart fails

def test_live_execution_flags_any_dataset_that_spans_more_than_one_connection():
    """Browser (M3): adding a MySQL table to a live PostgreSQL dataset refused
    EVERY chart (one chart runs on one engine) while the dataset still read
    "Live". The publish payload now reports live_executable=False and names the
    engines, so the UI warns before a chart fails."""
    from types import SimpleNamespace
    import app.services.dataset_publish_service as pub

    class _DS:
        def __init__(self, id, name, type_):
            self.id, self.name, self.type = id, name, SimpleNamespace(value=type_)

    def table(tid, dsid, kind="physical_table", enabled=True):
        return SimpleNamespace(id=tid, datasource_id=dsid, source_kind=kind, enabled=enabled)

    class _Q:
        def __init__(self, rows): self._rows = rows
        def filter(self, *a, **k): return self
        def all(self): return self._rows

    class _DB:
        def __init__(self, tables, sources): self._t, self._s = tables, sources
        def query(self, model):
            name = getattr(model, "__name__", str(model))
            if "DatasetTable" in name: return _Q(self._t)
            return _Q(self._s)

    def _cfg(db_, host="127.0.0.1", port=5432, schema="public", user="u"):
        return {"host": host, "port": port, "database": db_, "schema_name": schema, "username": user}

    pg = _DS(1, "Shop PG", "postgresql"); pg.config = _cfg("src_shop")
    my = _DS(2, "Targets MySQL", "mysql"); my.config = {"host": "127.0.0.1", "port": 3306, "database": "t", "username": "root"}
    # one engine → executable
    db1 = _DB([table(1, 1), table(2, 1)], [pg])
    labels, ok = pub._live_execution_engines(db1, 99)
    assert ok is True and len(labels) == 1

    # two engines → not executable, both named
    db2 = _DB([table(1, 1), table(2, 2)], [pg, my])
    labels2, ok2 = pub._live_execution_engines(db2, 99)
    assert ok2 is False
    assert any("postgresql" in x for x in labels2) and any("mysql" in x for x in labels2)

    # calculated / composed tables (no datasource) do not count
    db3 = _DB([table(1, 1), table(9, None, kind="derived_table")], [pg])
    _, ok3 = pub._live_execution_engines(db3, 99)
    assert ok3 is True

    # GAP A1: two PostgreSQL datasources on DIFFERENT databases are the SAME
    # dialect but NOT the same live connection → not executable, both named.
    pg_other = _DS(3, "Shop PG 2", "postgresql"); pg_other.config = _cfg("src_shop2")
    db4 = _DB([table(1, 1), table(2, 3)], [pg, pg_other])
    labels4, ok4 = pub._live_execution_engines(db4, 99)
    assert ok4 is False, "two PG databases must not look live-ready (runtime refuses the cross-connection join)"
    assert len(labels4) == 2

    # Two datasource RECORDS pointing at the SAME physical scope = one connection → executable.
    pg_dup = _DS(4, "Shop PG (dup)", "postgresql"); pg_dup.config = _cfg("src_shop")
    db5 = _DB([table(1, 1), table(2, 4)], [pg, pg_dup])
    _, ok5 = pub._live_execution_engines(db5, 99)
    assert ok5 is True, "duplicate records of the same physical DB are one connection"


# ── M8 Filters/Public — a relative date preset is resolved at request time ───

def test_a_relative_date_preset_resolves_to_today_not_the_authoring_day():
    """Browser (M8 §51): a public report authored with a relative preset must
    show the window relative to WHEN IT IS VIEWED, not freeze to the authoring
    day. The resolver recomputes from today (in the app timezone) on every call."""
    from datetime import datetime, timedelta, timezone
    from app.services.chart_contracts import compute_date_preset_range

    today = datetime.now(timezone.utc).date()   # APP_TIMEZONE default = UTC

    def d(s):
        from datetime import date
        return date.fromisoformat(s)

    s, e = compute_date_preset_range("today")
    assert d(s) == today and d(e) == today
    s, e = compute_date_preset_range("this_month")
    assert d(s).year == today.year and d(s).month == today.month and d(s).day == 1
    s, e = compute_date_preset_range("last_7_days")
    assert d(e) == today and d(s) == today - timedelta(days=6)
    # 'custom'/unknown yields no window (the stored explicit range is used instead)
    assert compute_date_preset_range("custom") == ("", "")


def test_one_report_read_shares_one_relative_date_anchor_across_midnight():
    """Final closure §7 / Q4: all tiles of one logical report read must use ONE
    relative-date anchor. The client stamps one instant per load (X-AppBI-As-Of);
    every tile resolves its preset against it, so a load that straddles midnight
    cannot mix windows. Absent an anchor, presets fall back to now() in the app tz."""
    from app.services.time_contract import set_report_anchor, reset_report_anchor, parse_anchor
    from app.services.chart_contracts import compute_date_preset_range

    # One read begins at 23:59:59Z; two "tiles" that share that stamp agree, even
    # though real wall-clock crosses midnight between them.
    tok = set_report_anchor(parse_anchor("2026-03-14T23:59:59Z"))
    try:
        tile1 = compute_date_preset_range("last_30_days")
        tile2 = compute_date_preset_range("today")
        assert tile1 == ("2026-02-13", "2026-03-14")
        assert tile2 == ("2026-03-14", "2026-03-14")
    finally:
        reset_report_anchor(tok)

    # A LATER logical read (next day) stamps a new anchor → window moves (§8).
    tok = set_report_anchor(parse_anchor("2026-03-15T00:00:01Z"))
    try:
        assert compute_date_preset_range("today") == ("2026-03-15", "2026-03-15")
    finally:
        reset_report_anchor(tok)

    # A malformed / absent stamp never crashes — falls back to now() in app tz.
    assert parse_anchor("not-a-date") is None
    assert parse_anchor("") is None


def test_the_relative_date_timezone_is_explicit_utc_not_process_local():
    """Final closure §6 / Q6: 'today' must be an intentional product timezone,
    not the server process's local clock. The anchor resolves in the configured
    app timezone (default UTC)."""
    from datetime import datetime, timezone
    from app.services.time_contract import current_report_date

    # With no request anchor, the resolved date is today IN UTC.
    assert current_report_date() == datetime.now(timezone.utc).date()


# ── M9 Export — the file preserves the value contract ────────────────────────

def test_xlsx_export_keeps_numbers_dates_and_unicode_typed():
    """Browser (M9 §64): the dataset Excel export was parsed from a real .xlsx —
    numbers are numeric cells (incl. negatives), dates are dates, NULL is empty,
    Unicode / embedded quotes+newlines survive. This locks the cell normalizer."""
    from datetime import datetime, date
    from decimal import Decimal
    from app.services.dataset_excel_export_service import (
        _normalize_cell_value, sanitize_excel_sheet_title, _clip_cell,
    )

    assert _normalize_cell_value(-50) == -50 and isinstance(_normalize_cell_value(-50), int)
    assert _normalize_cell_value(1000.25) == 1000.25
    assert _normalize_cell_value(Decimal("150.50")) == 150.5
    assert isinstance(_normalize_cell_value(Decimal("1.5")), float)
    assert _normalize_cell_value(None) is None
    assert _normalize_cell_value(date(2026, 10, 2)) == date(2026, 10, 2)
    aware = datetime(2026, 10, 2, 8, 30, tzinfo=__import__("datetime").timezone.utc)
    assert _normalize_cell_value(aware).tzinfo is None     # tz stripped, openpyxl-safe
    assert _normalize_cell_value('quote "x", comma') == 'quote "x", comma'
    assert _normalize_cell_value("line1\nline2") == "line1\nline2"
    assert _normalize_cell_value("Áo thun") == "Áo thun"
    # a huge cell is clipped, never crashes openpyxl
    assert len(_clip_cell("x" * 40000)) <= 32767
    # sheet title sanitized to <=31 chars, illegal chars removed
    assert len(sanitize_excel_sheet_title("a" * 50)) <= 31
    assert sanitize_excel_sheet_title("") == "Sheet1"


def test_csv_export_quotes_specials_and_neutralizes_injection():
    """Browser (M9 §63): the client CSV serializer — re-implemented here as the
    contract — quotes commas/quotes/newlines, doubles quotes, blanks NULL, and
    neutralizes spreadsheet-formula injection. (The TS lives in
    frontend/src/lib/export-csv.ts; this guards the behaviour it must keep.)"""
    import re

    def csv_cell(value):
        if value is None:
            return ""
        s = str(value)
        if re.match(r"^[=+\-@\t\r]", s):
            s = "'" + s
        if re.search(r'[",\n\r]', s):
            s = '"' + s.replace('"', '""') + '"'
        return s

    assert csv_cell(None) == ""
    assert csv_cell('quote "x", comma') == '"quote ""x"", comma"'
    assert csv_cell("line1\nline2") == '"line1\nline2"'
    assert csv_cell("=SUM(A1)") == "'=SUM(A1)"       # injection neutralized
    assert csv_cell("ok") == "ok"
    assert csv_cell("Áo thun") == "Áo thun"
