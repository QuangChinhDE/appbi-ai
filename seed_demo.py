#!/usr/bin/env python3
"""
seed_demo.py — Xoá dữ liệu cũ, tạo lại dữ liệu demo cho 3 tài khoản chính:

  admin@appbi.io   / 123456  → full toàn bộ module
  edit@appbi.io    / 123456  → view: data_sources; edit: workspaces/charts/dashboards/ai_chat; none: settings/user_management
  viewer@appbi.io  / 123456  → view: tất cả trừ settings/user_management (none)

Kịch bản phân quyền được tạo sẵn để test:
  [DS]  1 DataSource "Football Analytics"        — admin tạo  (mọi user view+ đều thấy)

  [W1]  Workspace "Rankings Workspace"          — admin tạo  | share → edit (edit)
  [W2]  Workspace "World Cup Workspace"         — edit  tạo  | share → viewer (view)

  [C1]  Chart "Điểm FIFA Top 20" (BAR)          — admin | dùng W1.T1 | KHÔNG share
  [C2]  Chart "Phân bố liên đoàn" (PIE)         — admin | dùng W1.T1 | share → edit (edit)
  [C3]  Chart "Top 10 Rankings" (TABLE)         — admin | dùng W1.T2 | share → edit (edit)
  [C4]  Chart "WC Titles by Country" (BAR)      — admin | dùng W2.T3 | share → viewer (view)
  [C5]  Chart "Top Scorers Bar" (BAR)           — edit  | dùng W2.T4 | KHÔNG share
  [C6]  Chart "Scorers by Country" (PIE)        — edit  | dùng W2.T4 | share → viewer (view)
  [C7]  Chart "WC History Table" (TABLE)        — edit  | dùng W2.T3 | KHÔNG share
  [C8]  Chart "Total Teams KPI" (KPI)           — admin | dùng W1.T1 | share → all team
  [C9]  Chart "Avg Points by Conf" (LINE)       — admin | dùng W1.T1 | share → all team

  [DB1] Dashboard "Admin Riêng"                 — admin | C1+C2+C8   | KHÔNG share → chỉ admin
  [DB2] Dashboard "Chia sẻ cho Edit"            — admin | C2+C3      | share → edit (edit) → admin+edit
  [DB3] Dashboard "Chia sẻ cho Viewer"          — admin | C3+C4      | share → viewer (view) → admin+viewer
  [DB4] Dashboard "Toàn Đội — Analytics"        — admin | C1+C4+C8+C9| share all team → tất cả
  [DB5] Dashboard "Edit Riêng"                  — edit  | C5+C6      | KHÔNG share → edit+admin(full)
  [DB6] Dashboard "Edit → Chia Viewer"          — edit  | C6+C7      | share → viewer (view) → edit+viewer+admin

Data sources (3 Excel sheets):
  fifa_world_rankings_jan_2026  → Rank, Country, Points, Confederation, World_Cup_Titles, Best_WC_Finish, Continental_Titles
  fifa_world_cup_history        → Rank, Country, Points, Confederation, World_Cup_Titles, Best_WC_Finish, Continental_Titles
  fifa_world_cup_top_scorers    → Year, Host, Player, Country, Goals
"""
import os, sys, uuid, warnings, shutil
warnings.filterwarnings("ignore")

# Detect backend path: ./backend/ locally, /app/ inside Docker container
_this_dir = os.path.dirname(os.path.abspath(__file__))
_backend_path = os.path.join(_this_dir, "backend")
if not os.path.isdir(_backend_path):
    _backend_path = "/app"          # Docker fallback (WORKDIR /app)
if _backend_path not in sys.path:
    sys.path.insert(0, _backend_path)

# DB / secret — use env vars; Docker default points at 'db' service
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://appbi:appbi@db:5432/appbi")
os.environ.setdefault("SECRET_KEY", "dev-secret-key-change-in-production")
os.environ.setdefault("DATA_DIR", "/app/.data")

from urllib.parse import urlparse
from sqlalchemy import text
from app.core.database import SessionLocal
from app.models.user import User, UserStatus
from app.models.models import (DataSource, Chart, Dashboard,
                                DashboardChart, ChartType, SyncJob)
from app.models.dataset_workspace import DatasetWorkspace, DatasetWorkspaceTable
from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.models.anomaly import MonitoredMetric
from app.api.auth import hash_password
from app.api.datasources import _parse_excel_bytes
import psycopg2

# XLSX next to this script — works locally and inside Docker (/app/)
XLSX_PATH = os.environ.get("XLSX_PATH", os.path.join(_this_dir, "scope-foodball-demo.xlsx"))

# Build psycopg2 DSN from DATABASE_URL (works in both Docker and local dev)
_db_url = os.environ["DATABASE_URL"]
_parsed = urlparse(_db_url.replace("postgresql+psycopg2://", "postgres://"))
DB_DSN = (
    f"dbname={_parsed.path.lstrip('/')} "
    f"user={_parsed.username} "
    f"password={_parsed.password} "
    f"host={_parsed.hostname}"
)

GREEN="\033[92m"; YELLOW="\033[93m"; RED="\033[91m"; BOLD="\033[1m"; RESET="\033[0m"
def ok(m):      print(f"  {GREEN}✓{RESET} {m}")
def info(m):    print(f"  {YELLOW}→{RESET} {m}")
def warn(m):    print(f"  {RED}!{RESET} {m}")
def section(t): print(f"\n{BOLD}{'─'*60}\n  {t}\n{'─'*60}{RESET}")

# ═══════════════════════════════════════════════════════════
#  BƯỚC 0 — XOÁ DỮ LIỆU CŨ
# ═══════════════════════════════════════════════════════════
section("0. Xoá dữ liệu cũ")
db = SessionLocal()
try:
    # Clear all app data tables (CASCADE handles FK dependencies)
    db.execute(text("""
        TRUNCATE TABLE
            anomaly_alerts, monitored_metrics,
            resource_embeddings,
            resource_shares, dashboard_charts, dashboards, charts,
            dataset_workspace_tables, dataset_workspaces,
            data_sources
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

# Also clear stale DuckDB Parquet files so there's no leftover from old datasource IDs
_data_dir = os.environ.get("DATA_DIR", "/app/.data")
_synced_dir = os.path.join(_data_dir, "synced")
if os.path.isdir(_synced_dir):
    shutil.rmtree(_synced_dir)
    info(f"Đã xoá Parquet cũ: {_synced_dir}")

# ═══════════════════════════════════════════════════════════
#  BƯỚC 1 — TẠO / CẬP NHẬT USERS
# ═══════════════════════════════════════════════════════════
section("1. Tạo / cập nhật users")

PERM_ADMIN  = dict(data_sources="full", workspaces="full",
                   explore_charts="full", dashboards="full",
                   ai_chat="full", user_management="full", settings="full")
PERM_EDIT   = dict(data_sources="view",  workspaces="edit",
                   explore_charts="edit", dashboards="edit",
                   ai_chat="edit",  user_management="none", settings="none")
PERM_VIEWER = dict(data_sources="view",  workspaces="view",
                   explore_charts="view", dashboards="view",
                   ai_chat="view",  user_management="none", settings="none")

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
    xlsx_bytes = f.read()
sheets = _parse_excel_bytes(xlsx_bytes)
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
    ok(f"DataSource id={DS_ID} (owner=admin, type=manual, sheets={len(sheets)})")
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 2.5 — SYNC DATASOURCE → DUCKDB PARQUET
#  Bắt buộc để AI agent tools (query_table, explore_data,
#  create_chart) hoạt động được. Nếu bỏ qua bước này tất cả
#  workspace table queries sẽ trả về NOT_SYNCED (422).
# ═══════════════════════════════════════════════════════════
section("2.5. Sync DataSource → DuckDB Parquet")

db = SessionLocal()
try:
    sync_job = SyncJob(
        data_source_id=DS_ID,
        status="running",
        mode="full_refresh",
    )
    db.add(sync_job); db.commit(); db.refresh(sync_job)
    JOB_ID = sync_job.id
    info(f"SyncJob id={JOB_ID} created")
finally:
    db.close()

# Run synchronously (join thread so next steps have Parquet ready)
from app.services.sync_engine import trigger_sync
info("Đang sync dữ liệu sang Parquet/DuckDB...")
_sync_thread = trigger_sync(DS_ID, JOB_ID)
_sync_thread.join(timeout=180)

db = SessionLocal()
try:
    job_result = db.query(SyncJob).filter(SyncJob.id == JOB_ID).first()
    if job_result and job_result.status == "success":
        ok(f"DuckDB sync xong: {job_result.rows_synced} rows, {len(sheets)} sheets → Parquet views sẵn sàng")
    else:
        err_msg = job_result.error_message if job_result else "unknown"
        warn(f"DuckDB sync thất bại: {err_msg}")
        warn("AI agent tools sẽ không hoạt động cho đến khi sync thành công!")
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 3 — TẠO WORKSPACES & TABLES
# ═══════════════════════════════════════════════════════════
section("3. Tạo Workspaces & Workspace Tables")

# fifa_world_rankings_jan_2026 và fifa_world_cup_history cùng schema
_rankings_cols = [
    {"name": "Rank",               "type": "integer", "nullable": True},
    {"name": "Country",            "type": "string",  "nullable": True},
    {"name": "Points",             "type": "float",   "nullable": True},
    {"name": "Confederation",      "type": "string",  "nullable": True},
    {"name": "World_Cup_Titles",   "type": "integer", "nullable": True},
    {"name": "Best_WC_Finish",     "type": "string",  "nullable": True},
    {"name": "Continental_Titles", "type": "integer", "nullable": True},
]
_scorers_cols = [
    {"name": "Year",    "type": "integer", "nullable": True},
    {"name": "Host",    "type": "string",  "nullable": True},
    {"name": "Player",  "type": "string",  "nullable": True},
    {"name": "Country", "type": "string",  "nullable": True},
    {"name": "Goals",   "type": "integer", "nullable": True},
]

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
        columns_cache=_rankings_cols,
    )
    t2 = DatasetWorkspaceTable(
        workspace_id=w1.id, datasource_id=DS_ID, source_kind="sql_query",
        source_query=(
            'SELECT "Rank","Country","Confederation","Points" '
            'FROM fifa_world_rankings_jan_2026 ORDER BY "Rank" LIMIT 10'
        ),
        display_name="Top 10 Rankings", enabled=True, transformations=[],
        columns_cache=[
            {"name": "Rank",          "type": "integer", "nullable": True},
            {"name": "Country",       "type": "string",  "nullable": True},
            {"name": "Confederation", "type": "string",  "nullable": True},
            {"name": "Points",        "type": "float",   "nullable": True},
        ],
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
    # T3: fifa_world_cup_history — cùng schema với rankings (Country, Points, World_Cup_Titles...)
    t3 = DatasetWorkspaceTable(
        workspace_id=w2.id, datasource_id=DS_ID, source_kind="sql_query",
        source_query='SELECT * FROM fifa_world_cup_history',
        display_name="WC History", enabled=True, transformations=[],
        columns_cache=_rankings_cols,   # same schema as rankings sheet
    )
    t4 = DatasetWorkspaceTable(
        workspace_id=w2.id, datasource_id=DS_ID, source_kind="sql_query",
        source_query='SELECT * FROM fifa_world_cup_top_scorers',
        display_name="Top Scorers", enabled=True, transformations=[],
        columns_cache=_scorers_cols,
    )
    db.add_all([t3, t4]); db.flush()
    W2_ID, T3_ID, T4_ID = w2.id, t3.id, t4.id
    ok(f"W2 id={W2_ID} (owner=edit)   → T3={T3_ID} WC History     | T4={T4_ID} Top Scorers")
    db.commit()
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 4 — TẠO CHARTS
# ═══════════════════════════════════════════════════════════
section("4. Tạo Charts")

def bar_cfg(ws_id, dim, metric, agg="sum"):
    return {"workspace_id": ws_id, "chartType": "BAR",
            "roleConfig": {"dimension": dim,
                           "metrics": [{"field": metric, "agg": agg}],
                           "breakdown": None, "sort": None, "limit": 20},
            "filters": []}

def pie_cfg(ws_id, dim, metric, agg="count"):
    return {"workspace_id": ws_id, "chartType": "PIE",
            "roleConfig": {"dimension": dim,
                           "metrics": [{"field": metric, "agg": agg}]},
            "filters": []}

def table_cfg(ws_id):
    return {"workspace_id": ws_id, "chartType": "TABLE",
            "roleConfig": {"columns": [], "sort": None, "limit": 50},
            "filters": []}

def kpi_cfg(ws_id, metric, agg="count"):
    """KPI chart: aggregate a single metric across all rows."""
    return {"workspace_id": ws_id, "chartType": "KPI",
            "roleConfig": {"dimension": None,
                           "metrics": [{"field": metric, "agg": agg}]},
            "filters": []}

def line_cfg(ws_id, dim, metric, agg="avg"):
    """LINE chart: metric (Y) over a dimension (X) — ideal for ordered/categorical X."""
    return {"workspace_id": ws_id, "chartType": "LINE",
            "roleConfig": {"dimension": dim,
                           "metrics": [{"field": metric, "agg": agg}],
                           "breakdown": None, "sort": None, "limit": 50},
            "filters": []}

db = SessionLocal()
try:
    charts_spec = [
        # (name, description, workspace_table_id, ChartType, config, owner_email)
        # ── Rankings charts (W1) ──────────────────────────────────────────────
        ("Điểm FIFA Top 20",
         "BAR: Top 20 quốc gia theo điểm FIFA — admin",
         T1_ID, ChartType.BAR,
         bar_cfg(W1_ID, "Country", "Points"),
         "admin@appbi.io"),

        ("Phân bố liên đoàn",
         "PIE: Số đội theo confederation — admin",
         T1_ID, ChartType.PIE,
         pie_cfg(W1_ID, "Confederation", "Rank"),
         "admin@appbi.io"),

        ("Top 10 Rankings",
         "TABLE: Bảng top 10 — admin",
         T2_ID, ChartType.TABLE,
         table_cfg(W1_ID),
         "admin@appbi.io"),

        # ── World Cup charts (W2) ─────────────────────────────────────────────
        ("WC Titles by Country",
         "BAR: Số lần vô địch World Cup theo quốc gia — admin",
         T3_ID, ChartType.BAR,
         bar_cfg(W2_ID, "Country", "World_Cup_Titles", "sum"),
         "admin@appbi.io"),

        ("Top Scorers Bar",
         "BAR: Số bàn thắng WC theo cầu thủ — edit",
         T4_ID, ChartType.BAR,
         bar_cfg(W2_ID, "Player", "Goals"),
         "edit@appbi.io"),

        ("Scorers by Country",
         "PIE: Số bàn theo quốc gia (top scorers) — edit",
         T4_ID, ChartType.PIE,
         pie_cfg(W2_ID, "Country", "Goals", "sum"),
         "edit@appbi.io"),

        ("WC History Table",
         "TABLE: Bảng lịch sử World Cup — edit",
         T3_ID, ChartType.TABLE,
         table_cfg(W2_ID),
         "edit@appbi.io"),

        # ── New chart types (W1) — shared with all team ───────────────────────
        ("Total Teams KPI",
         "KPI: Tổng số quốc gia trong bảng xếp hạng — admin",
         T1_ID, ChartType.KPI,
         kpi_cfg(W1_ID, "Country", "count"),
         "admin@appbi.io"),

        ("Avg Points by Confederation",
         "LINE: Điểm trung bình theo liên đoàn — admin",
         T1_ID, ChartType.LINE,
         line_cfg(W1_ID, "Confederation", "Points", "avg"),
         "admin@appbi.io"),
    ]
    chart_ids = []
    for name, desc, wt_id, ct, cfg, owner_email in charts_spec:
        c = Chart(name=name, description=desc, workspace_table_id=wt_id,
                  chart_type=ct, config=cfg, owner_id=uids[owner_email])
        db.add(c); db.flush()
        chart_ids.append(c.id)
        ok(f"C{len(chart_ids)}={c.id:3d} [{ct.value:12s}] '{name}' "
           f"(owner={'admin' if 'admin' in owner_email else 'edit'})")
    db.commit()
    C1, C2, C3, C4, C5, C6, C7, C8, C9 = chart_ids
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 5 — TẠO DASHBOARDS
# ═══════════════════════════════════════════════════════════
section("5. Tạo Dashboards")

db = SessionLocal()
try:
    # Layout helper: (chart_id, x, y, w, h)
    dashboards_spec = [
        ("Admin Riêng",
         "Private — chỉ admin thấy (BAR + PIE + KPI)",
         "admin@appbi.io",
         [(C1, 0, 0, 6, 4), (C2, 6, 0, 6, 4), (C8, 0, 4, 4, 2)]),

        ("Chia sẻ cho Edit",
         "Admin share cho edit@ (edit perm) — admin+edit thấy",
         "admin@appbi.io",
         [(C2, 0, 0, 6, 4), (C3, 6, 0, 6, 4)]),

        ("Chia sẻ cho Viewer",
         "Admin share cho viewer@ (view) — admin+viewer thấy",
         "admin@appbi.io",
         [(C3, 0, 0, 6, 4), (C4, 6, 0, 6, 4)]),

        ("Toàn Đội — Analytics",
         "Admin share toàn đội — mọi người thấy (BAR + BAR + KPI + LINE)",
         "admin@appbi.io",
         [(C1, 0, 0, 6, 4), (C4, 6, 0, 6, 4),
          (C8, 0, 4, 4, 2), (C9, 4, 4, 8, 4)]),

        ("Edit Riêng",
         "edit tạo, private — edit+admin(full) thấy",
         "edit@appbi.io",
         [(C5, 0, 0, 6, 4), (C6, 6, 0, 6, 4)]),

        ("Edit → Chia Viewer",
         "Edit share cho viewer@ (view) — edit+viewer+admin",
         "edit@appbi.io",
         [(C6, 0, 0, 6, 4), (C7, 6, 0, 6, 4)]),
    ]
    dash_ids = []
    for name, desc, owner_email, charts_layout in dashboards_spec:
        d = Dashboard(name=name, description=desc,
                      owner_id=uids[owner_email], filters_config=[])
        db.add(d); db.flush()
        for cid, x, y, w, h in charts_layout:
            db.add(DashboardChart(
                dashboard_id=d.id, chart_id=cid,
                layout={"x": x, "y": y, "w": w, "h": h},
                parameters={},
            ))
        db.flush()
        dash_ids.append(d.id)
        n_charts = len(charts_layout)
        ok(f"DB{len(dash_ids)}={d.id} '{name}' "
           f"({n_charts} charts, owner={'admin' if 'admin' in owner_email else 'edit'})")
    db.commit()
    DB1, DB2, DB3, DB4, DB5, DB6 = dash_ids
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 6 — TẠO RESOURCE SHARES
# ═══════════════════════════════════════════════════════════
section("6. Tạo Resource Shares")

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

    # Workspaces
    share("workspace", W1_ID, E, "edit", A);   ok(f"Workspace W1={W1_ID}: admin → edit  (edit)")
    share("workspace", W2_ID, V, "view", E);   ok(f"Workspace W2={W2_ID}: edit  → viewer (view)")

    # Charts (individual)
    share("chart", C2, E, "edit", A);           ok(f"Chart C2={C2}: admin → edit (edit)")
    share("chart", C3, E, "edit", A);           ok(f"Chart C3={C3}: admin → edit (edit)")
    share("chart", C4, V, "view", A);           ok(f"Chart C4={C4}: admin → viewer (view)")
    share("chart", C6, V, "view", E);           ok(f"Chart C6={C6}: edit  → viewer (view)")

    # C8 (KPI) and C9 (LINE) — shared with everyone for "Toàn Đội" dashboard
    share("chart", C8, E, "view", A);           ok(f"Chart C8={C8}: admin → edit (view) [all team]")
    share("chart", C8, V, "view", A);           ok(f"Chart C8={C8}: admin → viewer (view) [all team]")
    share("chart", C9, E, "view", A);           ok(f"Chart C9={C9}: admin → edit (view) [all team]")
    share("chart", C9, V, "view", A);           ok(f"Chart C9={C9}: admin → viewer (view) [all team]")

    # Dashboards
    share("dashboard", DB2, E, "edit", A);      ok(f"Dashboard DB2={DB2}: admin → edit (edit)")
    share("dashboard", DB3, V, "view", A);      ok(f"Dashboard DB3={DB3}: admin → viewer (view)")
    share("dashboard", DB4, E, "view", A);      ok(f"Dashboard DB4={DB4}: admin → edit (view) [all team]")
    share("dashboard", DB4, V, "view", A);      ok(f"Dashboard DB4={DB4}: admin → viewer (view) [all team]")
    share("dashboard", DB6, V, "view", E);      ok(f"Dashboard DB6={DB6}: edit  → viewer (view)")

    conn.commit()
finally:
    conn.close()

# ═══════════════════════════════════════════════════════════
#  BƯỚC 6.5 — TẠO MONITORED METRICS (Phase 4 — Proactive Intelligence)
#  Demo dữ liệu cho anomaly detection. Admin theo dõi điểm FIFA.
# ═══════════════════════════════════════════════════════════
section("6.5. Tạo MonitoredMetrics (Phase 4 demo)")

db = SessionLocal()
try:
    metrics_spec = [
        # (workspace_table_id, metric_column, aggregation, time_column, dimension_columns, threshold)
        # Theo dõi điểm FIFA trung bình — không có time col nên chạy theo snapshot
        (T1_ID, "Points", "avg", None, ["Confederation"], 2.0),
        # Theo dõi tổng số bàn thắng theo năm WC
        (T4_ID, "Goals", "sum", "Year", ["Country"], 2.0),
    ]
    metric_ids = []
    for wt_id, metric_col, agg, time_col, dim_cols, threshold in metrics_spec:
        m = MonitoredMetric(
            workspace_table_id=wt_id,
            metric_column=metric_col,
            aggregation=agg,
            time_column=time_col,
            dimension_columns=dim_cols,
            check_frequency="daily",
            threshold_z_score=threshold,
            is_active=True,
            owner_id=uids["admin@appbi.io"],
        )
        db.add(m); db.flush()
        metric_ids.append(m.id)
        ok(f"MonitoredMetric id={m.id}: {agg}({metric_col}) "
           f"[time={time_col or 'none'}, dims={dim_cols}, z≥{threshold}]")
    db.commit()
finally:
    db.close()

# ═══════════════════════════════════════════════════════════
#  TỔNG KẾT
# ═══════════════════════════════════════════════════════════
section("✅  HOÀN THÀNH")
print(f"""
{BOLD}Tài khoản:{RESET}
  admin@appbi.io   / 123456   (full access)
  edit@appbi.io    / 123456   (edit charts/dash/datasets/ws, view source, no settings)
  viewer@appbi.io  / 123456   (view only, no settings)

{BOLD}DataSource:{RESET}
  "Football Analytics" (type=manual, 3 sheets)
  └── DuckDB Parquet sync: {len(sheets)} sheets → synced_ds{DS_ID}__manual__*

{BOLD}Workspaces & Tables:{RESET}
  W1 "Rankings Workspace" (admin)
    T1 Rankings Full   → SELECT * FROM fifa_world_rankings_jan_2026
    T2 Top 10 Rankings → SELECT Rank,Country,Confederation,Points ... LIMIT 10
  W2 "World Cup Workspace" (edit)
    T3 WC History      → SELECT * FROM fifa_world_cup_history
    T4 Top Scorers     → SELECT * FROM fifa_world_cup_top_scorers

{BOLD}Charts (9 charts, 5 loại):{RESET}
  C1  [BAR]   Điểm FIFA Top 20           (admin, T1)
  C2  [PIE]   Phân bố liên đoàn          (admin, T1) → share edit
  C3  [TABLE] Top 10 Rankings            (admin, T2) → share edit
  C4  [BAR]   WC Titles by Country       (admin, T3) → share viewer
  C5  [BAR]   Top Scorers Bar            (edit,  T4)
  C6  [PIE]   Scorers by Country         (edit,  T4) → share viewer
  C7  [TABLE] WC History Table           (edit,  T3)
  C8  [KPI]   Total Teams KPI            (admin, T1) → share all team
  C9  [LINE]  Avg Points by Confederation (admin, T1) → share all team

{BOLD}Dashboards (6):{RESET}
  DB1 "Admin Riêng"            (admin) — C1+C2+C8        private
  DB2 "Chia sẻ cho Edit"       (admin) — C2+C3            → edit
  DB3 "Chia sẻ cho Viewer"     (admin) — C3+C4            → viewer
  DB4 "Toàn Đội — Analytics"   (admin) — C1+C4+C8+C9     → tất cả
  DB5 "Edit Riêng"             (edit)  — C5+C6            private
  DB6 "Edit → Chia Viewer"     (edit)  — C6+C7            → viewer

{BOLD}Kịch bản phân quyền để test:{RESET}

  {YELLOW}[Data Sources]{RESET}
    → Tất cả 3 user đều thấy "Football Analytics" (type=manual)

  {YELLOW}[Workspaces] (2 workspaces){RESET}
    admin  → thấy W1+W2
    edit   → thấy W1(share edit)+W2(own)
    viewer → thấy W2(share view)   ← KHÔNG thấy W1

  {YELLOW}[Charts / Explore] (9 charts){RESET}
    admin  → thấy C1..C9  (full)
    edit   → C2+C3(share edit)+C5+C6+C7(own)+C8+C9(share view)   7 charts
    viewer → C4+C6(share view)+C8+C9(share view)                  4 charts

  {YELLOW}[Dashboards] (6 dashboards){RESET}
    admin  → thấy DB1..DB6  (full)
    edit   → DB2(share edit)+DB4(all)+DB5(own)+DB6(own)   4 dashboards
    viewer → DB3(share view)+DB4(all)+DB6(share view)     3 dashboards

  {YELLOW}[AI Chat — query_table / explore_data / create_chart]{RESET}
    → DuckDB Parquet đã sync: các tool này hoạt động đầy đủ
    → Thử: "Top 10 đội có điểm FIFA cao nhất?"
    → Thử: "Tạo biểu đồ điểm theo confederation"
    → Thử: "Build me a dashboard about World Cup"

  {YELLOW}[Phase 4 — Anomaly Detection]{RESET}
    → 2 MonitoredMetrics đã tạo cho admin
    → POST /api/v1/anomaly/scan để chạy manual scan
    → GET  /api/v1/anomaly/alerts để xem alerts

  {YELLOW}[Settings / Users]{RESET}
    admin  → vào được Settings, quản lý users & permissions
    edit   → KHÔNG vào được Settings (403)
    viewer → KHÔNG vào được Settings (403)
""")
