"""Stage 5 supplement — HTML Import path for safe dashboard creation.

Two flows exist for creating dashboards in Stage 5:

  Flow A — HTML Import (safe / server-validated):
    1. Call get_html_dashboard_spec()     → understand the full v1 HTML spec
    2. Write an AppBI Import Plan v1 HTML → Claude authors the visual + metadata
    3. analyze_html_import()              → backend parses + validates all chart plans
    4. build_dashboard_from_html()        → materialises Dataset + Charts + Dashboard

  Flow B — Direct API (flexible / granular):
    Use create_dashboard() + create_chart() + add_chart_to_dashboard()
    from appbi_dashboard.py + appbi_chart.py

When to prefer Flow A:
  - Many charts (≥ 4) and you want server-side validation before anything is written
  - Need calculated fields or derived/aggregated virtual tables declared in HTML
  - Source data comes from an uploaded Excel file (upload_excel mode)
  - User wants to review the full chart-plan diff before committing

When to prefer Flow B:
  - Charts are already created; you are assembling an empty dashboard shell
  - You need fine-grained control over canvas layout or per-placement parameters
  - The semantic model is already in place and charts are pre-validated
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from appbi_core import (
    APPBI_API_BASE_URL,
    APPBI_LONG_TIMEOUT_SECONDS,
    APPBI_PAT,
    APPBI_VERIFY_TLS,
    Context,
    _drop_none,
    _requires_confirmation,
    logger,
    tool,
)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_JSON = json.dumps  # shorthand


async def _form_request(
    method: str,
    path: str,
    *,
    data: dict[str, str],
    files: list[tuple[str, tuple[str, bytes, str]]] | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    """POST/PUT multipart-form-data to the AppBI backend.

    `data`  — plain string form fields.
    `files` — list of (field_name, (filename, bytes, mime_type)) tuples.
    """
    url = f"{APPBI_API_BASE_URL}{path}"
    headers = {
        "Authorization": f"Bearer {APPBI_PAT}",
        "Accept": "application/json",
    }
    effective_timeout = float(timeout_seconds or APPBI_LONG_TIMEOUT_SECONDS)

    async with httpx.AsyncClient(
        timeout=effective_timeout,
        verify=APPBI_VERIFY_TLS,
        follow_redirects=True,
    ) as client:
        response = await client.request(
            method,
            url,
            headers=headers,
            data=data,
            files=files,
        )

    if response.status_code >= 400:
        detail: Any = response.text
        try:
            payload = response.json()
            detail = payload.get("detail", payload)
        except Exception:
            pass
        raise RuntimeError(f"{method} {path} failed ({response.status_code}): {detail}")

    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


# ---------------------------------------------------------------------------
# Spec / documentation tool
# ---------------------------------------------------------------------------

_HTML_DASHBOARD_SPEC = """
# AppBI Import Plan v1 — HTML Spec Reference (current)

## Purpose
An AppBI Import Plan v1 HTML is a self-contained `.html` file that both:
1. **Renders visually** in a browser (charts drawn with Chart.js or static values)
2. **Embeds machine-readable metadata** for the AppBI import pipeline

## File structure
```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Dashboard Title</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
    .card { background: #1a1d27; border-radius: 12px; padding: 20px; }
    .span-3  { grid-column: span 3; }
    .span-4  { grid-column: span 4; }
    .span-6  { grid-column: span 6; }
    .span-12 { grid-column: span 12; }
    /* ... */
  </style>
</head>
<body>
  <!-- Visual chart divs — each div id must match a block_id in the metadata -->
  <div id="kpi-revenue" class="card span-3">...</div>
  <div id="chart-sales-trend" class="card span-8">...</div>

  <!-- AppBI embedded metadata block — MUST appear once, near </body> -->
  <script type="application/appbi-dashboard">
  { /* ... metadata JSON ... */ }
  </script>
</body>
</html>
```

## Embedded metadata schema
```json
{
  "version": "appbi-import/v1",
  "strict": true,
  "authoring_mode": "skill",

  // Optional: dashboard layout mode. Defaults to "grid".
  // "canvas" enables free-placement canvas. Use xPx/yPx/wPx/hPx/z in chart layout.
  "layout_mode": "grid",

  // Optional: dashboard visual tokens. Runtime accepts these aliases:
  // font or fontFamily, background or backgroundColor, density compact|normal|spacious,
  // cardStyle soft|sharp|flat|elevated, cardRadius, cardShadow, hoverAnimation.
  "theme_config": {
    "mode": "light",
    "accent": "blue",
    "font": "inter",
    "backgroundColor": "#ffffff",
    "density": "normal",
    "cardStyle": "soft"
  },

  "dashboard": {
    "title": "Dashboard Title (≤ 80 chars)",
    "description": "Optional description (≤ 400 chars)",
    "default_page_name": "Overview"
  },

  // Declares which source data keys this dashboard expects.
  "source_contract": {
    "expected_source_keys": ["orders", "products"],
    "multi_source": false
  },

  // Dataset operations applied before chart creation.
  "dataset_ops": [
    // add_column — adds a calculated/derived column to an existing source table
    {
      "op": "add_column",
      "source_key": "orders",
      "name": "revenue_per_order",
      "label": "Revenue Per Order",
      "expression": "ROUND(total_amount / GREATEST(order_count, 1), 2)"
    },
    // derived_table — creates a new aggregated virtual table from one or more sources
    {
      "op": "derived_table",
      "source_key": "monthly_revenue",
      "display_name": "Monthly Revenue Summary",
      "inputs": ["orders"],
      "sql_template": "SELECT order_month, SUM(total_amount) AS revenue, COUNT(*) AS order_count FROM {{source:orders}} GROUP BY order_month ORDER BY order_month",
      "output_columns": [
        {"name": "order_month", "type": "date"},
        {"name": "revenue", "type": "number"},
        {"name": "order_count", "type": "number"}
      ]
    }
  ],

  // Chart plans — one entry per visual block (chart OR widget)
  "charts": [
    // ── Regular AppBI chart (widget_type omitted = "chart") ──
    {
      "block_id": "chart-sales-trend",    // must match the div id in the HTML
      "order": 1,                          // render order for auto-layout fallback
      "title": "Monthly Sales Trend",
      "description": null,
      "chart_type": "LINE",               // any AppBI supported type
      "source_key": "monthly_revenue",    // references a source OR derived_table key
      "role_config": {
        "dimension": "order_month",
        "metrics": [{"field": "revenue", "agg": "sum"}]
      },
      "base_filters": [],
      "layout": {"x": 0, "y": 2, "w": 8, "h": 4},  // 12-col grid; x+w ≤ 12
      "size_hint": "medium",
      "style_config": {},
      "conversion_note": null
    },

    // ── KPI card ──
    {
      "block_id": "kpi-total-revenue",
      "order": 2,
      "title": "Total Revenue",
      "chart_type": "KPI",
      "source_key": "orders",
      "role_config": {
        "metrics": [{"field": "total_amount", "agg": "sum"}]
      },
      "base_filters": [],
      "layout": {"x": 0, "y": 0, "w": 3, "h": 2},
      "size_hint": "kpi"
    },

    // ── Text widget (no chart, no source data required) ──
    {
      "block_id": "text-intro",
      "order": 0,
      "title": "Section Header",
      "widget_type": "text",           // "text" | "image" | "countdown" | "shape"
      "widget_config": {
        "markdown": "## Monthly Sales Report\\nThis dashboard shows revenue trends."
      },
      "layout": {"x": 0, "y": 0, "w": 12, "h": 2}
    },

    // ── Image widget ──
    {
      "block_id": "img-logo",
      "order": 0,
      "title": "Company Logo",
      "widget_type": "image",
      "widget_config": {
        "url": "https://example.com/logo.png",
        "alt": "Company Logo"
      },
      "layout": {"x": 9, "y": 0, "w": 3, "h": 2}
    }
  ]
}
```

## Layout coordinate system
- **12-column grid** (layout_mode = "grid"):
  - `x` : 0–11, column start (0-indexed)
  - `y` : 0+, row start (rows stack automatically; higher y = lower on page)
  - `w` : 1–12, width in columns (x + w ≤ 12)
  - `h` : height in row units (~50px per unit; KPI ≈ 2, chart ≈ 4–6, table ≈ 6–8)
- **canvas** (layout_mode = "canvas"):
  - prefer `xPx`, `yPx`, `wPx`, `hPx`, `z` for pixel-perfect placement
  - keep `x`, `y`, `w`, `h` too as a grid fallback when possible

## Supported chart_type values
TABLE, MATRIX, KPI, GAUGE, BULLET, PODIUM,
BAR, HORIZONTAL_BAR, GROUPED_BAR, STACKED_BAR, BAR_LINE, WATERFALL,
LINE, AREA, TIME_SERIES, RIBBON, TIMELINE,
PIE, DONUT, POLAR_AREA, TREEMAP, FUNNEL, WORD_CLOUD,
SCATTER, BUBBLE, HEATMAP, BOXPLOT, RADAR, SANKEY, SUNBURST,
MAP_POINT, MAP_REGION

## role_config shapes by chart type
- KPI / GAUGE / BULLET:   { "metrics": [{"field": "col", "agg": "sum|avg|max|min|count"}] }
- BAR / LINE / AREA:       { "dimension": "col", "metrics": [{"field": "col", "agg": "..."}] }
- PIE / DONUT:             { "dimension": "col", "metrics": [{"field": "col", "agg": "..."}] }
- TABLE:                   { "dimensions": ["col1", "col2"], "metrics": [{"field":"col","agg":"..."}] }
- SCATTER / BUBBLE:        { "x": "col", "y": "col", "size?": "col", "color?": "col" }
- HEATMAP:                 { "x": "col", "y": "col", "value": "col" }
- GROUPED_BAR / STACKED_BAR: { "dimension": "col", "group": "col", "metrics": [...] }

## base_filters format
[
  {"field": "col", "op": "eq|neq|gt|gte|lt|lte|in|not_in|contains|is_null|is_not_null",
   "value": "..."}
]

## widget_type options
| widget_type | widget_config keys |
|---|---|
| "chart"     | (none — use chart_type + role_config) |
| "text"      | {"markdown": "..."} (runtime also accepts {"template": "..."}) |
| "image"     | {"url": "...", "alt": "..."} |
| "countdown" | {"target_date": "2026-12-31T00:00:00"} (runtime also accepts {"target": "..."}) |
| "shape"     | {"shape": "rectangle|circle|line", "color": "#hex"} (runtime also accepts {"kind": "rect|circle|line|divider"}) |

## style_config keys covered by the dashboard runtime
- General chart style: `palette`, `fontSize`, `showDataLabels`, `numberFormat`, `currencySymbol`.
- Axes/legend/grid: `xAxisLabel`, `yAxisLabel`, `legendPosition`, `showGrid`.
- Bar/line: `barRadius`, `barSize`, `lineStyle`, `lineWidth`, `showDots`.
- Benchmark: `showBenchmarkLine`, `benchmarkValue`, `benchmarkLabel`, `benchmarkColor`.
- Tables: `tableConditionalFormatting`, `tableHeatmapRules`.
- KPI: `kpiIconName`, `kpiGradientBg`.
- Interaction: hover tooltip is automatic; click-to-filter is runtime-driven. Do not promise custom zoom/pan unless the frontend feature is explicitly enabled.

## source_mode options (for analyze/build calls)
- "existing_dataset" — source data is already in an AppBI dataset; pass dataset_id
- "upload_excel"     — source is an Excel/CSV file uploaded at build time

## Important rules
1. Every `block_id` in `charts[]` MUST match a `div id="..."` in the HTML visual section
2. `source_key` in each chart must match a key in `expected_source_keys` OR a `derived_table.source_key`
3. Column names in `role_config` should match actual column names in the source data (case-insensitive resolution is applied during import)
4. Derived table `sql_template` must use `{{source:source_key}}` placeholders for FROM clauses
5. For `upload_excel` mode, sheet names in the Excel file become the source_keys
""".strip()


@tool("all")
async def get_html_dashboard_spec(ctx: Context | None = None) -> dict[str, Any]:
    """Return the AppBI Import Plan v1 HTML spec.

    Call before writing HTML. Flow: this → write HTML → analyze_html_import
    → build_dashboard_from_html.
    """
    return {"spec": _HTML_DASHBOARD_SPEC}


# ---------------------------------------------------------------------------
# Analyze — server-side validation of HTML chart plans
# ---------------------------------------------------------------------------


@tool("all")
async def analyze_html_import(
    html_content: str,
    source_mode: str,
    dataset_id: int | None = None,
    dataset_table_id: int | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Analyze an AppBI Import Plan v1 HTML; returns chart_plans + warnings.

    `source_mode`: "existing_dataset" (needs dataset_id) | "upload_excel".
    Returns: suggested_dashboard_name, chart_plans, calculated_fields,
    derived_tables, ignored_blocks, warnings, ai_meta. Review warnings
    before calling build_dashboard_from_html.
    """
    if not str(html_content or "").strip():
        return {"error": "html_content is required"}

    normalized_source_mode = str(source_mode or "existing_dataset").strip().lower()
    if normalized_source_mode not in {"existing_dataset", "upload_excel"}:
        return {"error": "source_mode must be 'existing_dataset' or 'upload_excel'"}

    form_data: dict[str, str] = {
        "html_content": html_content,
        "source_mode": normalized_source_mode,
    }
    if dataset_id is not None:
        form_data["dataset_id"] = str(int(dataset_id))
    if dataset_table_id is not None:
        form_data["dataset_table_id"] = str(int(dataset_table_id))

    if normalized_source_mode == "existing_dataset" and dataset_id is None and dataset_table_id is None:
        return {
            "error": "dataset_id (or dataset_table_id) is required when source_mode='existing_dataset'",
            "hint": (
                "Call list_datasets to find the right dataset_id. If the source data is an "
                "Excel file not yet in AppBI, use source_mode='upload_excel' and pass the "
                "excel_path at build time."
            ),
        }

    try:
        result = await _form_request(
            "POST",
            "/dashboards/import-html/analyze",
            data=form_data,
        )
    except RuntimeError as exc:
        return {"error": str(exc)}

    if not isinstance(result, dict):
        return {"error": "Unexpected response from backend", "raw": str(result)}

    # Surface a clear summary to help Claude decide whether to proceed.
    chart_plans = result.get("chart_plans") or []
    warnings = result.get("warnings") or []
    widget_plans = [p for p in chart_plans if str(p.get("widget_type") or "chart") != "chart"]
    real_chart_plans = [p for p in chart_plans if str(p.get("widget_type") or "chart") == "chart"]

    result["_summary"] = {
        "chart_count": len(real_chart_plans),
        "widget_count": len(widget_plans),
        "warning_count": len(warnings),
        "has_derived_tables": bool(result.get("derived_tables")),
        "has_calculated_fields": bool(result.get("calculated_fields")),
        "ready_to_build": len(warnings) == 0 or all(
            "not found" not in str(w).lower() for w in warnings
        ),
        "next_step": (
            "Review warnings above before calling build_dashboard_from_html"
            if warnings
            else "No warnings — safe to call build_dashboard_from_html"
        ),
    }
    return result


# ---------------------------------------------------------------------------
# Build — materialise Dashboard + Charts from the analyzed plan
# ---------------------------------------------------------------------------


@tool("all")
async def build_dashboard_from_html(
    analysis_json: str,
    source_mode: str,
    dashboard_name: str | None = None,
    target_mode: str = "new_dashboard",
    dataset_id: int | None = None,
    layout_mode: str | None = None,
    theme_config: dict[str, Any] | None = None,
    canvas_config: dict[str, Any] | None = None,
    target_dashboard_id: int | None = None,
    included_block_ids: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Materialise a dashboard from analyze_html_import output.

    `analysis_json`: JSON string of the analysis dict.
    `source_mode`: "existing_dataset" (needs dataset_id) | "upload_excel".
    `target_mode`: "new_dashboard" | "append_to_dashboard" (needs target_dashboard_id).
    `layout_mode`: "grid" | "canvas" (override HTML default).
    `included_block_ids`: optional subset; omit = import all.
    Returns: {dashboard_id, created_chart_count, page_id, page_name, dataset_id, ...}.
    """
    # ── Parse analysis ────────────────────────────────────────────────────
    try:
        analysis = json.loads(str(analysis_json))
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        return {"error": f"analysis_json is not valid JSON: {exc}"}
    if not isinstance(analysis, dict):
        return {"error": "analysis_json must decode to an object"}

    # ── Inject optional overrides into analysis ───────────────────────────
    if layout_mode is not None:
        normalized_lm = str(layout_mode).strip().lower()
        if normalized_lm not in {"grid", "canvas"}:
            return {"error": "layout_mode must be 'grid' or 'canvas'"}
        analysis["layout_mode"] = normalized_lm
    if theme_config is not None:
        analysis["theme_config"] = theme_config
    if canvas_config is not None:
        analysis["canvas_config"] = canvas_config

    # ── Confirmation plan ────────────────────────────────────────────────
    chart_plans = analysis.get("chart_plans") or []
    real_charts = [p for p in chart_plans if str(p.get("widget_type") or "chart") == "chart"]
    widget_count = len(chart_plans) - len(real_charts)
    warnings = analysis.get("warnings") or []

    plan = {
        "dashboard_name": dashboard_name or analysis.get("suggested_dashboard_name"),
        "source_mode": source_mode,
        "target_mode": target_mode,
        "chart_count": len(real_charts),
        "widget_count": widget_count,
        "has_calculated_fields": bool(analysis.get("calculated_fields")),
        "has_derived_tables": bool(analysis.get("derived_tables")),
        "layout_mode": analysis.get("layout_mode", "grid"),
        "analysis_warnings": warnings,
    }

    if not user_confirmed:
        return _requires_confirmation("build_dashboard_from_html", plan)

    # ── Build form data ──────────────────────────────────────────────────
    normalized_source_mode = str(source_mode or "").strip().lower()
    if normalized_source_mode not in {"existing_dataset", "upload_excel"}:
        return {"error": "source_mode must be 'existing_dataset' or 'upload_excel'"}

    normalized_target_mode = str(target_mode or "new_dashboard").strip().lower()
    if normalized_target_mode not in {"new_dashboard", "append_to_dashboard"}:
        return {"error": "target_mode must be 'new_dashboard' or 'append_to_dashboard'"}

    form_data: dict[str, str] = {
        "analysis_json": json.dumps(analysis, ensure_ascii=False),
        "source_mode": normalized_source_mode,
        "target_mode": normalized_target_mode,
    }
    if dashboard_name:
        form_data["dashboard_name"] = str(dashboard_name).strip()
    if dataset_id is not None:
        form_data["dataset_id"] = str(int(dataset_id))
    if target_dashboard_id is not None:
        form_data["target_dashboard_id"] = str(int(target_dashboard_id))
    if included_block_ids is not None:
        form_data["included_block_ids_json"] = json.dumps(included_block_ids)

    try:
        result = await _form_request(
            "POST",
            "/dashboards/import-html/build",
            data=form_data,
            timeout_seconds=APPBI_LONG_TIMEOUT_SECONDS,
        )
    except RuntimeError as exc:
        return {"error": str(exc)}

    if not isinstance(result, dict):
        return {"error": "Unexpected response from backend", "raw": str(result)}

    dashboard_obj = result.get("dashboard") if isinstance(result.get("dashboard"), dict) else {}
    return {
        "status": "created",
        "dashboard_id": result.get("dashboard_id"),
        "dashboard_name": dashboard_obj.get("name") or dashboard_name,
        "created_chart_count": result.get("created_chart_count"),
        "created_widget_count": result.get("created_widget_count"),
        "page_id": result.get("page_id"),
        "page_name": result.get("page_name"),
        "dataset_id": result.get("dataset_id"),
        "dataset_table_id": result.get("dataset_table_id"),
        "type_changes": result.get("type_changes") or [],
    }


@tool("all")
async def validate_html_import_plans(
    analysis_json: str,
    dataset_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Re-validate every chart_plan against the live dataset.

    Use after manually editing chart_plans from analyze_html_import.
    Pure validation (no BE LLM); surfaces real engine errors.
    Returns `{results: [{block_id, status:'ok'|'error', error?, ...}]}`.
    """
    try:
        analysis = json.loads(str(analysis_json))
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        return {"error": f"analysis_json is not valid JSON: {exc}"}
    if not isinstance(analysis, dict):
        return {"error": "analysis_json must decode to an object"}

    form_data = {
        "analysis_json": json.dumps(analysis, ensure_ascii=False),
        "dataset_id": str(int(dataset_id)),
    }
    try:
        return await _form_request(
            "POST",
            "/dashboards/import-html/validate-plans",
            data=form_data,
        )
    except RuntimeError as exc:
        return {"error": str(exc)}


@tool("all")
async def dry_run_build_html_dashboard_import(
    analysis_json: str,
    source_mode: str,
    dashboard_name: str | None = None,
    target_mode: str = "new_dashboard",
    dataset_id: int | None = None,
    target_dashboard_id: int | None = None,
    included_block_ids: list[str] | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Preview the full build pipeline without writing (savepoint+rollback).

    Response mirrors a real build (would_create counts, page_id,
    type_changes). Use after validate_html_import_plans returns clean.

    `source_mode`: "existing_dataset" | "upload_excel".
    `target_mode`: "new_dashboard" | "append_to_dashboard".

    Caveat: background embedding/LLM workers scheduled during build
    are NOT rolled back (BE handles the orphans).
    """
    try:
        analysis = json.loads(str(analysis_json))
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        return {"error": f"analysis_json is not valid JSON: {exc}"}
    if not isinstance(analysis, dict):
        return {"error": "analysis_json must decode to an object"}

    normalized_source_mode = str(source_mode or "").strip().lower()
    if normalized_source_mode not in {"existing_dataset", "upload_excel"}:
        return {"error": "source_mode must be 'existing_dataset' or 'upload_excel'"}

    normalized_target_mode = str(target_mode or "new_dashboard").strip().lower()
    if normalized_target_mode not in {"new_dashboard", "append_to_dashboard"}:
        return {"error": "target_mode must be 'new_dashboard' or 'append_to_dashboard'"}

    form_data: dict[str, str] = {
        "analysis_json": json.dumps(analysis, ensure_ascii=False),
        "source_mode": normalized_source_mode,
        "target_mode": normalized_target_mode,
    }
    if dashboard_name:
        form_data["dashboard_name"] = str(dashboard_name).strip()
    if dataset_id is not None:
        form_data["dataset_id"] = str(int(dataset_id))
    if target_dashboard_id is not None:
        form_data["target_dashboard_id"] = str(int(target_dashboard_id))
    if included_block_ids is not None:
        form_data["included_block_ids_json"] = json.dumps(included_block_ids)

    try:
        return await _form_request(
            "POST",
            "/dashboards/import-html/dry-run-build",
            data=form_data,
        )
    except RuntimeError as exc:
        return {"error": str(exc)}


__all__: list[str] = []
