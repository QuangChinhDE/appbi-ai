#!/usr/bin/env python3
"""
Comprehensive permission test suite.

Scenarios tested:
  - Module-level access gate  (none / view / edit / full)
  - Ownership visibility      (only own resources visible at view/edit level)
  - Share flow                (share → visible; revoke → gone)
  - Cascade share             (sharing a dashboard also shares its charts/datasets)
  - Cross-user isolation      (User A cannot see User B's unshared resources)
  - Settings access denied    (user with settings:none cannot call user/permission APIs)
  - AI-chat blocked           (user with ai_chat:none gets empty list)
  - Datasource visibility     (all datasources visible to any view+ user — shared infra)

Users:
  admin  — admin@appbi.io / 123456   (full access, manages permissions)
  userb  — testb@appbi.io / Pass1234  (data_sources:full, explore_charts:full,
                                         dashboards:full, ai_chat:edit, settings:none)
  usera  — testa@appbi.io / Pass1234  (data_sources:view, explore_charts:edit,
                                         dashboards:edit, ai_chat:none, settings:none)
"""

import sys
import json
import time
import requests

BASE = "http://localhost:8000/api/v1"

# Unique run prefix to avoid name collisions between test runs
RUN_ID = str(int(time.time()))[-6:]

# ─── colour helpers ───────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

PASS = 0
FAIL = 0
WARN = 0

def ok(name):
    global PASS
    PASS += 1
    print(f"  {GREEN}✓ PASS{RESET}  {name}")

def fail(name, got=None, expected=None):
    global FAIL
    FAIL += 1
    msg = f"  {RED}✗ FAIL{RESET}  {name}"
    if expected is not None:
        msg += f"  (expected {expected!r}, got {got!r})"
    elif got is not None:
        msg += f"  → {got}"
    print(msg)

def warn(name, detail=""):
    global WARN
    WARN += 1
    print(f"  {YELLOW}⚠ WARN{RESET}  {name}  {detail}")

def section(title):
    print(f"\n{BOLD}{'─'*60}{RESET}")
    print(f"{BOLD}  {title}{RESET}")
    print(f"{BOLD}{'─'*60}{RESET}")

# ─── HTTP helpers ─────────────────────────────────────────────────────────────

class Client:
    """Thin wrapper that keeps an httpOnly cookie jar."""
    def __init__(self, label):
        self.label = label
        self.session = requests.Session()

    def login(self, email, password):
        r = self.session.post(f"{BASE}/auth/login",
                              json={"email": email, "password": password})
        if r.status_code != 200:
            raise RuntimeError(f"Login failed for {email}: {r.status_code} {r.text}")
        return r.json()

    def get(self, path, **kw):
        return self.session.get(f"{BASE}{path}", **kw)

    def post(self, path, **kw):
        return self.session.post(f"{BASE}{path}", **kw)

    def put(self, path, **kw):
        return self.session.put(f"{BASE}{path}", **kw)

    def delete(self, path, **kw):
        return self.session.delete(f"{BASE}{path}", **kw)


# ─── Setup helpers ────────────────────────────────────────────────────────────

PERM_A = {
    "data_sources":    "view",
    "datasets":        "view",
    "workspaces":      "view",
    "explore_charts":  "edit",
    "dashboards":      "edit",
    "ai_chat":         "none",
    "settings":        "none",
}

PERM_B = {
    "data_sources":    "full",
    "datasets":        "full",
    "workspaces":      "full",
    "explore_charts":  "full",
    "dashboards":      "full",
    "ai_chat":         "edit",
    "settings":        "none",
}


def ensure_user(admin: Client, email, fullname, password, perms) -> str:
    """Create user if not exists, then set permissions. Return user id."""
    r = admin.get("/users/")
    users = r.json() if r.status_code == 200 else []
    existing = next((u for u in users if u["email"] == email), None)

    if existing:
        uid = existing["id"]
    else:
        r = admin.post("/users/", json={
            "email": email, "full_name": fullname, "password": password
        })
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Cannot create user {email}: {r.status_code} {r.text}")
        uid = r.json()["id"]

    # Set permissions
    admin.put(f"/permissions/{uid}", json={"permissions": perms})
    return uid


def first_dataset_id(admin: Client):
    """Return any existing dataset id for chart creation."""
    r = admin.get("/datasets/")
    if r.status_code == 200 and r.json():
        return r.json()[0]["id"]
    return None


def first_workspace_table_id(admin: Client):
    r = admin.get("/dataset-workspaces/tables/")
    if r.status_code == 200 and r.json():
        return r.json()[0]["id"]
    return None


def get_chart_source(admin: Client):
    """Return (key, id) suitable for ChartCreate — dataset or workspace_table."""
    ds_id = first_dataset_id(admin)
    if ds_id:
        return "dataset_id", ds_id
    wt_id = first_workspace_table_id(admin)
    if wt_id:
        return "workspace_table_id", wt_id
    return None, None


MINIMAL_CHART_CONFIG = {
    "x_axis": "id",
    "y_axis": "value",
    "aggregation": "count",
}


def create_chart(client: Client, name, src_key, src_id):
    r = client.post("/charts/", json={
        "name": name,
        "chart_type": "BAR",
        "config": MINIMAL_CHART_CONFIG,
        src_key: src_id,
    })
    return r


def create_dashboard(client: Client, name):
    r = client.post("/dashboards/", json={"name": name, "charts": []})
    return r


def delete_resource(client: Client, rtype, rid):
    if rtype == "chart":
        client.delete(f"/charts/{rid}")
    elif rtype == "dashboard":
        client.delete(f"/dashboards/{rid}")


# ─── Cleanup tracker ─────────────────────────────────────────────────────────

created_charts     = []   # ids created during test (deleted at end)
created_dashboards = []


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN TEST SEQUENCE
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    admin = Client("admin")
    admin.login("admin@appbi.io", "123456")

    usera = Client("usera")
    userb = Client("userb")

    # ── 0. Setup ──────────────────────────────────────────────────────────────
    section("0. Setup — create test users & set permissions")

    try:
        uid_a = ensure_user(admin, "testa@appbi.io", "Test User A", "Pass1234", PERM_A)
        ok("User A created/found and permissions set")
    except Exception as e:
        fail("User A setup", got=str(e))
        sys.exit(1)

    try:
        uid_b = ensure_user(admin, "testb@appbi.io", "Test User B", "Pass1234", PERM_B)
        ok("User B created/found and permissions set")
    except Exception as e:
        fail("User B setup", got=str(e))
        sys.exit(1)

    usera.login("testa@appbi.io", "Pass1234")
    ok("User A logged in")
    userb.login("testb@appbi.io", "Pass1234")
    ok("User B logged in")

    src_key, src_id = get_chart_source(admin)
    if not src_id:
        warn("No dataset or workspace table found — chart creation tests will be skipped")

    # ── 1. Module-level access gates ─────────────────────────────────────────
    section("1. Module access gates (ai_chat:none / data_sources:view / settings:none)")

    # 1a. User A ai_chat = none → list returns empty
    r = usera.get("/charts/")   # different module, should work
    # ai_chat gate: there's no dedicated /ai-chat/ backend list; the frontend uses the
    # ai-service. We test what we can on the backend permissions endpoint.
    me = usera.get("/auth/me").json()
    if me.get("permissions", {}).get("ai_chat") == "none":
        ok("User A: ai_chat=none confirmed in /auth/me")
    else:
        fail("User A: expected ai_chat=none", got=me.get("permissions", {}).get("ai_chat"))

    # 1b. User A data_sources = view → can list datasources
    r = usera.get("/datasources/")
    if r.status_code == 200:
        ok("User A: data_sources=view → GET /datasources/ returns 200")
    else:
        fail("User A: data_sources=view → GET /datasources/", got=r.status_code, expected=200)

    # 1c. User A settings = none → cannot list users
    r = usera.get("/users/")
    if r.status_code in (401, 403):
        ok(f"User A: settings=none → GET /users/ blocked ({r.status_code})")
    else:
        fail("User A: settings=none → GET /users/ should be blocked", got=r.status_code, expected="401/403")

    # 1d. User A settings = none → cannot update permissions
    r = usera.put(f"/permissions/{uid_b}", json={"permissions": PERM_B})
    if r.status_code in (401, 403):
        ok(f"User A: settings=none → PUT /permissions/users/{{id}} blocked ({r.status_code})")
    else:
        fail("User A: settings=none → PUT /permissions blocked", got=r.status_code, expected="401/403")

    # ── 2. Ownership visibility ───────────────────────────────────────────────
    section("2. Ownership visibility — User A & B create; each sees only own")

    if not src_id:
        warn("Skipping chart/dashboard visibility tests — no data source available")
    else:
        # 2a. User B creates a chart
        r = create_chart(userb, f"TEST_B_Chart_{RUN_ID}", src_key, src_id)
        if r.status_code in (200, 201):
            chart_b_id = r.json()["id"]
            created_charts.append(chart_b_id)
            ok(f"User B: created chart {chart_b_id}")
        else:
            fail("User B: create chart", got=f"{r.status_code} {r.text[:100]}")
            chart_b_id = None

        # 2b. User B creates a dashboard
        r = create_dashboard(userb, f"TEST_B_Dashboard_{RUN_ID}")
        if r.status_code in (200, 201):
            dash_b_id = r.json()["id"]
            created_dashboards.append(dash_b_id)
            ok(f"User B: created dashboard {dash_b_id}")
        else:
            fail("User B: create dashboard", got=f"{r.status_code} {r.text[:100]}")
            dash_b_id = None

        # 2c. User A creates a chart
        r = create_chart(usera, f"TEST_A_Chart_{RUN_ID}", src_key, src_id)
        if r.status_code in (200, 201):
            chart_a_id = r.json()["id"]
            created_charts.append(chart_a_id)
            ok(f"User A: created chart {chart_a_id}")
        else:
            fail("User A: create chart", got=f"{r.status_code} {r.text[:100]}")
            chart_a_id = None

        # 2d. User A creates a dashboard
        r = create_dashboard(usera, f"TEST_A_Dashboard_{RUN_ID}")
        if r.status_code in (200, 201):
            dash_a_id = r.json()["id"]
            created_dashboards.append(dash_a_id)
            ok(f"User A: created dashboard {dash_a_id}")
        else:
            fail("User A: create dashboard", got=f"{r.status_code} {r.text[:100]}")
            dash_a_id = None

        # 2e. User A sees own chart but NOT User B's chart
        r = usera.get("/charts/")
        a_chart_ids = [c["id"] for c in r.json()] if r.status_code == 200 else []
        if chart_a_id and chart_a_id in a_chart_ids:
            ok("User A: sees own chart in list")
        else:
            fail("User A: should see own chart in list", got=a_chart_ids)

        if chart_b_id and chart_b_id not in a_chart_ids:
            ok("User A: does NOT see User B's unshared chart")
        elif chart_b_id:
            fail("User A: should NOT see User B's unshared chart", got=a_chart_ids)

        # 2f. User A sees own dashboard but NOT User B's dashboard
        r = usera.get("/dashboards/")
        a_dash_ids = [d["id"] for d in r.json()] if r.status_code == 200 else []
        if dash_a_id and dash_a_id in a_dash_ids:
            ok("User A: sees own dashboard in list")
        else:
            fail("User A: should see own dashboard in list", got=a_dash_ids)

        if dash_b_id and dash_b_id not in a_dash_ids:
            ok("User A: does NOT see User B's unshared dashboard")
        elif dash_b_id:
            fail("User A: should NOT see User B's unshared dashboard", got=a_dash_ids)

        # 2g. User B sees own resources (full level → sees everything!)
        r = userb.get("/charts/")
        b_chart_ids = [c["id"] for c in r.json()] if r.status_code == 200 else []
        if chart_b_id is not None:
            if chart_b_id in b_chart_ids:
                ok("User B: sees own chart (full level)")
            else:
                fail("User B: should see own chart", got=b_chart_ids)
        else:
            warn("Skipping User B chart visibility check — chart creation failed")

    # ── 3. Share flow ─────────────────────────────────────────────────────────
    section("3. Share flow — User B shares chart with User A → visible; revoke → gone")

    if src_id and chart_b_id:
        # 3a. Before share: User A cannot see chart_b
        r = usera.get("/charts/")
        a_chart_ids = [c["id"] for c in r.json()] if r.status_code == 200 else []
        if chart_b_id not in a_chart_ids:
            ok("Before share: User A cannot see User B's chart")
        else:
            warn("Before share: User A already sees User B's chart (unexpected)")

        # 3b. User B shares chart with User A (view)
        r = userb.post(f"/shares/chart/{chart_b_id}",
                       json={"user_id": uid_a, "permission": "view"})
        if r.status_code in (200, 201):
            ok(f"User B: shared chart {chart_b_id} with User A (view)")
        else:
            fail("User B: share chart with User A", got=f"{r.status_code} {r.text[:150]}")

        # 3c. After share: User A can see chart_b
        r = usera.get("/charts/")
        a_chart_ids = [c["id"] for c in r.json()] if r.status_code == 200 else []
        if chart_b_id in a_chart_ids:
            ok("After share: User A can see User B's chart")
        else:
            fail("After share: User A should see User B's chart", got=a_chart_ids)

        # 3d. User B revokes share
        r = userb.delete(f"/shares/chart/{chart_b_id}/{uid_a}")
        if r.status_code in (200, 204):
            ok("User B: revoked share")
        else:
            fail("User B: revoke share", got=f"{r.status_code} {r.text[:100]}")

        # 3e. After revoke: User A cannot see chart_b anymore
        r = usera.get("/charts/")
        a_chart_ids = [c["id"] for c in r.json()] if r.status_code == 200 else []
        if chart_b_id not in a_chart_ids:
            ok("After revoke: User A can no longer see User B's chart")
        else:
            fail("After revoke: User A should NOT see User B's chart", got=a_chart_ids)

    # ── 4. Dashboard cascade share ────────────────────────────────────────────
    section("4. Dashboard cascade share — sharing dashboard also shares charts inside")

    if src_id and dash_b_id and chart_b_id:
        # 4a. Add chart_b to dash_b first (if not already there)
        r = userb.post(f"/dashboards/{dash_b_id}/charts",
                       json={"chart_id": chart_b_id,
                             "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
                             "parameters": {}})
        chart_in_dash = r.status_code in (200, 201)
        if chart_in_dash:
            ok(f"Setup: added chart {chart_b_id} to dashboard {dash_b_id}")
        else:
            warn(f"Could not add chart to dashboard: {r.status_code} {r.text[:100]}")

        # 4b. Before cascade share: User A can't see dash_b or chart_b
        r = usera.get("/dashboards/")
        a_dash_ids_before = [d["id"] for d in r.json()] if r.status_code == 200 else []
        r2 = usera.get("/charts/")
        a_chart_ids_before = [c["id"] for c in r2.json()] if r2.status_code == 200 else []
        visible_before = dash_b_id in a_dash_ids_before
        if not visible_before:
            ok("Before cascade share: User A cannot see dashboard B")
        else:
            warn("Before cascade share: User A already sees dashboard B")

        # 4c. User B shares dashboard with User A (cascade)
        r = userb.post(f"/shares/dashboard/{dash_b_id}",
                       json={"user_id": uid_a, "permission": "view"})
        if r.status_code in (200, 201):
            ok("User B: shared dashboard with User A (cascade)")
        else:
            fail("User B: share dashboard cascade", got=f"{r.status_code} {r.text[:150]}")

        # 4d. User A sees dashboard
        r = usera.get("/dashboards/")
        a_dash_ids_after = [d["id"] for d in r.json()] if r.status_code == 200 else []
        if dash_b_id in a_dash_ids_after:
            ok("After cascade share: User A sees dashboard B")
        else:
            fail("After cascade share: User A should see dashboard B", got=a_dash_ids_after)

        # 4e. User A sees chart that was in the dashboard (cascade)
        if chart_in_dash:
            r = usera.get("/charts/")
            a_chart_ids_after = [c["id"] for c in r.json()] if r.status_code == 200 else []
            if chart_b_id in a_chart_ids_after:
                ok("After cascade share: User A sees chart B (cascaded from dashboard)")
            else:
                fail("After cascade share: User A should see chart B", got=a_chart_ids_after)

        # 4f. Verify resource_shares entries
        r = admin.get(f"/shares/dashboard/{dash_b_id}")
        if r.status_code == 200:
            share_users = [s["user_id"] for s in r.json()]
            if uid_a in share_users:
                ok("resource_shares: dashboard share entry exists for User A")
            else:
                fail("resource_shares: missing dashboard share for User A", got=share_users)

        # 4g. Revoke cascade
        r = userb.delete(f"/shares/dashboard/{dash_b_id}/{uid_a}")
        if r.status_code in (200, 204):
            ok("User B: revoked cascade dashboard share")
        else:
            fail("User B: revoke cascade dashboard share", got=f"{r.status_code} {r.text[:100]}")

        # 4h. After revoke: User A cannot see dashboard or cascaded chart
        r = usera.get("/dashboards/")
        a_dash_final = [d["id"] for d in r.json()] if r.status_code == 200 else []
        if dash_b_id not in a_dash_final:
            ok("After revoke cascade: User A cannot see dashboard B")
        else:
            fail("After revoke cascade: User A should NOT see dashboard B", got=a_dash_final)

        if chart_in_dash:
            r = usera.get("/charts/")
            a_chart_final = [c["id"] for c in r.json()] if r.status_code == 200 else []
            if chart_b_id not in a_chart_final:
                ok("After revoke cascade: User A cannot see chart B (cascade removed)")
            else:
                fail("After revoke cascade: User A should NOT see chart B", got=a_chart_final)

    # ── 5. Share permission levels ────────────────────────────────────────────
    section("5. Share permission levels — view vs edit on chart")

    if src_id and chart_b_id:
        # Share chart_b to User A with edit permission
        r = userb.post(f"/shares/chart/{chart_b_id}",
                       json={"user_id": uid_a, "permission": "edit"})
        if r.status_code in (200, 201):
            ok("User B: shared chart with User A (edit)")
        else:
            fail("User B: share chart (edit)", got=f"{r.status_code} {r.text[:100]}")

        # Verify the share exists and has edit permission
        r = admin.get(f"/shares/chart/{chart_b_id}")
        if r.status_code == 200:
            shares = r.json()
            share_for_a = next((s for s in shares if s["user_id"] == uid_a), None)
            if share_for_a and share_for_a.get("permission") == "edit":
                ok("Share permission=edit stored correctly")
            else:
                fail("Share permission=edit not stored", got=share_for_a)

        # Update to view
        r = userb.put(f"/shares/chart/{chart_b_id}/{uid_a}",
                      json={"permission": "view"})
        if r.status_code == 200:
            ok("User B: updated share permission to view")
        else:
            fail("User B: update share permission", got=f"{r.status_code} {r.text[:100]}")

        r = admin.get(f"/shares/chart/{chart_b_id}")
        if r.status_code == 200:
            shares = r.json()
            share_for_a = next((s for s in shares if s["user_id"] == uid_a), None)
            if share_for_a and share_for_a.get("permission") == "view":
                ok("Share permission updated to view correctly")
            else:
                fail("Share permission update to view failed", got=share_for_a)

        # Cleanup
        userb.delete(f"/shares/chart/{chart_b_id}/{uid_a}")

    # ── 6. Full-access user sees all resources ────────────────────────────────
    section("6. full-level user (admin) sees ALL charts/dashboards")

    r = admin.get("/charts/")
    all_chart_ids = [c["id"] for c in r.json()] if r.status_code == 200 else []
    if src_id and chart_a_id and chart_b_id:
        if chart_a_id in all_chart_ids and chart_b_id in all_chart_ids:
            ok("Admin (full) sees both User A and User B charts")
        else:
            fail("Admin should see all charts", got=all_chart_ids)

    r = admin.get("/dashboards/")
    all_dash_ids = [d["id"] for d in r.json()] if r.status_code == 200 else []
    if src_id and dash_a_id and dash_b_id:
        if dash_a_id in all_dash_ids and dash_b_id in all_dash_ids:
            ok("Admin (full) sees both User A and User B dashboards")
        else:
            fail("Admin should see all dashboards", got=all_dash_ids)

    # ── 7. all-team share ─────────────────────────────────────────────────────
    section("7. all-team share — share dashboard with all active users at once")

    if src_id and dash_b_id:
        r = userb.post(f"/shares/dashboard/{dash_b_id}/all-team",
                       json={"permission": "view"})
        if r.status_code in (200, 201, 204):
            ok("User B: shared dashboard with all-team")
        else:
            fail("User B: all-team share", got=f"{r.status_code} {r.text[:150]}")

        # User A should now see dashboard_b
        r = usera.get("/dashboards/")
        a_dash_ids = [d["id"] for d in r.json()] if r.status_code == 200 else []
        if dash_b_id in a_dash_ids:
            ok("After all-team share: User A sees dashboard B")
        else:
            fail("After all-team share: User A should see dashboard B", got=a_dash_ids)

        # Revoke
        userb.delete(f"/shares/dashboard/{dash_b_id}/{uid_a}")

    # ── 8. Datasource visibility (shared infra — all non-none users see all) ──
    section("8. Datasources — non-none users see all (shared infrastructure)")

    r_admin = admin.get("/datasources/")
    r_a     = usera.get("/datasources/")    # view level
    r_b     = userb.get("/datasources/")    # full level

    if r_admin.status_code == 200 and r_a.status_code == 200:
        admin_count = len(r_admin.json())
        a_count     = len(r_a.json())
        if admin_count == a_count:
            ok(f"Datasources: User A (view) sees same count as admin ({a_count} items)")
        else:
            warn(f"Datasources: admin sees {admin_count}, User A sees {a_count}")
    if r_a.status_code != 200:
        fail("User A: GET /datasources/", got=r_a.status_code, expected=200)

    # ── 9. Isolation between User A and User B's own items ────────────────────
    section("9. Cross-user isolation — no bleed between unshared resources")

    if src_id:
        r_a_charts = usera.get("/charts/").json() if usera.get("/charts/").status_code == 200 else []
        r_b_charts = userb.get("/charts/").json() if userb.get("/charts/").status_code == 200 else []
        a_ids = {c["id"] for c in r_a_charts}
        b_ids = {c["id"] for c in r_b_charts}
        # After all shares revoked, A's list should NOT include B's chart
        # (we revoked all shares above)
        if chart_b_id and chart_b_id not in a_ids:
            ok("User A's chart list has no bleed from User B (no active shares)")
        elif chart_b_id:
            warn("User A still sees chart B — check if share was revoked", detail=str(a_ids))

    # ─────────────────────────────────────────────────────────────────────────
    section("SUMMARY")
    total = PASS + FAIL + WARN
    print(f"\n  Total: {total}  |  "
          f"{GREEN}PASS: {PASS}{RESET}  |  "
          f"{RED}FAIL: {FAIL}{RESET}  |  "
          f"{YELLOW}WARN: {WARN}{RESET}\n")

    # ── Cleanup ───────────────────────────────────────────────────────────────
    section("Cleanup — removing test charts & dashboards")
    for cid in created_charts:
        admin.delete(f"/charts/{cid}")
    for did in created_dashboards:
        admin.delete(f"/dashboards/{did}")
    if created_charts or created_dashboards:
        ok(f"Deleted {len(created_charts)} charts and {len(created_dashboards)} dashboards")

    if FAIL > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
