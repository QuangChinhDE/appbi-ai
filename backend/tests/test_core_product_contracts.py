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


def test_source_error_redaction_survives_adversarial_secrets():
    """Final closure A5 / Q8: a driver error must never expose a configured
    credential — across password / token / API key / private key / SA JSON / DSN
    params / a SHORT secret / an UNUSUAL secret-key name — while the actionable
    reason (host, database, user) survives."""
    cfg = {
        "host": "db.example.com", "database": "sales", "username": "analyst",
        "password": "P@ss",                         # short-ish
        "app_pwd": "xyz",                           # 3-char, unusual key
        "svc_credential": "unusual-key-cred-value",  # unusual key name
        "api_token": "AKIA-SECRET-TOKEN-123456",
        "service_account_json": {"private_key": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"},
    }
    leaky = (
        "connect failed to host=db.example.com dbname=sales user=analyst "
        "password=P@ss app_pwd=xyz cred=unusual-key-cred-value "
        "token=AKIA-SECRET-TOKEN-123456 bearer eyJabc.def.ghi "
        "key=-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"
    )
    msg = describe_source_error(Exception(leaky), cfg)
    for secret in ("P@ss", "xyz", "unusual-key-cred-value", "AKIA-SECRET-TOKEN-123456",
                   "BEGIN PRIVATE KEY", "MIIB", "eyJabc.def.ghi"):
        assert secret not in msg, f"leaked: {secret!r} in {msg!r}"
    # the actionable parts stay
    assert "db.example.com" in msg and "sales" in msg and "analyst" in msg


def test_source_error_keeps_actionable_detail_not_over_redacted():
    """Must not destroy source detail to make redaction easy: a non-secret key
    whose name merely contains 'key' (schema_name, a key COLUMN) is not scrubbed."""
    cfg = {"host": "h", "database": "d", "schema_name": "public", "key_column": "order_id"}
    msg = describe_source_error(Exception('relation "public.orders" does not exist'), cfg)
    assert "public.orders" in msg


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


def test_a_pdf_export_carries_one_as_of_anchor_to_every_page():
    """Final closure §9 / Q5: one PDF export must render every page against ONE
    relative-date anchor, so a multi-page render crossing midnight can't mix
    windows. The job captures one as_of and the worker puts it on every page URL."""
    from types import SimpleNamespace
    from app.scripts.pdf_worker import _render_url

    job = SimpleNamespace(
        link_token="tok123",
        params={"as_of": "2026-03-14T23:59:59+00:00", "pages": ["p1", "p2"], "filters": []},
    )
    u1 = _render_url(job, "p1")
    u2 = _render_url(job, "p2")
    assert "asOf=2026-03-14" in u1 and "asOf=2026-03-14" in u2
    # the SAME anchor on both pages
    import re
    a1 = re.search(r"asOf=([^&]+)", u1).group(1)
    a2 = re.search(r"asOf=([^&]+)", u2).group(1)
    assert a1 == a2 and "p1" in u1 and "p2" in u2


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


# ── Codex re-verification — confirmed findings (durable regressions) ──────────

def test_batch_chart_reads_keep_the_request_relative_date_anchor():
    """APPBI-VERIFY-001 / R4: exercise the production single and batch methods.

    The deterministic executor below stands in for the warehouse only. Thread
    creation, SessionLocal lifecycle, anchor capture/re-application and calls to
    ``ChartService.get_chart_data`` are the real production implementation. If
    anchor propagation is removed from ``get_charts_data_batch``, its workers use
    wall-clock today and this test returns zero instead of the fixture totals.
    """
    from datetime import date
    import app.core.database as database_mod
    from app.services.chart_service import ChartService
    from app.services.time_contract import (
        set_report_anchor, reset_report_anchor, parse_anchor,
    )
    from app.services.chart_contracts import compute_date_preset_range

    rows = [
        (date(2026, 3, 14), 10),
        (date(2026, 3, 14), 20),
        (date(2026, 3, 15), 30),
        (date(2026, 3, 15), 40),
    ]

    class _Session:
        def close(self):
            pass

    original_inner = ChartService._get_chart_data_inner
    original_session_local = database_mod.SessionLocal

    def dated_executor(_db, chart_id, **_kwargs):
        lo, hi = compute_date_preset_range("today")
        total = sum(amount for day, amount in rows if lo <= day.isoformat() <= hi)
        return {"chart_id": chart_id, "date_range": [lo, hi], "value": total}

    ChartService._get_chart_data_inner = staticmethod(dated_executor)
    database_mod.SessionLocal = _Session
    try:
        for anchor_text, expected in (
            ("2026-03-14T23:59:59Z", 30),
            ("2026-03-15T00:00:00Z", 70),
        ):
            token = set_report_anchor(parse_anchor(anchor_text))
            try:
                single = ChartService.get_chart_data(_Session(), 101)
                batch = ChartService.get_charts_data_batch(
                    [{"chart_id": 101}, {"chart_id": 102}, {"chart_id": 103}],
                    max_workers=3,
                )
            finally:
                reset_report_anchor(token)

            assert single["value"] == expected
            assert single["date_range"] == [anchor_text[:10], anchor_text[:10]]
            assert [item["data"]["value"] for item in batch] == [expected] * 3
            assert all(item["data"]["date_range"] == single["date_range"] for item in batch)
    finally:
        ChartService._get_chart_data_inner = original_inner
        database_mod.SessionLocal = original_session_local


def test_a_published_dataset_plan_construction_failure_fails_closed():
    """APPBI-VERIFY-002: if the published read-plan cannot be CONSTRUCTED, the
    planner must NOT silently fall back to live (that would show un-published
    source numbers). It blocks. A legacy dataset still live-falls-back."""
    import app.services.execution_plan as ep

    class _DS:
        def __init__(self, pub): self.id = 1; self.publish_state = pub

    # Monkeypatch the planning body to raise, and the dataset lookups the except uses.
    import types
    calls = {}

    class _Q:
        def __init__(self, ds): self._ds = ds
        def filter(self, *a, **k): return self
        def first(self): return self._ds

    def make_db(ds):
        return types.SimpleNamespace(query=lambda model: _Q(ds))

    import app.models.dataset as _dm
    import app.services.snapshot_service as _ss
    orig_resolve = ep._resolve_dataset_id
    orig_plan_pub = ep._plan_published
    orig_isop = _ss.is_operational_dataset
    try:
        ep._resolve_dataset_id = lambda db, binding, base: 1
        def boom(*a, **k): raise RuntimeError("registry corrupt")
        ep._plan_published = boom
        _ss.is_operational_dataset = lambda d: False
        ds_src = types.SimpleNamespace(type="postgresql", config={})
        # published → the except must BLOCK (plan.blocked set), not run live
        pub_plan = ep.plan_chart_execution(
            make_db(_DS("published")), ds_src, {"datasetId": 1}, "v", is_preview=False,
        )
        assert pub_plan.blocked, "published plan-construction failure must fail closed"
        # legacy → still a live fallback (no block)
        leg_plan = ep.plan_chart_execution(
            make_db(_DS(None)), ds_src, {"datasetId": 1}, "v", is_preview=False,
        )
        assert not leg_plan.blocked and leg_plan.mode == "live"
    finally:
        ep._resolve_dataset_id = orig_resolve
        ep._plan_published = orig_plan_pub
        _ss.is_operational_dataset = orig_isop


def test_invalid_app_timezone_warns_and_falls_back_to_utc():
    """APPBI-VERIFY-003: an invalid APP_TIMEZONE must not silently change the day
    boundary with no trace — it warns (once) and falls back to UTC."""
    import logging
    from datetime import datetime, timezone
    import app.services.time_contract as tc
    from app.core.config import settings

    old = settings.APP_TIMEZONE
    tc._WARNED_BAD_TZ.discard("Not/AZone")
    try:
        settings.APP_TIMEZONE = "Not/AZone"
        records = []
        h = logging.Handler(); h.emit = lambda r: records.append(r.getMessage())
        lg = logging.getLogger("app.time_contract"); lg.addHandler(h); lg.setLevel(logging.WARNING)
        try:
            assert tc.current_report_date() == datetime.now(timezone.utc).date()
        finally:
            lg.removeHandler(h)
        assert any("APP_TIMEZONE" in m for m in records), "a bad timezone must warn"
    finally:
        settings.APP_TIMEZONE = old


def test_xlsx_export_keeps_formula_like_text_as_text():
    """APPBI-VERIFY-004: source text that looks like an Excel formula (=SUM(A1),
    +1, -1, @x) must export as a literal text cell, NOT a live formula."""
    from io import BytesIO
    from openpyxl import load_workbook
    from app.services.dataset_excel_export_service import export_dataset_table_to_excel

    def page(limit, offset):
        if offset: return {"columns": ["label"], "rows": []}
        return {"columns": ["label"], "rows": [["=SUM(A1)"], ["+1+1"], ["-1"], ["@x"], ["normal"]]}

    res = export_dataset_table_to_excel(page, sheet_title="t")
    ws = load_workbook(BytesIO(res.content))["t"]
    vals = [(c.value, c.data_type) for row in ws.iter_rows() for c in row]
    # header + 5 data cells; none of the formula-like ones is data_type 'f'
    assert ("=SUM(A1)", "s") in vals
    assert all(dt != "f" for _, dt in vals), f"a cell became a formula: {vals}"


def test_source_error_redaction_is_central_not_per_endpoint():
    """APPBI-VERIFY-006: redaction is a datasource invariant — the same scrubber
    the browse endpoints use also guards the create/update/test boundaries. Guard
    the shared function so every boundary that routes through it is covered."""
    cfg = {"host": "h", "database": "d", "username": "u", "password": "topsecretpw123"}
    msg = describe_source_error('FATAL: dsn "host=h password=topsecretpw123" rejected', cfg)
    assert "topsecretpw123" not in msg and "h" in msg


@pytest.mark.parametrize("provider", ["postgresql", "mysql", "bigquery", "google_sheets"])
def test_datasource_connection_service_scrubs_returns_and_logs_at_the_real_boundary(
    provider, monkeypatch, caplog,
):
    """R1: provider failures cross the actual production service boundary.

    This deliberately patches the connector/driver, not ``describe_source_error``
    or ``test_connection``. Restoring a raw log/return in the production dispatch
    therefore makes this regression fail.
    """
    import logging
    import app.services.datasource_service as mod

    secrets = (
        "pw-inline-closure-123",
        "token-closure-opaque-123456789",
        "BearerClosureToken123456",
        "AIzaClosureApiKey123456789",
        "SHORT",
        "PRIVATE-CLOSURE-MARKER",
    )
    config = {
        "host": "db.closure.invalid",
        "database": "sales",
        "username": "analyst",
        "password": secrets[0],
        "token": secrets[1],
        "bearer_token": secrets[2],
        "api_key": secrets[3],
        "app_pwd": secrets[4],
        "service_account_json": {
            "private_key": (
                "-----BEGIN PRIVATE KEY-----\n"
                f"{secrets[5]}\n"
                "-----END PRIVATE KEY-----"
            )
        },
        "spreadsheet_id": "sheet-closure",
        "project_id": "project-closure",
    }
    leaky = (
        "authentication failed at host db.closure.invalid for database sales; "
        f"dsn=postgresql://analyst:{secrets[0]}@db.closure.invalid/sales "
        f"password={secrets[0]} token={secrets[1]} bearer {secrets[2]} "
        f"api_key={secrets[3]} app_pwd={secrets[4]} "
        "key=-----BEGIN PRIVATE KEY-----\n"
        f"{secrets[5]}\n-----END PRIVATE KEY-----"
    )

    def fail(*_args, **_kwargs):
        raise RuntimeError(leaky)

    # The outbound network policy resolves the host before the driver is
    # reached; give the synthetic host a public address so the DRIVER boundary
    # (what this test locks) is the one that fails.
    import app.services.source_network_policy as netpol
    monkeypatch.setattr(netpol, "resolve_and_check", lambda host, port=None: "203.0.113.10")

    if provider == "postgresql":
        monkeypatch.setattr(mod.psycopg2, "connect", fail)
    elif provider == "mysql":
        monkeypatch.setattr(mod.pymysql, "connect", fail)
    elif provider == "bigquery":
        monkeypatch.setattr(mod, "_build_bigquery_client", fail)
    else:
        monkeypatch.setattr(mod, "create_google_sheets_connector", fail)

    caplog.set_level(logging.ERROR, logger=mod.__name__)
    success, message = mod.DataSourceConnectionService.test_connection(provider, config)
    log_text = "\n".join(record.getMessage() for record in caplog.records)

    assert success is False
    assert "db.closure.invalid" in message and "authentication failed" in message
    for secret in secrets:
        assert secret not in message
        assert secret not in log_text


def test_bigquery_success_warning_is_scrubbed_before_service_return(monkeypatch):
    """R1: a successful query plus failed metadata listing is still secret-safe."""
    import app.services.datasource_service as mod

    secret = "bq-warning-secret-closure-123456"
    config = {
        "project_id": "project-closure",
        "default_dataset": "sales",
        "password": secret,
    }

    class _Query:
        def result(self, timeout=None):
            return []

    class _Client:
        def query(self, _sql, timeout=None):
            return _Query()

        def list_tables(self, *_args, **_kwargs):
            raise RuntimeError(
                f"permission denied for dataset sales; password={secret}"
            )

        def close(self):
            pass

    monkeypatch.setattr(mod, "_build_bigquery_client", lambda _config: _Client())
    success, message = mod.DataSourceConnectionService.test_connection("bigquery", config)

    assert success is True
    assert "could not list tables" in message
    assert "dataset 'sales'" in message
    assert secret not in message


def test_datasource_test_api_receives_the_service_safe_message(monkeypatch, caplog):
    """R1: the API boundary receives an already-safe production service result."""
    import logging
    import app.api.datasources as api
    import app.services.datasource_service as mod
    import app.services.source_network_policy as netpol
    from app.schemas.schemas import DataSourceDraftTestRequest, DataSourceTypeSchema

    secret = "api-boundary-secret-closure-123456"
    monkeypatch.setattr(netpol, "resolve_and_check", lambda host, port=None: "203.0.113.10")

    def fail(*_args, **_kwargs):
        raise RuntimeError(
            f"authentication failed at db.closure.invalid; password={secret}"
        )

    # The egress policy (app/core/egress.py) resolves the host before the driver
    # is called; this test is about scrubbing DRIVER errors, so the synthetic
    # host is let through the policy and the driver stub stays the boundary.
    monkeypatch.setattr("app.core.egress._db_destination", lambda host, port: "203.0.113.10")
    monkeypatch.setattr(mod.psycopg2, "connect", fail)
    caplog.set_level(logging.ERROR, logger=mod.__name__)
    response = api.test_draft_data_source_connection(
        DataSourceDraftTestRequest(
            type=DataSourceTypeSchema.POSTGRESQL,
            config={
                "host": "db.closure.invalid",
                "database": "sales",
                "username": "analyst",
                "password": secret,
            },
        ),
        db=object(),
        current_user=object(),
    )

    assert response.success is False
    assert "authentication failed" in response.message
    assert secret not in response.message
    assert secret not in "\n".join(record.getMessage() for record in caplog.records)


def test_datasource_test_endpoint_enforces_resource_access_before_rehydration():
    """APPBI-VERIFY-005: the draft test (/datasources/test-draft, which replaced the
    ambiguous /datasources/test) must check resource access to the given
    data_source_id BEFORE it rehydrates that datasource's stored secrets — else a
    user could reuse another datasource's credentials (IDOR). Prove the endpoint
    checks object access (now `edit`) on the looked-up source and does NOT restore
    secrets when access is denied."""
    from fastapi import HTTPException
    import app.api.datasources as mod
    from app.schemas.schemas import DataSourceDraftTestRequest as DataSourceTestRequest, DataSourceTypeSchema as DataSourceType

    calls = {"restored": False, "access_checked_for": None}

    class _DS:  # a foreign datasource
        id = 99; type = DataSourceType.POSTGRESQL
        config = {"host": "h", "database": "d", "username": "u", "password": "STORED-SECRET"}

    def fake_get_by_id(db, i): return _DS()
    def fake_require_view(db, user, resource, module):
        calls["access_checked_for"] = getattr(resource, "id", None)
        raise HTTPException(status_code=403, detail="no access")
    def fake_restore(cfg, stored):
        calls["restored"] = True
        return {**cfg, **stored}

    orig = (mod.DataSourceCRUDService.get_by_id, mod.require_edit_access, mod._restore_sensitive_config_fields)
    mod.DataSourceCRUDService.get_by_id = staticmethod(fake_get_by_id)
    mod.require_edit_access = fake_require_view
    mod._restore_sensitive_config_fields = fake_restore
    try:
        req = DataSourceTestRequest(data_source_id=99, type=DataSourceType.POSTGRESQL,
                                    config={"host": "attacker", "username": "x"})
        raised = False
        try:
            mod.test_draft_data_source_connection(req, db=object(), current_user=object())
        except HTTPException as e:
            raised = (e.status_code == 403)
        assert raised, "foreign datasource test must be refused with 403"
        assert calls["access_checked_for"] == 99, "resource access must be checked on the looked-up source"
        assert calls["restored"] is False, "secrets must NOT be rehydrated when access is denied"
    finally:
        (mod.DataSourceCRUDService.get_by_id, mod.require_edit_access, mod._restore_sensitive_config_fields) = orig


# ── Datasource module-wide credential-safe error boundary (final release R1) ──
# Every reachable driver/connector exception boundary — not only Test Connection —
# must keep configured secrets out of the API response AND the application log,
# while keeping the actionable context (host, database, user, cause).

_DS_SECRETS = {
    "password": "Pw9!",                      # short password
    "api_token": "tok_SYNTH_live_51abc",
    "db_passphrase": "horse-battery-staple",  # unusual key name
    "extra": {"nested_secret": "NESTED-S3CRET-VALUE"},
    "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvSYNTHETIC\n-----END PRIVATE KEY-----",
}
_DS_LEAK = (
    "FATAL: password authentication failed for user analyst at db.example.com "
    "(dsn=postgresql://analyst:Pw9!@db.example.com/sales) token tok_SYNTH_live_51abc "
    "passphrase horse-battery-staple nested NESTED-S3CRET-VALUE "
    "Authorization: Bearer abcdefghijklmnop123 "
    "-----BEGIN PRIVATE KEY-----\nMIIEvSYNTHETIC\n-----END PRIVATE KEY-----"
)
_DS_FORBIDDEN = ("Pw9!", "tok_SYNTH_live_51abc", "horse-battery-staple",
                 "NESTED-S3CRET-VALUE", "MIIEvSYNTHETIC", "abcdefghijklmnop123")


def _assert_safe(text: str, where: str):
    for secret in _DS_FORBIDDEN:
        assert secret not in text, f"{where} leaked {secret!r}: {text[:300]}"


def _ds_client(monkeypatch, ds_type: str):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import app.api.datasources as mod
    import app.core.crypto as crypto
    from app.core import get_db
    from app.core.dependencies import get_current_user

    ds = SimpleNamespace(id=7, type=SimpleNamespace(value=ds_type),
                         config={"host": "db.example.com", "database": "sales", "username": "analyst",
                                 "spreadsheet_id": "sheet-1", **_DS_SECRETS})
    monkeypatch.setattr(mod.DataSourceCRUDService, "get_by_id", staticmethod(lambda db, i: ds))
    monkeypatch.setattr(mod, "require_view_access", lambda *a, **k: None)
    monkeypatch.setattr(mod, "require_edit_access", lambda *a, **k: None)
    monkeypatch.setattr(mod, "require_full_access", lambda *a, **k: None)
    monkeypatch.setattr(crypto, "decrypt_config", lambda cfg: dict(cfg or {}))

    def boom(*a, **k):
        raise Exception(_DS_LEAK)
    monkeypatch.setattr(mod.DataSourceConnectionService, "execute_query", staticmethod(boom))
    monkeypatch.setattr(mod.DataSourceConnectionService, "validate_user_sql", staticmethod(boom))
    monkeypatch.setattr(mod.DataSourceConnectionService, "get_table_detail", staticmethod(boom))
    monkeypatch.setattr(mod.DataSourceConnectionService, "get_watermark_candidates", staticmethod(boom))

    class _Conn:
        def __getattr__(self, name):
            def op(*a, **k):
                raise ValueError(f"Failed to {name}: {_DS_LEAK}")
            return op
    import app.services.google_sheets_connector as gsc
    monkeypatch.setattr(gsc, "create_google_sheets_connector", lambda cfg: _Conn())

    app = FastAPI()
    app.state.limiter = mod._limiter
    app.include_router(mod.router)
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    for dep in mod.router.dependencies:  # module_floor: a real module-level gate, out of scope here
        app.dependency_overrides[dep.dependency] = lambda: None
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("ds_type", ["postgresql", "mysql", "bigquery"])
def test_sql_datasource_failures_never_leak_secrets_in_response_or_log(monkeypatch, caplog, ds_type):
    import logging
    caplog.set_level(logging.DEBUG)
    client = _ds_client(monkeypatch, ds_type)
    responses = {
        "execute query": client.post("/datasources/query", json={"data_source_id": 7, "sql_query": "select 1"}),
        "validate sql": client.post("/datasources/validate-sql", json={"data_source_id": 7, "sql_query": "select 1"}),
        "table detail": client.get("/datasources/7/tables/public/orders"),
        "watermarks": client.get("/datasources/7/tables/public/orders/watermarks"),
    }
    for where, r in responses.items():
        _assert_safe(r.text, f"{ds_type} {where} response")
    # actionable context survives the redaction
    q = responses["execute query"]
    assert q.status_code == 400
    assert "db.example.com" in q.text and "analyst" in q.text and "authentication failed" in q.text
    v = responses["validate sql"].json()
    assert v["valid"] is False and "authentication failed" in v["error"]
    _assert_safe(caplog.text, f"{ds_type} application log")


def test_google_sheets_connector_failures_never_leak_secrets(monkeypatch, caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    client = _ds_client(monkeypatch, "google_sheets")
    calls = {
        "list": client.get("/datasources/7/gsheets/sheets"),
        "read": client.get("/datasources/7/gsheets/Sheet1/rows"),
        "create": client.post("/datasources/7/gsheets/sheets", json={"sheet_name": "X"}),
        "clear": client.delete("/datasources/7/gsheets/Sheet1/rows/all"),
    }
    for where, r in calls.items():
        assert r.status_code >= 400, where
        _assert_safe(r.text, f"sheets {where} response")
        assert "authentication failed" in r.text, f"sheets {where} lost its actionable cause"
    _assert_safe(caplog.text, "sheets application log")


def test_datasource_service_execute_query_log_is_scrubbed(monkeypatch, caplog):
    """The service boundary itself (used by many callers) logs without secrets."""
    import logging
    from app.services import datasource_service as svc
    caplog.set_level(logging.DEBUG)

    def boom(*a, **k):
        raise Exception(_DS_LEAK)
    monkeypatch.setattr(svc.DataSourceConnectionService, "_execute_postgresql", staticmethod(boom), raising=False)
    cfg = {"host": "db.example.com", "database": "sales", "username": "analyst", **_DS_SECRETS}
    with pytest.raises(Exception):
        svc.DataSourceConnectionService.execute_query("postgresql", cfg, "select 1", 1)
    assert "Query execution failed" in caplog.text
    _assert_safe(caplog.text, "execute_query service log")


def test_pdf_worker_inputs_carry_the_same_fixed_as_of_on_every_page():
    """Final release §13.11: the worker's per-page render inputs (the exact loop
    `_render_job` runs: _page_ids → _render_url) all carry the job's ONE as_of,
    in page order — the fixed-anchor contract itself, not inferred from values."""
    from types import SimpleNamespace
    from urllib.parse import urlparse, parse_qs
    from app.scripts.pdf_worker import _page_ids, _render_url

    as_of = "2026-03-14T23:59:59.500000+00:00"
    job = SimpleNamespace(link_token="e2e-closure-pdf",
                          params={"as_of": as_of, "pages": ["a", "b", "c"], "filters": []})
    urls = [_render_url(job, p) for p in _page_ids(job)]
    qs = [parse_qs(urlparse(u).query) for u in urls]
    assert [q["page"][0] for q in qs] == ["a", "b", "c"]
    assert {q["asOf"][0] for q in qs} == {as_of}


# ── User feedback closure: editable PowerPoint export ─────────────────────────

def _tiny_png(w=400, h=200) -> str:
    import base64, io as _io
    from PIL import Image
    buf = _io.BytesIO()
    Image.new("RGB", (w, h), (59, 130, 246)).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _parse_pptx(raw: bytes):
    import io as _io
    from pptx import Presentation
    return Presentation(_io.BytesIO(raw))


def test_pptx_export_is_editable_text_native_table_and_picture_charts():
    """FEEDBACK-02: the deck is genuinely editable where it says so — KPI label
    and value, titles and text are text frames; the table is a native table; a
    chart is a picture — and Vietnamese survives."""
    from app.services.report_pptx_service import ReportPptxRequest, build_report_pptx

    req = ReportPptxRequest(title="Báo cáo điều hành", footer="Báo cáo điều hành", pages=[{
        # 1800px wide: the 660px-tall page fits one 16:9 slide at this scale.
        "name": "Tổng quan", "width": 1800,
        "tiles": [
            {"kind": "kpi", "x": 0, "y": 0, "w": 290, "h": 140, "title": "Doanh thu", "value": "8.0B"},
            {"kind": "kpi", "x": 300, "y": 0, "w": 290, "h": 140,
             "title": "Tổng số đơn hàng trong kỳ báo cáo", "value": "920"},
            {"kind": "chart", "x": 0, "y": 150, "w": 590, "h": 300, "title": "Doanh thu theo khu vực",
             "image": _tiny_png()},
            {"kind": "text", "x": 600, "y": 150, "w": 590, "h": 300, "text": "Nhận định: doanh thu tăng đều."},
            {"kind": "table", "x": 0, "y": 460, "w": 1190, "h": 300, "title": "Chi tiết",
             "columns": ["id", "Khu vực", "Doanh thu"],
             "rows": [[str(i), "Miền Bắc", f"{i * 10}"] for i in range(1, 6)], "total_rows": 5},
        ],
    }])
    prs = _parse_pptx(build_report_pptx(req))
    assert len(prs.slides) == 1
    shapes = list(prs.slides[0].shapes)
    texts = [s.text_frame.text for s in shapes if s.has_text_frame]
    for expected in ("Báo cáo điều hành", "Tổng quan", "Doanh thu", "8.0B",
                     "Tổng số đơn hàng trong kỳ báo cáo", "920", "Doanh thu theo khu vực",
                     "Nhận định: doanh thu tăng đều."):
        assert expected in texts, expected
    tables = [s.table for s in shapes if s.has_table]
    assert len(tables) == 1 and tables[0].cell(0, 1).text == "Khu vực" and tables[0].cell(5, 0).text == "5"
    assert sum(1 for s in shapes if s.shape_type == 13) == 1  # the chart picture
    bottom = max(s.top + s.height for s in shapes)
    assert bottom <= prs.slide_height, "a block runs off the slide"


def test_pptx_export_keeps_shapes_and_never_runs_off_the_slide():
    """One uniform scale keeps a tile's shape (a KPI row stays one aligned row);
    a page taller than a slide continues on a new slide at a tile boundary; a
    long table shows the rows that fit and counts the rest."""
    from app.services.report_pptx_service import ReportPptxRequest, build_report_pptx

    kpis = [{"kind": "kpi", "x": i * 300, "y": 0, "w": 290, "h": 140, "title": f"KPI {i}",
             "value": str(i)} for i in range(4)]
    tall_table = {"kind": "table", "x": 0, "y": 1400, "w": 1190, "h": 300, "title": "Bảng dài",
                  "columns": ["a", "b"], "rows": [[str(i), "x"] for i in range(25)], "total_rows": 40}
    req = ReportPptxRequest(title="R", pages=[{"name": "P", "width": 1200, "tiles": kpis + [tall_table]}])
    prs = _parse_pptx(build_report_pptx(req))
    assert len(prs.slides) == 2, "the table far below the KPI row continues on its own slide"
    s1 = list(prs.slides[0].shapes)
    cards = [s for s in s1 if s.shape_type == 1]  # the KPI card rectangles
    assert len(cards) == 4
    assert len({c.top for c in cards}) == 1 and len({c.height for c in cards}) == 1
    gaps = [cards[i + 1].left - (cards[i].left + cards[i].width) for i in range(3)]
    assert max(gaps) - min(gaps) <= 2, gaps
    for slide in prs.slides:
        for s in slide.shapes:
            assert s.top + s.height <= prs.slide_height, "a block runs off the slide"
    s2 = list(prs.slides[1].shapes)
    table = next(s.table for s in s2 if s.has_table)
    shown = len(table.rows) - 1
    assert 1 <= shown < 25
    assert any(f"còn {40 - shown} dòng" in s.text_frame.text for s in s2 if s.has_text_frame)
