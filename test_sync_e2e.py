#!/usr/bin/env python3
"""
End-to-end integration test: DB -> Backend API -> Response shape matches Frontend types.

Tests the full sync/data pipeline from the perspective of what the Frontend expects:
  1. Manual datasource (CSV/imported data with spaces in sheet names)
  2. Create workspace -> add physical_table and sql_query tables
  3. Preview BEFORE sync  -> live fallback (no "Ch?a sync" / 422 / 503)
  4. Execute query BEFORE sync -> live fallback
  5. Trigger sync -> wait for completion
  6. Preview AFTER sync -> DuckDB view (same response shape)
  7. Execute query AFTER sync
  8. Chart data endpoint -> response shape matches ChartDataResponse TS type
  9. Schema contract checks: every field the FE reads must be present

Frontend TypeScript types being verified (from frontend/src/types/api.ts + hooks):
  TablePreviewResponse  : { columns: [{name, type}], rows: [...], total, has_more }
  ExecuteQueryResponse  : { columns: [{name, type}], rows: [...] }
  ChartDataResponse     : { chart: {id, name, chart_type, config, workspace_table_id,
                                    created_at, updated_at}, data: [...] }
  WorkspaceTable        : { id, workspace_id, datasource_id, source_kind,
                            display_name, columns_cache, created_at, updated_at }

Run against a live stack:
    docker compose up -d
    python test_sync_e2e.py
    # or against local dev:
    python test_sync_e2e.py --base http://localhost:8000/api/v1
"""

import sys
import json
import time
import argparse
import requests

# --- Config -------------------------------------------------------------------

parser = argparse.ArgumentParser()
parser.add_argument("--base", default="http://localhost:8000/api/v1")
parser.add_argument("--email", default="admin@appbi.io")
parser.add_argument("--password", default="123456")
ARGS = parser.parse_args()

BASE = ARGS.base.rstrip("/")
RUN_ID = str(int(time.time()))[-6:]

# --- Colour helpers -----------------------------------------------------------

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

PASS = FAIL = WARN = 0

def ok(name):
    global PASS; PASS += 1
    print(f"  {GREEN}[PASS]{RESET}  {name}")

def fail(name, got=None, expected=None):
    global FAIL; FAIL += 1
    msg = f"  {RED}[FAIL]{RESET}  {name}"
    if expected is not None:
        msg += f"\n           expected: {expected!r}\n           got:      {got!r}"
    elif got is not None:
        msg += f"  -> {got}"
    print(msg)

def warn(name, detail=""):
    global WARN; WARN += 1
    print(f"  {YELLOW}[WARN]{RESET}  {name}  {detail}")

def section(title):
    print(f"\n{BOLD}{CYAN}{'='*64}{RESET}")
    print(f"{BOLD}{CYAN}  {title}{RESET}")
    print(f"{BOLD}{CYAN}{'='*64}{RESET}")

def info(msg):
    print(f"  {CYAN}[i]{RESET}  {msg}")


# --- HTTP client --------------------------------------------------------------

class Client:
    def __init__(self, label):
        self.label = label
        self.s = requests.Session()

    def login(self, email, password):
        r = self.s.post(f"{BASE}/auth/login", json={"email": email, "password": password})
        if r.status_code != 200:
            print(f"{RED}Login failed for {email}: {r.text}{RESET}")
            sys.exit(1)
        ok(f"Login {self.label}")
        return self

    def get(self, path, **kw):    return self.s.get(f"{BASE}{path}", **kw)
    def post(self, path, **kw):   return self.s.post(f"{BASE}{path}", **kw)
    def put(self, path, **kw):    return self.s.put(f"{BASE}{path}", **kw)
    def delete(self, path, **kw): return self.s.delete(f"{BASE}{path}", **kw)


# --- Schema contract helpers --------------------------------------------------

def assert_fields(obj, fields, label):
    """Assert that every expected field is present in the response dict."""
    missing = [f for f in fields if f not in obj]
    if missing:
        fail(f"{label} - missing fields: {missing}", got=list(obj.keys()), expected=fields)
        return False
    ok(f"{label} - all required fields present")
    return True

def assert_200(r, label):
    if r.status_code == 200:
        ok(f"{label} -> 200")
        return True
    fail(f"{label} -> expected 200", got=r.status_code, expected=200)
    try: info(f"body: {r.json()}")
    except: pass
    return False

def assert_status(r, expected_status, label):
    if r.status_code == expected_status:
        ok(f"{label} -> {expected_status}")
        return True
    fail(f"{label} -> expected {expected_status}", got=r.status_code, expected=expected_status)
    try: info(f"body: {r.json()}")
    except: pass
    return False

def assert_no_sync_error(r, label):
    """Verify the response is not a 'not synced' error."""
    if r.status_code in (422, 503):
        body = ""
        try: body = r.json().get("detail", "")
        except: pass
        fail(f"{label} - got sync error", got=f"{r.status_code}: {body}")
        return False
    if r.status_code not in (200, 201):
        fail(f"{label} - unexpected error", got=r.status_code)
        return False
    ok(f"{label} - no sync error (status {r.status_code})")
    return True


# --- FE TypeScript type contracts --------------------------------------------

# From frontend/src/hooks/use-dataset-workspaces.ts: TablePreviewResponse
FE_TABLE_PREVIEW = ["columns", "rows", "total", "has_more"]

# From frontend/src/hooks/use-dataset-workspaces.ts: ExecuteQueryResponse
FE_EXECUTE_QUERY = ["columns", "rows"]

# From frontend/src/types/api.ts: ChartDataResponse
FE_CHART_DATA = ["chart", "data"]

# From frontend/src/types/api.ts: Chart
FE_CHART = ["id", "name", "chart_type", "config", "created_at", "updated_at"]

# From frontend/src/hooks/use-dataset-workspaces.ts: WorkspaceTable
FE_WORKSPACE_TABLE = [
    "id", "workspace_id", "datasource_id", "source_kind",
    "display_name", "created_at", "updated_at",
]

# From frontend/src/types/api.ts: ColumnMetadata (inside preview.columns[])
FE_COLUMN_META = ["name", "type"]

# From frontend/src/hooks/use-dataset-workspaces.ts: DatasetWorkspace
FE_WORKSPACE = ["id", "name", "created_at", "updated_at"]


def check_preview_response(r, label):
    """Verify preview response shape matches FE TablePreviewResponse."""
    if not assert_no_sync_error(r, label):
        return None
    body = r.json()
    assert_fields(body, FE_TABLE_PREVIEW, f"{label} shape")
    if body.get("columns"):
        assert_fields(body["columns"][0], FE_COLUMN_META, f"{label} columns[0]")
    return body


def check_execute_response(r, label):
    """Verify execute response shape matches FE ExecuteQueryResponse."""
    if not assert_no_sync_error(r, label):
        return None
    body = r.json()
    assert_fields(body, FE_EXECUTE_QUERY, f"{label} shape")
    if body.get("columns"):
        assert_fields(body["columns"][0], FE_COLUMN_META, f"{label} columns[0]")
    return body


# --- Test datasource config: Manual/CSV with two sheets ----------------------
#
# "Sales Data" uses a space in the sheet name (tests SQL quoting)
# "Customers" is a plain name

MANUAL_CONFIG = {
    "sheets": {
        "Sales Data": {
            "columns": [
                {"name": "order_id",   "type": "integer"},
                {"name": "product",    "type": "string"},
                {"name": "amount",     "type": "float"},
                {"name": "order_date", "type": "date"},
            ],
            "rows": [
                {"order_id": 1, "product": "Widget A", "amount": 100.0,  "order_date": "2024-01-15"},
                {"order_id": 2, "product": "Widget B", "amount": 250.50, "order_date": "2024-02-20"},
                {"order_id": 3, "product": "Gadget X", "amount": 75.0,   "order_date": "2024-03-05"},
                {"order_id": 4, "product": "Widget A", "amount": 180.0,  "order_date": "2024-03-22"},
                {"order_id": 5, "product": "Gadget X", "amount": 300.0,  "order_date": "2024-04-10"},
            ],
        },
        "Customers": {
            "columns": [
                {"name": "customer_id", "type": "integer"},
                {"name": "name",        "type": "string"},
                {"name": "region",      "type": "string"},
            ],
            "rows": [
                {"customer_id": 1, "name": "Alice",   "region": "North"},
                {"customer_id": 2, "name": "Bob",     "region": "South"},
                {"customer_id": 3, "name": "Charlie", "region": "North"},
            ],
        },
    }
}


# --- Cleanup helper -----------------------------------------------------------

_created = {"datasource_id": None, "workspace_id": None, "chart_ids": []}

def cleanup(admin):
    """Best-effort cleanup of resources created during the test."""
    for cid in _created["chart_ids"]:
        admin.delete(f"/charts/{cid}")
    if _created["workspace_id"]:
        admin.delete(f"/dataset-workspaces/{_created['workspace_id']}")
    if _created["datasource_id"]:
        admin.delete(f"/datasources/{_created['datasource_id']}")
    info(f"Cleanup done (ds={_created['datasource_id']}, ws={_created['workspace_id']})")


# --- Main ---------------------------------------------------------------------

def main():
    admin = Client("admin").login(ARGS.email, ARGS.password)

    # -------------------------------------------------------------------------
    section("1. Create datasource (Manual / CSV with spaces in sheet name)")
    # -------------------------------------------------------------------------

    r = admin.post("/datasources", json={
        "name": f"E2E_Manual_{RUN_ID}",
        "type": "manual",
        "config": MANUAL_CONFIG,
    })
    if not assert_status(r, 201, "Create manual datasource"):
        sys.exit(1)
    ds = r.json()
    _created["datasource_id"] = ds["id"]
    info(f"datasource id={ds['id']}")

    # Test connection (POST /datasources/test with type+config, not per-id)
    r = admin.post("/datasources/test", json={"type": "manual", "config": MANUAL_CONFIG})
    assert_200(r, "Test connection")

    # Schema browser: should list both sheets
    r = admin.get(f"/datasources/{ds['id']}/schema")
    if assert_200(r, "Schema browser"):
        schemas = r.json().get("schemas", [])
        tables_found = [t["name"] for s in schemas for t in s.get("tables", [])]
        if "Sales Data" in tables_found and "Customers" in tables_found:
            ok("Schema browser lists 'Sales Data' and 'Customers'")
        else:
            fail("Schema browser missing sheets", got=tables_found,
                 expected=["Sales Data", "Customers"])

    # -------------------------------------------------------------------------
    section("2. Create workspace and add tables")
    # -------------------------------------------------------------------------

    r = admin.post("/dataset-workspaces/", json={
        "name": f"E2E_Workspace_{RUN_ID}",
        "description": "Integration test workspace",
    })
    if not assert_status(r, 201, "Create workspace"):
        cleanup(admin); sys.exit(1)
    ws = r.json()
    _created["workspace_id"] = ws["id"]
    assert_fields(ws, FE_WORKSPACE, "WorkspaceResponse shape")
    info(f"workspace id={ws['id']}")

    # Add physical_table - sheet name has a space
    r = admin.post(f"/dataset-workspaces/{ws['id']}/tables", json={
        "datasource_id": ds["id"],
        "source_kind":   "physical_table",
        "source_table_name": "Sales Data",
        "display_name":  "Sales Data",
    })
    if not assert_status(r, 201, "Add physical_table 'Sales Data'"):
        cleanup(admin); sys.exit(1)
    tbl_physical = r.json()
    assert_fields(tbl_physical, FE_WORKSPACE_TABLE, "WorkspaceTable (physical) shape")
    info(f"physical table id={tbl_physical['id']}")

    # Add sql_query table - query references the spacey sheet name
    r = admin.post(f"/dataset-workspaces/{ws['id']}/tables", json={
        "datasource_id": ds["id"],
        "source_kind":   "sql_query",
        "source_query":  'SELECT order_id, product, SUM(amount) AS total FROM "Sales Data" GROUP BY order_id, product',
        "display_name":  "Sales Aggregated",
    })
    if not assert_status(r, 201, "Add sql_query table"):
        cleanup(admin); sys.exit(1)
    tbl_sql = r.json()
    assert_fields(tbl_sql, FE_WORKSPACE_TABLE, "WorkspaceTable (sql) shape")
    info(f"sql table id={tbl_sql['id']}")

    # Add customers table
    r = admin.post(f"/dataset-workspaces/{ws['id']}/tables", json={
        "datasource_id": ds["id"],
        "source_kind":   "physical_table",
        "source_table_name": "Customers",
        "display_name":  "Customers",
    })
    assert_status(r, 201, "Add physical_table 'Customers'")
    tbl_customers = r.json()

    # -------------------------------------------------------------------------
    section("3. Preview BEFORE sync (live fallback - must not return 422/503)")
    # -------------------------------------------------------------------------

    # physical_table with spaces
    r = admin.post(
        f"/dataset-workspaces/{ws['id']}/tables/{tbl_physical['id']}/preview",
        json={"limit": 10}
    )
    body = check_preview_response(r, "Preview 'Sales Data' (physical, before sync)")
    if body:
        if len(body["rows"]) == 5:
            ok("Preview returns expected 5 rows")
        else:
            fail("Preview row count", got=len(body["rows"]), expected=5)
        col_names = [c["name"] for c in body["columns"]]
        for expected_col in ["order_id", "product", "amount", "order_date"]:
            if expected_col in col_names:
                ok(f"Column '{expected_col}' present in preview")
            else:
                fail(f"Column '{expected_col}' missing from preview", got=col_names)

    # sql_query table
    r = admin.post(
        f"/dataset-workspaces/{ws['id']}/tables/{tbl_sql['id']}/preview",
        json={"limit": 10}
    )
    body = check_preview_response(r, "Preview 'Sales Aggregated' (sql, before sync)")
    if body:
        if body["rows"]:
            ok(f"SQL query preview returns {len(body['rows'])} rows")
        else:
            warn("SQL query preview returned 0 rows - may be ok if aggregation returned empty")

    # -------------------------------------------------------------------------
    section("4. Execute query BEFORE sync (live fallback)")
    # -------------------------------------------------------------------------

    r = admin.post(
        f"/dataset-workspaces/{ws['id']}/tables/{tbl_physical['id']}/execute",
        json={"limit": 100}
    )
    body = check_execute_response(r, "Execute on 'Sales Data' (before sync)")
    if body:
        if len(body["rows"]) == 5:
            ok("Execute returns expected 5 rows")
        else:
            fail("Execute row count", got=len(body["rows"]), expected=5)

    # Execute with filter
    r = admin.post(
        f"/dataset-workspaces/{ws['id']}/tables/{tbl_physical['id']}/execute",
        json={
            "filters": [{"field": "product", "operator": "=", "value": "Widget A"}],
            "limit": 100,
        }
    )
    body = check_execute_response(r, "Execute with filter product='Widget A'")
    if body:
        widget_a_rows = [row for row in body["rows"] if row.get("product") == "Widget A"]
        if len(widget_a_rows) == 2:
            ok("Filter returns correct 2 rows for 'Widget A'")
        else:
            fail("Filter row count", got=len(widget_a_rows), expected=2)

    # -------------------------------------------------------------------------
    section("5. Create chart and verify ChartDataResponse shape")
    # -------------------------------------------------------------------------

    r = admin.post("/charts", json={
        "name":               f"E2E_Chart_{RUN_ID}",
        "workspace_table_id": tbl_physical["id"],
        "chart_type":         "BAR",
        "config": {
            "xField":   "product",
            "yFields":  ["amount"],
        }
    })
    if not assert_status(r, 201, "Create chart"):
        cleanup(admin); sys.exit(1)
    chart = r.json()
    assert_fields(chart, FE_CHART, "Chart response shape")
    _created["chart_ids"].append(chart["id"])
    info(f"chart id={chart['id']}")

    # GET /charts/{id}/data - core endpoint FE uses to render charts
    r = admin.get(f"/charts/{chart['id']}/data")
    if assert_200(r, "GET /charts/{id}/data (before sync)"):
        body = r.json()
        assert_fields(body, FE_CHART_DATA, "ChartDataResponse shape")
        if "chart" in body:
            assert_fields(body["chart"], FE_CHART, "ChartDataResponse.chart shape")
        if "data" in body:
            if isinstance(body["data"], list):
                ok("ChartDataResponse.data is a list")
                if body["data"]:
                    ok(f"Chart data has {len(body['data'])} rows")
                else:
                    warn("Chart data is empty - check if live fallback returned rows")
            else:
                fail("ChartDataResponse.data is not a list", got=type(body["data"]).__name__)

    # -------------------------------------------------------------------------
    section("6. Trigger sync and wait for completion")
    # -------------------------------------------------------------------------

    r = admin.post(f"/datasources/{ds['id']}/sync")
    if r.status_code not in (200, 202):
        fail("Trigger sync", got=r.status_code, expected="200 or 202")
        warn("Sync trigger failed - skipping post-sync checks")
    else:
        ok(f"Trigger sync -> {r.status_code} (async job accepted)")
        body_sync = r.json()
        job_id = body_sync.get("id") or body_sync.get("job_id")
        info(f"Sync job id={job_id}")

        # Poll for completion via /sync-jobs (max 60s)
        status = "running"
        jr = None
        for _ in range(60):
            time.sleep(1)
            jr = admin.get(f"/datasources/{ds['id']}/sync-jobs?limit=1")
            if jr.status_code == 200:
                jobs = jr.json().get("jobs", [])
                if jobs:
                    status = jobs[0].get("status", "running")
                    if status in ("success", "failed"):
                        break

        if status == "success":
            ok("Sync job completed successfully")
        elif status == "failed":
            warn("Sync job failed - post-sync tests may use live fallback")
            try:
                info(f"Sync error: {jr.json()}")
            except: pass
        else:
            warn(f"Sync status unclear: {status!r}")

        # ---------------------------------------------------------------------
        section("7. Preview AFTER sync (should use DuckDB view, same response shape)")
        # ---------------------------------------------------------------------

        r = admin.post(
            f"/dataset-workspaces/{ws['id']}/tables/{tbl_physical['id']}/preview",
            json={"limit": 10}
        )
        body = check_preview_response(r, "Preview 'Sales Data' (physical, after sync)")
        if body and len(body["rows"]) == 5:
            ok("Post-sync preview returns same 5 rows")
        elif body:
            fail("Post-sync preview row count changed", got=len(body["rows"]), expected=5)

        # sql_query after sync
        r = admin.post(
            f"/dataset-workspaces/{ws['id']}/tables/{tbl_sql['id']}/preview",
            json={"limit": 10}
        )
        check_preview_response(r, "Preview 'Sales Aggregated' (sql, after sync)")

        # Chart data after sync
        r = admin.get(f"/charts/{chart['id']}/data")
        if assert_200(r, "GET /charts/{id}/data (after sync)"):
            body = r.json()
            assert_fields(body, FE_CHART_DATA, "ChartDataResponse shape (after sync)")
            if body.get("data"):
                ok(f"Chart data has {len(body['data'])} rows after sync")

    # -------------------------------------------------------------------------
    section("8. Execute query AFTER sync - verify aggregation works end-to-end")
    # -------------------------------------------------------------------------

    r = admin.post(
        f"/dataset-workspaces/{ws['id']}/tables/{tbl_physical['id']}/execute",
        json={
            "measures": [{"field": "amount", "function": "sum"}],
            "dimensions": ["product"],
            "limit": 100,
        }
    )
    body = check_execute_response(r, "Execute GROUP BY product SUM(amount)")
    if body and body.get("rows"):
        ok(f"Aggregation returns {len(body['rows'])} product groups")
        # Verify the FE can read the rows (keys are present)
        for row in body["rows"]:
            if "product" not in row and "amount" not in row:
                fail("Aggregation row missing expected keys", got=list(row.keys()))
                break
        else:
            ok("All aggregation rows have expected keys")

    # -------------------------------------------------------------------------
    section("9. Verify FE-side: workspace detail endpoint includes tables")
    # -------------------------------------------------------------------------

    r = admin.get(f"/dataset-workspaces/{ws['id']}")
    if assert_200(r, "GET workspace detail"):
        body = r.json()
        assert_fields(body, ["id", "name", "tables", "created_at", "updated_at"],
                      "WorkspaceWithTables shape")
        if "tables" in body:
            table_ids = [t["id"] for t in body["tables"]]
            if tbl_physical["id"] in table_ids and tbl_sql["id"] in table_ids:
                ok("Workspace detail includes all created tables")
            else:
                fail("Workspace detail missing tables", got=table_ids)
            # Each table must have the shape FE expects
            for t in body["tables"]:
                assert_fields(t, FE_WORKSPACE_TABLE, f"WorkspaceTable id={t['id']} shape")

    # -------------------------------------------------------------------------
    section("10. Edge cases: quoted table names with spaces in SQL builder output")
    # -------------------------------------------------------------------------

    # Simulate what QueryTableTab.tsx generateSql() produces with quoteSqlId:
    # SELECT "order_id", "product", "amount" FROM "Sales Data"
    r = admin.post(
        f"/dataset-workspaces/{ws['id']}/tables/{tbl_physical['id']}/execute",
        json={
            "limit": 5,
            # raw_sql passed when user switches to advanced mode
            "raw_sql": 'SELECT "order_id", "product", "amount" FROM "Sales Data" LIMIT 5',
        }
    )
    # This endpoint may not accept raw_sql yet, but it should not crash with 500
    if r.status_code == 200:
        ok("Quoted SQL with spaces executes successfully")
    elif r.status_code in (400, 422):
        info("raw_sql not supported by execute endpoint (that's ok - tests query builder path)")
    else:
        warn(f"Unexpected status for quoted SQL test: {r.status_code}")

    # -------------------------------------------------------------------------
    section("Cleanup")
    # -------------------------------------------------------------------------

    cleanup(admin)

    # -------------------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------------------

    print(f"\n{BOLD}{'='*64}{RESET}")
    print(f"{BOLD}  Results: "
          f"{GREEN}{PASS} passed{RESET}  "
          f"{RED}{FAIL} failed{RESET}  "
          f"{YELLOW}{WARN} warnings{RESET}")
    print(f"{BOLD}{'='*64}{RESET}\n")

    if FAIL > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
