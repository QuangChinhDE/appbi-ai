"""Snowflake filter matrix on dataset 56 (manual fixture).

Creates one chart per fact, then applies cross-table filters and prints:
routing, dropped_filters, whether the filter table is JOINed, the SQL, and
the aggregated result so we can judge correctness (not just 'applied').

Run inside container.
"""
from app.core.database import SessionLocal
from app.models.models import Chart, ChartType
from app.models.dataset import DatasetTable, Dataset

DATASET_ID = 56
TID = {  # table ids from seed
    "bc_date": 187, "bc_owner": 188, "bc_dim_stage": 189, "bc_deal": 190,
    "bc_deal_first_action": 191, "bc_activity": 192, "bc_revenue": 193,
}
V = {k: f"dataset_table_{v}" for k, v in TID.items()}


def ensure_chart(db, name, table_id, role_config, chart_type="BAR"):
    c = db.query(Chart).filter(Chart.name == name).first()
    if c is None:
        c = Chart(name=name, dataset_table_id=table_id, chart_type=ChartType(chart_type),
                  config={"roleConfig": role_config})
        db.add(c)
    else:
        c.dataset_table_id = table_id
        c.chart_type = ChartType(chart_type)
        c.config = {"roleConfig": role_config}
    db.commit()
    db.refresh(c)
    return c.id


def run(db, chart_id, label, filt, expect=None):
    from app.services.chart_service import ChartService
    try:
        res = ChartService.get_chart_data(db, chart_id, extra_filters=[filt] if filt else None)
    except Exception as exc:
        print(f"  [{label}] ERROR: {exc}")
        return
    debug = res.get("debug") or {}
    sql = (debug.get("sql_emitted") or "").replace("\n", " ")
    dropped = debug.get("dropped_filters")
    ftbl = filt["semanticField"].split(".")[0] if filt else None
    joined = (ftbl in sql) if ftbl else None
    data = res.get("data")
    print(f"  [{label}] routing={debug.get('routing')} filter_table_joined={joined} dropped={dropped}")
    print(f"      data={data}")
    if not joined or dropped:
        print(f"      SQL: {sql[:700]}")


def main():
    db = SessionLocal()
    try:
        # charts: BAR by a dim with SUM(amount/duration)
        deal_bar = ensure_chart(db, "[snow] deal amount by stage", TID["bc_deal"],
                                 {"metrics": [{"field": f"{V['bc_deal']}.amount", "agg": "sum"}],
                                  "dimension": f"{V['bc_deal']}.title"})
        rev_kpi = ensure_chart(db, "[snow] revenue total", TID["bc_revenue"],
                               {"metrics": [{"field": f"{V['bc_revenue']}.amount", "agg": "sum"}]}, "KPI")
        act_kpi = ensure_chart(db, "[snow] activity duration total", TID["bc_activity"],
                               {"metrics": [{"field": f"{V['bc_activity']}.duration", "agg": "sum"}]}, "KPI")

        def F(view, field, op, val):
            sf = f"{V[view]}.{field}"
            return {"semanticField": sf, "field": sf, "operator": op, "value": val, "datasetId": DATASET_ID}

        print("=== baseline (no filter) ===")
        run(db, rev_kpi, "revenue total baseline", None)
        run(db, act_kpi, "activity dur baseline", None)

        print("\n=== conformed dim: bc_owner (shared by deal/activity/revenue) ===")
        run(db, deal_bar, "deal <- owner.team=North", F("bc_owner", "team", "eq", "North"))
        run(db, act_kpi,  "activity <- owner.team=North", F("bc_owner", "team", "eq", "North"))
        run(db, rev_kpi,  "revenue <- owner.team=North", F("bc_owner", "team", "eq", "North"))

        print("\n=== conformed dim: bc_date (role-played per fact) ===")
        run(db, act_kpi, "activity <- date.year=2025", F("bc_date", "year", "eq", 2025))
        run(db, rev_kpi, "revenue <- date.year=2025", F("bc_date", "year", "eq", 2025))

        print("\n=== snowflake multi-hop reverse: revenue <- stage (193->188->190->189) ===")
        run(db, rev_kpi, "revenue <- stage.process=closed", F("bc_dim_stage", "process", "eq", "closed"))

        print("\n=== direct snowflake: deal <- stage ===")
        run(db, deal_bar, "deal <- stage.process=closed", F("bc_dim_stage", "process", "eq", "closed"))

        print("\nchart ids:", {"deal_bar": deal_bar, "rev_kpi": rev_kpi, "act_kpi": act_kpi})
    finally:
        db.close()


if __name__ == "__main__":
    main()
