"""Self-contained snowflake fixture for the CI **integration** golden tier.

The unit job (test_locked_contract + friends) runs on SQLite with no datasource.
The PowerBI-parity *behaviour* (cross-table measures, conformed-dim filters,
fan-out guard, multi-hop snowflake propagation) can only be proven against a
real engine + real SQL, so this script seeds the whole fixture into a fresh
Postgres and the golden harness replays it:

    alembic upgrade head                      # build the appbi metadata schema
    python scripts/seed_snowflake_ci_fixture.py
    python scripts/regression_filter_matrix.py --verify --tag snowflake

It CONSOLIDATES what was previously scattered across several local-only scripts
(seed_snowflake_manual_fixture.py + the gitignored add_measures_and_test.py /
seed_snowflake_demo_dashboard.py / test_snowflake_*.py) into ONE tracked file:

  • bcfix source schema (7 tables, deterministic rows)         — DDL below
  • a POSTGRESQL datasource + Dataset + 7 DatasetTables        — FIXED ids
  • generated semantic model + the snowflake join edges
  • declared measures on the fact views (total_revenue, …)
  • the 6 charts the committed golden (cases.yaml, tag=snowflake) resolves

FIXED ids matter: a semantic view is named ``dataset_table_<DatasetTable.id>``
and the golden's ``sql_patterns`` reference ``dataset_table_187 … 193`` (the
ids the golden was captured under). Forcing the DatasetTable PKs reproduces
those view names so the committed golden replays VERBATIM — no recapture, no
tautology. The bcfix source DB and the appbi metadata DB are the same Postgres
(bcfix is just a schema in it), mirroring the dev container.

Env (all default to the same local Postgres in CI):
  DATABASE_URL  appbi metadata DB (SessionLocal / alembic)
  DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD   bcfix source (== same PG)

Idempotent: safe to re-run; it clears the named fixture first. Intended for a
FRESH CI database — do NOT point it at a production metadata DB (it force-
assigns DatasetTable ids 187-193).
"""
import os

import psycopg2
from sqlalchemy import func, text
from sqlalchemy.orm.attributes import flag_modified

from app.core.crypto import encrypt_config
from app.core.database import SessionLocal
from app.models.dataset import Dataset, DatasetTable
from app.models.models import Chart, ChartType, DataSource, DataSourceType
from app.models.semantic import SemanticModel, SemanticView

DATASET_NAME = "BC Snowflake Manual"
DS_NAME = "BC Manual PG"
SCHEMA = "bcfix"

# FIXED Dataset id → the golden's extra_filters carry datasetId:56; the engine
# rejects a filter whose datasetId ≠ the chart's dataset (FILTER_DROP_DATASET_
# MISMATCH), so a fresh seed MUST reproduce id 56 or every filtered case fails.
DATASET_ID = 56

# FIXED DatasetTable ids → view names dataset_table_187..193 (golden depends on these).
TID = {
    "bc_date": 187, "bc_owner": 188, "bc_dim_stage": 189, "bc_deal": 190,
    "bc_deal_first_action": 191, "bc_activity": 192, "bc_revenue": 193,
}
V = {k: f"dataset_table_{v}" for k, v in TID.items()}

DDL = f"""
DROP SCHEMA IF EXISTS {SCHEMA} CASCADE;
CREATE SCHEMA {SCHEMA};

CREATE TABLE {SCHEMA}.bc_date (
    date DATE PRIMARY KEY,
    year INT, quarter TEXT, month INT, month_name TEXT
);

CREATE TABLE {SCHEMA}.bc_owner (
    bc_key TEXT PRIMARY KEY,
    crm_name TEXT, status TEXT, role TEXT, level TEXT, team TEXT,
    kpi NUMERIC, goal NUMERIC
);

CREATE TABLE {SCHEMA}.bc_dim_stage (
    migrate_stage_id TEXT PRIMARY KEY,
    pipeline_name TEXT, stage_name TEXT, ord INT, process TEXT
);

CREATE TABLE {SCHEMA}.bc_deal (
    migrate_deal_id TEXT PRIMARY KEY,
    stage_id TEXT REFERENCES {SCHEMA}.bc_dim_stage(migrate_stage_id),
    bc_key TEXT REFERENCES {SCHEMA}.bc_owner(bc_key),
    som_deal_add_time DATE REFERENCES {SCHEMA}.bc_date(date),
    title TEXT, pipeline_id TEXT, org_id TEXT, amount NUMERIC
);

CREATE TABLE {SCHEMA}.bc_deal_first_action (
    deal_id TEXT PRIMARY KEY,
    migrate_deal_id TEXT REFERENCES {SCHEMA}.bc_deal(migrate_deal_id),
    type TEXT, done BOOLEAN, subject TEXT, deal_add_time DATE
);

CREATE TABLE {SCHEMA}.bc_activity (
    activity_id TEXT PRIMARY KEY,
    deal_id TEXT,
    bc_key TEXT REFERENCES {SCHEMA}.bc_owner(bc_key),
    som_due_datetime DATE REFERENCES {SCHEMA}.bc_date(date),
    user_id TEXT, subject TEXT, duration NUMERIC
);

CREATE TABLE {SCHEMA}.bc_revenue (
    payment_id TEXT PRIMARY KEY,
    payment_month DATE REFERENCES {SCHEMA}.bc_date(date),
    bc_key TEXT REFERENCES {SCHEMA}.bc_owner(bc_key),
    customer_id TEXT, source_name TEXT, amount NUMERIC
);

INSERT INTO {SCHEMA}.bc_date(date, year, quarter, month, month_name) VALUES
 ('2025-01-15', 2025, 'Q1', 1, 'Jan'),
 ('2025-04-10', 2025, 'Q2', 4, 'Apr'),
 ('2025-07-22', 2025, 'Q3', 7, 'Jul'),
 ('2026-02-05', 2026, 'Q1', 2, 'Feb');

INSERT INTO {SCHEMA}.bc_owner(bc_key, crm_name, status, role, level, team, kpi, goal) VALUES
 ('K1','An',   'active',   'AE', 'Senior', 'North', 100, 120),
 ('K2','Binh', 'active',   'AE', 'Junior', 'North',  80,  90),
 ('K3','Cuong','inactive', 'SM', 'Senior', 'South', 150, 160),
 ('K4','Dung', 'active',   'AE', 'Junior', 'South',  60,  70);

INSERT INTO {SCHEMA}.bc_dim_stage(migrate_stage_id, pipeline_name, stage_name, ord, process) VALUES
 ('S1','Sales','Lead',    1,'open'),
 ('S2','Sales','Qualified',2,'open'),
 ('S3','Sales','Won',     3,'closed'),
 ('S4','Partner','Nego',  2,'open');

INSERT INTO {SCHEMA}.bc_deal(migrate_deal_id, stage_id, bc_key, som_deal_add_time, title, pipeline_id, org_id, amount) VALUES
 ('D1','S1','K1','2025-01-15','Deal A','P1','O1', 1000),
 ('D2','S3','K1','2025-04-10','Deal B','P1','O1', 2000),
 ('D3','S2','K2','2025-04-10','Deal C','P1','O2', 1500),
 ('D4','S4','K3','2025-07-22','Deal D','P2','O3', 3000),
 ('D5','S3','K4','2026-02-05','Deal E','P1','O3',  500);

INSERT INTO {SCHEMA}.bc_deal_first_action(deal_id, migrate_deal_id, type, done, subject, deal_add_time) VALUES
 ('FA1','D1','call', true, 'first call','2025-01-15'),
 ('FA2','D2','email',false,'intro mail','2025-04-10'),
 ('FA3','D4','call', true, 'demo',      '2025-07-22');

INSERT INTO {SCHEMA}.bc_activity(activity_id, deal_id, bc_key, som_due_datetime, user_id, subject, duration) VALUES
 ('A1','D1','K1','2025-01-15','U1','task1', 30),
 ('A2','D2','K1','2025-04-10','U1','task2', 45),
 ('A3','D3','K2','2025-07-22','U2','task3', 60),
 ('A4','D4','K3','2025-07-22','U3','task4', 20),
 ('A5','D5','K4','2026-02-05','U4','task5', 90);

INSERT INTO {SCHEMA}.bc_revenue(payment_id, payment_month, bc_key, customer_id, source_name, amount) VALUES
 ('R1','2025-01-15','K1','C1','web',   500),
 ('R2','2025-04-10','K1','C2','direct',700),
 ('R3','2025-04-10','K3','C3','web',   900),
 ('R4','2026-02-05','K4','C4','partner',300);
"""

# columns_cache type mapping per table (name -> appbi type)
TABLES = {
    "bc_date": ("Date", [("date", "date"), ("year", "integer"), ("quarter", "string"), ("month", "integer"), ("month_name", "string")]),
    "bc_owner": ("bc_owner", [("bc_key", "string"), ("crm_name", "string"), ("status", "string"), ("role", "string"), ("level", "string"), ("team", "string"), ("kpi", "float"), ("goal", "float")]),
    "bc_dim_stage": ("bc_dim_stage", [("migrate_stage_id", "string"), ("pipeline_name", "string"), ("stage_name", "string"), ("ord", "integer"), ("process", "string")]),
    "bc_deal": ("bc_deal", [("migrate_deal_id", "string"), ("stage_id", "string"), ("bc_key", "string"), ("som_deal_add_time", "date"), ("title", "string"), ("pipeline_id", "string"), ("org_id", "string"), ("amount", "float")]),
    "bc_deal_first_action": ("bc_deal_first_action", [("deal_id", "string"), ("migrate_deal_id", "string"), ("type", "string"), ("done", "boolean"), ("subject", "string"), ("deal_add_time", "date")]),
    "bc_activity": ("bc_activity", [("activity_id", "string"), ("deal_id", "string"), ("bc_key", "string"), ("som_due_datetime", "date"), ("user_id", "string"), ("subject", "string"), ("duration", "float")]),
    "bc_revenue": ("bc_revenue", [("payment_id", "string"), ("payment_month", "date"), ("bc_key", "string"), ("customer_id", "string"), ("source_name", "string"), ("amount", "float")]),
}

# from_view holds the FK → many_to_one to_view.
EDGES = [
    ("bc_deal", "stage_id", "bc_dim_stage", "migrate_stage_id"),
    ("bc_deal", "bc_key", "bc_owner", "bc_key"),
    ("bc_deal", "som_deal_add_time", "bc_date", "date"),
    ("bc_deal_first_action", "migrate_deal_id", "bc_deal", "migrate_deal_id"),
    ("bc_activity", "bc_key", "bc_owner", "bc_key"),
    ("bc_activity", "som_due_datetime", "bc_date", "date"),
    ("bc_revenue", "bc_key", "bc_owner", "bc_key"),
    ("bc_revenue", "payment_month", "bc_date", "date"),
]


def _measure(name, sql, mtype="sum"):
    return {
        "name": name, "type": mtype, "sql": sql, "expression": None, "filters": [],
        "where_sql": None, "depends_on": [], "format": None, "folder": None,
        "label": name, "description": None, "hidden": False,
    }


# Declared measures keyed by DatasetTable id (matches add_measures_and_test.py capture).
VIEW_MEASURES = {
    190: [_measure("total_amount", "amount"), _measure("deal_count", "*", "count")],
    193: [_measure("total_revenue", "amount"), _measure("revenue_count", "*", "count")],
    192: [_measure("total_duration", "duration"), _measure("activity_count", "*", "count")],
    188: [_measure("avg_kpi", "kpi", "avg"), _measure("owner_count", "*", "count")],
}

# The 6 chart names the golden (tag=snowflake) resolves, with their home table +
# canonical (view-qualified) roleConfig + type.
CHARTS = [
    ("[snow] revenue total", 193, "KPI",
     {"metrics": [{"field": f"{V['bc_revenue']}.amount", "agg": "sum"}]}),
    ("[snow] activity duration total", 192, "KPI",
     {"metrics": [{"field": f"{V['bc_activity']}.duration", "agg": "sum"}]}),
    ("[snow] Deal amount total", 190, "KPI",
     {"metrics": [{"field": f"{V['bc_deal']}.amount", "agg": "sum"}]}),
    ("[snow] revenue by owner", 193, "BAR",
     {"metrics": [{"field": f"{V['bc_revenue']}.amount", "agg": "sum"}],
      "dimension": f"{V['bc_owner']}.crm_name"}),
    ("[snow] M revenue (declared)", 193, "KPI",
     {"metrics": [{"field": f"{V['bc_revenue']}.total_revenue"}]}),
    # CROSS-TABLE measure: base = owner, measure lives on revenue (joined table).
    ("[snow] M revenue per owner (cross-table measure)", 188, "BAR",
     {"metrics": [{"field": f"{V['bc_revenue']}.total_revenue"}],
      "dimension": f"{V['bc_owner']}.crm_name"}),
    # SCATTER with DECLARED MEASURE axes (X=revenue.total_revenue, Y=owner.avg_kpi)
    # — exercises the chart-runtime reclassify (push_dim) so a measure on an
    # axis is AGGREGATED (not GROUP BY'd) and matches the Explore-preview
    # (dataset-execute) path. Used by test_explore_dashboard_parity.py.
    ("[snow] scatter rev-vs-kpi by owner", 188, "SCATTER",
     {"dimension": f"{V['bc_owner']}.crm_name",
      "scatterX": f"{V['bc_revenue']}.total_revenue",
      "scatterY": f"{V['bc_owner']}.avg_kpi"}),
    # GRAIN / chasm group-by guard: base = revenue (a fact), measure on revenue,
    # grouped by a column of ANOTHER fact (deal.title) reachable from revenue
    # ONLY through a shared dim (owner/date = chasm). PowerBI-correct = fail-loud
    # (or unrelated-dim policy); the current normal build JOINs deal and FANS the
    # SUM (revenue counted once per deal sharing the date → 4000 vs true 2400).
    # Used by golden case G_GRAIN (tag `grain`) — see KNOWN_ISSUES.md; the
    # Phase-6 grain validator will change this to fail-loud + recapture.
    ("[snow] grain rev by deal-title (chasm)", 193, "BAR",
     {"metrics": [{"field": f"{V['bc_revenue']}.amount", "agg": "sum"}],
      "dimension": f"{V['bc_deal']}.title"}),
]


def pg_conn():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", 5432)),
        database=os.environ.get("DB_NAME", "appbi"),
        user=os.environ.get("DB_USER", "appbi"),
        password=os.environ.get("DB_PASSWORD", "appbi"),
    )


def make_columns_cache(cols):
    return {
        "columns": [{"name": n, "type": t, "nullable": True} for n, t in cols],
        "source_columns": [n for n, _ in cols],
    }


def _clear_fixture(db):
    """Best-effort clean slate so re-runs are idempotent (no-op on a fresh DB).

    FK order matters: semantic_explores.base_view_id → semantic_views (RESTRICT),
    so the SemanticModel (whose `explores` cascade-delete) must go FIRST to free
    the views; only then can the views / tables / dataset be removed.
    """
    for cname, *_ in CHARTS:
        db.query(Chart).filter(func.lower(func.trim(Chart.name)) == cname.lower()).delete(
            synchronize_session=False
        )
    db.commit()
    for ds in db.query(Dataset).filter(Dataset.name == DATASET_NAME).all():
        tbl_ids = [t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == ds.id).all()]
        model = db.query(SemanticModel).filter(SemanticModel.dataset_id == ds.id).first()
        if model is not None:
            db.delete(model)        # cascades to SemanticExplore (delete-orphan)
            db.commit()
        if tbl_ids:
            db.query(SemanticView).filter(
                SemanticView.dataset_table_id.in_(tbl_ids)
            ).delete(synchronize_session=False)
        db.query(DatasetTable).filter(DatasetTable.dataset_id == ds.id).delete(
            synchronize_session=False
        )
        db.delete(ds)
        db.commit()


def main():
    # SAFETY — this script DROPs schema 'bcfix' (CASCADE) and force-assigns
    # FIXED PKs (dataset 56, tables 187-193). Run against a real dev/prod
    # metadata DB it would clobber data. Require an explicit opt-in so it cannot
    # run by accident; the CI workflow sets CI_FIXTURE_SEED=1. Point
    # DATABASE_URL / DB_* at a DISPOSABLE database only.
    if os.environ.get("CI_FIXTURE_SEED") != "1":
        raise SystemExit(
            "REFUSED: seed_snowflake_ci_fixture.py DROPs schema 'bcfix' and forces "
            "fixed ids (dataset 56, tables 187-193) — for a FRESH CI / test DB only. "
            "Set CI_FIXTURE_SEED=1 to proceed (the CI workflow does). Never run it "
            "against the dev/prod metadata DB."
        )
    # 1) bcfix source schema + rows
    conn = pg_conn()
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(DDL)
    conn.close()
    print(f"[1] source schema {SCHEMA} created (7 tables + deterministic rows)")

    db = SessionLocal()
    try:
        _clear_fixture(db)
        print("[2] cleared any prior fixture (idempotent)")

        # 3) datasource (postgres -> appbi-db, search_path bcfix)
        ds = db.query(DataSource).filter(DataSource.name == DS_NAME).first()
        if ds is None:
            ds = DataSource(name=DS_NAME, type=DataSourceType.POSTGRESQL, config={})
            db.add(ds)
        ds.type = DataSourceType.POSTGRESQL
        ds.config = encrypt_config({
            "host": os.environ.get("DB_HOST", "localhost"),
            "port": int(os.environ.get("DB_PORT", 5432)),
            "database": os.environ.get("DB_NAME", "appbi"),
            "username": os.environ.get("DB_USER", "appbi"),
            "password": os.environ.get("DB_PASSWORD", "appbi"),
            "schema_name": SCHEMA,
        })
        db.commit()
        print(f"[3] datasource id={ds.id} ({DS_NAME}) -> {SCHEMA}")

        # 4) dataset (FIXED id 56 → filter datasetId match) + 7 tables (FIXED ids)
        dataset = Dataset(name=DATASET_NAME, description="Manual snowflake fixture (CI golden tier)")
        dataset.id = DATASET_ID
        db.add(dataset)
        db.commit()
        db.execute(text(
            f"SELECT setval(pg_get_serial_sequence('{Dataset.__tablename__}', 'id'), "
            f"(SELECT MAX(id) FROM {Dataset.__tablename__}))"
        ))
        db.commit()
        for tbl, (disp, cols) in TABLES.items():
            dt = DatasetTable(
                dataset_id=dataset.id,
                datasource_id=ds.id,
                source_kind="physical_table",
                source_table_name=f"{SCHEMA}.{tbl}",
                display_name=disp,
                query_mode="synced",
                columns_cache=make_columns_cache(cols),
                enabled=True,
            )
            dt.id = TID[tbl]  # force PK → view name dataset_table_<id>
            db.add(dt)
        db.commit()
        # keep the serial ahead of the forced ids so later inserts don't collide
        db.execute(text(
            f"SELECT setval(pg_get_serial_sequence('{DatasetTable.__tablename__}', 'id'), "
            f"(SELECT MAX(id) FROM {DatasetTable.__tablename__}))"
        ))
        db.commit()
        print(f"[4] dataset id={dataset.id}, tables forced to ids {sorted(TID.values())}")

        # 5) generate semantic model (names views dataset_table_<id>)
        from app.services.dataset_model_service import add_join, generate_dataset_model
        gen = generate_dataset_model(db, dataset.id, force=True)
        print(f"[5] model: views={len(gen.get('views', []))} explores={len(gen.get('explores', []))}")

        view_by_table = {
            v.dataset_table_id: v
            for v in db.query(SemanticView).all()
            if v.dataset_table_id in TID.values()
        }

        def vid(tbl):
            return view_by_table[TID[tbl]].id

        # 6) declared measures on the fact views
        for tid_, meas in VIEW_MEASURES.items():
            v = view_by_table.get(tid_)
            if v is None:
                raise RuntimeError(f"semantic view for dataset_table {tid_} not found")
            v.measures = meas
            flag_modified(v, "measures")
        db.commit()
        print(f"[6] declared measures on views {sorted(VIEW_MEASURES)}")

        # 7) snowflake join edges
        for from_t, from_c, to_t, to_c in EDGES:
            add_join(
                db, dataset_id=dataset.id,
                from_view_id=vid(from_t), to_view_id=vid(to_t),
                from_column=from_c, to_column=to_c,
                join_type="left", relationship="many_to_one",
                cross_filter="both", force=True,
            )
        db.commit()
        print(f"[7] {len(EDGES)} join edges added (snowflake topology)")

        # 8) the golden charts
        created = {}
        for name, home_tid, ctype, role in CHARTS:
            c = db.query(Chart).filter(
                func.lower(func.trim(Chart.name)) == name.lower()
            ).first()
            if c is None:
                c = Chart(name=name, dataset_table_id=home_tid,
                          chart_type=ChartType(ctype), config={"roleConfig": role})
                db.add(c)
            else:
                c.dataset_table_id = home_tid
                c.chart_type = ChartType(ctype)
                c.config = {"roleConfig": role}
            db.commit()
            db.refresh(c)
            created[name] = c.id
        print(f"[8] charts: {created}")
        print(f"\nDONE. dataset_id={dataset.id}; run: "
              f"python scripts/regression_filter_matrix.py --verify --tag snowflake")
    finally:
        db.close()


if __name__ == "__main__":
    main()
