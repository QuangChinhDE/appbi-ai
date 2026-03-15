"""
Demo seed script — full end-to-end data flow:

  1. Upload scope-foodball-demo.xlsx → create Manual datasource
  2. Create Datasets (with rich transformation pipelines)
  3. Create Dataset Workspaces + SQL-query workspace tables
  4. Create Charts in Explore (mix of dataset_id and workspace_table_id)
  5. Create Dashboards (with filters_config pre-applied)

Usage:
    python seed_demo.py
"""
import os, sys, requests
import psycopg2

BASE      = "http://localhost:8000/api/v1"
XLSX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scope-foodball-demo.xlsx")
DB_URL    = "postgresql://postgres:postgres@localhost:5432/appbi_metadata"

# ─── truncate all tables and reset sequences ──────────────────────────────────

def reset_db():
    print("0. Truncating tables & resetting ID sequences ...")
    tables = [
        "dashboard_charts",
        "dashboards",
        "charts",
        "dataset_workspace_tables",
        "dataset_workspaces",
        "datasets",
        "data_sources",
    ]
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    cur = conn.cursor()
    for tbl in tables:
        try:
            cur.execute(f'TRUNCATE TABLE "{tbl}" RESTART IDENTITY CASCADE;')
            print(f"  + TRUNCATE {tbl}")
        except Exception as e:
            print(f"  ! {tbl}: {e}")
    cur.close()
    conn.close()
    print("  -> Done\n")

reset_db()

# ─── helpers ──────────────────────────────────────────────────────────────────

def post(path, body):
    r = requests.post(f"{BASE}{path}", json=body, timeout=30)
    if not r.ok:
        print(f"  ERROR {r.status_code} POST {path}: {r.text[:500]}")
        sys.exit(1)
    return r.json()

def put(path, body):
    r = requests.put(f"{BASE}{path}", json=body, timeout=30)
    if not r.ok:
        print(f"  ERROR {r.status_code} PUT {path}: {r.text[:300]}")
        sys.exit(1)
    return r.json()

def get(path):
    r = requests.get(f"{BASE}{path}", timeout=15)
    r.raise_for_status()
    return r.json()

def explore_config(workspace_id, chart_type, dimension, metrics, breakdown=None, filters=None):
    rc = {"dimension": dimension, "metrics": metrics}
    if breakdown:
        rc["breakdown"] = breakdown
    return {"workspace_id": workspace_id, "chartType": chart_type, "roleConfig": rc, "filters": filters or []}

def make_dashboard(name, description, chart_list, filters_config=None):
    """chart_list = [(chart_id, x, y, w, h), ...]"""
    dash = post("/dashboards/", {
        "name": name,
        "description": description,
        "charts": [],
        "filters_config": filters_config or [],
    })
    did = dash["id"]
    for chart_id, x, y, w, h in chart_list:
        post(f"/dashboards/{did}/charts", {
            "chart_id": chart_id,
            "layout": {"x": x, "y": y, "w": w, "h": h},
        })
    return did


# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 — Parse xlsx and create Manual datasource
# ══════════════════════════════════════════════════════════════════════════════
print("1. Uploading scope-foodball-demo.xlsx ...")
if not os.path.exists(XLSX_PATH):
    print(f"  x File not found: {XLSX_PATH}")
    sys.exit(1)

with open(XLSX_PATH, "rb") as fh:
    parse_resp = requests.post(
        f"{BASE}/datasources/manual/parse-file",
        files={"file": ("scope-foodball-demo.xlsx", fh,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        timeout=30,
    )
if not parse_resp.ok:
    print(f"  x Parse failed {parse_resp.status_code}: {parse_resp.text[:300]}")
    sys.exit(1)

parsed     = parse_resp.json()
sheets     = parsed["sheets"]
sheet_names = list(sheets.keys())
print(f"  + Parsed {len(sheet_names)} sheets: {sheet_names}")

ds = post("/datasources/", {
    "name": "Football Demo",
    "type": "manual",
    "description": "Du lieu bong da FIFA tu file scope-foodball-demo.xlsx (3 sheets)",
    "config": {"sheets": sheets},
})
DS_ID = ds["id"]
print(f"  + Datasource created  id={DS_ID}")


# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 — Datasets (base SQL + rich transformation pipelines)
# ══════════════════════════════════════════════════════════════════════════════
print("\n2. Creating datasets with transformations ...")
datasets = {}

# ── 2a. Raw World Rankings (base — no transforms) ────────────────────────────
d = post("/datasets/", {
    "name": "FIFA World Rankings (Jan 2026)",
    "description": "Bang xep hang FIFA thang 1/2026 — day du, khong loc",
    "data_source_id": DS_ID,
    "sql_query": "SELECT * FROM fifa_world_rankings_jan_2026",
    "transformations": [],
    "transformation_version": 2,
})
datasets["rankings"] = d["id"]
print(f"  + Rankings (raw)  id={d['id']}")

# ── 2b. Rankings — add_column + filter_rows + sort ───────────────────────────
# Demonstrates: add_column (CASE expression), filter_rows, sort
d = post("/datasets/", {
    "name": "Rankings — Performance Tier & Elite Filter",
    "description": "Them cot Performance_Tier bang CASE WHEN, loc lay Elite+Strong, sap xep giam dan",
    "data_source_id": DS_ID,
    "sql_query": "SELECT * FROM fifa_world_rankings_jan_2026",
    "transformation_version": 2,
    "transformations": [
        {
            "id": "step_add_tier",
            "type": "add_column",
            "enabled": True,
            "params": {
                "newField": "Performance_Tier",
                "expression": (
                    "CASE WHEN Points > 1800 THEN 'Elite' "
                    "WHEN Points > 1700 THEN 'Strong' "
                    "WHEN Points > 1600 THEN 'Solid' "
                    "ELSE 'Average' END"
                ),
            },
        },
        {
            "id": "step_filter_elite",
            "type": "filter_rows",
            "enabled": True,
            "params": {
                "conditions": [
                    {"field": "Performance_Tier", "operator": "in",
                     "value": ["Elite", "Strong"]},
                ],
                "logic": "AND",
            },
        },
        {
            "id": "step_sort",
            "type": "sort",
            "enabled": True,
            "params": {"by": [{"field": "Points", "direction": "desc"}]},
        },
    ],
})
datasets["rankings_elite"] = d["id"]
print(f"  + Rankings Elite+Strong (add_column+filter+sort)  id={d['id']}")

# ── 2c. Rankings — group_by ───────────────────────────────────────────────────
# Demonstrates: group_by with multiple aggregations
d = post("/datasets/", {
    "name": "Rankings by Confederation (Aggregated)",
    "description": "Nhom theo lien doan — dem quoc gia, TB diem, tong WC titles, max continental titles",
    "data_source_id": DS_ID,
    "sql_query": "SELECT * FROM fifa_world_rankings_jan_2026",
    "transformation_version": 2,
    "transformations": [
        {
            "id": "step_group",
            "type": "group_by",
            "enabled": True,
            "params": {
                "by": ["Confederation"],
                "aggregations": [
                    {"field": "*",                  "agg": "count",  "as": "num_countries"},
                    {"field": "Points",             "agg": "avg",    "as": "avg_points"},
                    {"field": "World_Cup_Titles",   "agg": "sum",    "as": "total_wc_titles"},
                    {"field": "Continental_Titles", "agg": "max",    "as": "max_continental"},
                ],
            },
        },
        {
            "id": "step_sort_conf",
            "type": "sort",
            "enabled": True,
            "params": {"by": [{"field": "avg_points", "direction": "desc"}]},
        },
    ],
})
datasets["by_confederation"] = d["id"]
print(f"  + By Confederation (group_by+sort)  id={d['id']}")

# ── 2d. Rankings — duplicate_column + merge_columns ──────────────────────────
d = post("/datasets/", {
    "name": "Rankings — Country & Confederation Label",
    "description": "Nhan doi cot, gop cot Country+Confederation thanh 1 nhan hien thi",
    "data_source_id": DS_ID,
    "sql_query": "SELECT Rank, Country, Confederation, Points, World_Cup_Titles FROM fifa_world_rankings_jan_2026",
    "transformation_version": 2,
    "transformations": [
        {
            "id": "step_dup",
            "type": "duplicate_column",
            "enabled": True,
            "params": {"field": "Country", "newField": "Country_Copy"},
        },
        {
            "id": "step_merge",
            "type": "merge_columns",
            "enabled": True,
            "params": {
                "fields": ["Country", "Confederation"],
                "separator": " / ",
                "newField": "Country_Conf_Label",
            },
        },
        {
            "id": "step_limit",
            "type": "limit",
            "enabled": True,
            "params": {"count": 20},
        },
    ],
})
datasets["label_merged"] = d["id"]
print(f"  + Label Merged (duplicate+merge+limit)  id={d['id']}")

# ── 2e. WC History — filter_rows + group_by ──────────────────────────────────
d = post("/datasets/", {
    "name": "WC Champions — Multi-Title Countries",
    "description": "Loc cac quoc gia co >= 2 chuc vo dich WC, nhom theo lien doan",
    "data_source_id": DS_ID,
    "sql_query": "SELECT * FROM fifa_world_cup_history",
    "transformation_version": 2,
    "transformations": [
        {
            "id": "step_filter_multi",
            "type": "filter_rows",
            "enabled": True,
            "params": {
                "conditions": [
                    {"field": "World_Cup_Titles", "operator": "gte", "value": 2}
                ],
                "logic": "AND",
            },
        },
        {
            "id": "step_sort_wc",
            "type": "sort",
            "enabled": True,
            "params": {"by": [{"field": "World_Cup_Titles", "direction": "desc"}]},
        },
    ],
})
datasets["wc_multi"] = d["id"]
print(f"  + WC Multi-Title (filter+sort)  id={d['id']}")

# ── 2f. Top Scorers — fill_null + add_column ─────────────────────────────────
d = post("/datasets/", {
    "name": "Top Scorers — Enriched",
    "description": "Them cot Goal_Era bang CASE, fill NULL trong cot Player neu co",
    "data_source_id": DS_ID,
    "sql_query": "SELECT * FROM fifa_world_cup_top_scorers",
    "transformation_version": 2,
    "transformations": [
        {
            "id": "step_fill_player",
            "type": "fill_null",
            "enabled": True,
            "params": {"field": "Player", "value": "Unknown"},
        },
        {
            "id": "step_add_era",
            "type": "add_column",
            "enabled": True,
            "params": {
                "newField": "Goal_Era",
                "expression": (
                    "CASE WHEN Year < 1970 THEN 'Classic (pre-1970)' "
                    "WHEN Year < 1994 THEN 'Modern (1970-1993)' "
                    "ELSE 'Contemporary (1994+)' END"
                ),
            },
        },
    ],
})
datasets["scorers_enriched"] = d["id"]
print(f"  + Scorers Enriched (fill_null+add_column)  id={d['id']}")

print(f"\n  -> {len(datasets)} datasets created")


# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 — Dataset Workspaces + Tables (SQL-query, uses DuckDB on manual DS)
# ══════════════════════════════════════════════════════════════════════════════
print("\n3. Creating dataset workspaces ...")

def add_table(workspace_id, display_name, sql_query):
    return post(f"/dataset-workspaces/{workspace_id}/tables", {
        "datasource_id": DS_ID,
        "source_kind": "sql_query",
        "source_query": sql_query,
        "display_name": display_name,
        "enabled": True,
        "transformations": [],
    })

# ── Workspace 1: FIFA World Rankings ─────────────────────────────────────────
ws1 = post("/dataset-workspaces/", {
    "name": "FIFA World Rankings",
    "description": "Bang xep hang FIFA thang 1/2026 — day du, top 10, phan tich lien doan",
})
WS1 = ws1["id"]

t_full      = add_table(WS1, "Full Rankings",
    "SELECT * FROM fifa_world_rankings_jan_2026 ORDER BY Rank")
t_top10     = add_table(WS1, "Top 10 Rankings",
    "SELECT * FROM fifa_world_rankings_jan_2026 WHERE Rank <= 10 ORDER BY Rank")
t_conf_agg  = add_table(WS1, "Summary by Confederation",
    "SELECT Confederation, COUNT(*) AS num_countries, "
    "ROUND(AVG(Points), 1) AS avg_points, "
    "SUM(World_Cup_Titles) AS total_wc_titles, "
    "SUM(Continental_Titles) AS total_continental "
    "FROM fifa_world_rankings_jan_2026 "
    "GROUP BY Confederation ORDER BY avg_points DESC")
T_FULL     = t_full["id"]
T_TOP10    = t_top10["id"]
T_CONF_AGG = t_conf_agg["id"]
print(f"  + Workspace 1 'FIFA World Rankings'  id={WS1}  tables: {T_FULL}, {T_TOP10}, {T_CONF_AGG}")

# ── Workspace 2: World Cup Analysis ──────────────────────────────────────────
ws2 = post("/dataset-workspaces/", {
    "name": "World Cup Analysis",
    "description": "Lich su va phan tich World Cup tu 1930 den 2022",
})
WS2 = ws2["id"]

t_history   = add_table(WS2, "WC Champions History",
    "SELECT * FROM fifa_world_cup_history ORDER BY World_Cup_Titles DESC")
t_scorers   = add_table(WS2, "Top Scorers by Year",
    "SELECT * FROM fifa_world_cup_top_scorers ORDER BY Year DESC")
t_wc_conf   = add_table(WS2, "WC Titles by Confederation",
    "SELECT Confederation, "
    "SUM(World_Cup_Titles) AS total_wc_titles, "
    "COUNT(*) AS num_countries "
    "FROM fifa_world_cup_history "
    "GROUP BY Confederation ORDER BY total_wc_titles DESC")
T_HISTORY  = t_history["id"]
T_SCORERS  = t_scorers["id"]
T_WC_CONF  = t_wc_conf["id"]
print(f"  + Workspace 2 'World Cup Analysis'  id={WS2}  tables: {T_HISTORY}, {T_SCORERS}, {T_WC_CONF}")

# ── Workspace 3: Football Analytics Hub ──────────────────────────────────────
ws3 = post("/dataset-workspaces/", {
    "name": "Football Analytics Hub",
    "description": "Phan tich nang cao — phan tang suc manh, so sanh da chieu, cross-sheet",
})
WS3 = ws3["id"]

t_tiers     = add_table(WS3, "Country Performance Tiers",
    "SELECT Country, Points, World_Cup_Titles, Continental_Titles, "
    "CASE WHEN Points > 1800 THEN 'Elite' "
    "WHEN Points > 1700 THEN 'Strong' "
    "WHEN Points > 1600 THEN 'Solid' "
    "ELSE 'Average' END AS Performance_Tier "
    "FROM fifa_world_rankings_jan_2026 ORDER BY Points DESC")
t_titles_cmp = add_table(WS3, "WC vs Continental Titles (Top 10)",
    "SELECT Country, World_Cup_Titles, Continental_Titles, "
    "World_Cup_Titles + Continental_Titles AS Total_Titles "
    "FROM fifa_world_rankings_jan_2026 WHERE Rank <= 10 ORDER BY Total_Titles DESC")
t_cross     = add_table(WS3, "Cross-Sheet: Rankings + History",
    "SELECT r.Rank, r.Country, r.Points, r.Confederation, "
    "COALESCE(h.World_Cup_Titles, 0) AS WC_Titles_History "
    "FROM fifa_world_rankings_jan_2026 r "
    "LEFT JOIN fifa_world_cup_history h ON r.Country = h.Country "
    "ORDER BY r.Rank LIMIT 15")
T_TIERS      = t_tiers["id"]
T_TITLES_CMP = t_titles_cmp["id"]
T_CROSS      = t_cross["id"]
print(f"  + Workspace 3 'Football Analytics Hub'  id={WS3}  tables: {T_TIERS}, {T_TITLES_CMP}, {T_CROSS}")


# ══════════════════════════════════════════════════════════════════════════════
# STEP 4 — Charts (all via workspace_table_id so Explore editor loads correctly)
# ══════════════════════════════════════════════════════════════════════════════
print("\n4. Creating charts ...")
charts = {}

def ws_chart(name, description, workspace_id, table_id, chart_type, dimension, metrics,
             breakdown=None, filters=None):
    return post("/charts/", {
        "name": name,
        "description": description,
        "workspace_table_id": table_id,
        "chart_type": chart_type,
        "config": explore_config(workspace_id, chart_type, dimension, metrics,
                                  breakdown=breakdown, filters=filters),
    })

# ── WS1: FIFA World Rankings ──────────────────────────────────────────────────
c = ws_chart("Total Countries in Rankings",
    "Tong so quoc gia xep hang FIFA thang 1/2026",
    WS1, T_FULL, "KPI",
    "dummy",
    [{"field": "Rank", "agg": "count"}])
charts["kpi_total"] = c["id"]
print(f"  + KPI Total Nations  id={c['id']}")

c = ws_chart("Full FIFA Rankings — TABLE",
    "Bang xep hang day du — tat ca cac truong",
    WS1, T_FULL, "TABLE",
    "Country",
    [{"field": "Points", "agg": "sum"}, {"field": "Rank", "agg": "sum"}])
charts["table_rankings"] = c["id"]
print(f"  + TABLE Full Rankings  id={c['id']}")

c = ws_chart("Top 10 Points — BAR",
    "Diem FIFA top 10 quoc gia xep hang cao nhat",
    WS1, T_TOP10, "BAR",
    "Country",
    [{"field": "Points", "agg": "sum"}])
charts["bar_top10_pts"] = c["id"]
print(f"  + BAR Top 10 Points  id={c['id']}")

c = ws_chart("WC Champions in Top 10 — PIE",
    "Phan bo chuc vo dich WC trong top 10 quoc gia hang dau",
    WS1, T_TOP10, "PIE",
    "Confederation",
    [{"field": "Country", "agg": "count"}])
charts["pie_top10_conf"] = c["id"]
print(f"  + PIE Top 10 Confederation  id={c['id']}")

c = ws_chart("Countries per Confederation — PIE",
    "Phan bo so quoc gia trong tung lien doan FIFA",
    WS1, T_CONF_AGG, "PIE",
    "Confederation",
    [{"field": "num_countries", "agg": "sum"}])
charts["pie_confederation"] = c["id"]
print(f"  + PIE Confederation Distribution  id={c['id']}")

c = ws_chart("Avg FIFA Points by Confederation — BAR",
    "Diem FIFA trung binh moi lien doan (GROUP BY workspace table)",
    WS1, T_CONF_AGG, "BAR",
    "Confederation",
    [{"field": "avg_points", "agg": "sum"}])
charts["bar_avg_pts_conf"] = c["id"]
print(f"  + BAR Avg Points by Confederation  id={c['id']}")

# ── WS2: World Cup Analysis ────────────────────────────────────────────────────
c = ws_chart("WC Titles by Country — BAR",
    "So chuc vo dich World Cup theo quoc gia",
    WS2, T_HISTORY, "BAR",
    "Country",
    [{"field": "World_Cup_Titles", "agg": "sum"}])
charts["bar_wc_titles"] = c["id"]
print(f"  + BAR WC Titles by Country  id={c['id']}")

c = ws_chart("WC Champions — Full History TABLE",
    "Lich su day du cac doi vo dich World Cup qua cac the he",
    WS2, T_HISTORY, "TABLE",
    "Country",
    [{"field": "World_Cup_Titles", "agg": "sum"}, {"field": "Continental_Titles", "agg": "sum"}])
charts["table_wc_history"] = c["id"]
print(f"  + TABLE WC History  id={c['id']}")

c = ws_chart("Total WC Editions — KPI",
    "Tong so lan to chuc World Cup trong lich su",
    WS2, T_SCORERS, "KPI",
    "dummy",
    [{"field": "Year", "agg": "count"}])
charts["kpi_wc_editions"] = c["id"]
print(f"  + KPI WC Editions  id={c['id']}")

c = ws_chart("Top Goals by WC Year — BAR",
    "So ban thang nhieu nhat cua vua pha luoi qua tung ky World Cup",
    WS2, T_SCORERS, "BAR",
    "Year",
    [{"field": "Goals", "agg": "max"}])
charts["bar_scorer_goals"] = c["id"]
print(f"  + BAR Scorer Goals by Year  id={c['id']}")

c = ws_chart("WC Titles by Confederation — BAR",
    "Tong so lan vo dich WC cua moi lien doan",
    WS2, T_WC_CONF, "BAR",
    "Confederation",
    [{"field": "total_wc_titles", "agg": "sum"}])
charts["bar_ws_wc_conf"] = c["id"]
print(f"  + BAR WC Titles by Confederation  id={c['id']}")

c = ws_chart("WC Titles Confederation Share — PIE",
    "Phan bo chuc vo dich WC theo lien doan",
    WS2, T_WC_CONF, "PIE",
    "Confederation",
    [{"field": "total_wc_titles", "agg": "sum"}])
charts["pie_goal_era"] = c["id"]
print(f"  + PIE WC Confederation Share  id={c['id']}")

# ── WS3: Football Analytics Hub ───────────────────────────────────────────────
c = ws_chart("Performance Tier Distribution — PIE",
    "Phan tang cac doi tuyen theo muc diem: Elite/Strong/Solid/Average (CASE WHEN)",
    WS3, T_TIERS, "PIE",
    "Performance_Tier",
    [{"field": "Country", "agg": "count"}])
charts["pie_ws_tiers"] = c["id"]
print(f"  + PIE Performance Tiers  id={c['id']}")

c = ws_chart("Performance Tiers — TABLE",
    "Bang day du phan tang cac doi tuyen voi Performance_Tier (CASE WHEN trong SQL)",
    WS3, T_TIERS, "TABLE",
    "Country",
    [{"field": "Points", "agg": "sum"}, {"field": "Performance_Tier", "agg": "count"}])
charts["table_tiers"] = c["id"]
print(f"  + TABLE Performance Tiers  id={c['id']}")

c = ws_chart("WC vs Continental Titles — GROUPED BAR",
    "So sanh chuc vo dich WC va luc dia cua top 10 quoc gia (hai series tren 1 bieu do)",
    WS3, T_TITLES_CMP, "GROUPED_BAR",
    "Country",
    [{"field": "World_Cup_Titles", "agg": "sum"},
     {"field": "Continental_Titles", "agg": "sum"}])
charts["grouped_ws_titles"] = c["id"]
print(f"  + GROUPED_BAR WC vs Continental Titles  id={c['id']}")

c = ws_chart("Total Titles Top 10 — BAR",
    "Tong danh hieu WC + Luc dia top 10 (cot tinh toan = WC + Continental)",
    WS3, T_TITLES_CMP, "BAR",
    "Country",
    [{"field": "Total_Titles", "agg": "sum"}])
charts["bar_ws_total_titles"] = c["id"]
print(f"  + BAR Total Titles Top 10  id={c['id']}")

c = ws_chart("Rankings + WC History — TABLE",
    "Ket hop bang xep hang FIFA + lich su WC qua LEFT JOIN 2 sheets (cross-sheet)",
    WS3, T_CROSS, "TABLE",
    "Country",
    [{"field": "Points", "agg": "sum"}, {"field": "WC_Titles_History", "agg": "sum"}])
charts["table_ws_cross"] = c["id"]
print(f"  + TABLE Cross-Sheet Rankings+History  id={c['id']}")

c = ws_chart("FIFA Rankings + WC Data — BAR",
    "Diem FIFA cua cac nuoc co du lieu cross-sheet (JOIN giua hai sheets)",
    WS3, T_CROSS, "BAR",
    "Country",
    [{"field": "Points", "agg": "sum"}])
charts["bar_cross_pts"] = c["id"]
print(f"  + BAR Cross-Sheet Points  id={c['id']}")

print(f"\n  -> {len(charts)} charts total")


# ══════════════════════════════════════════════════════════════════════════════
# STEP 5 — Dashboards (with filters_config pre-applied)
# ══════════════════════════════════════════════════════════════════════════════
print("\n5. Creating dashboards ...")

# ── Dashboard 1: FIFA World Rankings Overview ─────────────────────────────────
d1 = make_dashboard(
    name="FIFA World Rankings Overview",
    description="Tong quan bang xep hang FIFA thang 1/2026 — KPI, top 10, phan bo lien doan",
    chart_list=[
        (charts["kpi_total"],         0,  0,  3, 4),
        (charts["pie_confederation"],  3,  0,  4, 4),
        (charts["bar_avg_pts_conf"],   7,  0,  5, 4),
        (charts["bar_top10_pts"],      0,  4,  6, 5),
        (charts["pie_top10_conf"],     6,  4,  6, 5),
        (charts["table_rankings"],     0,  9, 12, 5),
    ],
    filters_config=[
        {
            "field": "Confederation",
            "label": "Confederation",
            "operator": "eq",
            "value": "UEFA",
            "type": "string",
        }
    ],
)
print(f"  + Dashboard 1 'FIFA World Rankings Overview'  id={d1}  [filter: Confederation=UEFA]")

# ── Dashboard 2: World Cup History & Analysis ─────────────────────────────────
d2 = make_dashboard(
    name="World Cup History & Champions",
    description="Phan tich lich su World Cup — chuc vo dich, lien doan, vua pha luoi qua cac ky",
    chart_list=[
        (charts["kpi_wc_editions"],    0,  0,  3, 4),
        (charts["bar_ws_wc_conf"],     3,  0,  9, 4),
        (charts["bar_wc_titles"],      0,  4,  6, 5),
        (charts["table_wc_history"],   6,  4,  6, 5),
        (charts["bar_scorer_goals"],   0,  9,  6, 5),
        (charts["pie_goal_era"],       6,  9,  6, 5),
    ],
    filters_config=[
        {
            "field": "World_Cup_Titles",
            "label": "Min WC Titles",
            "operator": "gte",
            "value": 1,
            "type": "number",
        }
    ],
)
print(f"  + Dashboard 2 'World Cup History'  id={d2}  [filter: WC_Titles>=1]")

# ── Dashboard 3: Football Analytics Hub ───────────────────────────────────────
d3 = make_dashboard(
    name="Football Analytics Hub",
    description="Phan tich nang cao — phan tang suc manh, so sanh da chieu, cross-sheet join",
    chart_list=[
        (charts["pie_ws_tiers"],        0,  0,  4, 5),
        (charts["bar_ws_total_titles"], 4,  0,  8, 5),
        (charts["grouped_ws_titles"],   0,  5, 12, 5),
        (charts["table_ws_cross"],      0, 10, 12, 5),
    ],
    filters_config=[
        {
            "field": "Points",
            "label": "Min Points",
            "operator": "gte",
            "value": 1600,
            "type": "number",
        }
    ],
)
print(f"  + Dashboard 3 'Football Analytics Hub'  id={d3}  [filter: Points>=1600]")


# ══════════════════════════════════════════════════════════════════════════════
print(f"""
+================================================================+
|  SEED COMPLETE                                                 |
+================================================================+
|  1 Datasource    Manual (Football Demo, 3 sheets)             |
|  6 Datasets      — transformation pipelines:                  |
|                    add_column, filter_rows, group_by,          |
|                    sort, limit, duplicate_column,              |
|                    merge_columns, fill_null                    |
|  3 Workspaces    FIFA Rankings / WC Analysis / Analytics Hub  |
|  9 Workspace Tables (GROUP BY, CASE WHEN, cross-join)         |
| {len(charts):2d} Charts        all via workspace_table_id (Explore-ready)  |
|  3 Dashboards    (each with pre-applied filters_config)        |
+================================================================+
|  http://localhost:3000                                         |
+================================================================+
""")
