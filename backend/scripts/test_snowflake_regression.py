"""Regression guard for the EXISTS rewrite.

1) Selected joined dim (owner.crm_name) must still JOIN (group-by), not EXISTS.
2) Mixed: group by owner.crm_name + filter on deal.org_id (filter-only -> EXISTS,
   owner JOINed for grouping). Verify no fan-out double count.
"""
from app.core.database import SessionLocal
from app.models.models import Chart, ChartType

DATASET_ID = 56
TID = {"bc_owner": 188, "bc_deal": 190, "bc_revenue": 193}
V = {k: f"dataset_table_{v}" for k, v in TID.items()}


def ensure(db, name, table_id, role, ctype="BAR"):
    c = db.query(Chart).filter(Chart.name == name).first()
    if c is None:
        c = Chart(name=name, dataset_table_id=table_id, chart_type=ChartType(ctype), config={"roleConfig": role})
        db.add(c)
    else:
        c.dataset_table_id = table_id; c.chart_type = ChartType(ctype); c.config = {"roleConfig": role}
    db.commit(); db.refresh(c)
    return c.id


def run(db, cid, label, filt=None):
    from app.services.chart_service import ChartService
    res = ChartService.get_chart_data(db, cid, extra_filters=[filt] if filt else None)
    debug = res.get("debug") or {}
    sql = (debug.get("sql_emitted") or "").replace("\n", " ")
    owner_join_marker = 'JOIN (SELECT * FROM "bcfix"."bc_owner")'
    has_owner_join = owner_join_marker in sql
    has_exists = "EXISTS" in sql
    print(f"  [{label}] data={res.get('data')}")
    print(f"      JOIN owner? {has_owner_join}  EXISTS? {has_exists}")
    print(f"      SQL: {sql[:500]}")


def main():
    db = SessionLocal()
    try:
        def F(view, field, op, val):
            sf = f"{V[view]}.{field}"
            return {"semanticField": sf, "field": sf, "operator": op, "value": val, "datasetId": DATASET_ID}

        # revenue grouped by owner.crm_name (joined dim) + metric amount
        rev_by_owner = ensure(db, "[snow] revenue by owner", TID["bc_revenue"],
                              {"metrics": [{"field": f"{V['bc_revenue']}.amount", "agg": "sum"}],
                               "dimension": f"{V['bc_owner']}.crm_name"})

        print("=== selected joined dim: revenue by owner.crm_name (expect JOIN owner, totals K1=1200,K3=900,K4=300) ===")
        run(db, rev_by_owner, "rev by owner (no filter)")

        print("\n=== mixed: revenue by owner.crm_name + filter deal.org_id=O1 (owner JOIN, deal EXISTS, no fanout) ===")
        # Only K1 has O1 deals -> only An row, amount 1200 (R1+R2), NOT doubled.
        run(db, rev_by_owner, "rev by owner <- deal.org_id=O1", F("bc_deal", "org_id", "eq", "O1"))
    finally:
        db.close()


if __name__ == "__main__":
    main()
