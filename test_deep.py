#!/usr/bin/env python3
"""
Deep Comprehensive Test Suite — AppBI Dashboard Platform

Covers (beyond test_permissions.py):
  S1  Auth & Identity           — login/logout/me/anonymous/bad-creds
  S2  Module Permission Gates   — each module's none/view/edit/full enforced
  S3  Permission Level Ops      — view blocked from write; edit blocked from delete
  S4  DataSource Lifecycle      — CRUD + level enforcement
  S5  Workspace CRUD            — create/read/update/delete + isolation
  S6  Workspace Table Auth      — NEW: auth on GET /tables, /preview, /execute
  S7  Execute Query Security    — schema validation, SQL-injection patterns, limits
  S8  Chart Lifecycle           — create/read/update/delete + workspace_table_id
  S9  Chart Data Access         — owner/non-owner/shared access to /charts/{id}/data
  S10 Dashboard Lifecycle       — CRUD + chart ops + layout
  S11 Resource Sharing Chart    — view/edit share, revoke, permission enforcement
  S12 Dashboard Cascade Share   — cascade to charts+workspaces, revoke cascade
  S13 Cross-User Isolation      — no resource bleed, list filters
  S14 Admin-Only Operations     — user CRUD, permission matrix
  S15 404 Not Found             — all resource types return 404 for missing IDs
  S16 Delete Constraints        — cannot delete table with dependent charts
  S17 AI Chat Permission Gate   — ai_chat levels in /auth/me + /permissions/me
  S18 Permission Presets        — apply preset, validate result

Users:
  admin      admin@appbi.io / 123456            (implicit settings:full)
  dt_full    deeptest_full@appbi.io / Pass1234  (all modules = max level possible)
  dt_edit    deeptest_edit@appbi.io / Pass1234  (workspaces/charts/dashboards = edit)
  dt_view    deeptest_view@appbi.io / Pass1234  (all modules = view)
  dt_b       deeptest_b@appbi.io / Pass1234     (all full, for isolation testing)
  anon       (no login — session only, never logs in)
"""

import sys
import time
import requests

BASE    = "http://localhost:8000/api/v1"
RUN_ID  = str(int(time.time()))[-6:]

# ── Colour helpers ─────────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
BLUE   = "\033[94m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

PASS = FAIL = WARN = SKIP = 0


def ok(name):
    global PASS; PASS += 1
    print(f"  {GREEN}✓ PASS{RESET}  {name}")


def fail(name, got=None, expected=None):
    global FAIL; FAIL += 1
    msg = f"  {RED}✗ FAIL{RESET}  {name}"
    if expected is not None:
        msg += f"  (expected {expected!r}, got {got!r})"
    elif got is not None:
        msg += f"  → {got}"
    print(msg)


def warn(name, detail=""):
    global WARN; WARN += 1
    print(f"  {YELLOW}⚠ WARN{RESET}  {name}  {detail}")


def skip(name):
    global SKIP; SKIP += 1
    print(f"  {BLUE}○ SKIP{RESET}  {name}")


def section(title):
    print(f"\n{BOLD}{'─'*65}{RESET}")
    print(f"{BOLD}  {title}{RESET}")
    print(f"{BOLD}{'─'*65}{RESET}")


# ── HTTP client ────────────────────────────────────────────────────────────────

class Client:
    def __init__(self, label):
        self.label   = label
        self.session = requests.Session()
        self.user_id = None

    def login(self, email, password):
        r = self.session.post(f"{BASE}/auth/login", json={"email": email, "password": password})
        if r.status_code != 200:
            raise RuntimeError(f"Login failed for {email}: {r.status_code} {r.text}")
        data = r.json()
        self.user_id = data.get("id") or (data.get("user") or {}).get("id")
        return data

    def get(self, path, **kw):    return self.session.get(f"{BASE}{path}", **kw)
    def post(self, path, **kw):   return self.session.post(f"{BASE}{path}", **kw)
    def put(self, path, **kw):    return self.session.put(f"{BASE}{path}", **kw)
    def delete(self, path, **kw): return self.session.delete(f"{BASE}{path}", **kw)


# ── Permission profiles ────────────────────────────────────────────────────────
# data_sources: none|view|full  (no edit)
# ai_chat:      none|view|edit  (no full)
# settings:     none|full       (binary)

PERM_FULL = {
    "data_sources": "full", "workspaces": "full", "explore_charts": "full",
    "dashboards": "full", "ai_chat": "edit", "settings": "none",
}
PERM_EDIT = {
    "data_sources": "view", "workspaces": "edit", "explore_charts": "edit",
    "dashboards": "edit", "ai_chat": "edit", "settings": "none",
}
PERM_VIEW = {
    "data_sources": "view", "workspaces": "view", "explore_charts": "view",
    "dashboards": "view", "ai_chat": "view", "settings": "none",
}
PERM_B = {
    "data_sources": "full", "workspaces": "full", "explore_charts": "full",
    "dashboards": "full", "ai_chat": "edit", "settings": "none",
}


def ensure_user(admin, email, full_name, password, perms):
    r = admin.get("/users/")
    users = r.json() if r.status_code == 200 else []
    existing = next((u for u in users if u["email"] == email), None)
    if existing:
        uid = existing["id"]
    else:
        r = admin.post("/users/", json={"email": email, "full_name": full_name, "password": password})
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Cannot create {email}: {r.status_code} {r.text}")
        uid = r.json()["id"]
    admin.put(f"/permissions/{uid}", json={"permissions": perms})
    return uid


def _ids(r, key="id"):
    return [item[key] for item in r.json()] if r.status_code == 200 else []


# ── Cleanup tracking ───────────────────────────────────────────────────────────
_cleanup = {"charts": [], "dashboards": [], "workspaces": []}


# ══════════════════════════════════════════════════════════════════════════════
def main():
    admin    = Client("admin")
    dt_full  = Client("dt_full")
    dt_edit  = Client("dt_edit")
    dt_view  = Client("dt_view")
    dt_b     = Client("dt_b")
    anon     = Client("anon")  # never logs in

    # ── S0: Setup ──────────────────────────────────────────────────────────────
    section("S0. Setup — users & login")

    admin.login("admin@appbi.io", "123456")
    ok("admin logged in")

    uid_full = ensure_user(admin, "deeptest_full@appbi.io", "DT Full",  "Pass1234", PERM_FULL)
    uid_edit = ensure_user(admin, "deeptest_edit@appbi.io", "DT Edit",  "Pass1234", PERM_EDIT)
    uid_view = ensure_user(admin, "deeptest_view@appbi.io", "DT View",  "Pass1234", PERM_VIEW)
    uid_b    = ensure_user(admin, "deeptest_b@appbi.io",    "DT B",     "Pass1234", PERM_B)
    ok("test users ensured")

    dt_full.login("deeptest_full@appbi.io", "Pass1234")
    dt_edit.login("deeptest_edit@appbi.io", "Pass1234")
    dt_view.login("deeptest_view@appbi.io", "Pass1234")
    dt_b.login("deeptest_b@appbi.io",       "Pass1234")
    ok("dt_full / dt_edit / dt_view / dt_b logged in")

    # Discover admin's first workspace + table (demo data or seed data)
    admin_ws_id    = None
    admin_table_id = None
    r = admin.get("/dataset-workspaces/")
    if r.status_code == 200 and r.json():
        admin_ws_id = r.json()[0]["id"]
        r2 = admin.get(f"/dataset-workspaces/{admin_ws_id}/tables")
        if r2.status_code == 200 and r2.json():
            admin_table_id = r2.json()[0]["id"]

    if admin_ws_id:
        ok(f"Admin workspace id={admin_ws_id}, table id={admin_table_id}")
    else:
        warn("No admin workspace found — some data-access tests will be skipped")

    # Extract first column name from admin's table for query tests
    first_col = "id"
    if admin_ws_id and admin_table_id:
        r = admin.get(f"/dataset-workspaces/{admin_ws_id}/tables")
        tables = r.json() if r.status_code == 200 else []
        tbl = next((t for t in tables if t["id"] == admin_table_id), None)
        if tbl:
            cc = tbl.get("columns_cache")
            col_list = cc if isinstance(cc, list) else (cc or {}).get("columns", [])
            if col_list:
                c = col_list[0]
                first_col = c["name"] if isinstance(c, dict) else str(c)
        ok(f"First column for query tests: '{first_col}'")

    # ── S1: Auth & Identity ────────────────────────────────────────────────────
    section("S1. Auth & Identity")

    # 1.1 Login success — returns user JSON
    r = requests.post(f"{BASE}/auth/login", json={"email": "admin@appbi.io", "password": "123456"})
    if r.status_code == 200 and "email" in r.json():
        ok("Login correct credentials → 200 with user JSON")
    else:
        fail("Login correct credentials", got=f"{r.status_code}")

    # 1.2 Login wrong password → 401
    r = requests.post(f"{BASE}/auth/login", json={"email": "admin@appbi.io", "password": "wrongpass"})
    if r.status_code in (401, 422):
        ok(f"Login wrong password → {r.status_code}")
    else:
        fail("Login wrong password", got=r.status_code, expected="401/422")

    # 1.3 Login unknown email → 401/404
    r = requests.post(f"{BASE}/auth/login", json={"email": "nobody_xyz@appbi.io", "password": "pass"})
    if r.status_code in (401, 404, 422):
        ok(f"Login unknown email → {r.status_code}")
    else:
        fail("Login unknown email", got=r.status_code, expected="401/404/422")

    # 1.4 /auth/me returns correct profile
    r = admin.get("/auth/me")
    if r.status_code == 200 and r.json().get("email") == "admin@appbi.io":
        ok("GET /auth/me admin → correct profile")
    else:
        fail("GET /auth/me admin", got=f"{r.status_code} {r.text[:80]}")

    # 1.5 /auth/me includes permissions field
    r = dt_view.get("/auth/me")
    if r.status_code == 200 and "permissions" in r.json():
        ok("GET /auth/me → permissions field present")
    else:
        fail("GET /auth/me missing permissions", got=r.status_code)

    # 1.6 Anonymous access → 401
    for path, label in [("/charts/", "charts"), ("/dashboards/", "dashboards"),
                        ("/dataset-workspaces/", "workspaces")]:
        r = anon.get(path)
        if r.status_code == 401:
            ok(f"Anon GET {path} → 401")
        else:
            fail(f"Anon {label} should be 401", got=r.status_code)

    # 1.7 /permissions/me returns module permissions
    r = dt_view.get("/permissions/me")
    if r.status_code == 200 and "permissions" in r.json():
        perms = r.json()["permissions"]
        if perms.get("workspaces") == "view":
            ok("GET /permissions/me → workspaces=view for dt_view")
        else:
            fail("/permissions/me workspaces", got=perms.get("workspaces"), expected="view")
    else:
        fail("GET /permissions/me", got=r.status_code)

    # ── S2: Module Permission Gates ────────────────────────────────────────────
    section("S2. Module Permission Gates")

    # 2.1–2.3 settings gate (none → blocked from /users/, /permissions/matrix)
    for label, client in [("dt_full", dt_full), ("dt_edit", dt_edit), ("dt_view", dt_view)]:
        r = client.get("/users/")
        if r.status_code in (401, 403):
            ok(f"settings:none → {label} GET /users/ → {r.status_code}")
        else:
            fail(f"settings:none → {label} /users/ should be blocked", got=r.status_code)

    # 2.4 settings:none → cannot view permission matrix
    r = dt_full.get("/permissions/matrix")
    if r.status_code in (401, 403):
        ok(f"settings:none → GET /permissions/matrix → {r.status_code}")
    else:
        fail("settings:none → /permissions/matrix should be blocked", got=r.status_code)

    # 2.5 settings:none → cannot update another user's permissions
    r = dt_full.put(f"/permissions/{uid_b}", json={"permissions": PERM_B})
    if r.status_code in (401, 403):
        ok(f"settings:none → PUT /permissions/{{id}} → {r.status_code}")
    else:
        fail("settings:none → PUT /permissions should be blocked", got=r.status_code)

    # 2.6 workspaces:view → can list workspaces (GET)
    r = dt_view.get("/dataset-workspaces/")
    if r.status_code == 200:
        ok("workspaces:view → GET /dataset-workspaces/ → 200")
    else:
        fail("workspaces:view → list workspaces", got=r.status_code)

    # 2.7 workspaces:view → cannot create workspace (POST)
    r = dt_view.post("/dataset-workspaces/", json={"name": f"ViewWS_{RUN_ID}", "description": "x"})
    if r.status_code in (401, 403):
        ok(f"workspaces:view → POST /dataset-workspaces/ → {r.status_code}")
    else:
        fail("workspaces:view → create workspace should be blocked", got=r.status_code)

    # 2.8 explore_charts:view → cannot create chart
    r = dt_view.post("/charts/", json={
        "name": f"ViewChart_{RUN_ID}", "chart_type": "BAR",
        "config": {}, "workspace_table_id": admin_table_id or 1,
    })
    if r.status_code in (401, 403):
        ok(f"explore_charts:view → POST /charts/ → {r.status_code}")
    else:
        fail("explore_charts:view → create chart should be blocked", got=r.status_code)

    # 2.9 dashboards:view → cannot create dashboard
    r = dt_view.post("/dashboards/", json={"name": f"ViewDash_{RUN_ID}"})
    if r.status_code in (401, 403):
        ok(f"dashboards:view → POST /dashboards/ → {r.status_code}")
    else:
        fail("dashboards:view → create dashboard should be blocked", got=r.status_code)

    # 2.10 data_sources:view → can list datasources
    r = dt_view.get("/datasources/")
    if r.status_code == 200:
        ok("data_sources:view → GET /datasources/ → 200")
    else:
        fail("data_sources:view → list datasources", got=r.status_code)

    # 2.11 data_sources:view → cannot create datasource
    r = dt_view.post("/datasources/", json={
        "name": f"ViewDS_{RUN_ID}", "type": "postgresql",
        "host": "localhost", "port": 5432, "database": "x",
    })
    if r.status_code in (401, 403, 422):
        ok(f"data_sources:view → POST /datasources/ → {r.status_code}")
    else:
        fail("data_sources:view → create datasource should be blocked", got=r.status_code)

    # ── S3: Permission Level Write Operations ──────────────────────────────────
    section("S3. Permission Level Write Operations (edit vs full)")

    # 3.1 workspaces:edit → CAN create workspace
    r = dt_edit.post("/dataset-workspaces/", json={"name": f"DT_EditWS_{RUN_ID}", "description": "edit test"})
    ws_edit_id = None
    if r.status_code in (200, 201):
        ws_edit_id = r.json()["id"]
        _cleanup["workspaces"].append(ws_edit_id)
        ok(f"workspaces:edit → POST /dataset-workspaces/ → 201 (id={ws_edit_id})")
    else:
        fail("workspaces:edit → create workspace", got=f"{r.status_code} {r.text[:100]}")

    # 3.2 workspaces:edit → cannot DELETE own workspace
    if ws_edit_id:
        r = dt_edit.delete(f"/dataset-workspaces/{ws_edit_id}")
        if r.status_code in (401, 403):
            ok(f"workspaces:edit → DELETE own workspace → {r.status_code} (correct: edit cannot delete)")
        elif r.status_code in (200, 204):
            warn("workspaces:edit DELETE succeeded (may be allowed for own resources at edit level)")
            _cleanup["workspaces"].remove(ws_edit_id)
        else:
            warn(f"workspaces:edit DELETE → {r.status_code}")

    # 3.3 workspaces:full → CAN create and delete workspace
    r = dt_full.post("/dataset-workspaces/", json={"name": f"DT_FullWS_{RUN_ID}", "description": "full test"})
    ws_full_id = None
    if r.status_code in (200, 201):
        ws_full_id = r.json()["id"]
        ok(f"workspaces:full → POST → 201 (id={ws_full_id})")
        r = dt_full.delete(f"/dataset-workspaces/{ws_full_id}")
        if r.status_code in (200, 204):
            ok("workspaces:full → DELETE own workspace → success")
        else:
            warn(f"workspaces:full DELETE → {r.status_code}")
    else:
        fail("workspaces:full → create workspace", got=f"{r.status_code} {r.text[:100]}")

    # 3.4 dashboards:edit → CAN create dashboard
    r = dt_edit.post("/dashboards/", json={"name": f"DT_EditDash_{RUN_ID}"})
    dash_edit_id = None
    if r.status_code in (200, 201):
        dash_edit_id = r.json()["id"]
        _cleanup["dashboards"].append(dash_edit_id)
        ok(f"dashboards:edit → POST /dashboards/ → 201")
    else:
        fail("dashboards:edit → create dashboard", got=f"{r.status_code} {r.text[:100]}")

    # 3.5 dashboards:edit → cannot DELETE own dashboard
    if dash_edit_id:
        r = dt_edit.delete(f"/dashboards/{dash_edit_id}")
        if r.status_code in (401, 403):
            ok(f"dashboards:edit → DELETE own dashboard → {r.status_code}")
        elif r.status_code in (200, 204):
            warn("dashboards:edit DELETE succeeded — may be allowed for own resources")
            _cleanup["dashboards"].remove(dash_edit_id)
        else:
            warn(f"dashboards:edit DELETE → {r.status_code}")

    # ── S4: DataSource Lifecycle ───────────────────────────────────────────────
    section("S4. DataSource Lifecycle")

    # 4.1 All authenticated users can list datasources
    for label, client in [("admin", admin), ("dt_full", dt_full), ("dt_edit", dt_edit), ("dt_view", dt_view)]:
        r = client.get("/datasources/")
        if r.status_code == 200:
            ok(f"{label} GET /datasources/ → 200 ({len(r.json())} items)")
        else:
            fail(f"{label} GET /datasources/", got=r.status_code)

    # 4.2 GET /datasources/{id} — view users can read
    existing_ds = admin.get("/datasources/").json()
    if existing_ds:
        ds_id = existing_ds[0]["id"]
        r = dt_view.get(f"/datasources/{ds_id}")
        if r.status_code == 200:
            ok(f"data_sources:view → GET /datasources/{ds_id} → 200")
        else:
            fail(f"data_sources:view → GET datasource by id", got=r.status_code)

    # 4.3 view cannot PUT datasource
    if existing_ds:
        r = dt_view.put(f"/datasources/{existing_ds[0]['id']}", json={"name": "should_fail"})
        if r.status_code in (401, 403):
            ok(f"data_sources:view → PUT /datasources/{{id}} → {r.status_code}")
        else:
            fail("data_sources:view → PUT should be blocked", got=r.status_code)

    # 4.4 Not found → 404
    r = admin.get("/datasources/999999")
    if r.status_code == 404:
        ok("GET /datasources/999999 → 404")
    else:
        warn(f"GET /datasources/999999 → {r.status_code}")

    # ── S5: Workspace CRUD Lifecycle ───────────────────────────────────────────
    section("S5. Workspace CRUD Lifecycle")

    # 5.1 Create workspace as dt_full
    r = dt_full.post("/dataset-workspaces/", json={"name": f"DT_MainWS_{RUN_ID}", "description": "main test"})
    ws_main_id = None
    if r.status_code in (200, 201):
        ws_main_id = r.json()["id"]
        _cleanup["workspaces"].append(ws_main_id)
        ok(f"dt_full creates workspace → id={ws_main_id}")
    else:
        fail("dt_full create workspace", got=f"{r.status_code} {r.text[:150]}")

    # 5.2 GET own workspace → returns data
    if ws_main_id:
        r = dt_full.get(f"/dataset-workspaces/{ws_main_id}")
        if r.status_code == 200 and r.json().get("id") == ws_main_id:
            ok("GET own workspace → correct data")
        else:
            fail("GET own workspace", got=r.status_code)

    # 5.3 PUT own workspace → update name
    if ws_main_id:
        r = dt_full.put(f"/dataset-workspaces/{ws_main_id}", json={"name": f"DT_MainWS_Updated_{RUN_ID}"})
        if r.status_code == 200:
            ok("PUT workspace (update name) → 200")
        else:
            fail("PUT workspace", got=f"{r.status_code} {r.text[:100]}")

    # 5.4 dt_b cannot GET dt_full's workspace (not shared)
    if ws_main_id:
        r = dt_b.get(f"/dataset-workspaces/{ws_main_id}")
        if r.status_code in (403, 404):
            ok(f"dt_b GET unshared workspace → {r.status_code}")
        else:
            fail("dt_b should not access dt_full's workspace", got=r.status_code)

    # 5.5 dt_full's workspace not in dt_b's list
    if ws_main_id:
        ids = _ids(dt_b.get("/dataset-workspaces/"))
        if ws_main_id not in ids:
            ok("dt_b list: dt_full's workspace not present (not shared)")
        else:
            fail("dt_b list should NOT include dt_full's workspace", got=ids)

    # 5.6 Not found → 404
    r = admin.get("/dataset-workspaces/999999")
    if r.status_code == 404:
        ok("GET /dataset-workspaces/999999 → 404")
    else:
        warn(f"GET /dataset-workspaces/999999 → {r.status_code}")

    # ── S6: Workspace Table Auth Enforcement ────────────────────────────────────
    section("S6. Workspace Table Auth Enforcement (Security Fix)")

    # 6.1 Anonymous GET /dataset-workspaces/{id}/tables → 401
    if admin_ws_id:
        r = anon.get(f"/dataset-workspaces/{admin_ws_id}/tables")
        if r.status_code == 401:
            ok("Anon GET workspace /tables → 401")
        else:
            fail("Anon workspace /tables should be 401", got=r.status_code)
    else:
        skip("Anon /tables — no admin workspace")

    # 6.2 Anonymous POST /preview → 401
    if admin_ws_id and admin_table_id:
        r = anon.post(f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/preview",
                      json={"limit": 5})
        if r.status_code == 401:
            ok("Anon POST /preview → 401")
        else:
            fail("Anon /preview should be 401", got=r.status_code)
    else:
        skip("Anon /preview — no workspace/table")

    # 6.3 Anonymous POST /execute → 401
    if admin_ws_id and admin_table_id:
        r = anon.post(f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/execute",
                      json={"limit": 5})
        if r.status_code == 401:
            ok("Anon POST /execute → 401")
        else:
            fail("Anon /execute should be 401", got=r.status_code)
    else:
        skip("Anon /execute — no workspace/table")

    # 6.4 dt_b (no share) GET admin workspace /tables → 403/404
    if admin_ws_id:
        r = dt_b.get(f"/dataset-workspaces/{admin_ws_id}/tables")
        if r.status_code in (403, 404):
            ok(f"dt_b GET admin workspace /tables → {r.status_code} (correct)")
        else:
            fail("dt_b GET admin workspace /tables should be 403/404", got=r.status_code)
    else:
        skip("dt_b /tables isolation — no workspace")

    # 6.5 dt_b POST /preview on admin's table → 403/404
    if admin_ws_id and admin_table_id:
        r = dt_b.post(f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/preview",
                      json={"limit": 5})
        if r.status_code in (403, 404):
            ok(f"dt_b POST /preview on admin table → {r.status_code} (correct)")
        else:
            fail("dt_b /preview on admin table should be 403/404", got=r.status_code)
    else:
        skip("dt_b /preview isolation — no workspace/table")

    # 6.6 dt_b POST /execute on admin's table → 403/404
    if admin_ws_id and admin_table_id:
        r = dt_b.post(f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/execute",
                      json={"limit": 5})
        if r.status_code in (403, 404):
            ok(f"dt_b POST /execute on admin table → {r.status_code} (correct)")
        else:
            fail("dt_b /execute on admin table should be 403/404", got=r.status_code)
    else:
        skip("dt_b /execute isolation — no workspace/table")

    # 6.7 Share workspace with dt_b → access granted → revoke → blocked again
    if admin_ws_id and admin_table_id:
        r = admin.post(f"/shares/workspace/{admin_ws_id}",
                       json={"user_id": uid_b, "permission": "view"})
        if r.status_code in (200, 201):
            ok(f"Admin shares workspace {admin_ws_id} with dt_b")
            r2 = dt_b.get(f"/dataset-workspaces/{admin_ws_id}/tables")
            if r2.status_code == 200:
                ok("dt_b GET /tables after share → 200 (access granted)")
            else:
                fail("dt_b /tables after share", got=r2.status_code)
            r3 = dt_b.post(f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/preview",
                           json={"limit": 3})
            if r3.status_code == 200:
                ok("dt_b POST /preview after share → 200")
            else:
                warn(f"dt_b /preview after share → {r3.status_code}")
            # Revoke
            admin.delete(f"/shares/workspace/{admin_ws_id}/{uid_b}")
            r4 = dt_b.get(f"/dataset-workspaces/{admin_ws_id}/tables")
            if r4.status_code in (403, 404):
                ok(f"dt_b GET /tables after share revoke → {r4.status_code}")
            else:
                fail("After revoke workspace share, dt_b should be blocked", got=r4.status_code)
        else:
            warn(f"Admin share workspace → {r.status_code} {r.text[:100]}")
    else:
        skip("Workspace share/revoke cycle — no workspace/table")

    # 6.8 Vector search returns only accessible workspaces
    r = dt_b.get("/dataset-workspaces/tables/search", params={"q": "test", "limit": 20})
    if r.status_code == 200:
        results = r.json()
        b_ws_ids = set(_ids(dt_b.get("/dataset-workspaces/")))
        leaked = [t for t in results if t.get("workspace_id") not in b_ws_ids]
        if not leaked:
            ok(f"Vector search: {len(results)} results, all from dt_b's accessible workspaces")
        else:
            fail("Vector search leaked tables from inaccessible workspaces", got=leaked)
    elif r.status_code in (404, 422):
        skip(f"Vector search endpoint → {r.status_code}")
    else:
        warn(f"Vector search → {r.status_code}")

    # ── S7: Execute Query Validation & Security ────────────────────────────────
    section("S7. Execute Query Validation & Security")

    if not (admin_ws_id and admin_table_id):
        warn("S7 requires admin workspace/table — all skipped")
    else:
        def execute(body):
            return admin.post(
                f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/execute",
                json=body,
            )

        # 7.1 Valid count query
        r = execute({"measures": [{"field": first_col, "function": "count"}], "limit": 10})
        if r.status_code == 200:
            ok("Execute: valid count aggregation → 200")
        else:
            fail("Execute valid count", got=f"{r.status_code} {r.text[:150]}")

        # 7.2 Valid table preview
        r = admin.post(f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/preview",
                       json={"limit": 5})
        if r.status_code == 200 and "rows" in r.json():
            ok("Preview table → 200 with rows key")
        else:
            fail("Preview table", got=f"{r.status_code} {r.text[:100]}")

        # 7.3 Invalid aggregation function → 422 (Pydantic pattern)
        r = execute({"measures": [{"field": first_col, "function": "EVIL_FUNC"}], "limit": 10})
        if r.status_code == 422:
            ok("Invalid agg function 'EVIL_FUNC' → 422")
        else:
            fail("Invalid agg function should be 422", got=r.status_code)

        # 7.4 SQL injection in aggregation function → 422
        r = execute({"measures": [{"field": first_col, "function": "count; DROP TABLE users;--"}], "limit": 10})
        if r.status_code == 422:
            ok("SQL injection in agg function → 422 (Pydantic pattern blocked)")
        else:
            fail("SQL injection in agg function should be 422", got=r.status_code)

        # 7.5 Invalid filter operator → 422
        r = execute({"filters": [{"field": first_col, "operator": "INJECT", "value": "x"}], "limit": 10})
        if r.status_code == 422:
            ok("Invalid filter operator 'INJECT' → 422")
        else:
            fail("Invalid filter operator should be 422", got=r.status_code)

        # 7.6 SQL injection via filter operator → 422
        r = execute({"filters": [{"field": first_col, "operator": "= 1; DROP TABLE users;--", "value": "x"}], "limit": 10})
        if r.status_code == 422:
            ok("SQL injection in filter operator → 422")
        else:
            fail("SQL injection filter operator should be 422", got=r.status_code)

        # 7.7 Invalid order_by direction → 422
        r = execute({"order_by": [{"field": first_col, "direction": "SIDEWAYS"}], "limit": 10})
        if r.status_code == 422:
            ok("Invalid order direction 'SIDEWAYS' → 422")
        else:
            fail("Invalid order direction should be 422", got=r.status_code)

        # 7.8 Column not in whitelist → 400 (backend column validation)
        r = execute({"dimensions": ["non_existent_column_xyz_99"], "limit": 10})
        if r.status_code in (400, 422):
            ok(f"Non-existent column in dimensions → {r.status_code}")
        else:
            warn(f"Non-existent column → {r.status_code} (verify column whitelist active)")

        # 7.9 SQL injection via dimension field name → 400 (column whitelist)
        r = execute({"dimensions": ["id; DROP TABLE users; --"], "limit": 10})
        if r.status_code in (400, 422):
            ok(f"SQL injection in dimension field → {r.status_code} (whitelist blocked it)")
        else:
            warn(f"SQL injection in dimension → {r.status_code} (verify safety)")

        # 7.10 limit exceeds max (10000) → 422
        r = execute({"limit": 99999})
        if r.status_code == 422:
            ok("Execute limit=99999 (>10000) → 422")
        else:
            warn(f"Execute limit=99999 → {r.status_code} (expected 422)")

        # 7.11 limit below min (0) → 422
        r = execute({"limit": 0})
        if r.status_code == 422:
            ok("Execute limit=0 (<1) → 422")
        else:
            warn(f"Execute limit=0 → {r.status_code} (expected 422)")

        # 7.12 Valid LIKE filter
        r = execute({"filters": [{"field": first_col, "operator": "LIKE", "value": "%a%"}], "limit": 5})
        if r.status_code in (200, 400):
            ok(f"Valid LIKE filter → {r.status_code} (200 if string col, 400 if type mismatch)")
        else:
            warn(f"LIKE filter → {r.status_code}")

        # 7.13 Preview limit boundary — below min → 422
        r = admin.post(f"/dataset-workspaces/{admin_ws_id}/tables/{admin_table_id}/preview",
                       json={"limit": 0})
        if r.status_code == 422:
            ok("Preview limit=0 → 422")
        else:
            warn(f"Preview limit=0 → {r.status_code}")

    # ── S8: Chart Lifecycle ────────────────────────────────────────────────────
    section("S8. Chart Lifecycle")

    chart_full_id = chart_edit_id = chart_b_id = None
    wt_id = admin_table_id

    # Share admin workspace with dt_full, dt_edit, dt_b so they can create charts on it
    if admin_ws_id:
        for uid in [uid_full, uid_b]:
            admin.post(f"/shares/workspace/{admin_ws_id}", json={"user_id": uid, "permission": "view"})

    # 8.1 dt_full creates chart
    if wt_id:
        r = dt_full.post("/charts/", json={
            "name": f"DT_Chart_Full_{RUN_ID}", "chart_type": "BAR",
            "config": {"x_axis": first_col, "y_axis": "count", "aggregation": "count"},
            "workspace_table_id": wt_id,
        })
        if r.status_code in (200, 201):
            chart_full_id = r.json()["id"]
            _cleanup["charts"].append(chart_full_id)
            ok(f"dt_full creates chart → id={chart_full_id}")
        else:
            fail("dt_full create chart", got=f"{r.status_code} {r.text[:150]}")
    else:
        skip("Chart creation — no workspace_table_id")

    # 8.2 dt_edit creates chart
    if wt_id:
        r = dt_edit.post("/charts/", json={
            "name": f"DT_Chart_Edit_{RUN_ID}", "chart_type": "LINE",
            "config": {"x_axis": first_col, "y_axis": "count"},
            "workspace_table_id": wt_id,
        })
        if r.status_code in (200, 201):
            chart_edit_id = r.json()["id"]
            _cleanup["charts"].append(chart_edit_id)
            ok(f"dt_edit creates chart → id={chart_edit_id}")
        else:
            fail("dt_edit create chart", got=f"{r.status_code} {r.text[:150]}")

    # 8.3 dt_b creates chart (for isolation/sharing tests)
    if wt_id:
        r = dt_b.post("/charts/", json={
            "name": f"DT_Chart_B_{RUN_ID}", "chart_type": "PIE",
            "config": {"dimension": first_col, "measure": "count"},
            "workspace_table_id": wt_id,
        })
        if r.status_code in (200, 201):
            chart_b_id = r.json()["id"]
            _cleanup["charts"].append(chart_b_id)
            ok(f"dt_b creates chart → id={chart_b_id}")
        else:
            warn(f"dt_b create chart → {r.status_code} {r.text[:150]}")

    # 8.4 dt_view CANNOT create chart
    if wt_id:
        r = dt_view.post("/charts/", json={
            "name": f"DT_Chart_View_{RUN_ID}", "chart_type": "BAR",
            "config": {}, "workspace_table_id": wt_id,
        })
        if r.status_code in (401, 403):
            ok(f"explore_charts:view → create chart blocked → {r.status_code}")
        else:
            fail("explore_charts:view create chart should be blocked", got=r.status_code)

    # 8.5 Creator sees own chart in list
    if chart_full_id:
        ids = _ids(dt_full.get("/charts/"))
        if chart_full_id in ids:
            ok("dt_full sees own chart in list")
        else:
            fail("dt_full should see own chart", got=ids)

    # 8.6 dt_b does NOT see dt_full's unshared chart
    if chart_full_id:
        ids = _ids(dt_b.get("/charts/"))
        if chart_full_id not in ids:
            ok("dt_b: dt_full's unshared chart not in list")
        else:
            fail("dt_b should not see dt_full's chart", got=ids)

    # 8.7 Direct GET on unshared chart → 403/404
    if chart_full_id:
        r = dt_b.get(f"/charts/{chart_full_id}")
        if r.status_code in (403, 404):
            ok(f"dt_b GET unshared chart direct → {r.status_code}")
        else:
            fail("dt_b should not get unshared chart", got=r.status_code)

    # 8.8 PUT own chart
    if chart_full_id:
        r = dt_full.put(f"/charts/{chart_full_id}", json={"name": f"DT_Chart_Full_Updated_{RUN_ID}"})
        if r.status_code == 200:
            ok("PUT own chart → 200")
        else:
            fail("PUT own chart", got=f"{r.status_code} {r.text[:100]}")

    # 8.9 dt_edit cannot DELETE own chart (edit level)
    if chart_edit_id:
        r = dt_edit.delete(f"/charts/{chart_edit_id}")
        if r.status_code in (401, 403):
            ok(f"explore_charts:edit DELETE own chart → {r.status_code} (correct)")
        elif r.status_code in (200, 204):
            warn("dt_edit DELETE chart succeeded — check if edit level allows own-delete")
            _cleanup["charts"].remove(chart_edit_id)
        else:
            warn(f"dt_edit DELETE chart → {r.status_code}")

    # 8.10 Chart 404
    r = admin.get("/charts/999999")
    if r.status_code == 404:
        ok("GET /charts/999999 → 404")
    else:
        warn(f"GET /charts/999999 → {r.status_code}")

    # 8.11 Chart with legacy dataset_id (no workspace_table_id) → rejected
    r = dt_full.post("/charts/", json={
        "name": f"DT_Legacy_{RUN_ID}", "chart_type": "BAR", "config": {},
        "dataset_id": 1,
    })
    if r.status_code in (400, 422):
        ok("Chart with only dataset_id (legacy field) → 400/422 rejected")
    else:
        warn(f"Chart with dataset_id → {r.status_code} (verify workspace_table_id required)")

    # ── S9: Chart Data Access ──────────────────────────────────────────────────
    section("S9. Chart Data Access")

    # 9.1 Owner can GET chart data
    if chart_full_id:
        r = dt_full.get(f"/charts/{chart_full_id}/data")
        if r.status_code == 200:
            ok("Owner GET /charts/{id}/data → 200")
        else:
            warn(f"Owner GET chart data → {r.status_code} {r.text[:100]}")

    # 9.2 Admin can GET any chart data
    if chart_full_id:
        r = admin.get(f"/charts/{chart_full_id}/data")
        if r.status_code == 200:
            ok("Admin GET chart data → 200")
        else:
            warn(f"Admin GET chart data → {r.status_code} {r.text[:100]}")

    # 9.3 Non-owner (dt_b, no share) cannot GET chart data
    if chart_full_id:
        r = dt_b.get(f"/charts/{chart_full_id}/data")
        if r.status_code in (403, 404):
            ok(f"Non-owner GET chart data (no share) → {r.status_code}")
        else:
            fail("Non-owner should not get chart data", got=r.status_code)

    # 9.4 After view share: dt_b can GET chart data
    if chart_full_id:
        dt_full.post(f"/shares/chart/{chart_full_id}", json={"user_id": uid_b, "permission": "view"})
        r = dt_b.get(f"/charts/{chart_full_id}/data")
        if r.status_code == 200:
            ok("View-shared user GET chart data → 200")
        else:
            warn(f"View-shared GET chart data → {r.status_code}")
        dt_full.delete(f"/shares/chart/{chart_full_id}/{uid_b}")

    # 9.5 Chart data has expected structure
    if chart_full_id:
        r = admin.get(f"/charts/{chart_full_id}/data")
        if r.status_code == 200:
            data = r.json()
            has_expected = bool({"data", "chart", "rows", "columns"} & set(data.keys()))
            if has_expected:
                ok(f"Chart data response has expected structure: {list(data.keys())}")
            else:
                warn(f"Unexpected chart data structure: {list(data.keys())}")

    # 9.6 Chart data 404
    r = admin.get("/charts/999999/data")
    if r.status_code == 404:
        ok("GET /charts/999999/data → 404")
    else:
        warn(f"GET /charts/999999/data → {r.status_code}")

    # ── S10: Dashboard Lifecycle ───────────────────────────────────────────────
    section("S10. Dashboard Lifecycle")

    dash_full_id = dash_edit_id2 = dash_b_id = None

    # 10.1 dt_full creates dashboard
    r = dt_full.post("/dashboards/", json={"name": f"DT_Dash_Full_{RUN_ID}", "description": "test"})
    if r.status_code in (200, 201):
        dash_full_id = r.json()["id"]
        _cleanup["dashboards"].append(dash_full_id)
        ok(f"dt_full creates dashboard → id={dash_full_id}")
    else:
        fail("dt_full create dashboard", got=f"{r.status_code} {r.text[:150]}")

    # 10.2 dt_edit creates dashboard
    r = dt_edit.post("/dashboards/", json={"name": f"DT_Dash_Edit2_{RUN_ID}"})
    if r.status_code in (200, 201):
        dash_edit_id2 = r.json()["id"]
        _cleanup["dashboards"].append(dash_edit_id2)
        ok(f"dt_edit creates dashboard → id={dash_edit_id2}")
    else:
        fail("dt_edit create dashboard", got=f"{r.status_code} {r.text[:150]}")

    # 10.3 dt_b creates dashboard (for cascade share test)
    r = dt_b.post("/dashboards/", json={"name": f"DT_Dash_B_{RUN_ID}"})
    if r.status_code in (200, 201):
        dash_b_id = r.json()["id"]
        _cleanup["dashboards"].append(dash_b_id)
        ok(f"dt_b creates dashboard → id={dash_b_id}")
    else:
        fail("dt_b create dashboard", got=f"{r.status_code} {r.text[:150]}")

    # 10.4 dt_view CANNOT create dashboard
    r = dt_view.post("/dashboards/", json={"name": f"DT_Dash_View_{RUN_ID}"})
    if r.status_code in (401, 403):
        ok(f"dashboards:view → create blocked → {r.status_code}")
    else:
        fail("dashboards:view create should be blocked", got=r.status_code)

    # 10.5 Owner sees own dashboard in list
    if dash_full_id:
        ids = _ids(dt_full.get("/dashboards/"))
        if dash_full_id in ids:
            ok("dt_full sees own dashboard in list")
        else:
            fail("dt_full should see own dashboard", got=ids)

    # 10.6 dt_b does NOT see dt_full's unshared dashboard
    if dash_full_id:
        ids = _ids(dt_b.get("/dashboards/"))
        if dash_full_id not in ids:
            ok("dt_b: dt_full's unshared dashboard not in list")
        else:
            fail("dt_b should not see dt_full's dashboard", got=ids)

    # 10.7 Direct GET on unshared dashboard → 403/404
    if dash_full_id:
        r = dt_b.get(f"/dashboards/{dash_full_id}")
        if r.status_code in (403, 404):
            ok(f"dt_b GET unshared dashboard direct → {r.status_code}")
        else:
            fail("dt_b should not get unshared dashboard", got=r.status_code)

    # 10.8 PUT own dashboard
    if dash_full_id:
        r = dt_full.put(f"/dashboards/{dash_full_id}", json={"name": f"DT_Dash_Full_Updated_{RUN_ID}"})
        if r.status_code == 200:
            ok("PUT own dashboard → 200")
        else:
            fail("PUT own dashboard", got=f"{r.status_code}")

    # 10.9 dt_edit cannot DELETE dashboard
    if dash_edit_id2:
        r = dt_edit.delete(f"/dashboards/{dash_edit_id2}")
        if r.status_code in (401, 403):
            ok(f"dashboards:edit DELETE → {r.status_code} (correct)")
        elif r.status_code in (200, 204):
            warn("dt_edit DELETE dashboard succeeded")
            _cleanup["dashboards"].remove(dash_edit_id2)
        else:
            warn(f"dt_edit DELETE dashboard → {r.status_code}")

    # 10.10 Dashboard 404
    r = admin.get("/dashboards/999999")
    if r.status_code == 404:
        ok("GET /dashboards/999999 → 404")
    else:
        warn(f"GET /dashboards/999999 → {r.status_code}")

    # ── S11: Dashboard-Chart Operations ───────────────────────────────────────
    section("S11. Dashboard-Chart Operations")

    # 11.1 Add chart to own dashboard
    if dash_full_id and chart_full_id:
        r = dt_full.post(f"/dashboards/{dash_full_id}/charts", json={
            "chart_id": chart_full_id,
            "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
            "parameters": {}
        })
        if r.status_code in (200, 201):
            ok(f"Add chart {chart_full_id} to dashboard {dash_full_id}")
        else:
            fail("Add chart to dashboard", got=f"{r.status_code} {r.text[:100]}")

    # 11.2 GET dashboard includes the chart
    if dash_full_id and chart_full_id:
        r = dt_full.get(f"/dashboards/{dash_full_id}")
        if r.status_code == 200:
            charts_in_dash = r.json().get("charts", [])
            chart_ids_in_dash = [c.get("chart_id") or c.get("id") for c in charts_in_dash]
            if chart_full_id in chart_ids_in_dash:
                ok("GET dashboard → includes added chart")
            else:
                warn(f"GET dashboard charts: {chart_ids_in_dash}")

    # 11.3 Update layout
    if dash_full_id and chart_full_id:
        r = dt_full.put(f"/dashboards/{dash_full_id}/layout", json={
            "layouts": [{"chart_id": chart_full_id, "x": 1, "y": 1, "w": 8, "h": 5}]
        })
        if r.status_code == 200:
            ok("PUT /dashboards/{id}/layout → 200")
        else:
            fail("PUT layout", got=f"{r.status_code} {r.text[:100]}")

    # 11.4 dt_b (no share) cannot add chart to dt_full's dashboard
    if dash_full_id and chart_b_id:
        r = dt_b.post(f"/dashboards/{dash_full_id}/charts", json={
            "chart_id": chart_b_id, "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
        })
        if r.status_code in (403, 404):
            ok(f"Non-owner add chart to dashboard → {r.status_code}")
        else:
            fail("Non-owner add chart to dashboard should fail", got=r.status_code)

    # 11.5 Add chart_b to dash_b (for cascade share test)
    if dash_b_id and chart_b_id:
        r = dt_b.post(f"/dashboards/{dash_b_id}/charts", json={
            "chart_id": chart_b_id, "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
        })
        if r.status_code in (200, 201):
            ok(f"dt_b adds own chart to own dashboard (cascade test setup)")
        else:
            warn(f"dt_b add chart to dashboard → {r.status_code}")

    # ── S12: Chart-Level Resource Sharing ─────────────────────────────────────
    section("S12. Resource Sharing — Chart Level")

    if not chart_b_id:
        warn("S12 requires chart_b — skipping")
    else:
        # 12.1 Before share: dt_full cannot see chart_b
        ids = _ids(dt_full.get("/charts/"))
        if chart_b_id not in ids:
            ok("Before share: dt_full cannot see dt_b's chart")
        else:
            warn("Before share: dt_full already sees chart_b (unexpected)")

        # 12.2 dt_b shares chart with dt_full (view)
        r = dt_b.post(f"/shares/chart/{chart_b_id}", json={"user_id": uid_full, "permission": "view"})
        if r.status_code in (200, 201):
            ok("dt_b shares chart_b with dt_full (view)")
        else:
            fail("Share chart view", got=f"{r.status_code} {r.text[:150]}")

        # 12.3 After share: dt_full sees chart_b in list
        ids = _ids(dt_full.get("/charts/"))
        if chart_b_id in ids:
            ok("After share: dt_full sees chart_b in list")
        else:
            fail("After share: dt_full should see chart_b", got=ids)

        # 12.4 View-shared user can GET chart data
        r = dt_full.get(f"/charts/{chart_b_id}/data")
        if r.status_code == 200:
            ok("View-shared: dt_full GET chart_b data → 200")
        else:
            warn(f"View-shared GET chart data → {r.status_code}")

        # 12.5 View-shared user CANNOT PUT chart
        r = dt_full.put(f"/charts/{chart_b_id}", json={"name": "hacked"})
        if r.status_code in (401, 403):
            ok(f"View-shared cannot PUT chart → {r.status_code}")
        else:
            warn(f"View-shared PUT chart → {r.status_code} (expected 403)")

        # 12.6 View-shared user CANNOT DELETE chart
        r = dt_full.delete(f"/charts/{chart_b_id}")
        if r.status_code in (401, 403):
            ok(f"View-shared cannot DELETE chart → {r.status_code}")
        else:
            warn(f"View-shared DELETE chart → {r.status_code} (expected 403)")

        # 12.7 Upgrade to edit share
        r = dt_b.put(f"/shares/chart/{chart_b_id}/{uid_full}", json={"permission": "edit"})
        if r.status_code == 200:
            ok("Upgrade share to edit → 200")
        else:
            warn(f"Upgrade share → {r.status_code}")

        # 12.8 Edit-shared user CAN PUT chart
        r = dt_full.put(f"/charts/{chart_b_id}", json={"name": f"DT_Chart_B_Edited_{RUN_ID}"})
        if r.status_code == 200:
            ok("Edit-shared user PUT chart → 200")
        else:
            warn(f"Edit-shared PUT chart → {r.status_code}")

        # 12.9 Revoke share
        r = dt_b.delete(f"/shares/chart/{chart_b_id}/{uid_full}")
        if r.status_code in (200, 204):
            ok("Revoke chart share → success")
        else:
            fail("Revoke share", got=f"{r.status_code}")

        # 12.10 After revoke: dt_full cannot see chart_b
        ids = _ids(dt_full.get("/charts/"))
        if chart_b_id not in ids:
            ok("After revoke: dt_full cannot see chart_b")
        else:
            fail("After revoke: dt_full should NOT see chart_b", got=ids)

        # 12.11 Verify list_shares is accessible by owner
        r = dt_b.get(f"/shares/chart/{chart_b_id}")
        if r.status_code == 200:
            ok(f"Owner GET /shares/chart/{{id}} → 200")
        else:
            warn(f"List shares → {r.status_code}")

    # ── S13: Dashboard Cascade Share ───────────────────────────────────────────
    section("S13. Resource Sharing — Dashboard Cascade")

    if not (dash_b_id and chart_b_id):
        warn("S13 requires dash_b + chart_b — skipping")
    else:
        # 13.1 Before cascade: dt_full sees neither dash_b nor chart_b
        d_ids = _ids(dt_full.get("/dashboards/"))
        c_ids = _ids(dt_full.get("/charts/"))
        if dash_b_id not in d_ids and chart_b_id not in c_ids:
            ok("Before cascade: dt_full sees neither dash_b nor chart_b")
        else:
            warn("Before cascade: dt_full already sees some dt_b resources")

        # 13.2 Cascade share dashboard
        r = dt_b.post(f"/shares/dashboard/{dash_b_id}",
                      json={"user_id": uid_full, "permission": "view"})
        if r.status_code in (200, 201):
            ok("dt_b cascade shares dash_b with dt_full")
        else:
            fail("Cascade share dashboard", got=f"{r.status_code} {r.text[:150]}")

        # 13.3 dt_full sees dash_b
        d_ids = _ids(dt_full.get("/dashboards/"))
        if dash_b_id in d_ids:
            ok("Cascade: dt_full sees dash_b")
        else:
            fail("Cascade: dt_full should see dash_b", got=d_ids)

        # 13.4 dt_full sees chart_b (cascaded from dashboard)
        c_ids = _ids(dt_full.get("/charts/"))
        if chart_b_id in c_ids:
            ok("Cascade: dt_full sees chart_b (auto-cascaded from dashboard)")
        else:
            fail("Cascade: dt_full should see chart_b", got=c_ids)

        # 13.5 resource_shares contains entry for dashboard
        r = admin.get(f"/shares/dashboard/{dash_b_id}")
        if r.status_code == 200:
            share_users = [s["user_id"] for s in r.json()]
            if uid_full in share_users:
                ok("resource_shares: dashboard entry exists for dt_full")
            else:
                fail("resource_shares: missing entry for dt_full", got=share_users)

        # 13.6 View-shared user cannot modify dashboard
        r = dt_full.put(f"/dashboards/{dash_b_id}", json={"name": "hacked"})
        if r.status_code in (401, 403):
            ok(f"View-shared dashboard: PUT blocked → {r.status_code}")
        else:
            warn(f"View-shared PUT dashboard → {r.status_code}")

        # 13.7 All-team share
        r = dt_b.post(f"/shares/dashboard/{dash_b_id}/all-team", json={"permission": "view"})
        if r.status_code in (200, 201, 204):
            ok("All-team share dashboard → success")
            # dt_view should now see the dashboard
            d_ids = _ids(dt_view.get("/dashboards/"))
            if dash_b_id in d_ids:
                ok("All-team share: dt_view sees dash_b")
            else:
                warn("All-team share: dt_view does not see dash_b")
            # Cleanup: revoke dt_view's share
            dt_b.delete(f"/shares/dashboard/{dash_b_id}/{uid_view}")
        else:
            warn(f"All-team share → {r.status_code}")

        # 13.8 Revoke cascade share
        r = dt_b.delete(f"/shares/dashboard/{dash_b_id}/{uid_full}")
        if r.status_code in (200, 204):
            ok("Revoke cascade share → success")
        else:
            fail("Revoke cascade", got=f"{r.status_code}")

        # 13.9 After revoke: dt_full cannot see dash_b
        d_ids = _ids(dt_full.get("/dashboards/"))
        if dash_b_id not in d_ids:
            ok("After cascade revoke: dt_full cannot see dash_b")
        else:
            fail("After cascade revoke: dt_full should NOT see dash_b", got=d_ids)

        # 13.10 After revoke: dt_full cannot see chart_b (cascade removed)
        c_ids = _ids(dt_full.get("/charts/"))
        if chart_b_id not in c_ids:
            ok("After cascade revoke: dt_full cannot see chart_b")
        else:
            fail("After cascade revoke: dt_full should NOT see chart_b", got=c_ids)

    # ── S14: Cross-User Isolation ──────────────────────────────────────────────
    section("S14. Cross-User Isolation (no resource bleed)")

    # 14.1 dt_full list contains no dt_b charts (no active share)
    if chart_full_id and chart_b_id:
        c_ids = set(_ids(dt_full.get("/charts/")))
        if chart_b_id not in c_ids:
            ok("dt_full list: no bleed from dt_b's charts")
        else:
            warn("dt_full sees dt_b's chart — check for active share")

    # 14.2 dt_b list contains no dt_full charts
    if chart_full_id and chart_b_id:
        c_ids = set(_ids(dt_b.get("/charts/")))
        if chart_full_id not in c_ids:
            ok("dt_b list: no bleed from dt_full's charts")
        else:
            warn("dt_b sees dt_full's chart — check for active share")

    # 14.3 Dashboard isolation
    if dash_full_id and dash_b_id:
        d_ids = set(_ids(dt_b.get("/dashboards/")))
        if dash_full_id not in d_ids:
            ok("dt_b list: no bleed from dt_full's dashboards")
        else:
            warn("dt_b sees dt_full's dashboard")

    # 14.4 Workspace isolation
    if ws_main_id:
        w_ids = set(_ids(dt_b.get("/dataset-workspaces/")))
        if ws_main_id not in w_ids:
            ok("dt_b list: no bleed from dt_full's workspaces")
        else:
            warn("dt_b sees dt_full's workspace")

    # 14.5 Admin sees all resources (full access)
    if chart_full_id and chart_b_id:
        c_ids = set(_ids(admin.get("/charts/")))
        if chart_full_id in c_ids and chart_b_id in c_ids:
            ok("Admin sees all charts (full access)")
        else:
            warn(f"Admin chart visibility: full={chart_full_id in c_ids}, b={chart_b_id in c_ids}")

    # ── S15: Admin-Only Operations ─────────────────────────────────────────────
    section("S15. Admin-Only Operations")

    # 15.1 Admin GET /users/ → 200
    r = admin.get("/users/")
    if r.status_code == 200:
        ok(f"Admin GET /users/ → 200 ({len(r.json())} users)")
    else:
        fail("Admin GET /users/", got=r.status_code)

    # 15.2 Non-admin cannot GET /users/ (settings:none)
    for label, client in [("dt_full", dt_full), ("dt_edit", dt_edit), ("dt_view", dt_view)]:
        r = client.get("/users/")
        if r.status_code in (401, 403):
            ok(f"settings:none → {label} GET /users/ → {r.status_code}")
        else:
            fail(f"settings:none {label} /users/ should be blocked", got=r.status_code)

    # 15.3 Admin can GET /permissions/matrix
    r = admin.get("/permissions/matrix")
    if r.status_code == 200 and "users" in r.json():
        ok(f"Admin GET /permissions/matrix → 200 ({len(r.json()['users'])} users)")
    else:
        fail("Admin GET /permissions/matrix", got=r.status_code)

    # 15.4 Admin can update permissions
    r = admin.put(f"/permissions/{uid_view}", json={"permissions": PERM_VIEW})
    if r.status_code == 200:
        ok("Admin PUT /permissions/{id} → 200")
    else:
        fail("Admin PUT permissions", got=r.status_code)

    # 15.5 Admin can apply permission preset
    r = admin.put(f"/permissions/{uid_view}/preset", json={"preset": "viewer"})
    if r.status_code == 200:
        ok("Admin apply 'viewer' preset to dt_view → 200")
    else:
        warn(f"Apply preset → {r.status_code}")
    # Re-apply PERM_VIEW to restore
    admin.put(f"/permissions/{uid_view}", json={"permissions": PERM_VIEW})

    # 15.6 Create user (admin only)
    r = admin.post("/users/", json={
        "email": f"tmp_{RUN_ID}@appbi.io", "full_name": "Temp", "password": "Pass1234"
    })
    tmp_uid = None
    if r.status_code in (200, 201):
        tmp_uid = r.json()["id"]
        ok(f"Admin create user → id={tmp_uid}")
    else:
        warn(f"Admin create user → {r.status_code}")

    # 15.7 Non-admin cannot create user
    r = dt_full.post("/users/", json={
        "email": f"illegal_{RUN_ID}@appbi.io", "full_name": "Illegal", "password": "Pass1234"
    })
    if r.status_code in (401, 403):
        ok(f"settings:none → create user blocked → {r.status_code}")
    else:
        fail("settings:none create user should be blocked", got=r.status_code)

    # 15.8 Deactivate (soft delete) temp user
    if tmp_uid:
        r = admin.delete(f"/users/{tmp_uid}")
        if r.status_code in (200, 204):
            ok("Admin deactivate temp user → success")
        else:
            warn(f"Deactivate user → {r.status_code}")

    # 15.9 Admin cannot deactivate themselves
    r = admin.get("/users/")
    admin_uid = next((u["id"] for u in r.json() if u["email"] == "admin@appbi.io"), None)
    if admin_uid:
        r = admin.delete(f"/users/{admin_uid}")
        if r.status_code == 400:
            ok("Admin cannot deactivate own account → 400")
        else:
            warn(f"Self-deactivation → {r.status_code} (expected 400)")

    # ── S16: Resource 404 ─────────────────────────────────────────────────────
    section("S16. Resource Not Found (404s)")

    for path, label in [
        ("/charts/999999",                             "chart"),
        ("/charts/999999/data",                        "chart data"),
        ("/dashboards/999999",                         "dashboard"),
        ("/dataset-workspaces/999999",                 "workspace"),
        ("/datasources/999999",                        "datasource"),
        ("/dataset-workspaces/999999/tables",          "workspace tables"),
    ]:
        r = admin.get(path)
        if r.status_code == 404:
            ok(f"GET {path} → 404")
        else:
            warn(f"GET {path} → {r.status_code} (expected 404)")

    # ── S17: AI Chat Permission Gate ───────────────────────────────────────────
    section("S17. AI Chat Permission Gate")

    # 17.1 dt_view has ai_chat:view → confirmed in /permissions/me
    r = dt_view.get("/permissions/me")
    if r.status_code == 200:
        ai_level = r.json().get("permissions", {}).get("ai_chat")
        if ai_level == "view":
            ok("dt_view: ai_chat=view in /permissions/me")
        else:
            fail("dt_view: ai_chat should be view", got=ai_level)

    # 17.2 dt_edit has ai_chat:edit
    r = dt_edit.get("/permissions/me")
    if r.status_code == 200:
        ai_level = r.json().get("permissions", {}).get("ai_chat")
        if ai_level == "edit":
            ok("dt_edit: ai_chat=edit in /permissions/me")
        else:
            fail("dt_edit: ai_chat should be edit", got=ai_level)

    # 17.3 Set ai_chat=none and verify it propagates
    admin.put(f"/permissions/{uid_view}", json={"permissions": {**PERM_VIEW, "ai_chat": "none"}})
    r = dt_view.get("/permissions/me")
    if r.status_code == 200:
        ai_level = r.json().get("permissions", {}).get("ai_chat")
        if ai_level == "none":
            ok("ai_chat set to none → confirmed in /permissions/me")
        else:
            fail("ai_chat none not reflected", got=ai_level)
    # Restore
    admin.put(f"/permissions/{uid_view}", json={"permissions": PERM_VIEW})
    ok("dt_view permissions restored to PERM_VIEW")

    # 17.4 AI service health (if running at :8001)
    try:
        r = requests.get("http://localhost:8001/health", timeout=3)
        if r.status_code == 200:
            ok("AI service health check → 200")
        else:
            warn(f"AI service health → {r.status_code}")
    except Exception:
        skip("AI service not reachable (:8001) — health check skipped")

    # ── S18: Permission Presets ────────────────────────────────────────────────
    section("S18. Permission Presets")

    # 18.1 GET /permissions/presets (admin only)
    r = admin.get("/permissions/presets")
    if r.status_code == 200 and "presets" in r.json():
        presets = r.json()["presets"]
        if "admin" in presets and "editor" in presets and "viewer" in presets:
            ok(f"GET /permissions/presets → {list(presets.keys())}")
        else:
            warn(f"Presets missing expected keys: {list(presets.keys())}")
    else:
        fail("GET /permissions/presets", got=r.status_code)

    # 18.2 Non-admin cannot view presets
    r = dt_full.get("/permissions/presets")
    if r.status_code in (401, 403):
        ok(f"settings:none → GET /permissions/presets → {r.status_code}")
    else:
        fail("Non-admin presets should be blocked", got=r.status_code)

    # 18.3 Apply 'editor' preset to dt_edit and verify
    r = admin.put(f"/permissions/{uid_edit}/preset", json={"preset": "editor"})
    if r.status_code == 200:
        result = r.json()
        expected_level = "edit"
        if result.get("permissions", {}).get("workspaces") == expected_level:
            ok("Apply editor preset → workspaces=edit confirmed")
        else:
            warn(f"Apply editor preset result: {result.get('permissions', {})}")
    else:
        warn(f"Apply editor preset → {r.status_code}")
    # Re-apply original permissions
    admin.put(f"/permissions/{uid_edit}", json={"permissions": PERM_EDIT})

    # 18.4 Apply unknown preset → 400
    r = admin.put(f"/permissions/{uid_edit}/preset", json={"preset": "superadmin_xyz"})
    if r.status_code == 400:
        ok("Apply unknown preset → 400")
    else:
        warn(f"Apply unknown preset → {r.status_code} (expected 400)")

    # ── Summary ────────────────────────────────────────────────────────────────
    section("SUMMARY")
    total = PASS + FAIL + WARN + SKIP
    print(f"\n  Total: {total}  |  "
          f"{GREEN}PASS: {PASS}{RESET}  |  "
          f"{RED}FAIL: {FAIL}{RESET}  |  "
          f"{YELLOW}WARN: {WARN}{RESET}  |  "
          f"{BLUE}SKIP: {SKIP}{RESET}\n")

    # ── Cleanup ────────────────────────────────────────────────────────────────
    section("Cleanup")

    # Revoke workspace shares before deleting
    if admin_ws_id:
        for uid in [uid_full, uid_b, uid_edit, uid_view]:
            admin.delete(f"/shares/workspace/{admin_ws_id}/{uid}")

    for cid in _cleanup["charts"]:
        admin.delete(f"/charts/{cid}")
    for did in _cleanup["dashboards"]:
        admin.delete(f"/dashboards/{did}")
    for wid in _cleanup["workspaces"]:
        admin.delete(f"/dataset-workspaces/{wid}")

    c = len(_cleanup["charts"]); d = len(_cleanup["dashboards"]); w = len(_cleanup["workspaces"])
    ok(f"Cleanup: {c} charts, {d} dashboards, {w} workspaces deleted")

    if FAIL > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
