#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed ONE representative dashboard for the presentation e2e gate. CI only.

WHY IT EXISTS. `e2e/tests/dashboard-presentation.spec.ts` measures the rendered
builder and the published report: that a style-only AI change moves nothing,
that a lock holds, that Save draft / Publish / reload show the approved
presentation, that `/d` and `/embed` agree with the builder, and that the page
stays readable on tablet and phone. It needs a real dashboard with real data —
KPIs, a time series, a breakdown, a bar, a table, a section header, a slicer.
A database built by `alembic upgrade head` has none, and a gate that skips when
its fixture is missing reports "passed" for a check that never ran.

WHY IT SEEDS THROUGH THE SERVICES. The data enters exactly the way an uploaded
Excel file does (`create_manual_dataset_from_excel_source`), and every chart is
created by `ChartService.create`, which resolves the semantic binding the
renderer depends on. Inserting rows directly would produce a dashboard the
product never makes, and the test would then measure an artefact of this script.

DETERMINISTIC. Fixed rows, fixed names, fixed public-link token. IDEMPOTENT:
everything is looked up by name/token first and re-used; nothing it did not
create is touched.
"""
from __future__ import annotations

import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from openpyxl import Workbook  # noqa: E402

from app.core.database import SessionLocal  # noqa: E402
from app.models.models import (  # noqa: E402
    Chart, Dashboard, DashboardChart, DashboardPublicLink,
)
from app.models.user import User  # noqa: E402
from app.schemas.schemas import ChartCreate  # noqa: E402
from app.services.chart_service import ChartService  # noqa: E402
from app.services.dashboard_html_import_service import (  # noqa: E402
    create_manual_dataset_from_excel_source,
    parse_uploaded_source_sheets,
)
from app.services.dataset_crud import DatasetCRUDService  # noqa: E402
from app.services.dataset_model_service import generate_dataset_model  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
DASHBOARD = "E2E Presentation fixture"
DATASET = "E2E presentation sales"
TOKEN = "e2e-presentation-fixture"
PAGE = "page-1"

REGIONS = ["North", "South", "Central"]
CHANNELS = ["Online", "Retail"]


def _workbook_bytes() -> bytes:
    """24 months × 3 regions × 2 channels of fixed, arithmetic data."""
    wb = Workbook()
    ws = wb.active
    ws.title = "sales"
    ws.append(["order_month", "region", "channel", "revenue", "orders"])
    for m in range(24):
        year, month = 2024 + m // 12, m % 12 + 1
        for r, region in enumerate(REGIONS):
            for c, channel in enumerate(CHANNELS):
                orders = 40 + 3 * m + 7 * r + 5 * c
                revenue = orders * (120 + 10 * r + 25 * c)
                ws.append([f"{year:04d}-{month:02d}-01", region, channel, revenue, orders])
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _config(chart_type: str, title: str, role: dict) -> dict:
    return {
        "chartType": chart_type,
        "queryMode": "generated",
        "roleConfig": role,
        "generatedRoleConfig": role,
        "customRoleConfig": {"metrics": []},
        "filters": [],
        "baseFilters": [],
        "styleConfig": {"chartTitle": title},
    }


#: (name, chart_type, role config, grid layout on the 36-column grid)
CHARTS = [
    ("E2E Revenue", "KPI", {"metrics": [{"field": "revenue", "agg": "sum"}]}, (0, 0, 12, 6)),
    ("E2E Orders", "KPI", {"metrics": [{"field": "orders", "agg": "sum"}]}, (12, 0, 12, 6)),
    # Average order value is total revenue / total orders — a formula measure
    # declared on the semantic view below — not AVG(revenue) over the rows,
    # which is "average revenue per region-channel-month" wearing AOV's label.
    ("E2E Average order value", "KPI", {"metrics": [{"field": "{view}.aov", "agg": "auto"}]}, (24, 0, 12, 6)),
    ("E2E Revenue over time", "TIME_SERIES",
     {"metrics": [{"field": "revenue", "agg": "sum"}], "timeField": "order_month", "dimension": "order_month"},
     (0, 9, 24, 16)),
    ("E2E Revenue by channel", "PIE",
     {"metrics": [{"field": "revenue", "agg": "sum"}], "dimension": "channel"}, (24, 9, 12, 16)),
    ("E2E Revenue by region", "BAR",
     {"metrics": [{"field": "revenue", "agg": "sum"}], "dimension": "region"}, (0, 25, 18, 14)),
    ("E2E Sales detail", "TABLE",
     {"metrics": [], "selectedColumns": ["region", "channel", "revenue", "orders"]}, (18, 25, 18, 14)),
]


def _declare_measures(db, table_id: int) -> str:
    """The business measures the fixture's KPIs mean, on its semantic view."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.models.semantic import SemanticView
    from app.schemas.semantic import MeasureDefinition

    view = db.query(SemanticView).filter(SemanticView.dataset_table_id == table_id).one()
    wanted = [
        {"name": "total_revenue", "label": "Revenue", "type": "sum", "sql": "${TABLE}.revenue",
         "format": {"kind": "currency", "currency": "USD"}},
        {"name": "total_orders", "label": "Orders", "type": "sum", "sql": "${TABLE}.orders"},
        {"name": "aov", "label": "Average order value", "type": "formula",
         "expression": "${total_revenue} / NULLIF(${total_orders}, 0)",
         "depends_on": ["total_revenue", "total_orders"], "format": {"kind": "currency", "currency": "USD"}},
    ]
    names = {m["name"] for m in wanted}
    kept = [m for m in (view.measures or []) if isinstance(m, dict) and m.get("name") not in names]
    view.measures = kept + [MeasureDefinition.model_validate(m).model_dump() for m in wanted]
    flag_modified(view, "measures")
    db.flush()
    return view.name


def main() -> int:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == EMAIL).first()
        if user is None:
            print(f"seed_e2e_presentation: no user {EMAIL} — run seed_e2e_user.py first")
            return 1

        dashboard = db.query(Dashboard).filter(Dashboard.name == DASHBOARD).first()
        if dashboard is not None and db.query(DashboardPublicLink).filter(DashboardPublicLink.token == TOKEN).first():
            print(f"seed_e2e_presentation: fixture already present (dashboard {dashboard.id})")
            return 0

        workbook = _workbook_bytes()
        dataset_id, table_id = create_manual_dataset_from_excel_source(
            db, current_user=user, file_bytes=workbook,
            filename="e2e_presentation_sales.xlsx", requested_name=DATASET,
        )
        # The column cache a table preview writes — the semantic model is built
        # from it. Filled from the SAME parse the upload used, through the same
        # service method the preview endpoint calls.
        sheet = parse_uploaded_source_sheets(file_bytes=workbook, filename="e2e_presentation_sales.xlsx")["sales"]
        DatasetCRUDService.update_table_cache(
            db, table_id, columns_cache={"columns": sheet.get("columns") or []},
            sample_cache=(sheet.get("rows") or [])[:50],
        )
        # The semantic model the charts bind to — the same step the Excel import
        # takes right after creating the dataset. Without it every chart answers
        # "Invalid field reference" and the gate would be measuring error cards.
        generate_dataset_model(db, int(dataset_id), force=False)
        view_name = _declare_measures(db, table_id)

        if dashboard is None:
            dashboard = Dashboard(
                name=DASHBOARD,
                description="Fixture for dashboard-presentation.spec.ts",
                owner_id=user.id,
                pages_config=[{"id": PAGE, "name": "Overview"}],
                slicers_config=[{
                    "id": "slicer-region", "field": "region", "label": "Region",
                    "type": "dropdown", "operator": "in", "value": [], "scope": "all",
                }],
                theme_config={"templateId": "brief", "colorwayId": "slate"},
            )
            db.add(dashboard)
            db.flush()

        for name, chart_type, role, (x, y, w, h) in CHARTS:
            role = json.loads(json.dumps(role).replace("{view}", view_name))
            chart = db.query(Chart).filter(Chart.name == name).first()
            if chart is None:
                chart = ChartService.create(db, ChartCreate(
                    name=name, chart_type=chart_type, dataset_table_id=table_id,
                    config=_config(chart_type, name.replace("E2E ", ""), role),
                ), owner_id=user.id)
            exists = db.query(DashboardChart).filter(
                DashboardChart.dashboard_id == dashboard.id, DashboardChart.chart_id == chart.id,
            ).first()
            if exists is None:
                db.add(DashboardChart(
                    dashboard_id=dashboard.id, chart_id=chart.id, widget_type="chart",
                    layout={"x": x, "y": y, "w": w, "h": h, "gv": 2, "pageId": PAGE},
                ))

        header = db.query(DashboardChart).filter(
            DashboardChart.dashboard_id == dashboard.id, DashboardChart.widget_type == "section_header",
        ).first()
        if header is None:
            db.add(DashboardChart(
                dashboard_id=dashboard.id, chart_id=None, widget_type="section_header",
                widget_config={"title": "Performance", "subtitle": "Revenue and orders"},
                layout={"x": 0, "y": 6, "w": 36, "h": 3, "gv": 2, "pageId": PAGE},
            ))

        if db.query(DashboardPublicLink).filter(DashboardPublicLink.token == TOKEN).first() is None:
            db.add(DashboardPublicLink(
                dashboard_id=dashboard.id, name="E2E presentation fixture",
                token=TOKEN, is_active=True, created_by=user.id,
            ))
        db.commit()
        print(f"seed_e2e_presentation: dashboard {dashboard.id}, table {table_id}, link {TOKEN}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
