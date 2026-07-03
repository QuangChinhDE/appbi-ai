"""Build a MANUAL snowflake test fixture (independent of the live BigQuery
source) so the dashboard filter/slicer engine can be tested reproducibly.

Topology (mirrors the user's bc_* model):

    bc_deal_first_action --(migrate_deal_id)--> bc_deal
    bc_dim_stage <--(stage_id)-- bc_deal
    bc_owner    <--(bc_key)----- bc_deal        (CONFORMED dim, shared)
    bc_owner    <--(bc_key)----- bc_activity
    bc_owner    <--(bc_key)----- bc_revenue
    bc_date     <--(som_deal_add_time)-- bc_deal (CONFORMED dim, shared)
    bc_date     <--(som_due_datetime)--- bc_activity
    bc_date     <--(payment_month)------ bc_revenue

So bc_activity / bc_revenue reach the rest ONLY through the shared dims
(bc_owner, bc_date). Reaching bc_dim_stage from bc_revenue needs the
multi-hop reverse path bc_revenue -> bc_owner -> bc_deal -> bc_dim_stage.

Run inside the backend container (reaches appbi-db):
  DATABASE_URL=... PYTHONPATH=/app python /tmp/seed.py
"""
import os
import psycopg2
from app.core.database import SessionLocal
from app.core.crypto import encrypt_config
from app.models.models import DataSource, DataSourceType
from app.models.dataset import Dataset, DatasetTable

DATASET_NAME = "BC Snowflake Manual"
DS_NAME = "BC Manual PG"
SCHEMA = "bcfix"

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
    "bc_date": ("Date", [("date","date"),("year","integer"),("quarter","string"),("month","integer"),("month_name","string")]),
    "bc_owner": ("bc_owner", [("bc_key","string"),("crm_name","string"),("status","string"),("role","string"),("level","string"),("team","string"),("kpi","float"),("goal","float")]),
    "bc_dim_stage": ("bc_dim_stage", [("migrate_stage_id","string"),("pipeline_name","string"),("stage_name","string"),("ord","integer"),("process","string")]),
    "bc_deal": ("bc_deal", [("migrate_deal_id","string"),("stage_id","string"),("bc_key","string"),("som_deal_add_time","date"),("title","string"),("pipeline_id","string"),("org_id","string"),("amount","float")]),
    "bc_deal_first_action": ("bc_deal_first_action", [("deal_id","string"),("migrate_deal_id","string"),("type","string"),("done","boolean"),("subject","string"),("deal_add_time","date")]),
    "bc_activity": ("bc_activity", [("activity_id","string"),("deal_id","string"),("bc_key","string"),("som_due_datetime","date"),("user_id","string"),("subject","string"),("duration","float")]),
    "bc_revenue": ("bc_revenue", [("payment_id","string"),("payment_month","date"),("bc_key","string"),("customer_id","string"),("source_name","string"),("amount","float")]),
}


def pg_conn():
    return psycopg2.connect(
        host=os.environ["DB_HOST"], port=os.environ.get("DB_PORT", 5432),
        database=os.environ["DB_NAME"], user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
    )


def make_columns_cache(cols):
    return {
        "columns": [{"name": n, "type": t, "nullable": True} for n, t in cols],
        "source_columns": [n for n, _ in cols],
    }


def main():
    # 1) create schema + tables + data
    conn = pg_conn()
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(DDL)
    conn.close()
    print(f"[1] schema {SCHEMA} created with 7 tables + data")

    db = SessionLocal()
    try:
        # 2) datasource (postgres -> appbi-db, search_path bcfix)
        ds = db.query(DataSource).filter(DataSource.name == DS_NAME).first()
        if ds is None:
            ds = DataSource(name=DS_NAME, type=DataSourceType.POSTGRESQL, config={})
            db.add(ds)
        ds.type = DataSourceType.POSTGRESQL
        ds.config = encrypt_config({
            "host": os.environ["DB_HOST"], "port": int(os.environ.get("DB_PORT", 5432)),
            "database": os.environ["DB_NAME"], "username": os.environ["DB_USER"],
            "password": os.environ["DB_PASSWORD"], "schema_name": SCHEMA,
        })
        db.commit()
        print(f"[2] datasource id={ds.id} ({DS_NAME}) postgres -> {SCHEMA}")

        # 3) reset + create dataset
        old = db.query(Dataset).filter(Dataset.name == DATASET_NAME).all()
        for o in old:
            db.query(DatasetTable).filter(DatasetTable.dataset_id == o.id).delete()
            db.delete(o)
        db.commit()
        dataset = Dataset(name=DATASET_NAME, description="Manual snowflake fixture for filter tests")
        db.add(dataset)
        db.commit()
        print(f"[3] dataset id={dataset.id} ({DATASET_NAME})")

        # 4) dataset tables (physical_table)
        name_to_id = {}
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
            db.add(dt)
            db.flush()
            name_to_id[tbl] = dt.id
        db.commit()
        print(f"[4] dataset tables: {name_to_id}")

        # 5) generate semantic model
        from app.services.dataset_model_service import generate_dataset_model, add_join
        from app.models.semantic import SemanticView
        gen = generate_dataset_model(db, dataset.id, force=True)
        print(f"[5] model generated: views={len(gen.get('views', []))} explores={len(gen.get('explores', []))}")

        # map dataset_table_id -> semantic view id
        view_by_table = {}
        for v in db.query(SemanticView).all():
            if v.dataset_table_id in name_to_id.values():
                view_by_table[v.dataset_table_id] = v
        tid = name_to_id

        def vid(tbl):
            return view_by_table[tid[tbl]].id

        # 6) relationships (snowflake). from_view holds the FK.
        edges = [
            ("bc_deal", "stage_id", "bc_dim_stage", "migrate_stage_id"),
            ("bc_deal", "bc_key", "bc_owner", "bc_key"),
            ("bc_deal", "som_deal_add_time", "bc_date", "date"),
            ("bc_deal_first_action", "migrate_deal_id", "bc_deal", "migrate_deal_id"),
            ("bc_activity", "bc_key", "bc_owner", "bc_key"),
            ("bc_activity", "som_due_datetime", "bc_date", "date"),
            ("bc_revenue", "bc_key", "bc_owner", "bc_key"),
            ("bc_revenue", "payment_month", "bc_date", "date"),
        ]
        for from_t, from_c, to_t, to_c in edges:
            try:
                add_join(
                    db, dataset_id=dataset.id,
                    from_view_id=vid(from_t), to_view_id=vid(to_t),
                    from_column=from_c, to_column=to_c,
                    join_type="left", relationship="many_to_one",
                    cross_filter="both",
                    force=True,
                )
                print(f"    + join {from_t}.{from_c} -> {to_t}.{to_c}")
            except Exception as exc:
                print(f"    ! FAILED join {from_t}.{from_c} -> {to_t}.{to_c}: {exc}")
        db.commit()
        print("[6] relationships added")
        print(f"\nDONE. dataset_id={dataset.id}")
        print("table ids:", name_to_id)
    finally:
        db.close()


if __name__ == "__main__":
    main()
