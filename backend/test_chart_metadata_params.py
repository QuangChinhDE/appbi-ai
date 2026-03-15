"""
Tests for ChartMetadata and ChartParameter — chart_service layer.

Runs against the real database (no mocking).
Cleans up all created rows after each test.
Does NOT require the HTTP server to be running.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.core.database import SessionLocal
from app.models.models import Chart, ChartMetadata, ChartParameter, ChartType
from app.services.chart_service import ChartService
from app.schemas.schemas import (
    ChartCreate,
    ChartMetadataUpsert,
    ChartParameterCreate,
    ChartParameterUpdate,
    ChartResponse,
)

# ─── helpers ────────────────────────────────────────────────────────────────

PASS = "✅"
FAIL = "❌"

results = []

def check(label: str, condition: bool, extra: str = ""):
    icon = PASS if condition else FAIL
    msg = f"{icon} {label}"
    if extra:
        msg += f"  [{extra}]"
    print(msg)
    results.append((label, condition))
    return condition


def _make_test_chart(db) -> Chart:
    """Create a throwaway chart for testing; uses null dataset_id."""
    c = Chart(
        name=f"_test_meta_{id(db)}",
        description="temp chart for metadata tests",
        dataset_id=None,
        workspace_table_id=None,
        chart_type=ChartType.BAR,
        config={"xField": "x", "yFields": ["y"]},
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


# ─── tests ──────────────────────────────────────────────────────────────────

def test_upsert_and_get_metadata():
    db = SessionLocal()
    chart = _make_test_chart(db)
    try:
        # CREATE
        data = ChartMetadataUpsert(
            domain="sales",
            intent="trend",
            metrics=["revenue", "order_count"],
            dimensions=["month", "region"],
            tags=["kpi", "q1"],
        )
        meta = ChartService.upsert_metadata(db, chart.id, data)
        check("upsert_metadata creates record", meta is not None)
        check("domain stored", meta.domain == "sales")
        check("intent stored", meta.intent == "trend")
        check("metrics list", meta.metrics == ["revenue", "order_count"])
        check("dimensions list", meta.dimensions == ["month", "region"])
        check("tags list", meta.tags == ["kpi", "q1"])

        # GET
        fetched = ChartService.get_metadata(db, chart.id)
        check("get_metadata returns same id", fetched.id == meta.id)

        # UPDATE (upsert again)
        update = ChartMetadataUpsert(domain="marketing", intent="comparison", metrics=["ctr"], dimensions=[], tags=[])
        updated = ChartService.upsert_metadata(db, chart.id, update)
        check("upsert updates existing record", updated.id == meta.id)
        check("domain updated", updated.domain == "marketing")
        check("metrics updated", updated.metrics == ["ctr"])

        # DELETE
        deleted = ChartService.delete_metadata(db, chart.id)
        check("delete_metadata returns True", deleted is True)
        check("get_metadata after delete returns None", ChartService.get_metadata(db, chart.id) is None)
        check("delete again returns False", ChartService.delete_metadata(db, chart.id) is False)

    finally:
        db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart.id).delete()
        db.delete(chart)
        db.commit()
        db.close()


def test_replace_and_manage_parameters():
    db = SessionLocal()
    chart = _make_test_chart(db)
    try:
        # REPLACE (bulk PUT)
        params_in = [
            ChartParameterCreate(parameter_name="date_range", parameter_type="time_range",
                                  column_mapping={"column": "order_date", "type": "date"},
                                  default_value="last_30_days", description="Date filter"),
            ChartParameterCreate(parameter_name="region", parameter_type="dimension",
                                  column_mapping={"column": "region_code", "type": "string"},
                                  default_value=None, description=None),
        ]
        created = ChartService.replace_parameters(db, chart.id, params_in)
        check("replace_parameters creates 2 rows", len(created) == 2)
        check("first param name", created[0].parameter_name == "date_range")
        check("column_mapping is dict", isinstance(created[0].column_mapping, dict))
        check("column_mapping.column", created[0].column_mapping.get("column") == "order_date")

        # GET
        fetched_params = ChartService.get_parameters(db, chart.id)
        check("get_parameters returns 2", len(fetched_params) == 2)

        # ADD single
        new_param = ChartService.add_parameter(
            db, chart.id,
            ChartParameterCreate(parameter_name="currency", parameter_type="dimension")
        )
        check("add_parameter created", new_param.id is not None)
        check("get_parameters now returns 3", len(ChartService.get_parameters(db, chart.id)) == 3)

        # UPDATE single
        updated = ChartService.update_parameter(
            db, chart.id, new_param.id,
            ChartParameterUpdate(default_value="USD", description="Currency code")
        )
        check("update_parameter returns updated", updated is not None)
        check("default_value updated", updated.default_value == "USD")

        # UPDATE non-existent → None
        missing = ChartService.update_parameter(db, chart.id, 999999, ChartParameterUpdate(default_value="x"))
        check("update non-existent returns None", missing is None)

        # DELETE single
        deleted = ChartService.delete_parameter(db, chart.id, new_param.id)
        check("delete_parameter returns True", deleted is True)
        check("get_parameters returns 2 after delete", len(ChartService.get_parameters(db, chart.id)) == 2)
        check("delete non-existent returns False", ChartService.delete_parameter(db, chart.id, 999999) is False)

        # REPLACE again clears and inserts fresh
        replaced_again = ChartService.replace_parameters(db, chart.id, [
            ChartParameterCreate(parameter_name="only_one", parameter_type="measure"),
        ])
        check("replace clears old, inserts 1 new", len(ChartService.get_parameters(db, chart.id)) == 1)

    finally:
        db.query(ChartParameter).filter(ChartParameter.chart_id == chart.id).delete()
        db.delete(chart)
        db.commit()
        db.close()


def test_chart_response_serialization():
    """Ensure Pydantic ChartResponse serializes chart_meta → 'metadata' key."""
    db = SessionLocal()
    chart = _make_test_chart(db)
    try:
        # Add metadata
        ChartService.upsert_metadata(db, chart.id, ChartMetadataUpsert(
            domain="finance", intent="summary", metrics=["profit"], dimensions=["quarter"], tags=[]
        ))
        # Add parameter
        ChartService.add_parameter(db, chart.id, ChartParameterCreate(
            parameter_name="period", parameter_type="time_range", default_value="ytd"
        ))

        # Re-fetch fresh chart object to load relationships
        db.expire(chart)
        fresh = db.query(Chart).filter(Chart.id == chart.id).first()

        # Serialize via Pydantic
        schema = ChartResponse.model_validate(fresh)
        as_dict = schema.model_dump()

        check("ChartResponse has 'metadata' key in dict", "metadata" in as_dict)
        check("metadata.domain serialized", as_dict["metadata"]["domain"] == "finance")
        check("metadata.metrics serialized", as_dict["metadata"]["metrics"] == ["profit"])
        check("'parameters' key present", "parameters" in as_dict)
        check("parameters has 1 entry", len(as_dict["parameters"]) == 1)
        check("parameter name serialized", as_dict["parameters"][0]["parameter_name"] == "period")

    finally:
        db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart.id).delete()
        db.query(ChartParameter).filter(ChartParameter.chart_id == chart.id).delete()
        db.delete(chart)
        db.commit()
        db.close()


def test_dashboard_chart_parameters_column():
    """Verify DashboardChart.parameters column exists and can store JSON."""
    from app.models.models import DashboardChart
    from sqlalchemy import text
    db = SessionLocal()
    try:
        # Check column exists via reflection
        result = db.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'dashboard_charts' AND column_name = 'parameters'"
        )).fetchone()
        check("dashboard_charts.parameters column exists in DB", result is not None)
    finally:
        db.close()


def test_chart_metadata_table_exists():
    """Verify chart_metadata table exists in the DB."""
    from sqlalchemy import text
    db = SessionLocal()
    try:
        result = db.execute(text(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_name = 'chart_metadata'"
        )).fetchone()
        check("chart_metadata table exists in DB", result is not None)
    finally:
        db.close()


def test_chart_parameters_table_exists():
    """Verify chart_parameters table exists in the DB."""
    from sqlalchemy import text
    db = SessionLocal()
    try:
        result = db.execute(text(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_name = 'chart_parameters'"
        )).fetchone()
        check("chart_parameters table exists in DB", result is not None)
    finally:
        db.close()


# ─── runner ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("Chart Metadata & Parameters — Service Tests")
    print("=" * 60)

    test_chart_metadata_table_exists()
    test_chart_parameters_table_exists()
    test_dashboard_chart_parameters_column()
    test_upsert_and_get_metadata()
    test_replace_and_manage_parameters()
    test_chart_response_serialization()

    print("=" * 60)
    total = len(results)
    passed = sum(1 for _, ok in results if ok)
    failed = total - passed
    print(f"Results: {passed}/{total} passed" + (f"  ({failed} FAILED)" if failed else "  — all OK"))
    print("=" * 60)
    sys.exit(0 if failed == 0 else 1)
