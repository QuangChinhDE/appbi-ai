#!/usr/bin/env python3
"""
seed_demo.py — Xoá dữ liệu cũ, tạo lại dữ liệu demo cho 3 tài khoản chính:

  admin@appbi.io   / 123456  → full toàn bộ module
  edit@appbi.io    / 123456  → view: data_sources; edit: datasets/workspaces/charts/dashboards/ai_chat; none: settings
  viewer@appbi.io  / 123456  → view: tất cả trừ settings (none)

Kịch bản phân quyền được tạo sẵn để test:
  [DS]  1 DataSource "Football Analytics"        — admin tạo  (mọi user view+ đều thấy)

  [D1]  Dataset "Bảng xếp hạng FIFA"             — admin tạo  | KHÔNG share
  [D2]  Dataset "Lịch sử World Cup"              — admin tạo  | share → edit (edit)
  [D3]  Dataset "Thống kê liên đoàn"             — edit  tạo  | KHÔNG share
  [D4]  Dataset "Top Scorers FIFA"               — edit  tạo  | share → viewer (view)

  [W1]  Workspace "Rankings Workspace"          — admin tạo  | share → edit (edit)
  [W2]  Workspace "World Cup Workspace"         — edit  tạo  | share → viewer (view)

  [C1]  Chart "Điểm FIFA Top 20" (BAR)          — admin | dùng W1.T1 | KHÔNG share
  [C2]  Chart "Phân bố liên đoàn" (PIE)         — admin | dùng W1.T1 | share → edit (edit)
  [C3]  Chart "Top 10 Rankings" (TABLE)         — admin | dùng W1.T2 | share → edit (edit)
  [C4]  Chart "WC Champions" (BAR)              — admin | dùng W2.T1 | share → viewer (view)
  [C5]  Chart "Top Scorers Bar" (BAR)           — edit  | dùng W2.T2 | KHÔNG share
  [C6]  Chart "Scorers by Confederation" (PIE)  — edit  | dùng W2.T2 | share → viewer (view)
  [C7]  Chart "WC History Table" (TABLE)        — edit  | dùng W2.T1 | KHÔNG share

  [DB1] Dashboard "Admin Riêng"                 — admin | C1+C2      | KHÔNG share → chỉ admin
  [DB2] Dashboard "Chia sẻ cho Edit"            — admin | C2+C3      | share → edit (edit) → admin+edit
  [DB3] Dashboard "Chia sẻ cho Viewer"          — admin | C3+C4      | share → viewer (view) → admin+viewer
  [DB4] Dashboard "Toàn Đội"                    — admin | C1+C4      | share all team → tất cả
  [DB5] Dashboard "Edit Riêng"                  — edit  | C5+C6      | KHÔNG share → edit+admin(full)
  [DB6] Dashboard "Edit → Chia Viewer"          — edit  | C6+C7      | share → viewer (view) → edit+viewer+admin
"""
import os, sys, uuid, warnings, requests
warnings.filterwarnings("ignore")

sys.path.insert(0, "/home/appbi/AppBI/Dashboard-App/backend")
os.environ["DATABASE_URL"]  = "postgresql+psycopg2://appbi:appbi@localhost:5432/appbi"
os.environ["SECRET_KEY"]    = "dev-secret-key-change-in-production"

from sqlalchemy import text
from app.core.database import SessionLocal
from app.models.user import User, UserStatus
from app.models.models import (DataSource, Dataset, Chart, Dashboard,
                                DashboardChart, ChartType)
from app.models.dataset_workspace import DatasetWorkspace, DatasetWorkspaceTable
from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.api.auth import hash_password
import psycopg2

BASE      = "http://localhost:8000/api/v1"
XLSX_PATH = "/home/appbi/AppBI/Dashboard-App/scope-foodball-demo.xlsx"
DB_DSN    = "dbname=appbi user=appbi password=appbi host=localhost"

GREEN="\033[92m"; YELLOW="\033[93m"; RED="\033[91m"; BOLD="\033[1m"; RESET="\033[0m"
def ok(m):      print(f"  {GREEN}✓{RESET} {m}")
def info(m):    print(f"  {YELLOW}→{RESET} {m}")
def section(t): print(f"\n{BOLD}{'─'*60}\n  {t}\n{'─'*60}{RESET}")

# ═══════════════════════════════════════════════════════════
#  BƯỚC 0 — XOÁ DỮ LIỆU CŨ
# ═══════════════════════════════════════════════════════════
section("0. Xoá dữ liệu cũ")
db = SessionLocal()
try:
    db.execute(text("""
        TRUNCATE TABLE
            resource_shares, dashboard_charts, dashboards, charts,
            dataset_workspace_tables, dataset_workspaces,
            datasets, data_sources
        RESTART IDENTITY CASCADE
    """))
    db.execute(text(
        "DELETE FROM users WHERE email NOT IN "
        "('admin@appbi.io','edit@appbi.io','viewer@appbi.io')"
    ))
    db.commit()
    ok("Đã xoá toàn bộ dữ liệu cũ (trữ lại 3 tài khoản chính)")
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 1 — TẠO / CẬP NHẬT USERS
# ═══════════════════════════════════════════════════════════
section("1. Tạo / cập nhật users")

PERM_ADMIN  = dict(data_sources="full", datasets="full",    workspaces="full",
                   explore_charts="full",  dashboards="full",  ai_chat="full",  settings="full")
PERM_EDIT   = dict(data_sources="view",  datasets="edit",   workspaces="edit",
                   explore_charts="edit",  dashboards="edit",  ai_chat="edit",  settings="none")
PERM_VIEWER = dict(data_sources="view",  datasets="view",   workspaces="view",
                   explore_charts="view",  dashboards="view",  ai_chat="view",  settings="none")

ACCOUNTS = [
    ("admin@appbi.io",  "Admin AppBI",  PERM_ADMIN),
    ("edit@appbi.io",   "Edit User",    PERM_EDIT),
    ("viewer@appbi.io", "Viewer User",  PERM_VIEWER),
]

uids = {}
db = SessionLocal()
try:
    for email, full_name, perms in ACCOUNTS:
        u = db.query(User).filter(User.email == email).first()
        if u:
            u.permissions = perms
            u.status = UserStatus.ACTIVE
            u.password_hash = hash_password("123456")
            ok(f"Cập nhật: {email}")
        else:
            u = User(id=uuid.uuid4(), email=email,
                     password_hash=hash_password("123456"),
                     full_name=full_name, status=UserStatus.ACTIVE,
                     permissions=perms)
            db.add(u)
            ok(f"Tạo:      {email}")
    db.commit()
    for email, _, _ in ACCOUNTS:
        uids[email] = db.query(User.id).filter(User.email == email).scalar()
    info(f"admin_id  = {uids['admin@appbi.io']}")
    info(f"edit_id   = {uids['edit@appbi.io']}")
    info(f"viewer_id = {uids['viewer@appbi.io']}")
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 2 — PARSE XLSX + TẠO DATASOURCE
# ═══════════════════════════════════════════════════════════
section("2. Parse xlsx & tạo DataSource")

if not os.path.exists(XLSX_PATH):
    print(f"{RED}✗ Không tìm thấy {XLSX_PATH}{RESET}"); sys.exit(1)

with open(XLSX_PATH, "rb") as f:
    resp = requests.post(
        f"{BASE}/datasources/manual/parse-file",
        files={"file": ("scope-foodball-demo.xlsx", f,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        timeout=60,
    )
if resp.status_code != 200:
    print(f"{RED}✗ Parse xlsx thất bại: {resp.status_code} {resp.text[:200]}{RESET}"); sys.exit(1)

sheets = resp.json()["sheets"]
ok(f"Parse xlsx OK — {len(sheets)} sheets: {list(sheets.keys())}")

db = SessionLocal()
try:
    ds = DataSource(
        name="Football Analytics",
        type="manual",
        description="Dữ liệu bóng đá FIFA từ scope-foodball-demo.xlsx (3 sheets)",
        config={"sheets": sheets},
        owner_id=uids["admin@appbi.io"],
    )
    db.add(ds); db.commit(); db.refresh(ds)
    DS_ID = ds.id
    ok(f"DataSource id={DS_ID} (owner=admin)")
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 3 — TẠO WORKSPACES & TABLES
# ═══════════════════════════════════════════════════════════
section("3. Tạo Workspaces & Workspace Tables")

db = SessionLocal()
try:
    # W1 — Rankings Workspace (admin)
    w1 = DatasetWorkspace(
        name="Rankings Workspace",
        description="Bảng xếp hạng FIFA — do admin quản lý",
        owner_id=uids["admin@appbi.io"],
    )
    db.add(w1); db.flush()
    t1 = DatasetWorkspaceTable(
        workspace_id=w1.id, datasource_id=DS_ID, source_kind="sql_query",
        source_query='SELECT * FROM fifa_world_rankings_jan_2026',
        display_name="Rankings Full", enabled=True, transformations=[],
    )
    t2 = DatasetWorkspaceTable(
        workspace_id=w1.id, datasource_id=DS_ID, source_kind="sql_query",
        source_query='SELECT "Rank","Country","Confederation","Points" FROM fifa_world_rankings_jan_2026 ORDER BY "Rank" LIMIT 10',
        display_name="Top 10 Rankings", enabled=True, transformations=[],
    )
    db.add_all([t1, t2]); db.flush()
    W1_ID, T1_ID, T2_ID = w1.id, t1.id, t2.id
    ok(f"W1 id={W1_ID} (owner=admin)  → T1={T1_ID} Rankings Full  | T2={T2_ID} Top 10")

    # W2 — World Cup Workspace (edit@)
    w2 = DatasetWorkspace(
        name="World Cup Workspace",
        description="Lịch sử World Cup & Top Scorers — do edit quản lý",
        owner_id=uids["edit@appbi.io"],
    )
    db.add(w2); db.flush()
    t3 = DatasetWorkspaceTable(
        workspace_id=w2.id, datasource_id=DS_ID, source_kind="sql_query",
        source_query='SELECT * FROM fifa_world_cup_history',
        display_name="WC History", enabled=True, transformations=[],
    )
    t4 = DatasetWorkspaceTable(
        workspace_id=w2.id, datasource_id=DS_ID, source_kind="sql_query",
        source_query='SELECT * FROM fifa_world_cup_top_scorers',
        display_name="Top Scorers", enabled=True, transformations=[],
    )
    db.add_all([t3, t4]); db.flush()
    W2_ID, T3_ID, T4_ID = w2.id, t3.id, t4.id
    ok(f"W2 id={W2_ID} (owner=edit)   → T3={T3_ID} WC History     | T4={T4_ID} Top Scorers")
    db.commit()
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 4 — TẠO DATASETS
# ═══════════════════════════════════════════════════════════
section("4. Tạo Datasets")

db = SessionLocal()
try:
    datasets_data = [
        ("Bảng xếp hạng FIFA",
         "Bảng xếp hạng FIFA tháng 1/2026 — do admin quản lý, CHƯA share",
         'SELECT * FROM fifa_world_rankings_jan_2026',
         "admin@appbi.io"),
        ("Lịch sử World Cup",
         "Toàn bộ lịch sử WC — do admin quản lý, share cho edit (edit)",
         'SELECT * FROM fifa_world_cup_history',
         "admin@appbi.io"),
        ("Thống kê liên đoàn",
         "Tổng hợp theo confederation — do edit tạo, CHƯA share",
         'SELECT "Confederation", COUNT(*) as "Teams", ROUND(AVG(CAST("Points" AS NUMERIC)),1) as "Avg_Points" FROM fifa_world_rankings_jan_2026 GROUP BY "Confederation" ORDER BY "Avg_Points" DESC',
         "edit@appbi.io"),
        ("Top Scorers FIFA",
         "Danh sách cầu thủ ghi nhiều bàn WC — do edit tạo, share cho viewer (view)",
         'SELECT * FROM fifa_world_cup_top_scorers',
         "edit@appbi.io"),
    ]
    dataset_ids = []
    for name, desc, sql, owner_email in datasets_data:
        d = Dataset(
            name=name, description=desc,
            data_source_id=DS_ID, sql_query=sql,
            transformations=[], transformation_version=2,
            owner_id=uids[owner_email],
        )
        db.add(d); db.flush()
        dataset_ids.append(d.id)
        ok(f"Dataset id={d.id} '{name}' (owner={'admin' if 'admin' in owner_email else 'edit'})")
    db.commit()
    D1_ID, D2_ID, D3_ID, D4_ID = dataset_ids
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 5 — TẠO CHARTS
# ═══════════════════════════════════════════════════════════
section("5. Tạo Charts")

def bar_cfg(ws_id, dim, metric, agg="sum"):
    return {"workspace_id": ws_id, "chartType": "BAR",
            "roleConfig": {"dimension": dim, "metrics": [{"field": metric, "agg": agg}],
                           "breakdown": None, "sort": None, "limit": 20},
            "filters": []}

def pie_cfg(ws_id, dim, metric, agg="count"):
    return {"workspace_id": ws_id, "chartType": "PIE",
            "roleConfig": {"dimension": dim, "metrics": [{"field": metric, "agg": agg}]},
            "filters": []}

def table_cfg(ws_id):
    return {"workspace_id": ws_id, "chartType": "TABLE",
            "roleConfig": {"columns": [], "sort": None, "limit": 50},
            "filters": []}

db = SessionLocal()
try:
    charts_spec = [
        # name                        desc                                           wt_id  chart_type        config                                        owner
        ("Điểm FIFA Top 20",         "BAR: Top 20 quốc gia theo điểm FIFA — admin",  T1_ID, ChartType.BAR,   bar_cfg(W1_ID,"Country","Points"),          "admin@appbi.io"),
        ("Phân bố liên đoàn",        "PIE: Số đội theo confederation — admin",       T1_ID, ChartType.PIE,   pie_cfg(W1_ID,"Confederation","Rank"),       "admin@appbi.io"),
        ("Top 10 Rankings",          "TABLE: Bảng top 10 — admin",                   T2_ID, ChartType.TABLE, table_cfg(W1_ID),                            "admin@appbi.io"),
        ("WC Champions Overview",    "BAR: Số lần vô địch theo quốc gia — admin",    T3_ID, ChartType.BAR,   bar_cfg(W2_ID,"Champion","Year","count"),     "admin@appbi.io"),
        ("Top Scorers Bar",          "BAR: Số bàn thắng WC theo cầu thủ — edit",     T4_ID, ChartType.BAR,   bar_cfg(W2_ID,"Player","Goals"),             "edit@appbi.io"),
        ("Scorers by Confederation", "PIE: Số bàn theo liên đoàn — edit",            T4_ID, ChartType.PIE,   pie_cfg(W2_ID,"Confederation","Goals"),      "edit@appbi.io"),
        ("WC History Table",         "TABLE: Bảng lịch sử World Cup — edit",         T3_ID, ChartType.TABLE, table_cfg(W2_ID),                            "edit@appbi.io"),
    ]
    chart_ids = []
    for name, desc, wt_id, ct, cfg, owner_email in charts_spec:
        c = Chart(name=name, description=desc, workspace_table_id=wt_id,
                  chart_type=ct, config=cfg, owner_id=uids[owner_email])
        db.add(c); db.flush()
        chart_ids.append(c.id)
        ok(f"C{len(chart_ids)}={c.id} '{name}' (owner={'admin' if 'admin' in owner_email else 'edit'})")
    db.commit()
    C1, C2, C3, C4, C5, C6, C7 = chart_ids
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 6 — TẠO DASHBOARDS
# ═══════════════════════════════════════════════════════════
section("6. Tạo Dashboards")

db = SessionLocal()
try:
    dashboards_spec = [
        ("Admin Riêng",           "Private — chỉ admin thấy",                            "admin@appbi.io",  [(C1,0,0),(C2,6,0)]),
        ("Chia sẻ cho Edit",      "Admin share cho edit@ (edit perm) — admin+edit thấy", "admin@appbi.io",  [(C2,0,0),(C3,6,0)]),
        ("Chia sẻ cho Viewer",    "Admin share cho viewer@ (view) — admin+viewer thấy",  "admin@appbi.io",  [(C3,0,0),(C4,6,0)]),
        ("Toàn Đội",              "Admin share toàn đội — mọi người thấy",               "admin@appbi.io",  [(C1,0,0),(C4,6,0)]),
        ("Edit Riêng",            "edit tạo, private — edit+admin(full) thấy",           "edit@appbi.io",   [(C5,0,0),(C6,6,0)]),
        ("Edit → Chia Viewer",    "Edit share cho viewer@ (view) — edit+viewer+admin",   "edit@appbi.io",   [(C6,0,0),(C7,6,0)]),
    ]
    dash_ids = []
    for name, desc, owner_email, charts_layout in dashboards_spec:
        d = Dashboard(name=name, description=desc,
                      owner_id=uids[owner_email], filters_config=[])
        db.add(d); db.flush()
        for cid, x, y in charts_layout:
            db.add(DashboardChart(dashboard_id=d.id, chart_id=cid,
                                  layout={"x":x,"y":y,"w":6,"h":4}, parameters={}))
        db.flush()
        dash_ids.append(d.id)
        ok(f"DB{len(dash_ids)}={d.id} '{name}' (owner={'admin' if 'admin' in owner_email else 'edit'})")
    db.commit()
    DB1, DB2, DB3, DB4, DB5, DB6 = dash_ids
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 7 — TẠO RESOURCE SHARES
# ═══════════════════════════════════════════════════════════
section("7. Tạo Resource Shares")

conn = psycopg2.connect(DB_DSN)

def share(rtype, rid, uid, perm, shared_by):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO resource_shares (resource_type, resource_id, user_id, permission, shared_by)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT ON CONSTRAINT uq_resource_shares DO UPDATE
              SET permission=EXCLUDED.permission, shared_by=EXCLUDED.shared_by
        """, (rtype, str(rid), str(uid), perm, str(shared_by)))

try:
    A = uids["admin@appbi.io"]
    E = uids["edit@appbi.io"]
    V = uids["viewer@appbi.io"]

    # Datasets
    share("dataset", D2_ID, E, "edit", A);   ok(f"Dataset  D2={D2_ID}: admin → edit (edit)")
    share("dataset", D4_ID, V, "view", E);   ok(f"Dataset  D4={D4_ID}: edit  → viewer (view)")

    # Workspaces
    share("workspace", W1_ID, E, "edit", A); ok(f"Workspace W1={W1_ID}: admin → edit  (edit)")
    share("workspace", W2_ID, V, "view", E); ok(f"Workspace W2={W2_ID}: edit  → viewer (view)")

    # Charts
    share("chart", C2, E, "edit", A);        ok(f"Chart    C2={C2}: admin → edit (edit)")
    share("chart", C3, E, "edit", A);        ok(f"Chart    C3={C3}: admin → edit (edit)")
    share("chart", C4, V, "view", A);        ok(f"Chart    C4={C4}: admin → viewer (view)")
    share("chart", C6, V, "view", E);        ok(f"Chart    C6={C6}: edit  → viewer (view)")

    # Dashboards
    share("dashboard", DB2, E, "edit", A);   ok(f"Dashboard DB2={DB2}: admin → edit (edit)")
    share("dashboard", DB3, V, "view", A);   ok(f"Dashboard DB3={DB3}: admin → viewer (view)")
    share("dashboard", DB4, E, "view", A);   ok(f"Dashboard DB4={DB4}: admin → edit (view) [all team]")
    share("dashboard", DB4, V, "view", A);   ok(f"Dashboard DB4={DB4}: admin → viewer (view) [all team]")
    share("dashboard", DB6, V, "view", E);   ok(f"Dashboard DB6={DB6}: edit  → viewer (view)")

    conn.commit()
finally:
    conn.close()

# ═══════════════════════════════════════════════════════════
#  TỔNG KẾT
# ═══════════════════════════════════════════════════════════
section("✅  HOÀN THÀNH")
print(f"""
{BOLD}Tài khoản:{RESET}
  admin@appbi.io   / 123456   (full access)
  edit@appbi.io    / 123456   (edit charts/dash/datasets/ws, view source, no settings)
  viewer@appbi.io  / 123456   (view only, no settings)

{BOLD}Kịch bản phân quyền để test:{RESET}

  {YELLOW}[Data Sources]{RESET}
    → Tất cả 3 user đều thấy "Football Analytics" (shared infra, view+)

  {YELLOW}[Datasets] (4 datasets){RESET}
    admin  → thấy D1+D2+D3+D4  (full access, thấy hết)
    edit   → thấy D2(share edit)+D3(own)+D4(own)   ← KHÔNG thấy D1 (admin private)
    viewer → thấy D4(share view)                   ← KHÔNG thấy D1, D2, D3

  {YELLOW}[Workspaces] (2 workspaces){RESET}
    admin  → thấy W1+W2
    edit   → thấy W1(share edit)+W2(own)
    viewer → thấy W2(share view)   ← KHÔNG thấy W1

  {YELLOW}[Charts / Explore] (7 charts){RESET}
    admin  → thấy C1..C7  (full)
    edit   → thấy C2+C3(share edit)+C5+C6+C7(own)   5 charts, KHÔNG thấy C1, C4
    viewer → thấy C4+C6(share view)                  2 charts, KHÔNG thấy C1,C2,C3,C5,C7

  {YELLOW}[Dashboards] (6 dashboards){RESET}
    admin  → thấy DB1..DB6  (full)
    edit   → thấy DB2(share edit)+DB4(all team)+DB5(own)+DB6(own)   4 dashboards
    viewer → thấy DB3(share view)+DB4(all team)+DB6(share view)     3 dashboards

  {YELLOW}[Settings / Users]{RESET}
    admin  → vào được Settings, quản lý users & permissions
    edit   → KHÔNG vào được Settings (403)
    viewer → KHÔNG vào được Settings (403)
""")
