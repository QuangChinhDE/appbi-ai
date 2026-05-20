"""Blueprint workflow — the canonical path from user intent to dashboard.

Why this module exists
----------------------
Without a blueprint stage, Claude reaches straight for `create_chart` /
`create_dashboard` and produces output that *renders* but is structurally
wrong: charts with no semantic binding, ad-hoc metrics that never appear
on the dataset's measure list, dashboards that read fine on screen but
break the moment a human opens Explore. The blueprint stage forces a
**design pass** the user can review *before* anything is written, and a
**measure-authoring pass** that puts metrics in the right place
(SemanticView.measures, not chart.config).

Canonical flow this module enforces
-----------------------------------
    Stage 3 — Semantic
        propose_semantic_model(dataset_id, business_intent)
            → returns a structured plan (views + measures + joins)
              and `open_questions_for_user` Claude must surface
        commit_semantic_model(plan_json, user_confirmed=True)
            → writes SemanticView rows so measures live in the model

    Stage 4 — Dashboard blueprint
        propose_dashboard_blueprint(dataset_id, business_intent)
            → chart specs that REFERENCE measures from Stage 3 (not bare
              column names). Backed by a server-side dry validation.
        commit_dashboard_blueprint(plan_json, user_confirmed=True)
            → creates charts (with valid dataset_table_id and
              semantic-resolvable metrics) + dashboard + placements.

Auditing pre-existing data
--------------------------
    audit_chart_semantic_health(dataset_id?)
        → flags charts with NULL dataset_table_id, ad-hoc metrics that
          don't resolve to any SemanticView.measure, or orphan
          placements. Read-only.
    repair_chart_semantic_binding(chart_id, dataset_table_id?)
        → re-points a chart at a valid dataset_table_id and (optionally)
          adds the missing measure to the corresponding SemanticView.

Hard vs soft gates
------------------
- Semantic measure integrity is hard-gated server-side (commit refuses
  to write a chart whose metrics don't resolve).
- Blueprint usage is soft-gated via instructions — Claude is told to
  prefer this flow but `create_chart` still exists for ad-hoc edits
  initiated by the user.

This module deliberately does no LLM calls. Claude is the LLM; the
backend is the executor; this module is the contract between them.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
from typing import Any

_IDENT_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

from appbi_core import (
    APPBI_LONG_TIMEOUT_SECONDS,
    Context,
    _append_session_log,
    _drop_none,
    _render_dashboard_html_preview,
    _request,
    _requires_confirmation,
    _session_log_dir,
    logger,
    tool,
)


# ---------------------------------------------------------------------------
# Blueprint shapes (documented here so Claude can structure its output)
# ---------------------------------------------------------------------------


SEMANTIC_MODEL_PLAN_SHAPE = {
    "dataset_id": "<int>",
    "model": {
        "name": "<str — usually `<dataset_name>_model`>",
        "description": "<str — what this model represents>",
    },
    "views": [
        {
            "dataset_table_id": "<int>",
            "name": "<str — short identifier, snake_case>",
            "description": "<str>",
            "dimensions": [
                {
                    "name": "<str — column or alias>",
                    "type": "string|number|date|datetime|yesno",
                    "sql": "${TABLE}.<col>  (optional — defaults to ${TABLE}.<name>)",
                    "label": "<str — human-readable>",
                    "description": "<str>",
                }
            ],
            "measures": [
                # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                # MEASURE — REQUIRED fields. The 3-line minimal form below is
                # what 95% of measures look like. Optional fields come after.
                # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                {
                    # REQUIRED — unique within this view, snake_case.
                    "name": "<str — e.g. total_revenue>",
                    # REQUIRED — what aggregation to apply.
                    "type": "count|sum|avg|min|max|count_distinct|percent_of_total",
                    # REQUIRED for every type EXCEPT "count" — the column to
                    # aggregate. Use ${TABLE}.<actual_column_name> referencing
                    # a real column on this view's dataset_table. The MCP
                    # pre-flight (Phase-15.29) rejects non-count measures
                    # without sql; the BE Pydantic validator rejects them
                    # too. DO NOT use the measure name as the column name
                    # unless that column literally exists in the source data.
                    "sql": "${TABLE}.<actual_column_name_in_source>",
                    "label": "<str — human readable, optional>",
                    "description": "<str — business meaning, optional>",
                    "folder": "<str — optional UI grouping, e.g. 'Revenue'>",
                    # `expression` 2 modes (non-count: sql OR expression required):
                    #   Mode 1 row-level (depends_on=[]): "${TABLE}.a - ${TABLE}.b"
                    #     → SUM(a-b). Aggregates inside expression are FORBIDDEN
                    #     in this mode (would double-aggregate).
                    #   Mode 2 ratio/measure-formula (depends_on set):
                    #     expression: "${revenue} / NULLIF(${deal_won}, 0)"
                    #     depends_on: ["revenue","deal_won"]
                    #     → engine inlines each measure's full aggregate SQL.
                    "expression": "<str — optional SQL expression, overrides sql>",
                    # Structured filters → CASE WHEN wrapper (Looker-style
                    # filtered measure). Example: revenue from paid orders only.
                    "filters": [
                        {
                            "field": "<str — bare column or view.col>",
                            "operator": "eq|ne|neq|gt|gte|lt|lte|in|not_in|between|"
                                        "contains|not_contains|starts_with|ends_with|"
                                        "is_null|is_not_null",
                            "value": "<scalar | [a,b,...] for in/not_in | [lo,hi] for between | null for is_null/is_not_null>",
                        }
                    ],
                    # Raw WHERE fragment, AND-combined with `filters`. Reserve
                    # for predicates the structured builder cannot express.
                    "where_sql": "<str — optional raw SQL boolean fragment>",
                    # Names of other measures on the SAME view referenced by
                    # `expression` (e.g. ratio = revenue / orders → ['revenue','orders']).
                    # Used for cycle detection; the actual reference still
                    # happens through SQL inside `expression`.
                    "depends_on": ["<str — measure name>"],
                    # Display format hint (does not affect SQL).
                    "format": {
                        "kind": "number|currency|percent|duration|custom",
                        "decimals": "<int 0..10 — optional>",
                        "currency": "<str — e.g. 'USD', 'VND' — only when kind=currency>",
                        "prefix": "<str — optional>",
                        "suffix": "<str — optional, e.g. ' orders'>",
                        "pattern": "<str — only when kind=custom>",
                    },
                    # ── Phase-12 extensions: dataset-scope measure (Power BI parity) ──
                    # Default scope='view' — measure aggregates columns from its
                    # parent view only. Use scope='dataset' when measure needs
                    # columns from OTHER views joined into the model (cross-table
                    # aggregation). Engine auto-joins via the dataset join graph;
                    # `source_columns` tells engine which views to pull in.
                    # Example: revenue_per_lead lives in `analytics` view but
                    # references deals.amount and leads.id —
                    #   scope: "dataset"
                    #   expression: "${deals.amount} / NULLIF(COUNT(${leads.id}), 0)"
                    #   source_columns: [{view: "deals", field: "amount"},
                    #                    {view: "leads", field: "id"}]
                    # Rules enforced by BE (and pre-validated here):
                    #   * scope='view' + non-empty source_columns → reject
                    #   * scope='dataset' + empty source_columns → reject
                    #   * source_columns[].view must exist in plan views[]
                    #   * source_columns[].field must exist as dimension/column
                    "scope": "view|dataset  (default 'view'; omit if not cross-table)",
                    "source_columns": [
                        {
                            "view": "<str — name of view in plan>",
                            "field": "<str — bare column / dimension name on that view>",
                        }
                    ],
                    # ── Phase-14 extensions: filter-context modifiers ──
                    # Turn the measure into a SQL window aggregate so it
                    # bypasses chart filter context. Omit entirely for a
                    # plain GROUP-BY aggregate (legacy default).
                    #
                    # Use cases:
                    #   - "% of grand total"      → [{type: "all"}]
                    #   - "% of region total"     → [{type: "all_except",
                    #                                 keep_fields: ["region"]}]
                    #   - Use an inactive join    → [{type: "use_relationship",
                    #                                 join_alias: "creator"}]
                    #
                    # Hard rules (validator rejects on commit_semantic_model):
                    #   * 'all' and 'all_except' cannot coexist on the same
                    #     measure (opposite semantics).
                    #   * 'all_except' requires keep_fields (≥1 entry).
                    #   * 'use_relationship' requires join_alias matching a
                    #     JoinDefinition.alias on the dataset's explore.
                    #
                    # 'use_relationship' is SCHEMA-ONLY in Phase-14 — the
                    # engine accepts the modifier but does not yet route via
                    # that alias when compiling FROM/JOIN. Safe to save; it
                    # will become effective when wired in a follow-up phase.
                    "context_modifiers": [
                        {
                            "type": "all|all_except|use_relationship",
                            "keep_fields": ["<str — only for all_except>"],
                            "join_alias": "<str — only for use_relationship>",
                        }
                    ],
                }
            ],
        }
    ],
    "explores": [
        {
            "name": "<str — chart-facing name>",
            "base_view_name": "<str — must match one of views[].name>",
            "joins": [
                {
                    "name": "<str>",
                    "view": "<str — target view name>",
                    "type": "left|inner|right|full",
                    "sql_on": "${TABLE}.<col> = ${<other_view>}.<col>",
                    "relationship": "one_to_one|one_to_many|many_to_one|many_to_many",
                }
            ],
        }
    ],
    "narrative": "<str — 2-3 sentence summary of what this model enables>",
    "open_questions_for_user": [
        "<str — questions Claude should ask before commit>"
    ],
}


# Maximum charts a single commit_dashboard_blueprint call can handle before
# we refuse upfront. Empirically larger blueprints time out at the validation
# stage because each chart runs a runtime preview query.
_BLUEPRINT_MAX_CHARTS = 20


# Safe layout defaults per chart_type (react-grid-layout: 12 cols × 80px row).
# Picked from the FE dashboard defaults + manual QA on truncation behaviour.
_LAYOUT_DEFAULTS: dict[str, tuple[int, int]] = {
    "KPI": (3, 2),
    "TABLE": (12, 5),
    "PIVOT_TABLE": (12, 5),
    "SCATTER": (6, 5),
    "MAP_POINT": (6, 5),
    "COMBO": (12, 4),
}
_LAYOUT_DEFAULT_FALLBACK = (6, 4)  # LINE, BAR, AREA, PIE, etc.
_LAYOUT_MIN_W = 3
_LAYOUT_MIN_H = 2


def _normalize_chart_layout(
    layout: Any,
    chart_type: str,
    index: int,
) -> dict[str, int]:
    """Return a layout dict that always renders without clipped axes.

    Falls back to a full-width stack when `layout` is missing/invalid.
    Clamps to per-chart-type minimums when Claude underspecifies. Charts
    render badly below ~w:3 (axis labels overlap) or ~h:2 (legend cuts
    into plot area), and we cannot recover from that downstream.
    """
    default_w, default_h = _LAYOUT_DEFAULTS.get(
        (chart_type or "").upper(), _LAYOUT_DEFAULT_FALLBACK
    )
    if not isinstance(layout, dict):
        return {"x": 0, "y": index * default_h, "w": 12, "h": default_h}
    try:
        x = max(0, min(11, int(layout.get("x", 0))))
        y = max(0, int(layout.get("y", index * default_h)))
        w = int(layout.get("w", default_w))
        h = int(layout.get("h", default_h))
    except (TypeError, ValueError):
        return {"x": 0, "y": index * default_h, "w": 12, "h": default_h}
    w = max(_LAYOUT_MIN_W, min(12, w))
    if x + w > 12:
        w = 12 - x
    h = max(_LAYOUT_MIN_H, h)
    return {"x": x, "y": y, "w": w, "h": h}


def _measure_chart_compatibility(measure: dict[str, Any]) -> dict[str, Any]:
    """Decide whether a semantic measure can be referenced directly in a chart.

    Phase 11/12 routing (chart_service.py:129 `_role_config_needs_semantic_runtime`):
      * Bare ref → legacy `build_live_agg_query` (live_query_service) treats
        the field as a raw column on the bound view. Does NOT compile
        expression / filters / where_sql.
      * Qualified `view.field` ref → SemanticQueryEngine compiles measure
        SQL (expression, filtered measure, dataset-scope JOIN) correctly.

    For backward compat with charts authored before Phase 11, this helper
    marks measures with `expression`, `filters`, or `where_sql` as
    "chart_incompatible" so the agent prefers a workaround (materialise via
    transformation, or use count_distinct + structured filter). The agent
    CAN reference these measures with qualified refs and they will work —
    the warning exists because Claude-generated dashboards often use bare
    refs as a habit, and qualifying every metric ref is more reliable.

    Returns: {"compatible": bool, "reason": str|None, "workaround": str|None}.
    """
    if not isinstance(measure, dict):
        return {"compatible": False, "reason": "invalid_measure", "workaround": None}
    has_expression = bool((measure.get("expression") or "").strip())
    filters = measure.get("filters") or []
    has_filters = isinstance(filters, list) and len(filters) > 0
    has_where_sql = bool((measure.get("where_sql") or "").strip())
    if has_expression:
        return {
            "compatible": False,
            "reason": "computed_expression",
            "workaround": (
                "Materialise the expression as a derived dimension via a SQL "
                "transformation on the bound table, then aggregate normally; "
                "OR use execute_semantic_query (semantic engine path) which "
                "DOES resolve expressions but is not the chart-render path."
            ),
        }
    if has_filters or has_where_sql:
        base_field = (measure.get("sql") or "").strip() or measure.get("name")
        agg = (measure.get("type") or "count").lower()
        return {
            "compatible": False,
            "reason": "filtered_measure",
            "workaround": (
                f"Use base aggregation '{agg}' on '{base_field}' with the same "
                "predicate copied into role_config.filters / baseFilters. The "
                "chart will produce identical numbers but stays renderable."
            ),
        }
    return {"compatible": True, "reason": None, "workaround": None}


DASHBOARD_BLUEPRINT_SHAPE = {
    "dataset_id": "<int>",
    "dashboard": {
        "name": "<str>",
        "description": "<str>",
        "target_audience": "<str — who reads this>",
        "success_criteria": "<str — what decision this enables>",
    },
    "narrative": "<str — the story this dashboard tells, top to bottom>",
    "metric_definitions": [
        {
            "name": "<str — MUST equal a measure name on the bound view>",
            "view": "<str — the SemanticView this measure lives on>",
            "formula": "<str — human-readable, e.g. 'SUM(orders.amount) where status=paid'>",
            "why_this_matters": "<str — business reason>",
            # Optional — fill these to remind yourself which Phase-1
            # capabilities the measure relies on. They are documentation
            # only; the real definition lives on the SemanticView.
            "filtered": "<bool — true if the measure has filters/where_sql>",
            "format_hint": "<str — e.g. 'currency USD, 0 decimals' / 'percent'>",
        }
    ],
    "charts": [
        {
            "title": "<str>",
            "chart_type": "BAR|LINE|KPI|...  (uppercase AppBI enum)",
            "dataset_table_id": "<int — must belong to dataset_id>",
            "role_config": {
                "dimension": "<str — column on the bound view>",
                "metrics": [
                    {
                        "field": "<str — MUST match a metric_definitions[].name>",
                        "agg": "sum|avg|count|...",
                    }
                ],
            },
            # layout (optional): omit to stack full-width safely. Defaults:
            # KPI=3×2, LINE/BAR/AREA/PIE=6×4, TABLE/PIVOT=12×5, SCATTER=6×5.
            "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
            "why_this_chart": "<str — why this visualization for this question>",
        }
    ],
    "open_questions_for_user": [
        "<str — anything Claude is unsure about>"
    ],
}


# ---------------------------------------------------------------------------
# Semantic model plan
# ---------------------------------------------------------------------------


@tool({"report", "explore"})
async def propose_semantic_model(
    dataset_id: int,
    business_intent: str,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Stage 3 — plan a semantic model for a dataset. Read-only.

    Returns existing_model, tables, plan_template, guidance. UPDATE
    instead of duplicate-create when a view already covers a table.

    Measures: non-count types MUST set sql='${TABLE}.<real_column>' OR
    expression. Setting sql=<measure_name> is rejected. See plan_template
    for `expression` modes (row-level vs ratio-of-measures).
    """
    intent = str(business_intent or "").strip()
    if not intent:
        raise ValueError(
            "business_intent is required — describe in 1-2 sentences what "
            "the user wants to analyze. Without it, Claude has no signal "
            "for which measures matter."
        )

    try:
        existing_model = await _request("GET", f"/datasets/{int(dataset_id)}/model")
    except RuntimeError as exc:
        logger.warning("Failed to load existing model for dataset %s: %s", dataset_id, exc)
        existing_model = {"generated": False, "views": [], "explores": []}

    # Pull the lighter table list (no columns_cache) instead of the full
    # /datasets/{id} payload. columns_cache duplicates what
    # get_table_profile already returned for any table Claude actually
    # cares about — re-sending it here was costing ~3-5K tokens per call
    # for nothing.
    try:
        tables_raw = await _request(
            "GET", f"/datasets/{int(dataset_id)}/tables"
        )
    except RuntimeError as exc:
        logger.warning("Failed to load tables for dataset %s: %s", dataset_id, exc)
        tables_raw = []

    tables_summary = []
    for table in (tables_raw or []):
        if not isinstance(table, dict):
            continue
        tables_summary.append(
            {
                "id": table.get("id"),
                "display_name": table.get("display_name"),
                "source_kind": table.get("source_kind"),
                "row_count_estimate": table.get("estimated_row_count"),
            }
        )

    return {
        "stage": "propose_semantic_model",
        "dataset_id": int(dataset_id),
        "business_intent": intent,
        "existing_model": {
            "generated": bool(existing_model.get("generated")),
            "model_id": existing_model.get("model_id"),
            "dataset_name": existing_model.get("dataset_name"),
            "view_count": len(existing_model.get("views") or []),
            "explore_count": len(existing_model.get("explores") or []),
            "views": [
                {
                    "id": v.get("id"),
                    "name": v.get("name"),
                    "dataset_table_id": v.get("dataset_table_id"),
                    "dimension_count": len(v.get("dimensions") or []),
                    "measure_count": len(v.get("measures") or []),
                }
                for v in (existing_model.get("views") or [])
            ],
        },
        "tables": tables_summary,
        "tables_note": (
            "Light list — no columns. Call get_table_profile(table_id) "
            "for any table you have not already profiled in this session. "
            "Reuse the response from conversation context if you have."
        ),
        "plan_template": SEMANTIC_MODEL_PLAN_SHAPE,
        "guidance": {
            "measure_naming": "Use business names (total_revenue), not column "
                              "names (sum_amount). Measures live on the view "
                              "and are reused across charts.",
            "measure_sql": "Reference the underlying column with ${TABLE}.col. "
                           "Type field controls the aggregation; sql is just "
                           "the operand. e.g. type=sum, sql=${TABLE}.amount.",
            "measure_expression_when": "Use `expression` (overrides `sql`) for "
                                       "arithmetic across columns: "
                                       "type=sum + expression='${TABLE}.amount - "
                                       "${TABLE}.cost' produces SUM(amount-cost). "
                                       "For a single column, prefer `sql` — it is "
                                       "easier for users to edit in the UI.",
            "measure_filters_when": "Use `filters` for Looker-style filtered "
                                    "measures (revenue ONLY for paid orders, "
                                    "count of late shipments, etc). Each filter "
                                    "becomes a CASE WHEN wrapper so the aggregate "
                                    "only sees qualifying rows. Always prefer "
                                    "structured `filters` over `where_sql` — "
                                    "users without SQL can edit them in the UI. "
                                    "Reserve `where_sql` for predicates the "
                                    "operator list cannot express (date math, "
                                    "regex, multi-column comparisons).",
            "measure_depends_on": "Whenever `expression` references another "
                                  "measure by name, list that measure in "
                                  "`depends_on` so cycle-detection can run. "
                                  "Self-reference and circular chains are "
                                  "rejected at commit time.",
            "measure_format": "Set `format` so charts/KPIs render numbers "
                              "consistently: kind='currency' + currency='USD' "
                              "for money, kind='percent' for ratios "
                              "(0..1 → '50%'), kind='number' + decimals=0 for "
                              "counts. The format does NOT affect SQL — only "
                              "display — but downstream charts inherit it.",
            "measure_folder": "Group related measures with the same `folder` "
                              "label (e.g. 'Revenue', 'Funnel') so the Explore "
                              "panel can collapse them. Pure cosmetics; safe to "
                              "omit.",
            "filtered_vs_pivot": "A filtered measure is a fixed slice baked into "
                                 "the model (e.g. `paid_revenue`). It is NOT the "
                                 "same as a chart pivot/breakdown — for ad-hoc "
                                 "comparisons across categories, use a pivot in "
                                 "the chart instead of creating one filtered "
                                 "measure per category.",
            "dimension_sql_default": "Omit `sql` if the dimension name equals "
                                     "the column name. The backend defaults "
                                     "to ${TABLE}.<name>.",
            "join_sql_on": "Use ${TABLE}.col = ${other_view}.col format. "
                           "${TABLE} resolves to base_view alias.",
            "do_not_create_duplicate_views": "If existing_model.views already "
                                             "has an entry for a table, plan "
                                             "an update via update_semantic_view "
                                             "instead of recreating it.",
        },
        "next_step": (
            "Author plan_json matching plan_template. Surface "
            "open_questions_for_user to the human and wait for answers. "
            "Then call commit_semantic_model(plan_json, user_confirmed=True)."
        ),
    }


@tool("explore")
async def commit_semantic_model(
    plan_json: str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Stage 3 commit — execute the semantic model plan from propose_semantic_model.

    `plan_json`: JSON string of the plan. Writes: model, views (create/update
    by dataset_table_id or name), explores. First call returns diff; pass
    user_confirmed=True to write. Refuses views with zero measures.
    """
    plan = _parse_plan_json(plan_json, "plan_json")

    dataset_id = _require_int(plan, "dataset_id")
    views_plan = plan.get("views") or []
    explores_plan = plan.get("explores") or []
    model_plan = plan.get("model") or {}

    if not isinstance(views_plan, list) or not views_plan:
        raise ValueError("plan must include at least one view in `views`.")

    validation_errors: list[str] = []
    # Phase-15.19: keep this list aligned with `_build_where_clause` in
    # `backend/app/services/semantic_query_engine.py` AND with FilterBuilder
    # in `frontend/src/components/explore/FilterBuilder.tsx`. Drift between
    # the three is what put DA's "between Jan-Dec" filter into the dropped
    # bucket — MCP validated OK, BE engine silently ignored.
    #
    # `neq` is an FE-only alias that the BE endpoint canonicalises to `ne`
    # via `_OP_ALIAS` (datasets.py + chart_service.py). We accept it here
    # so blueprints copy-pasted from FE chart configs validate without
    # extra normalisation work.
    _ALLOWED_FILTER_OPS = {
        "eq", "ne", "neq",
        "gt", "gte", "lt", "lte",
        "in", "not_in", "between",
        "contains", "not_contains",
        "starts_with", "ends_with",
        "is_null", "is_not_null",
    }
    _LIST_OPS = {"in", "not_in", "between"}
    _NO_VALUE_OPS = {"is_null", "is_not_null"}
    _ALLOWED_FORMAT_KINDS = {"number", "currency", "percent", "duration", "custom"}

    # Pre-pass: collect measure names per view name so cross-view depends_on
    # (`other_view.some_measure`) can be validated against the full plan.
    # Mirrors backend `_validate_measure_dependencies` (datasets.py) which
    # accepts both bare (same-view) and qualified (`view.measure`) refs.
    measure_names_by_view: dict[str, set[str]] = {}
    # Phase-12: dimension names per view so source_columns[].field can be
    # pre-validated before the plan hits the backend. Mirror BE validator
    # in datasets.py which also checks columns_cache; MCP can only check
    # dimensions declared in this plan, but that already catches the
    # common DA mistake of misnaming a field. BE still has final say on
    # columns_cache existence.
    dim_names_by_view: dict[str, set[str]] = {}
    for _v in views_plan:
        if not isinstance(_v, dict):
            continue
        _vname = str(_v.get("name") or "").strip()
        if not _vname:
            continue
        measure_names_by_view[_vname] = {
            str(_m.get("name") or "").strip()
            for _m in (_v.get("measures") or [])
            if isinstance(_m, dict) and str(_m.get("name") or "").strip()
        }
        dim_names_by_view[_vname] = {
            str(_d.get("name") or "").strip()
            for _d in (_v.get("dimensions") or [])
            if isinstance(_d, dict) and str(_d.get("name") or "").strip()
        }

    for index, view in enumerate(views_plan):
        if not isinstance(view, dict):
            validation_errors.append(f"views[{index}] is not an object.")
            continue
        if not view.get("name"):
            validation_errors.append(f"views[{index}].name is required.")
        measures = view.get("measures")
        if not measures:
            validation_errors.append(
                f"views[{index}] '{view.get('name', '?')}' has no measures. "
                "A view with no measures forces charts to invent ad-hoc "
                "metrics — define at least one measure (sum/avg/count/...) "
                "before committing."
            )
            continue

        # Phase-1 measure validation: catch obvious authoring mistakes here so
        # the user does not have to discover them in the chart editor.
        view_name = view.get("name", "?")
        measure_names = {
            str(m.get("name")) for m in measures
            if isinstance(m, dict) and m.get("name")
        }
        for m_idx, m in enumerate(measures):
            if not isinstance(m, dict):
                validation_errors.append(
                    f"views[{index}].measures[{m_idx}] is not an object."
                )
                continue
            m_name = m.get("name") or f"#{m_idx}"
            loc = f"views[{index}] '{view_name}'.measures '{m_name}'"

            # Phase-15.36: measure name must be a SQL-safe identifier.
            # The AppBI FE rejects bad names on save (regex
            # /^[a-zA-Z_][a-zA-Z0-9_]*$/), so a measure that slips into
            # the DB with a space (e.g. 'AVG Goal') blocks every later
            # edit of the view from the UI. BE itself doesn't enforce —
            # catch it here on the MCP write path.
            trimmed_name = str(m_name).strip()
            if trimmed_name and not _IDENT_RE.match(trimmed_name):
                suggestion = re.sub(r"[^a-zA-Z0-9_]+", "_", trimmed_name).strip("_").lower() or "measure"
                if not _IDENT_RE.match(suggestion):
                    suggestion = "_" + suggestion
                validation_errors.append(
                    f"{loc}.name {trimmed_name!r} is not a valid identifier. "
                    f"Use letters / digits / underscore only (no spaces, "
                    f"no accents). Suggested: {suggestion!r}. Put the "
                    "human-readable text in `label`, not `name`."
                )

            # Phase-15.29: non-count measures must declare the column being
            # aggregated. Caught here so Claude gets a clear error before
            # the BE rejection. Mirrors MeasureDefinition validator.
            m_type = (m.get("type") or "").strip().lower()
            m_sql = (m.get("sql") or "").strip()
            m_expr = (m.get("expression") or "").strip()
            if m_type and m_type != "count" and not m_sql and not m_expr:
                validation_errors.append(
                    f"{loc} type='{m_type}' but neither `sql` nor `expression` is "
                    f"set. Add sql='${{TABLE}}.<column>' (the column to "
                    "aggregate) — required for any agg ≠ count. Examples: "
                    "sum/avg/min/max/count_distinct/percent_of_total."
                )
            # Heuristic warning: sql == measure name often means Claude "picked
            # the easy path" and assumed there's a column matching the measure
            # name. Almost always wrong unless the dataset actually has such
            # a column. Surfaces as a non-blocking note (BE will still reject
            # if the column doesn't exist).
            if m_sql and "${" not in m_sql and m_sql == m_name:
                validation_errors.append(
                    f"{loc}.sql='{m_sql}' equals the measure name. This usually "
                    f"means the measure name was reused as a column reference. "
                    f"Use sql='${{TABLE}}.<actual_column_in_view>' instead."
                )

            # Phase-15.30: Path-C trap. An expression containing an aggregate
            # function (SUM/AVG/COUNT/MIN/MAX/COUNT_DISTINCT) WITHOUT a
            # `depends_on` list means the engine will WRAP this expression
            # in the measure's outer `type` aggregate — producing nonsense
            # like AVG(SUM(...)/COUNT(...)). This is the recurring "ratio
            # measure looks wrong" bug. Either:
            #   • inline raw column refs (${TABLE}.col) and let `type` wrap
            #     them with the single right aggregate, OR
            #   • split the formula into named measures and reference them
            #     via depends_on (Mode 2).
            if m_expr and not (m.get("depends_on") or []):
                expr_upper = m_expr.upper()
                contains_agg = any(
                    f"{fn}(" in expr_upper
                    for fn in ("SUM", "AVG", "COUNT", "MIN", "MAX")
                )
                if contains_agg:
                    validation_errors.append(
                        f"{loc}.expression contains an aggregate function "
                        f"(SUM/AVG/COUNT/MIN/MAX) but depends_on is empty. "
                        "The engine will wrap this with the outer "
                        f"{m_type or 'agg'} again → double-aggregation bug. "
                        "Either: (1) remove the aggregate from expression "
                        "and let `type` apply it ONCE, or "
                        "(2) extract each aggregated piece into its own "
                        "measure and use Mode 2 (expression with measure "
                        "refs + depends_on)."
                    )

            # filters
            for f_idx, f in enumerate(m.get("filters") or []):
                if not isinstance(f, dict):
                    validation_errors.append(f"{loc}.filters[{f_idx}] is not an object.")
                    continue
                if not f.get("field"):
                    validation_errors.append(f"{loc}.filters[{f_idx}].field is required.")
                op = (f.get("operator") or "").lower()
                if op not in _ALLOWED_FILTER_OPS:
                    validation_errors.append(
                        f"{loc}.filters[{f_idx}].operator '{op}' is invalid. "
                        f"Allowed: {sorted(_ALLOWED_FILTER_OPS)}."
                    )
                    continue
                val = f.get("value")
                if op in _NO_VALUE_OPS:
                    continue
                if op in _LIST_OPS and not isinstance(val, list):
                    validation_errors.append(
                        f"{loc}.filters[{f_idx}].value must be a list for "
                        f"operator '{op}' (got {type(val).__name__})."
                    )
                elif op == "between" and isinstance(val, list) and len(val) != 2:
                    validation_errors.append(
                        f"{loc}.filters[{f_idx}].value for 'between' must have "
                        f"exactly 2 elements [low, high]."
                    )
                elif op not in _LIST_OPS and val is None:
                    validation_errors.append(
                        f"{loc}.filters[{f_idx}].value is required for operator '{op}'."
                    )

            # depends_on — bare names refer to same view; "view.measure"
            # refers to a measure on another view in this plan. Self-ref
            # forbidden in either form. Mirrors backend qualify_dep().
            for dep in m.get("depends_on") or []:
                dep_raw = str(dep or "").strip()
                if not dep_raw:
                    continue
                if "." in dep_raw:
                    dep_view, dep_name = dep_raw.split(".", 1)
                    dep_view = dep_view.strip()
                    dep_name = dep_name.strip()
                else:
                    dep_view, dep_name = view_name, dep_raw
                if dep_view == view_name and dep_name == m_name:
                    validation_errors.append(
                        f"{loc}.depends_on includes self-reference '{dep_raw}'."
                    )
                    continue
                known_in_view = measure_names_by_view.get(dep_view)
                if known_in_view is None:
                    validation_errors.append(
                        f"{loc}.depends_on '{dep_raw}' references view '{dep_view}' "
                        f"which is not in this plan. Known views: "
                        f"{sorted(measure_names_by_view)}."
                    )
                elif dep_name not in known_in_view:
                    validation_errors.append(
                        f"{loc}.depends_on '{dep_raw}' is not a measure on view "
                        f"'{dep_view}'. Available there: {sorted(known_in_view)}."
                    )
            # depends_on without expression is almost certainly a mistake
            if (m.get("depends_on") or []) and not m.get("expression"):
                validation_errors.append(
                    f"{loc} declares depends_on but has no `expression` referencing them. "
                    "Either add the expression or remove depends_on."
                )

            # format
            fmt = m.get("format")
            if fmt is not None:
                if not isinstance(fmt, dict):
                    validation_errors.append(f"{loc}.format must be an object.")
                else:
                    kind = (fmt.get("kind") or "number").lower()
                    if kind not in _ALLOWED_FORMAT_KINDS:
                        validation_errors.append(
                            f"{loc}.format.kind '{kind}' invalid. "
                            f"Allowed: {sorted(_ALLOWED_FORMAT_KINDS)}."
                        )
                    if kind == "currency" and not fmt.get("currency"):
                        validation_errors.append(
                            f"{loc}.format.currency is required when kind='currency'."
                        )
                    decimals = fmt.get("decimals")
                    if decimals is not None and (
                        not isinstance(decimals, int) or decimals < 0 or decimals > 10
                    ):
                        validation_errors.append(
                            f"{loc}.format.decimals must be int 0..10."
                        )

            # ── Phase-12: scope + source_columns validation ──
            # Mirrors `_validate_measure_dependencies` (Phase-12 block) in
            # backend/app/api/datasets.py so DA gets the same error here
            # — without round-tripping through the BE.
            scope_raw = m.get("scope")
            source_cols = m.get("source_columns") or []
            if scope_raw is not None or source_cols:
                scope = str(scope_raw or "view").lower().strip()
                if scope not in ("view", "dataset"):
                    validation_errors.append(
                        f"{loc}.scope '{scope_raw}' invalid. Use 'view' (default) "
                        "or 'dataset' (cross-table measure)."
                    )
                elif scope == "view" and source_cols:
                    validation_errors.append(
                        f"{loc}.scope='view' but source_columns is non-empty. "
                        "Either remove source_columns, or set scope='dataset' if "
                        "the measure aggregates columns from other tables."
                    )
                elif scope == "dataset" and not source_cols:
                    validation_errors.append(
                        f"{loc}.scope='dataset' requires at least one entry in "
                        "source_columns. Each entry = {view: <view name>, "
                        "field: <bare column / dimension name>}. The engine uses "
                        "this to auto-JOIN the source views into the query."
                    )
                elif scope == "dataset":
                    for sc_idx, sc in enumerate(source_cols):
                        if not isinstance(sc, dict):
                            validation_errors.append(
                                f"{loc}.source_columns[{sc_idx}] must be an object "
                                "{view, field}."
                            )
                            continue
                        sc_view = str(sc.get("view") or "").strip()
                        sc_field = str(sc.get("field") or "").strip()
                        if not sc_view:
                            validation_errors.append(
                                f"{loc}.source_columns[{sc_idx}].view is required."
                            )
                        elif sc_view not in measure_names_by_view:
                            validation_errors.append(
                                f"{loc}.source_columns[{sc_idx}].view '{sc_view}' "
                                "is not declared in plan views[]. Known views: "
                                f"{sorted(measure_names_by_view)}."
                            )
                        if not sc_field:
                            validation_errors.append(
                                f"{loc}.source_columns[{sc_idx}].field is required."
                            )
                        elif sc_view in dim_names_by_view:
                            # Pre-check: field should match a declared dimension
                            # on that view. BE has the final say (it also
                            # consults columns_cache), so we only WARN-via-error
                            # if the plan has dimensions[] declared at all.
                            known_dims = dim_names_by_view.get(sc_view, set())
                            if known_dims and sc_field not in known_dims:
                                validation_errors.append(
                                    f"{loc}.source_columns[{sc_idx}].field "
                                    f"'{sc_field}' is not a declared dimension on "
                                    f"view '{sc_view}'. Declared dimensions: "
                                    f"{sorted(known_dims)}. (If field is a column "
                                    "not surfaced as a dimension, BE will still "
                                    "accept it if columns_cache has it.)"
                                )

            # ── Phase-14: context_modifiers pre-validation ──
            # Mirror the BE `_validate_context_modifiers` (Pydantic) +
            # cross-ref checks in datasets.py so Claude / DA hit errors at
            # MCP plan-commit time instead of round-tripping through BE.
            cmods = m.get("context_modifiers") or []
            if cmods:
                seen_all = False
                seen_all_except = False
                for ci, cmod in enumerate(cmods):
                    if not isinstance(cmod, dict):
                        validation_errors.append(
                            f"{loc}.context_modifiers[{ci}] must be an object."
                        )
                        continue
                    ct = str(cmod.get("type") or "").strip()
                    if ct == "all":
                        if cmod.get("keep_fields"):
                            validation_errors.append(
                                f"{loc}.context_modifiers[{ci}] type='all' "
                                "không nhận keep_fields. Dùng 'all_except' "
                                "nếu muốn giữ một số dim."
                            )
                        seen_all = True
                    elif ct == "all_except":
                        keep = cmod.get("keep_fields") or []
                        if not keep:
                            validation_errors.append(
                                f"{loc}.context_modifiers[{ci}] type='all_except' "
                                "phải có ít nhất 1 keep_fields."
                            )
                        else:
                            # Each kept field must be a declared dimension on
                            # this view (BE checks `current_view_dims`).
                            known_dims_here = dim_names_by_view.get(view_name, set())
                            if known_dims_here:
                                for kf in keep:
                                    kf_bare = str(kf or "").strip().split(".", 1)[-1]
                                    if kf_bare and kf_bare not in known_dims_here:
                                        validation_errors.append(
                                            f"{loc}.context_modifiers[{ci}].keep_fields "
                                            f"chứa '{kf}' không phải dimension trên "
                                            f"view '{view_name}'. Có sẵn: "
                                            f"{sorted(known_dims_here)}."
                                        )
                        seen_all_except = True
                    elif ct == "use_relationship":
                        if not (cmod.get("join_alias") or "").strip():
                            validation_errors.append(
                                f"{loc}.context_modifiers[{ci}] type='use_relationship' "
                                "phải có join_alias trỏ vào JoinDefinition.alias."
                            )
                    else:
                        validation_errors.append(
                            f"{loc}.context_modifiers[{ci}].type '{ct}' invalid. "
                            "Allowed: all | all_except | use_relationship."
                        )
                if seen_all and seen_all_except:
                    validation_errors.append(
                        f"{loc}.context_modifiers không thể đồng thời có 'all' và "
                        "'all_except' — chúng có ngữ nghĩa đối lập."
                    )

    # Cycle detection across the whole plan using qualified node names
    # (view.measure). Mirrors backend cycle check so two measures with the
    # same bare name on different views are treated as distinct nodes and
    # cross-view dependency cycles are caught.
    if not validation_errors:
        graph: dict[str, list[str]] = {}
        for _v in views_plan:
            if not isinstance(_v, dict):
                continue
            _vname = str(_v.get("name") or "").strip()
            if not _vname:
                continue
            for _m in _v.get("measures") or []:
                if not isinstance(_m, dict):
                    continue
                _mname = str(_m.get("name") or "").strip()
                if not _mname:
                    continue
                node = f"{_vname}.{_mname}"
                deps_q: list[str] = []
                for dep in _m.get("depends_on") or []:
                    dep_raw = str(dep or "").strip()
                    if not dep_raw:
                        continue
                    if "." in dep_raw:
                        dv, dn = dep_raw.split(".", 1)
                        deps_q.append(f"{dv.strip()}.{dn.strip()}")
                    else:
                        deps_q.append(f"{_vname}.{dep_raw}")
                graph[node] = deps_q

        visiting: set[str] = set()
        visited: set[str] = set()

        def _walk(node: str, path: list[str]) -> str | None:
            if node in visiting:
                return " -> ".join(path + [node])
            if node in visited:
                return None
            visiting.add(node)
            for dep in graph.get(node, []):
                cycle = _walk(dep, path + [node])
                if cycle:
                    return cycle
            visiting.discard(node)
            visited.add(node)
            return None

        for start in list(graph):
            cycle = _walk(start, [])
            if cycle:
                validation_errors.append(
                    f"Measure dependency cycle detected: {cycle}. "
                    "Break the cycle before committing."
                )
                break

    if validation_errors:
        return {
            "status": "validation_failed",
            "errors": validation_errors,
            "hint": "Fix the issues above and re-issue the plan_json.",
        }

    existing = await _request("GET", f"/datasets/{int(dataset_id)}/model")
    existing_views_by_table: dict[int, dict[str, Any]] = {}
    existing_views_by_name: dict[str, dict[str, Any]] = {}
    for v in existing.get("views") or []:
        if v.get("dataset_table_id") is not None:
            existing_views_by_table[int(v["dataset_table_id"])] = v
        if v.get("name"):
            existing_views_by_name[str(v["name"])] = v

    actions: list[dict[str, Any]] = []
    for view in views_plan:
        existing_match = None
        if view.get("dataset_table_id") is not None:
            existing_match = existing_views_by_table.get(int(view["dataset_table_id"]))
        if existing_match is None and view.get("name"):
            existing_match = existing_views_by_name.get(str(view["name"]))
        actions.append(
            {
                "kind": "view_update" if existing_match else "view_create",
                "name": view.get("name"),
                "existing_id": existing_match.get("id") if existing_match else None,
                "dataset_table_id": view.get("dataset_table_id"),
                "dimension_count": len(view.get("dimensions") or []),
                "measure_count": len(view.get("measures") or []),
            }
        )

    existing_explore_names = {
        str(e.get("name")) for e in (existing.get("explores") or []) if e.get("name")
    }
    for explore in explores_plan:
        if not isinstance(explore, dict) or not explore.get("name"):
            continue
        actions.append(
            {
                "kind": "explore_update" if explore["name"] in existing_explore_names else "explore_create",
                "name": explore["name"],
                "join_count": len(explore.get("joins") or []),
            }
        )

    if not user_confirmed:
        return _requires_confirmation(
            "commit_semantic_model",
            {
                "dataset_id": dataset_id,
                "model_name": model_plan.get("name"),
                "narrative": plan.get("narrative"),
                "actions": actions,
                "open_questions_for_user": plan.get("open_questions_for_user") or [],
                "warning": (
                    "Make sure every open_questions_for_user has been "
                    "answered by the human before confirming."
                ),
            },
        )

    model_id = await _ensure_semantic_model(dataset_id, model_plan, existing)
    name_to_view_id: dict[str, int] = {
        str(v.get("name")): int(v["id"])
        for v in (existing.get("views") or [])
        if v.get("name") and v.get("id") is not None
    }

    written_views: list[dict[str, Any]] = []
    for view in views_plan:
        existing_match = None
        if view.get("dataset_table_id") is not None:
            existing_match = existing_views_by_table.get(int(view["dataset_table_id"]))
        if existing_match is None and view.get("name"):
            existing_match = existing_views_by_name.get(str(view["name"]))

        body = _drop_none(
            {
                "name": view.get("name"),
                "sql_table_name": view.get("sql_table_name"),
                "dataset_table_id": view.get("dataset_table_id"),
                "dimensions": view.get("dimensions") or [],
                "measures": view.get("measures") or [],
                "description": view.get("description"),
            }
        )
        if existing_match:
            result = await _request(
                "PUT",
                f"/semantic/views/{int(existing_match['id'])}",
                json_body=body,
            )
        else:
            result = await _request("POST", "/semantic/views", json_body=body)
        if isinstance(result, dict) and result.get("id") and result.get("name"):
            name_to_view_id[str(result["name"])] = int(result["id"])
        written_views.append(
            {
                "name": result.get("name") if isinstance(result, dict) else view.get("name"),
                "id": result.get("id") if isinstance(result, dict) else None,
                "action": "updated" if existing_match else "created",
            }
        )

    written_explores: list[dict[str, Any]] = []
    for explore in explores_plan:
        if not isinstance(explore, dict):
            continue
        base_view_name = str(explore.get("base_view_name") or "")
        base_view_id = name_to_view_id.get(base_view_name)
        if base_view_id is None:
            written_explores.append(
                {
                    "name": explore.get("name"),
                    "skipped": True,
                    "reason": (
                        f"base_view_name '{base_view_name}' not found among "
                        "written or existing views."
                    ),
                }
            )
            continue
        body = _drop_none(
            {
                "name": explore.get("name"),
                "base_view_name": base_view_name,
                "base_view_id": base_view_id,
                "model_id": model_id,
                "joins": explore.get("joins") or [],
                "default_filters": explore.get("default_filters") or {},
                "description": explore.get("description"),
            }
        )
        existing_explore = next(
            (
                e
                for e in (existing.get("explores") or [])
                if e.get("name") == explore.get("name")
            ),
            None,
        )
        if existing_explore and existing_explore.get("id"):
            result = await _request(
                "PUT",
                f"/semantic/explores/{int(existing_explore['id'])}",
                json_body=body,
            )
            written_explores.append({"name": explore.get("name"), "id": result.get("id"), "action": "updated"})
        else:
            result = await _request("POST", "/semantic/explores", json_body=body)
            written_explores.append({"name": explore.get("name"), "id": result.get("id"), "action": "created"})

    _append_session_log(
        "dataset",
        "commit_semantic_model",
        {
            "dataset_id": dataset_id,
            "model_id": model_id,
            "views": [
                f"{v.get('name')} ({v.get('action')}, id={v.get('id')})"
                for v in written_views
            ],
            "explores": [
                f"{e.get('name')} ({e.get('action')}, id={e.get('id')})"
                for e in written_explores
            ],
        },
    )
    return {
        "status": "committed",
        "dataset_id": dataset_id,
        "model_id": model_id,
        "views": written_views,
        "explores": written_explores,
        "next_step": (
            "Move to dashboard blueprint stage: call "
            "propose_dashboard_blueprint(dataset_id, business_intent)."
        ),
    }


# ---------------------------------------------------------------------------
# Dashboard blueprint
# ---------------------------------------------------------------------------


@tool("report")
async def propose_dashboard_blueprint(
    dataset_id: int,
    business_intent: str,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Stage 4 — design dashboard before write. Read-only.

    Returns available_measures (`view.measure_name`), available_dimensions,
    explores (reachable view sets per chart), blueprint_template. Every
    chart spec MUST reference these — invented measures are rejected at
    commit. Missing measure → go back to propose_semantic_model.
    """
    intent = str(business_intent or "").strip()
    if not intent:
        raise ValueError("business_intent is required.")

    dataset = await _request("GET", f"/datasets/{int(dataset_id)}")
    model = await _request("GET", f"/datasets/{int(dataset_id)}/model")

    # NOTE: the backend's GET /datasets/{id}/model always returns generated=False
    # (it is a read, not a generate call).  Only check whether views actually
    # exist — do NOT gate on the `generated` flag.
    if not (model.get("views") or []):
        return {
            "status": "blocked",
            "reason": (
                "Dataset has no semantic model with views. "
                "Charts built without semantic measures will not appear "
                "correctly in Explore or the dataset model UI."
            ),
            "fix": (
                "Call propose_semantic_model(dataset_id, business_intent) "
                "FIRST to author views and measures, then return here."
            ),
        }

    available_measures: list[dict[str, Any]] = []
    available_dimensions: list[dict[str, Any]] = []
    table_to_view: dict[int, dict[str, Any]] = {}
    incompatible_measures: list[dict[str, Any]] = []
    for view in model.get("views") or []:
        view_name = view.get("name")
        if view.get("dataset_table_id") is not None:
            table_to_view[int(view["dataset_table_id"])] = view
        for measure in view.get("measures") or []:
            compat = _measure_chart_compatibility(measure)
            entry = {
                "qualified_name": f"{view_name}.{measure.get('name')}",
                "field": measure.get("name"),
                "view": view_name,
                "agg_type": measure.get("type"),
                "label": measure.get("label"),
                "description": measure.get("description"),
                "chart_compatible": compat["compatible"],
            }
            if not compat["compatible"]:
                entry["incompatible_reason"] = compat["reason"]
                entry["workaround"] = compat["workaround"]
                incompatible_measures.append(entry)
            available_measures.append(entry)
        for dim in view.get("dimensions") or []:
            available_dimensions.append(
                {
                    "qualified_name": f"{view_name}.{dim.get('name')}",
                    "field": dim.get("name"),
                    "view": view_name,
                    "type": dim.get("type"),
                    "label": dim.get("label"),
                }
            )

    explores_summary = []
    for explore in model.get("explores") or []:
        explores_summary.append(
            {
                "name": explore.get("name"),
                "base_view": explore.get("base_view_name"),
                "joined_views": [j.get("view") for j in (explore.get("joins") or []) if j.get("view")],
            }
        )

    # Per-table dimension catalogue so AI picks the right field for the right
    # bound view without needing to read full view objects. Tightly indexed by
    # dataset_table_id — matches how charts are bound at runtime.
    dimensions_by_table: dict[int, list[str]] = {}
    measures_by_table: dict[int, list[str]] = {}
    for tid, view in table_to_view.items():
        dimensions_by_table[tid] = [
            str(d.get("name")) for d in (view.get("dimensions") or []) if d.get("name")
        ]
        measures_by_table[tid] = [
            str(m.get("name"))
            for m in (view.get("measures") or [])
            if m.get("name") and _measure_chart_compatibility(m)["compatible"]
        ]

    return {
        "stage": "propose_dashboard_blueprint",
        "dataset": {"id": dataset.get("id"), "name": dataset.get("name")},
        "business_intent": intent,
        "available_measures": available_measures,
        "available_dimensions": available_dimensions,
        "explores": explores_summary,
        "table_bindings": [
            {"dataset_table_id": tid, "view_name": v.get("name")}
            for tid, v in table_to_view.items()
        ],
        "fields_by_table": [
            {
                "dataset_table_id": tid,
                "view_name": table_to_view[tid].get("name"),
                "chart_ready_measures": measures_by_table.get(tid, []),
                "dimensions": dimensions_by_table.get(tid, []),
            }
            for tid in table_to_view
        ],
        "blueprint_template": DASHBOARD_BLUEPRINT_SHAPE,
        "rules": {
            "every_metric_must_reference_a_measure": (
                "In each chart's role_config.metrics[], the `field` value "
                "MUST equal one of available_measures[].qualified_name "
                "(or its short field name when the chart's bound view is "
                "obvious). The commit step will reject anything else."
            ),
            "dataset_table_id_must_be_set": (
                "Every chart needs a dataset_table_id from table_bindings. "
                "Charts with NULL dataset_table_id render but disappear "
                "from Explore and the dataset chart list."
            ),
            "metric_definitions_block_is_mandatory": (
                "Even though commit checks availability, write the "
                "metric_definitions block — it makes the blueprint "
                "self-explanatory in chat for the human reviewer."
            ),
        },
        "agent_contract": {
            "stored_queryMode": "generated",
            "metric_field_resolution": (
                "Phase-12.5 field-qualifier contract — chart engine routes based "
                "on whether ANY role_config field has a dotted 'view.field' ref:\n"
                "  * Qualified 'view.field' → SemanticQueryEngine with multi-hop "
                "JOIN resolver (`_role_config_needs_semantic_runtime`). Required "
                "for semantic measures (filtered / expression / dataset-scope "
                "Phase 12) AND cross-table dimensions.\n"
                "  * Bare 'field' → legacy live_query path (single table, NO "
                "JOIN). Only valid for raw columns on the chart's bound view.\n"
                "Same-base-view qualifiers (e.g. 'orders.amount' when chart is "
                "bound to orders) are stripped to bare BY THE BE in "
                "`_strip_base_view_qualifiers` (datasets.py:743). DO NOT strip "
                "client-side — that breaks Phase-12 dataset-scope measures.\n"
                "Use the qualified form whenever a field is declared as a "
                "semantic dimension or measure. The FE Explore Editor "
                "auto-upgrades bare→qualified via `upgradeRoleConfigToQualified` "
                "(Phase 12.5) when a unique mapping exists."
            ),
            "joined_view_fields_blocked": (
                "Phase 11/12 — joined-view raw dimensions (e.g. 'pipeline_name' "
                "from a non-bound view) ARE supported when referenced qualified "
                "('pipeline.pipeline_name') AND the explore has an active JOIN "
                "from the bound view to that view. If not reachable, the engine "
                "raises a VN message: `Bảng \"X\" chưa có relationship tới base "
                "view \"Y\". Mở tab Data Model...` — fix by adding the JOIN via "
                "`set_view_relationship`. Joined-view SEMANTIC measures still "
                "require either (a) declaring them dataset-scope on a hub view "
                "with source_columns, or (b) materialising via transformation."
            ),
            "chart_incompatible_measures": [
                {
                    "qualified_name": m["qualified_name"],
                    "reason": m["incompatible_reason"],
                    "workaround": m["workaround"],
                }
                for m in incompatible_measures
            ],
            "chart_incompatible_measures_note": (
                "Measures with expression/filters/where_sql cannot be referenced "
                "directly in role_config.metrics[].field — chart runtime does "
                "not resolve semantic measure SQL. Use the listed workaround "
                "(typically: filtered measure → count_distinct + base + filters; "
                "expression measure → materialise via transformation)."
            )
            if incompatible_measures
            else "All semantic measures on this dataset are chart-compatible.",
            "blueprint_chart_limit": (
                "commit_dashboard_blueprint accepts up to "
                f"{_BLUEPRINT_MAX_CHARTS} charts per call. Split multi-page "
                "dashboards across multiple commits if needed."
            ),
        },
        "next_step": (
            "Author blueprint_json. Surface open_questions_for_user, get "
            "human approval, then call commit_dashboard_blueprint."
        ),
    }


@tool("all")
async def commit_dashboard_blueprint(
    blueprint_json: str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Stage 4 commit — materialise dashboard from propose_dashboard_blueprint output.

    Validates each chart: dataset_table_id→SemanticView, metric.field→view
    measure, role_config shape, BE dry-run-create. First call returns diff;
    user_confirmed=True creates charts then dashboard with placements.
    """
    blueprint = _parse_plan_json(blueprint_json, "blueprint_json")
    dataset_id = _require_int(blueprint, "dataset_id")

    dashboard_meta = blueprint.get("dashboard") or {}
    if not dashboard_meta.get("name"):
        raise ValueError("blueprint.dashboard.name is required.")

    charts_plan = blueprint.get("charts") or []
    if not isinstance(charts_plan, list) or not charts_plan:
        raise ValueError("blueprint.charts must be a non-empty list.")

    if len(charts_plan) > _BLUEPRINT_MAX_CHARTS:
        return {
            "status": "blocked_by_chart_limit",
            "chart_count": len(charts_plan),
            "max_charts_per_commit": _BLUEPRINT_MAX_CHARTS,
            "reason": (
                f"Blueprint has {len(charts_plan)} charts which exceeds the "
                f"per-commit ceiling of {_BLUEPRINT_MAX_CHARTS}. Each chart "
                "runs a runtime preview during commit; oversized blueprints "
                "time out before any chart is written."
            ),
            "fix": (
                "Split the blueprint by page or section: commit the first "
                f"{_BLUEPRINT_MAX_CHARTS} charts under one dashboard, then "
                "issue follow-up commits whose dashboard payload reuses the "
                "same id (or attach further charts via add_chart_to_dashboard)."
            ),
        }

    model = await _request("GET", f"/datasets/{int(dataset_id)}/model")
    if not (model.get("views") or []):
        return {
            "status": "blocked",
            "reason": (
                "Dataset has no semantic views. Run propose_semantic_model "
                "/ commit_semantic_model first."
            ),
        }

    # Build per-view measure + dimension indexes and a join-reachability map.
    # `measure_index` only contains CHART-COMPATIBLE measures so commit refuses
    # specs that reference computed/filtered measures, which would otherwise
    # pass symbolic check but fail at runtime preview.
    measure_index: dict[str, set[str]] = {}
    measure_incompat_index: dict[str, dict[str, dict[str, str]]] = {}
    dimension_index: dict[str, set[str]] = {}
    table_to_view_name: dict[int, str] = {}
    for view in model.get("views") or []:
        vname = str(view.get("name") or "")
        chart_ready: set[str] = set()
        incompat: dict[str, dict[str, str]] = {}
        for m in (view.get("measures") or []):
            if not isinstance(m, dict) or not m.get("name"):
                continue
            mname = str(m["name"])
            compat = _measure_chart_compatibility(m)
            if compat["compatible"]:
                chart_ready.add(mname)
            else:
                incompat[mname] = {
                    "reason": compat["reason"] or "",
                    "workaround": compat["workaround"] or "",
                }
        measure_index[vname] = chart_ready
        measure_incompat_index[vname] = incompat
        dimension_index[vname] = {
            str(d.get("name")) for d in (view.get("dimensions") or []) if d.get("name")
        }
        if view.get("dataset_table_id") is not None:
            table_to_view_name[int(view["dataset_table_id"])] = vname

    # Required dimension-like role fields per chart type.
    _CHART_REQUIRED_DIMENSION_FIELDS: dict[str, list[str]] = {
        "BAR": ["dimension"], "HORIZONTAL_BAR": ["dimension"],
        "GROUPED_BAR": ["dimension", "breakdown"], "STACKED_BAR": ["dimension", "breakdown"],
        "BAR_LINE": ["dimension"], "WATERFALL": ["dimension"],
        "LINE": ["dimension"], "AREA": ["dimension"],
        "TIME_SERIES": ["timeField"], "RIBBON": ["timeField", "breakdown"],
        "TIMELINE": ["timeField", "dimension"],
        "PIE": ["dimension"], "DONUT": ["dimension"], "POLAR_AREA": ["dimension"],
        "RADAR": ["dimension"], "TREEMAP": ["dimension"], "FUNNEL": ["dimension"],
        "WORD_CLOUD": ["dimension"],
        "SCATTER": ["scatterX", "scatterY"], "BUBBLE": ["scatterX", "scatterY"],
        "MAP_POINT": ["scatterX", "scatterY"], "MAP_REGION": ["dimension"],
        "HEATMAP": ["dimension", "breakdown"], "BOXPLOT": ["dimension"],
        "SANKEY": ["dimension", "breakdown"], "SUNBURST": ["dimension", "breakdown"],
        "PODIUM": ["dimension"],
        "MATRIX": ["tableRowDimension", "tableColumnDimension"],
    }
    _DIMENSION_FIELD_KEYS = {
        "dimension", "breakdown", "timeField", "scatterX", "scatterY",
        "tableRowDimension", "tableColumnDimension",
    }

    validation: list[dict[str, Any]] = []
    valid_specs: list[dict[str, Any]] = []
    for index, chart in enumerate(charts_plan):
        errors: list[str] = []
        if not isinstance(chart, dict):
            validation.append({"index": index, "errors": ["chart spec is not an object"]})
            continue
        title = chart.get("title") or chart.get("name") or f"chart_{index}"
        ctype = str(chart.get("chart_type") or "").strip().upper()

        dataset_table_id = chart.get("dataset_table_id")
        try:
            dtid = int(dataset_table_id) if dataset_table_id is not None else None
        except (TypeError, ValueError):
            dtid = None

        if dtid is None:
            errors.append("dataset_table_id is missing or not an int.")
        elif dtid not in table_to_view_name:
            errors.append(
                f"dataset_table_id={dtid} has no SemanticView. "
                "Add the view in commit_semantic_model first."
            )

        view_name = table_to_view_name.get(dtid) if dtid is not None else None
        role_config = chart.get("role_config") or {}

        # ── 1. Chart-type role shape check (required dimension-like fields) ──
        required_dim_keys = _CHART_REQUIRED_DIMENSION_FIELDS.get(ctype, [])
        for req_key in required_dim_keys:
            if not str(role_config.get(req_key) or "").strip():
                errors.append(
                    f"chart_type={ctype} requires role_config.{req_key} but it is missing."
                )

        # ── 2. Metric field resolution ──
        metrics = role_config.get("metrics") or []
        if not metrics and ctype not in {"TABLE", "MATRIX", "KPI", "GAUGE", "BULLET"}:
            errors.append("role_config.metrics is empty.")

        for m_index, metric in enumerate(metrics or []):
            if not isinstance(metric, dict):
                errors.append(f"metrics[{m_index}] is not an object.")
                continue
            field = str(metric.get("field") or "").strip()
            if not field:
                errors.append(f"metrics[{m_index}].field is empty.")
                continue
            qualified_view, qualified_field = _split_qualified(field)
            if qualified_view:
                if qualified_view not in measure_index:
                    errors.append(
                        f"metrics[{m_index}].field='{field}' references view "
                        f"'{qualified_view}' which has no SemanticView."
                    )
                elif qualified_field not in measure_index[qualified_view]:
                    incompat = measure_incompat_index.get(qualified_view, {}).get(qualified_field)
                    if incompat:
                        errors.append(
                            f"metrics[{m_index}].field='{field}' is a "
                            f"{incompat['reason']} measure and cannot be used "
                            f"directly in a chart. Workaround: {incompat['workaround']}"
                        )
                    else:
                        errors.append(
                            f"metrics[{m_index}].field='{field}' is not a measure "
                            f"on view '{qualified_view}'. "
                            f"Available: {sorted(measure_index[qualified_view])}."
                        )
            else:
                if view_name is None:
                    errors.append(
                        f"metrics[{m_index}].field='{field}' is unqualified "
                        "and chart has no resolvable view."
                    )
                elif field not in measure_index.get(view_name, set()):
                    incompat = measure_incompat_index.get(view_name, {}).get(field)
                    if incompat:
                        errors.append(
                            f"metrics[{m_index}].field='{field}' is a "
                            f"{incompat['reason']} measure on view "
                            f"'{view_name}' and cannot be used directly in a "
                            f"chart. Workaround: {incompat['workaround']}"
                        )
                        continue
                    errors.append(
                        f"metrics[{m_index}].field='{field}' is not a measure "
                        f"on the bound view '{view_name}'. "
                        f"Available: {sorted(measure_index.get(view_name, set()))}."
                    )

        # ── 3. Dimension field resolution (only for present, non-empty keys) ──
        if view_name is not None:
            for dim_key in _DIMENSION_FIELD_KEYS:
                val = str(role_config.get(dim_key) or "").strip()
                if not val:
                    continue  # absence already caught by required_dim_keys check
                q_view, q_field = _split_qualified(val)
                target_view = q_view if q_view else view_name
                if q_view:
                    if q_field not in dimension_index.get(q_view, set()):
                        errors.append(
                            f"role_config.{dim_key}='{val}' is not a dimension "
                            f"on view '{q_view}'. "
                            f"Available: {sorted(dimension_index.get(q_view, set()))}."
                        )
                else:
                    if val not in dimension_index.get(target_view, set()):
                        errors.append(
                            f"role_config.{dim_key}='{val}' is not a dimension "
                            f"on view '{target_view}'. "
                            f"Available: {sorted(dimension_index.get(target_view, set()))}."
                        )

        # ── 4. KPI/GAUGE/BULLET: metrics[0] required ──
        for metric_key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
            metric = role_config.get(metric_key)
            if not isinstance(metric, dict):
                continue
            field = str(metric.get("field") or "").strip()
            if not field:
                continue
            qualified_view, qualified_field = _split_qualified(field)
            if qualified_view:
                if qualified_view not in measure_index:
                    errors.append(
                        f"role_config.{metric_key}.field='{field}' references view "
                        f"'{qualified_view}' which has no SemanticView."
                    )
                elif qualified_field not in measure_index.get(qualified_view, set()):
                    errors.append(
                        f"role_config.{metric_key}.field='{field}' is not a measure "
                        f"on view '{qualified_view}'. "
                        f"Available: {sorted(measure_index.get(qualified_view, set()))}."
                    )
            else:
                if view_name is None:
                    errors.append(
                        f"role_config.{metric_key}.field='{field}' is unqualified "
                        "and chart has no resolvable view."
                    )
                elif field not in measure_index.get(view_name, set()):
                    errors.append(
                        f"role_config.{metric_key}.field='{field}' is not a measure "
                        f"on the bound view '{view_name}'. "
                        f"Available: {sorted(measure_index.get(view_name, set()))}."
                    )

        for col_index, column in enumerate(role_config.get("selectedColumns") or []):
            if not isinstance(column, str):
                continue
            field = column.strip()
            if not field:
                continue
            qualified_view, qualified_field = _split_qualified(field)
            if qualified_view:
                if qualified_view not in dimension_index and qualified_view not in measure_index:
                    errors.append(
                        f"role_config.selectedColumns[{col_index}]='{field}' references "
                        f"view '{qualified_view}' which has no SemanticView."
                    )
                elif (
                    qualified_field not in dimension_index.get(qualified_view, set())
                    and qualified_field not in measure_index.get(qualified_view, set())
                ):
                    errors.append(
                        f"role_config.selectedColumns[{col_index}]='{field}' is neither "
                        f"a dimension nor a measure on view '{qualified_view}'."
                    )
            else:
                if view_name is None:
                    errors.append(
                        f"role_config.selectedColumns[{col_index}]='{field}' is "
                        "unqualified and chart has no resolvable view."
                    )
                elif (
                    field not in dimension_index.get(view_name, set())
                    and field not in measure_index.get(view_name, set())
                ):
                    errors.append(
                        f"role_config.selectedColumns[{col_index}]='{field}' is neither "
                        f"a dimension nor a measure on the bound view '{view_name}'."
                    )

        if ctype in {"KPI", "GAUGE", "BULLET"} and not metrics:
            errors.append(f"{ctype} requires at least one metric in role_config.metrics.")

        validation.append(
            {
                "index": index,
                "title": title,
                "errors": errors,
                "valid": not errors,
            }
        )
        if not errors:
            valid_specs.append(chart)

    invalid_count = sum(1 for v in validation if not v["valid"])
    if invalid_count:
        return {
            "status": "validation_failed",
            "invalid_count": invalid_count,
            "valid_count": len(valid_specs),
            "validation": validation,
            "hint": (
                "Fix the chart specs (or extend the semantic model with the "
                "missing measures/dimensions via commit_semantic_model) and retry."
            ),
        }

    staged_specs: list[dict[str, Any]] = []
    # Phase-12: ask the BE single gatekeeper to dry-run every chart in
    # the blueprint. Normalize + Pydantic + runtime preview happen there
    # so MCP cannot drift from the canonical contract. We still surface
    # per-chart errors so the agent can fix exactly the offending spec.
    preview_validation: list[dict[str, Any]] = []
    for index, chart in enumerate(valid_specs):
        proposed_config = _build_chart_config_from_spec(chart)
        chart_type_value = str(chart.get("chart_type") or "").upper()
        title = chart.get("title") or chart.get("name") or f"chart_{index}"
        dry_run = await _request(
            "POST",
            "/charts/dry-run-create",
            json_body={
                "name": chart.get("title") or f"Chart {index + 1}",
                "chart_type": chart_type_value,
                "dataset_table_id": int(chart["dataset_table_id"]),
                "config": proposed_config,
                "description": chart.get("why_this_chart"),
            },
        )
        if not isinstance(dry_run, dict):
            preview_validation.append({
                "index": index,
                "title": title,
                "errors": ["Unexpected dry-run-create response from backend."],
                "valid": False,
            })
            continue
        if dry_run.get("validation_errors") or dry_run.get("runtime_errors"):
            preview_validation.append({
                "index": index,
                "title": title,
                "errors": (
                    list(dry_run.get("validation_errors") or [])
                    + list(dry_run.get("runtime_errors") or [])
                ),
                "root_cause": dry_run.get("runtime_root_cause"),
                "valid": False,
            })
            continue
        # Stage the BE-normalized config so the commit POST writes exactly
        # what dry-run validated — no second drift opportunity.
        staged_specs.append({
            "chart": chart,
            "config": dry_run.get("normalized_config") or proposed_config,
        })

    if preview_validation:
        return {
            "status": "validation_failed",
            "invalid_count": len(preview_validation),
            "valid_count": len(staged_specs),
            "validation": preview_validation,
            "hint": (
                "At least one chart fails preview_chart_data with the final stored "
                "config. Fix the chart specs and retry before committing."
            ),
        }

    # Phase-15.46: audit qualified-vs-bare refs across all charts so the
    # confirmation surfaces the "Column X is ambiguous" risk class BEFORE
    # commit (Phase 15.44 covered _post_chart in chart_library; this
    # closes the same gap on the blueprint flow).
    from appbi_chart_library import _audit_role_refs
    locked_charts: list[str] = []
    for staged in staged_specs:
        chart = staged["chart"]
        audit = _audit_role_refs(chart.get("role_config") or {})
        if audit["is_locked_to_single_table"]:
            locked_charts.append(
                f"{chart.get('title')}: bare refs {audit['bare_refs']}"
            )

    if not user_confirmed:
        confirm_plan: dict[str, Any] = {
            "dataset_id": dataset_id,
            "dashboard_name": dashboard_meta.get("name"),
            "narrative": blueprint.get("narrative"),
            "chart_count": len(staged_specs),
            "metrics_used": sorted({
                str(m.get("field"))
                for staged in staged_specs
                for m in (staged["chart"].get("role_config") or {}).get("metrics") or []
            }),
            "open_questions_for_user": blueprint.get("open_questions_for_user") or [],
        }
        if locked_charts:
            confirm_plan["refs_warning"] = (
                f"{len(locked_charts)}/{len(staged_specs)} charts use BARE "
                "refs only — locked to legacy single-table path. If the "
                "dataset has relationships and you intended cross-table "
                "data (or to avoid 'Column X is ambiguous' SQL errors), "
                "qualify the role_config fields as `view.field`."
            )
            confirm_plan["locked_charts"] = locked_charts[:10]
        return _requires_confirmation("commit_dashboard_blueprint", confirm_plan)

    created_charts: list[dict[str, Any]] = []
    creation_errors: list[dict[str, Any]] = []
    placements: list[dict[str, Any]] = []
    for index, staged in enumerate(staged_specs):
        chart = staged["chart"]
        config = staged["config"]
        body = _drop_none(
            {
                "name": chart.get("title") or f"Chart {index + 1}",
                "description": chart.get("why_this_chart"),
                "chart_type": str(chart.get("chart_type") or "").upper(),
                "dataset_table_id": int(chart["dataset_table_id"]),
                "config": config,
            }
        )
        try:
            result = await _request("POST", "/charts/", json_body=body)
        except RuntimeError as exc:
            creation_errors.append({"index": index, "title": body["name"], "error": str(exc)})
            logger.warning("Chart creation failed for '%s': %s", body["name"], exc)
            continue
        chart_id = result.get("id") if isinstance(result, dict) else None
        created_charts.append(
            {
                "id": chart_id,
                "title": body["name"],
                "chart_type": body["chart_type"],
            }
        )
        layout = _normalize_chart_layout(
            chart.get("layout"),
            body["chart_type"],
            index,
        )
        if chart_id is not None:
            placements.append(
                {
                    "chart_id": chart_id,
                    "layout": layout,
                    "widget_type": "chart",
                }
            )

    dashboard_body = _drop_none(
        {
            "name": dashboard_meta.get("name"),
            "description": dashboard_meta.get("description"),
            "charts": placements,
            "layout_mode": dashboard_meta.get("layout_mode") or "grid",
            "theme_config": dashboard_meta.get("theme_config"),
        }
    )

    if creation_errors:
        cleanup = await _rollback_created_charts(created_charts)
        # Some charts failed — report partial state so user can clean up.
        return {
            "status": "partial_failure",
            "created_charts": created_charts,
            "creation_errors": creation_errors,
            "dashboard_created": False,
            "cleanup": cleanup,
            "hint": (
                "Some charts failed to create (see creation_errors). "
                "The dashboard was NOT created and the MCP attempted to roll back "
                "already-created charts to avoid an inconsistent state."
            ),
        }

    try:
        dashboard_result = await _request("POST", "/dashboards/", json_body=dashboard_body)
    except RuntimeError as exc:
        cleanup = await _rollback_created_charts(created_charts)
        return {
            "status": "partial_failure",
            "created_charts": created_charts,
            "dashboard_created": False,
            "dashboard_error": str(exc),
            "cleanup": cleanup,
            "hint": (
                "Dashboard creation failed after charts were created. The MCP attempted "
                "to roll back the charts; inspect cleanup for any manual follow-up."
            ),
        }

    dashboard_id = dashboard_result.get("id") if isinstance(dashboard_result, dict) else None
    _append_session_log(
        "charts",
        "commit_dashboard_blueprint",
        {
            "dataset_id": dataset_id,
            "dashboard_id": dashboard_id,
            "dashboard_name": dashboard_meta.get("name"),
            "see_dataset_md": "↳ measures/tables for these charts live in dataset.md (same folder)",
            "charts_created": [
                f"{c.get('title')} ({c.get('chart_type')}, id={c.get('id')})"
                for c in created_charts
            ],
            "placement_count": len(placements),
        },
        dataset_id=dataset_id,
    )
    _append_session_log(
        "report",
        "commit_dashboard_blueprint",
        {
            "dataset_id": dataset_id,
            "dashboard_id": dashboard_id,
            "dashboard_name": dashboard_meta.get("name"),
            "see_charts_md": "↳ chart configs placed on this dashboard live in charts.md (same folder)",
            "placements": [
                f"chart_id={p.get('chart_id')} layout={p.get('layout')}"
                for p in placements
            ],
        },
        dataset_id=dataset_id,
    )
    return {
        "status": "committed",
        "dashboard_id": dashboard_id,
        "dashboard_name": dashboard_meta.get("name"),
        "created_charts": created_charts,
        "placement_count": len(placements),
        "next_step": "Verify in the AppBI UI: dashboard renders, charts appear in Explore with their dataset_table bound, and dataset model UI lists the new measures.",
    }


# ---------------------------------------------------------------------------
# Audit + repair (for pre-blueprint legacy data)
# ---------------------------------------------------------------------------


@tool("all")
async def audit_chart_semantic_health(
    dataset_id: int | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Inventory charts that render but are invisible in Explore. Read-only.

    Flags: orphan_dataset_table (NULL/missing table), no_semantic_view,
    adhoc_metric (config metric doesn't match any view measure).
    """
    charts = await _request("GET", "/charts/")
    if not isinstance(charts, list):
        return {"error": "Unexpected /charts/ response", "raw": str(charts)[:200]}

    findings: list[dict[str, Any]] = []
    for chart in charts:
        if not isinstance(chart, dict):
            continue
        chart_id = chart.get("id")
        chart_dataset_table_id = chart.get("dataset_table_id")
        chart_dataset_id = (chart.get("dataset_table") or {}).get("dataset_id") if isinstance(chart.get("dataset_table"), dict) else None
        if dataset_id is not None and chart_dataset_id != int(dataset_id):
            continue

        issues: list[str] = []
        if chart_dataset_table_id is None:
            issues.append("orphan_dataset_table")

        binding = chart.get("semanticBinding") or {}
        if chart_dataset_table_id is not None and not binding.get("baseViewId"):
            issues.append("no_semantic_view")

        config = chart.get("config") or {}
        active_role = (
            config.get("customRoleConfig")
            if str(config.get("queryMode") or "").lower() == "custom"
            else config.get("generatedRoleConfig") or config.get("roleConfig")
        ) or {}
        measure_fields = set(binding.get("measureFields") or [])
        for metric in (active_role.get("metrics") or []):
            if not isinstance(metric, dict):
                continue
            field = str(metric.get("field") or "")
            if not field:
                continue
            qualified_view, qualified_field = _split_qualified(field)
            if qualified_view:
                if field not in measure_fields:
                    issues.append("adhoc_metric")
                    break
            else:
                base_view = binding.get("baseViewName")
                full = f"{base_view}.{field}" if base_view else field
                if full not in measure_fields:
                    issues.append("adhoc_metric")
                    break

        if issues:
            findings.append(
                {
                    "chart_id": chart_id,
                    "name": chart.get("name"),
                    "dataset_id": chart_dataset_id,
                    "dataset_table_id": chart_dataset_table_id,
                    "issues": sorted(set(issues)),
                }
            )

    summary = {"total_charts_scanned": len(charts), "unhealthy_count": len(findings)}
    by_issue: dict[str, int] = {}
    for entry in findings:
        for issue in entry["issues"]:
            by_issue[issue] = by_issue.get(issue, 0) + 1
    summary["by_issue"] = by_issue

    return {
        "summary": summary,
        "findings": findings[:200],
        "findings_truncated": max(0, len(findings) - 200),
        "next_step": (
            "For each finding: either delete the chart and rebuild via "
            "blueprint flow, or call repair_chart_semantic_binding to "
            "re-point + add missing measures."
        ),
    }


@tool("all")
async def repair_chart_semantic_binding(
    chart_id: int,
    dataset_table_id: int | None = None,
    add_missing_measures: bool = True,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Fix a chart's broken semantic binding (per audit_chart_semantic_health).

    Re-points chart to dataset_table_id (if given), resolves bound view,
    appends SUM measures for missing fields (when add_missing_measures=True).
    Confirmation plan first; writes only on user_confirmed.
    """
    chart = await _request("GET", f"/charts/{int(chart_id)}")
    if not isinstance(chart, dict):
        return {"error": f"Chart {chart_id} not found"}

    plan_changes: list[str] = []
    target_dataset_table_id = dataset_table_id or chart.get("dataset_table_id")
    if dataset_table_id is not None and dataset_table_id != chart.get("dataset_table_id"):
        plan_changes.append(
            f"Re-point chart from dataset_table_id={chart.get('dataset_table_id')} "
            f"to dataset_table_id={dataset_table_id}"
        )

    if target_dataset_table_id is None:
        return {
            "error": (
                "Chart has no dataset_table_id and none was provided. "
                "Pass dataset_table_id explicitly to re-point."
            )
        }

    config = chart.get("config") or {}
    active_role = (
        config.get("customRoleConfig")
        if str(config.get("queryMode") or "").lower() == "custom"
        else config.get("generatedRoleConfig") or config.get("roleConfig")
    ) or {}
    desired_metrics = [
        str(m.get("field"))
        for m in (active_role.get("metrics") or [])
        if isinstance(m, dict) and m.get("field")
    ]

    measures_to_add: list[dict[str, Any]] = []
    target_view_id: int | None = None
    if add_missing_measures and desired_metrics:
        views = await _request("GET", "/semantic/views")
        target_view = next(
            (
                v
                for v in (views or [])
                if isinstance(v, dict) and v.get("dataset_table_id") == int(target_dataset_table_id)
            ),
            None,
        )
        if target_view is None:
            plan_changes.append(
                f"Note: no SemanticView for dataset_table_id={target_dataset_table_id}; "
                "use propose_semantic_model first."
            )
        else:
            target_view_id = int(target_view["id"])
            existing_measure_names = {
                str(m.get("name")) for m in (target_view.get("measures") or [])
            }
            for raw_field in desired_metrics:
                _, field = _split_qualified(raw_field)
                if field and field not in existing_measure_names:
                    measures_to_add.append(
                        {
                            "name": field,
                            "type": "sum",
                            "sql": f"${{TABLE}}.{field}",
                            "label": field.replace("_", " ").title(),
                            "description": f"Auto-added by repair_chart_semantic_binding for chart {chart_id}.",
                        }
                    )
            if measures_to_add:
                plan_changes.append(
                    f"Add {len(measures_to_add)} measure(s) to view '{target_view.get('name')}': "
                    f"{[m['name'] for m in measures_to_add]} (default type=sum, "
                    "review and edit type/sql afterwards)."
                )

    if not plan_changes:
        return {
            "status": "no_action_needed",
            "chart_id": chart_id,
            "note": "Binding looks healthy or no repair was requested.",
        }

    if not user_confirmed:
        return _requires_confirmation(
            "repair_chart_semantic_binding",
            {
                "chart_id": chart_id,
                "changes": plan_changes,
                "warning": (
                    "Auto-added measures default to type=sum. Review them "
                    "afterward and switch to count/avg/etc as needed."
                ),
            },
        )

    if dataset_table_id is not None and dataset_table_id != chart.get("dataset_table_id"):
        await _request(
            "PUT",
            f"/charts/{int(chart_id)}",
            json_body={"dataset_table_id": int(dataset_table_id)},
        )

    if measures_to_add and target_view_id is not None:
        existing_view = await _request("GET", f"/semantic/views/{target_view_id}")
        merged_measures = list(existing_view.get("measures") or []) + measures_to_add
        await _request(
            "PUT",
            f"/semantic/views/{target_view_id}",
            json_body={"measures": merged_measures},
        )

    return {
        "status": "repaired",
        "chart_id": chart_id,
        "changes_applied": plan_changes,
        "next_step": (
            "Re-run audit_chart_semantic_health to verify the chart now "
            "passes. Open the chart in Explore to confirm the dataset "
            "and measure list look right."
        ),
    }


# ---------------------------------------------------------------------------
# 2-confirm orchestration: Stage 1+2 then Stage 3+4
# Bundle individual stage commits behind two user_confirmed flags so a
# from-scratch dashboard build is "confirm twice → done" instead of the
# default "confirm 4-7 times".
# ---------------------------------------------------------------------------


@tool("report")
async def propose_dataset_workspace(
    business_intent: str,
    datasource_id: int | None = None,
    existing_dataset_id: int | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Stage 1+2 read-only plan. Returns plan_template for
    `commit_dataset_workspace`.

    Pass `existing_dataset_id` to reuse a dataset (the commit step then
    only adds missing tables). Pass `datasource_id` to scope source-table
    suggestions to that datasource.
    """
    intent = str(business_intent or "").strip()
    if not intent:
        raise ValueError("business_intent is required.")

    existing: dict[str, Any] | None = None
    if existing_dataset_id is not None:
        try:
            existing = await _request(
                "GET", f"/datasets/{int(existing_dataset_id)}"
            )
        except RuntimeError as exc:
            logger.warning(
                "Failed to load dataset %s: %s", existing_dataset_id, exc
            )

    sources: list[dict[str, Any]] = []
    if datasource_id is not None:
        try:
            sources = await _request(
                "GET", f"/datasets/datasources/{int(datasource_id)}/tables"
            ) or []
        except RuntimeError as exc:
            logger.warning(
                "Failed to list source tables for %s: %s", datasource_id, exc
            )

    return {
        "business_intent": intent,
        "existing_dataset": existing,
        "available_source_tables": sources[:50],
        "plan_template": {
            "dataset": {
                "name": "<str — required if existing_dataset_id not set>",
                "description": "<str — optional>",
            },
            "existing_dataset_id": "<int — pass instead of `dataset` to reuse>",
            "tables": [
                {
                    "display_name": "<str>",
                    "source_kind": "physical_table|sql_query|derived_table",
                    "datasource_id": "<int — required for physical_table / sql_query>",
                    "source_table_name": "<str — schema.table for physical_table>",
                    "source_query": "<str — SQL for sql_query / derived_table>",
                }
            ],
        },
        "next_step": (
            "Author the plan, then call "
            "commit_dataset_workspace(plan, user_confirmed=true). After "
            "that returns, call get_table_profile for each table, then "
            "propose_semantic_model + propose_dashboard_blueprint, then "
            "commit_full_dashboard(...). Total user confirmations: 2."
        ),
    }


@tool("report")
async def commit_dataset_workspace(
    plan: dict[str, Any] | str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """CONFIRM 1 of 2 — commit dataset + tables + semantic; log planned
    charts for Phase 2 (`build_dashboard_from_design`).

    `plan` shape:
      dataset OR existing_dataset_id (one required)
        dataset: {name, description?}
      tables[]: {display_name, source_kind, datasource_id?,
                 source_table_name?, source_query?}
      semantic?: full plan_json for commit_semantic_model.
      relationships?[]: dataset-model joins (created AFTER semantic so
        view IDs resolve). Each: {from_view_name, to_view_name,
        from_column|from_columns, to_column|to_columns,
        join_type?='left', relationship?='many_to_one',
        alias?, is_active?=True, cross_filter?='single', force?=False}.
        Use `suggest_dataset_model_join` first to pick relationship type.
      planned_charts?[]: chart specs logged for Phase 2. Each: {title,
        chart_type, role_config, layout?, dataset_table_name OR
        dataset_table_index}. role_config may use cross-view qualified
        refs (e.g. dimension='owner.name') if `relationships` connects
        the views.
      dashboard_meta?: {name, description?} logged for Phase 2.

    Rollback: table-add failure → rollback added tables + new dataset.
    Semantic / relationship failure → kept; can retry separately.
    """
    plan_dict = _parse_plan_json(plan, "plan") if isinstance(plan, str) else plan
    if not isinstance(plan_dict, dict):
        raise ValueError("plan must be an object.")

    existing_dataset_id = plan_dict.get("existing_dataset_id")
    dataset_meta = plan_dict.get("dataset") or {}
    tables = plan_dict.get("tables") or []
    semantic_plan = plan_dict.get("semantic")
    relationships = plan_dict.get("relationships") or []
    planned_charts = plan_dict.get("planned_charts") or []
    dashboard_meta_in = plan_dict.get("dashboard_meta") or {}

    if not isinstance(tables, list) or not tables:
        raise ValueError("plan.tables must be a non-empty list.")
    if existing_dataset_id is None and not dataset_meta.get("name"):
        raise ValueError(
            "Either plan.existing_dataset_id or plan.dataset.name is required."
        )

    if not user_confirmed:
        sem_views = (semantic_plan or {}).get("views") or []
        sem_measure_count = sum(
            len((v or {}).get("measures") or []) for v in sem_views
        )
        return _requires_confirmation(
            "commit_dataset_workspace",
            {
                "dataset_action": (
                    f"reuse id={existing_dataset_id}"
                    if existing_dataset_id is not None
                    else f"create '{dataset_meta.get('name')}'"
                ),
                "table_count": len(tables),
                "tables": [
                    {
                        "display_name": t.get("display_name"),
                        "source_kind": t.get("source_kind"),
                    }
                    for t in tables
                ],
                "semantic_views": [v.get("name") for v in sem_views],
                "semantic_measure_count": sem_measure_count,
                "relationships": [
                    f"{r.get('from_view_name')}.{r.get('from_column')} → "
                    f"{r.get('to_view_name')}.{r.get('to_column')} "
                    f"({r.get('relationship', 'many_to_one')})"
                    for r in relationships
                ],
                "planned_chart_count": len(planned_charts),
                "planned_chart_titles": [
                    c.get("title") for c in planned_charts[:8]
                ],
                "dashboard_name": dashboard_meta_in.get("name"),
            },
        )

    # Phase A — dataset
    created_dataset = False
    if existing_dataset_id is not None:
        dataset_id = int(existing_dataset_id)
        dataset_result: dict[str, Any] = {"id": dataset_id, "reused": True}
    else:
        body = _drop_none(
            {
                "name": dataset_meta.get("name"),
                "description": dataset_meta.get("description"),
            }
        )
        dataset_result = await _request("POST", "/datasets/", json_body=body)
        dataset_id = int(dataset_result.get("id"))
        created_dataset = True
        _append_session_log(
            "dataset",
            "commit_dataset_workspace.create_dataset",
            {
                "dataset_id": dataset_id,
                "name": dataset_meta.get("name"),
            },
        )

    # Phase B — tables (rollback on any failure)
    created_table_ids: list[int] = []
    for index, t in enumerate(tables):
        body = _drop_none(
            {
                "display_name": t.get("display_name"),
                "source_kind": t.get("source_kind", "physical_table"),
                "datasource_id": t.get("datasource_id"),
                "source_table_name": t.get("source_table_name"),
                "source_query": t.get("source_query"),
                "enabled": t.get("enabled", True),
            }
        )
        try:
            table_result = await _request(
                "POST", f"/datasets/{dataset_id}/tables", json_body=body
            )
        except RuntimeError as exc:
            # Rollback
            for tid in reversed(created_table_ids):
                try:
                    await _request(
                        "DELETE",
                        f"/datasets/{dataset_id}/tables/{tid}",
                        expect_json=False,
                    )
                except RuntimeError:
                    pass
            if created_dataset:
                try:
                    await _request(
                        "DELETE",
                        f"/datasets/{dataset_id}",
                        expect_json=False,
                    )
                except RuntimeError:
                    pass
            return {
                "status": "rolled_back",
                "failed_at_table_index": index,
                "failed_table": t.get("display_name"),
                "error": str(exc),
            }
        created_table_ids.append(int(table_result.get("id")))

    dataset_log_path = _append_session_log(
        "dataset",
        "commit_dataset_workspace",
        {
            "dataset_id": dataset_id,
            "dataset_action": "created" if created_dataset else "reused",
            "tables_added": [
                f"{t.get('display_name')} (id={tid})"
                for t, tid in zip(tables, created_table_ids)
            ],
        },
    )

    # Phase C — semantic model (optional, only when provided)
    semantic_result: dict[str, Any] | None = None
    if semantic_plan:
        try:
            semantic_result = await commit_semantic_model(
                plan_json=semantic_plan, user_confirmed=True, ctx=ctx
            )
            if (
                isinstance(semantic_result, dict)
                and semantic_result.get("status") not in ("committed", None)
            ):
                return {
                    "status": "committed_with_semantic_error",
                    "dataset_id": dataset_id,
                    "table_ids": created_table_ids,
                    "semantic_result": semantic_result,
                }
        except Exception as exc:  # noqa: BLE001
            return {
                "status": "committed_with_semantic_error",
                "dataset_id": dataset_id,
                "table_ids": created_table_ids,
                "semantic_error": str(exc),
            }

    # Phase C.5 — relationships (dataset-model joins). View IDs only
    # exist after Phase C committed semantic, so this MUST run after.
    # Relationships reference views by NAME in the plan; we resolve to
    # the freshly-committed view IDs from the dataset model graph.
    relationship_results: list[dict[str, Any]] = []
    relationship_errors: list[dict[str, Any]] = []
    if relationships:
        try:
            model = await _request("GET", f"/datasets/{dataset_id}/model")
            view_name_to_id = {
                str(v.get("name")): int(v.get("id"))
                for v in (model.get("views") or [])
                if v.get("id") is not None
            }
        except Exception as exc:  # noqa: BLE001
            view_name_to_id = {}
            relationship_errors.append({
                "stage": "load_model",
                "error": str(exc),
            })

        for r_idx, rel in enumerate(relationships):
            if not isinstance(rel, dict):
                relationship_errors.append({"index": r_idx, "error": "not an object"})
                continue
            from_name = str(rel.get("from_view_name") or "").strip()
            to_name = str(rel.get("to_view_name") or "").strip()
            from_id = view_name_to_id.get(from_name)
            to_id = view_name_to_id.get(to_name)
            if not from_id or not to_id:
                relationship_errors.append({
                    "index": r_idx,
                    "error": (
                        f"could not resolve from_view_name={from_name!r} or "
                        f"to_view_name={to_name!r} — known views: "
                        f"{sorted(view_name_to_id)}"
                    ),
                })
                continue
            body = _drop_none({
                "from_view_id": from_id,
                "to_view_id": to_id,
                "from_column": rel.get("from_column"),
                "to_column": rel.get("to_column"),
                "from_columns": rel.get("from_columns"),
                "to_columns": rel.get("to_columns"),
                "join_type": rel.get("join_type") or "left",
                "relationship": rel.get("relationship") or "many_to_one",
                "alias": rel.get("alias"),
                "is_active": rel.get("is_active", True),
                "cross_filter": rel.get("cross_filter") or "single",
                "force": rel.get("force", False) if rel.get("force") else None,
            })
            try:
                join_res = await _request(
                    "POST", f"/datasets/{dataset_id}/model/joins", json_body=body
                )
                relationship_results.append({
                    "from": f"{from_name}.{rel.get('from_column')}",
                    "to": f"{to_name}.{rel.get('to_column')}",
                    "relationship": body["relationship"],
                    "id": (join_res or {}).get("id") if isinstance(join_res, dict) else None,
                })
            except Exception as exc:  # noqa: BLE001
                relationship_errors.append({
                    "index": r_idx,
                    "from": from_name, "to": to_name,
                    "error": str(exc),
                })

        if relationship_results or relationship_errors:
            _append_session_log(
                "dataset",
                "commit_dataset_workspace.relationships",
                {
                    "created": [
                        f"{r['from']} → {r['to']} ({r['relationship']})"
                        for r in relationship_results
                    ],
                    "errors": [
                        f"#{e.get('index', '?')}: {e.get('error')}"
                        for e in relationship_errors
                    ],
                },
            )

    # Phase D — log planned_charts (NOT created yet; Phase 2 materialises).
    # Resolve table refs from display_name/index → real dataset_table_id.
    name_to_id = {
        t.get("display_name"): tid
        for t, tid in zip(tables, created_table_ids)
    }
    resolved_charts: list[dict[str, Any]] = []
    for idx, chart in enumerate(planned_charts):
        if not isinstance(chart, dict):
            continue
        resolved = dict(chart)
        if "dataset_table_id" not in resolved:
            ref_name = resolved.pop("dataset_table_name", None)
            ref_idx = resolved.pop("dataset_table_index", None)
            if ref_name and ref_name in name_to_id:
                resolved["dataset_table_id"] = name_to_id[ref_name]
            elif isinstance(ref_idx, int) and 0 <= ref_idx < len(created_table_ids):
                resolved["dataset_table_id"] = created_table_ids[ref_idx]
        resolved_charts.append(resolved)

    design_log_path: str | None = None
    if resolved_charts or dashboard_meta_in:
        try:
            design_path = _session_log_dir(dataset_id) / "charts_design.json"
            payload = {
                "saved_at": _dt.datetime.now().isoformat(timespec="seconds"),
                "dataset_id": dataset_id,
                "table_ids": created_table_ids,
                "table_name_to_id": name_to_id,
                "dashboard_meta": dashboard_meta_in,
                "planned_charts": resolved_charts,
            }
            design_path.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            design_log_path = str(design_path)
            _append_session_log(
                "charts",
                "commit_dataset_workspace.log_planned_charts",
                {
                    "chart_count": len(resolved_charts),
                    "design_log_path": design_log_path,
                    "titles": [c.get("title") for c in resolved_charts[:8]],
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to log planned charts: %s", exc)

    return {
        "status": "committed",
        "dataset_id": dataset_id,
        "dataset_created": created_dataset,
        "table_ids": created_table_ids,
        "table_name_to_id": name_to_id,
        "semantic_committed": bool(semantic_result),
        "semantic_result": semantic_result,
        "relationships_committed": relationship_results,
        "relationship_errors": relationship_errors,
        "planned_chart_count": len(resolved_charts),
        "auto_logged_to": [
            p for p in [dataset_log_path, design_log_path] if p
        ],
        "design_log_path": design_log_path,
        "instruction_for_claude": (
            "Phase 1 of 2 committed. Tell the user briefly: "
            f"(a) dataset_id={dataset_id}, (b) tables created, "
            f"(c) semantic committed, (d) {len(resolved_charts)} chart "
            "designs locked into the log file. Then move directly to "
            "Phase 2: call build_dashboard_from_design() with "
            "user_confirmed=false to render the HTML preview, present "
            "it to the user, and wait for the second confirmation."
        ),
        "next_step": (
            "Phase 1 complete. Call build_dashboard_from_design() next — "
            "it reads the logged chart specs and builds the dashboard "
            "WITHOUT re-designing. That call is your second (final) confirm."
            if resolved_charts
            else "Phase 1 complete. Author chart specs, then call "
            "commit_full_dashboard or build_dashboard_from_design."
        ),
    }


@tool("report")
async def build_dashboard_from_design(
    dataset_id: int | None = None,
    dashboard_meta_override: dict[str, Any] | None = None,
    design_log_path: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """CONFIRM 2 of 2 — materialise the dashboard from Phase 1's logged
    `charts_design.json`. No re-design — pulls everything from the log.

    Without user_confirmed: renders HTML preview at
    `dashboard_preview.html` in the same log folder, returns its path
    for browser review.
    With user_confirmed=True: creates charts + dashboard in AppBI.

    `dashboard_meta_override` — optional {name, description} overriding
    the logged meta. `design_log_path` — explicit path for resumed
    sessions; defaults to the active log folder.
    """
    # Locate design file. Order of preference:
    #   1. explicit design_log_path
    #   2. logs/dataset_<id>/charts_design.json when dataset_id given
    #   3. latest dataset_*/charts_design.json across all known datasets
    from pathlib import Path as _Path
    if design_log_path:
        design_file = _Path(design_log_path)
    elif dataset_id is not None:
        design_file = _session_log_dir(dataset_id) / "charts_design.json"
    else:
        # Fallback: scan logs/dataset_*/ folders, pick the newest
        # charts_design.json. Helps resumed conversations where Claude
        # didn't track dataset_id explicitly.
        logs_root = _Path(__file__).resolve().parent / "logs"
        candidates = sorted(
            logs_root.glob("dataset_*/charts_design.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            return {
                "status": "no_design_found",
                "hint": (
                    "Pass dataset_id explicitly so the right design log "
                    "is read, or pass design_log_path. No "
                    "logs/dataset_*/charts_design.json was found."
                ),
            }
        design_file = candidates[0]
        logger.info(
            "build_dashboard_from_design: dataset_id omitted, picked "
            "newest design log: %s", design_file,
        )

    if not design_file.exists():
        return {
            "status": "no_design_found",
            "checked_path": str(design_file),
            "hint": (
                "Call commit_dataset_workspace first with a `planned_charts` "
                "list — that writes the design log this tool reads. Or pass "
                "design_log_path explicitly if reusing a prior session."
            ),
        }

    try:
        design = json.loads(design_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return {
            "status": "design_unreadable",
            "checked_path": str(design_file),
            "error": str(exc),
        }

    planned_charts = design.get("planned_charts") or []
    dashboard_meta = dict(design.get("dashboard_meta") or {})
    if dashboard_meta_override:
        dashboard_meta.update(dashboard_meta_override)
    if not dashboard_meta.get("name"):
        dashboard_meta["name"] = "Dashboard"

    if not planned_charts:
        return {
            "status": "empty_design",
            "checked_path": str(design_file),
            "hint": "Logged design has no planned_charts. Update Phase 1.",
        }

    # Always (re)write the HTML preview so DA can open it.
    preview_path = design_file.parent / "dashboard_preview.html"
    try:
        preview_path.write_text(
            _render_dashboard_html_preview(dashboard_meta, planned_charts),
            encoding="utf-8",
        )
    except OSError as exc:
        logger.warning("Failed to render dashboard preview: %s", exc)

    # Phase-15.46: refs audit on logged design — bare-only charts will
    # hit "Column X is ambiguous" if the dataset has joins.
    from appbi_chart_library import _audit_role_refs
    locked_charts: list[str] = []
    for chart in planned_charts:
        if not isinstance(chart, dict):
            continue
        audit = _audit_role_refs(chart.get("role_config") or {})
        if audit["is_locked_to_single_table"]:
            locked_charts.append(
                f"{chart.get('title')}: bare {audit['bare_refs']}"
            )

    if not user_confirmed:
        confirm_plan: dict[str, Any] = {
            "design_path": str(design_file),
            "html_preview_path": str(preview_path),
            "dashboard_name": dashboard_meta.get("name"),
            "chart_count": len(planned_charts),
            "chart_titles": [c.get("title") for c in planned_charts[:8]],
            "hint": (
                "Open html_preview_path in a browser to verify the "
                "layout. Call again with user_confirmed=True to write "
                "the charts + dashboard to AppBI."
            ),
        }
        if locked_charts:
            confirm_plan["refs_warning"] = (
                f"{len(locked_charts)}/{len(planned_charts)} planned "
                "charts use BARE refs only — locked to single-table. If "
                "the dataset has relationships (cross-table intent or to "
                "avoid 'Column X is ambiguous'), go back to Phase 1 and "
                "qualify the role_config fields as `view.field`."
            )
            confirm_plan["locked_charts"] = locked_charts[:10]
        return _requires_confirmation("build_dashboard_from_design", confirm_plan)

    # Materialise — for each chart, POST to /charts/. Then POST to
    # /dashboards/ with placements. Rollback any created chart on
    # dashboard failure.
    created_charts: list[dict[str, Any]] = []
    creation_errors: list[dict[str, Any]] = []
    placements: list[dict[str, Any]] = []

    for index, chart in enumerate(planned_charts):
        if not isinstance(chart, dict):
            continue
        chart_type = str(chart.get("chart_type") or "").upper()
        dataset_table_id = chart.get("dataset_table_id")
        if not dataset_table_id:
            creation_errors.append({
                "index": index,
                "title": chart.get("title"),
                "error": "dataset_table_id missing — Phase 1 did not resolve table reference",
            })
            continue
        config = _build_chart_config_from_spec(chart)
        body = _drop_none({
            "name": chart.get("title") or f"Chart {index + 1}",
            "description": chart.get("why_this_chart") or chart.get("description"),
            "chart_type": chart_type,
            "dataset_table_id": int(dataset_table_id),
            "config": config,
        })
        try:
            chart_result = await _request("POST", "/charts/", json_body=body)
        except RuntimeError as exc:
            creation_errors.append({
                "index": index,
                "title": body["name"],
                "error": str(exc),
            })
            continue
        chart_id = chart_result.get("id") if isinstance(chart_result, dict) else None
        created_charts.append({
            "id": chart_id,
            "title": body["name"],
            "chart_type": chart_type,
        })
        layout = _normalize_chart_layout(
            chart.get("layout"), chart_type, index
        )
        if chart_id is not None:
            placements.append({
                "chart_id": chart_id,
                "layout": layout,
                "widget_type": "chart",
            })

    if creation_errors:
        cleanup = await _rollback_created_charts(created_charts)
        return {
            "status": "partial_failure",
            "created_charts": created_charts,
            "creation_errors": creation_errors,
            "dashboard_created": False,
            "cleanup": cleanup,
            "html_preview_path": str(preview_path),
        }

    dashboard_body = _drop_none({
        "name": dashboard_meta.get("name"),
        "description": dashboard_meta.get("description"),
        "charts": placements,
        "layout_mode": dashboard_meta.get("layout_mode") or "grid",
        "theme_config": dashboard_meta.get("theme_config"),
    })

    try:
        dashboard_result = await _request(
            "POST", "/dashboards/", json_body=dashboard_body
        )
    except RuntimeError as exc:
        cleanup = await _rollback_created_charts(created_charts)
        return {
            "status": "dashboard_failed",
            "created_charts": created_charts,
            "dashboard_error": str(exc),
            "cleanup": cleanup,
            "html_preview_path": str(preview_path),
        }

    dashboard_id = (
        dashboard_result.get("id") if isinstance(dashboard_result, dict) else None
    )
    # Route logs to the dataset folder: design.json was written with the
    # dataset_id during Phase 1; reuse it here so the same dataset's
    # dataset.md / charts.md / report.md sit together.
    log_ds_id = design.get("dataset_id") if isinstance(design.get("dataset_id"), int) else dataset_id
    charts_log_path = _append_session_log(
        "charts",
        "build_dashboard_from_design",
        {
            "dataset_id": log_ds_id,
            "dashboard_id": dashboard_id,
            "see_dataset_md": "↳ measures + tables for this dashboard live in dataset.md (same folder)",
            "charts_created": [
                f"{c.get('title')} ({c.get('chart_type')}, id={c.get('id')})"
                for c in created_charts
            ],
        },
        dataset_id=log_ds_id,
    )
    report_log_path = _append_session_log(
        "report",
        "build_dashboard_from_design",
        {
            "dataset_id": log_ds_id,
            "dashboard_id": dashboard_id,
            "dashboard_name": dashboard_meta.get("name"),
            "see_charts_md": "↳ chart configs placed on this dashboard live in charts.md (same folder)",
            "placement_count": len(placements),
            "html_preview_path": str(preview_path),
        },
        dataset_id=log_ds_id,
    )
    return {
        "status": "committed",
        "dashboard_id": dashboard_id,
        "dashboard_name": dashboard_meta.get("name"),
        "created_charts": created_charts,
        "placement_count": len(placements),
        "html_preview_path": str(preview_path),
        "auto_logged_to": [
            p for p in [charts_log_path, report_log_path] if p
        ],
        "instruction_for_claude": (
            "Phase 2 of 2 committed. Tell the user briefly: "
            f"(a) dashboard_id={dashboard_id}, "
            f"(b) {len(placements)} charts placed, "
            f"(c) HTML preview at {preview_path}, "
            "(d) auto-log files written. The 2-confirm workflow is complete."
        ),
        "next_step": (
            "Dashboard is live in AppBI. Open html_preview_path to compare "
            "the design with what was committed."
        ),
    }


@tool("all")
async def commit_full_dashboard(
    semantic_plan: dict[str, Any] | str,
    dashboard_blueprint: dict[str, Any] | str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Stage 3+4 atomic commit — ONE confirmation covers semantic + dashboard.

    `semantic_plan`     — from propose_semantic_model.plan_template
    `dashboard_blueprint` — from propose_dashboard_blueprint.blueprint_template

    On semantic-commit failure: nothing else is attempted, return the
    structured error so Claude can fix the plan and retry.
    On dashboard-commit failure: the semantic model is LEFT IN PLACE
    (it's reusable). Claude can retry only the blueprint via
    commit_dashboard_blueprint.

    This is the 2nd of 2 confirmations in the canonical from-scratch
    flow. After this returns "committed", the dashboard is live and
    visible across Explore / Dataset Model / Dashboard list.
    """
    semantic = (
        _parse_plan_json(semantic_plan, "semantic_plan")
        if isinstance(semantic_plan, str)
        else semantic_plan
    )
    blueprint = (
        _parse_plan_json(dashboard_blueprint, "dashboard_blueprint")
        if isinstance(dashboard_blueprint, str)
        else dashboard_blueprint
    )
    if not isinstance(semantic, dict) or not isinstance(blueprint, dict):
        raise ValueError("Both plans must be objects.")

    if not user_confirmed:
        sem_views = (semantic.get("views") or [])
        bp_charts = (blueprint.get("charts") or [])
        sem_measure_count = sum(
            len((v or {}).get("measures") or []) for v in sem_views
        )
        return _requires_confirmation(
            "commit_full_dashboard",
            {
                "semantic_views": [v.get("name") for v in sem_views],
                "semantic_measure_count": sem_measure_count,
                "dashboard_name": (blueprint.get("dashboard") or {}).get("name"),
                "chart_count": len(bp_charts),
                "chart_titles": [c.get("title") for c in bp_charts[:8]],
            },
        )

    # Phase A — semantic (delegate, but pre-confirmed)
    sem_result = await commit_semantic_model(
        plan_json=semantic, user_confirmed=True, ctx=ctx
    )
    if isinstance(sem_result, dict) and sem_result.get("status") not in (
        "committed",
        None,
    ):
        return {
            "status": "blocked_at_semantic",
            "semantic_result": sem_result,
        }

    # Phase B — dashboard blueprint
    bp_result = await commit_dashboard_blueprint(
        blueprint_json=blueprint, user_confirmed=True, ctx=ctx
    )
    return {
        "status": (
            "committed"
            if isinstance(bp_result, dict)
            and bp_result.get("status") == "committed"
            else "partial"
        ),
        "semantic_result": sem_result,
        "dashboard_result": bp_result,
    }


# ---------------------------------------------------------------------------
# Helpers (private)
# ---------------------------------------------------------------------------


def _parse_plan_json(raw: str, field_name: str) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        plan = json.loads(str(raw))
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} is not valid JSON: {exc}") from exc
    if not isinstance(plan, dict):
        raise ValueError(f"{field_name} must decode to an object, got {type(plan).__name__}.")
    return plan


def _require_int(plan: dict[str, Any], key: str) -> int:
    value = plan.get(key)
    if value is None:
        raise ValueError(f"plan.{key} is required.")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"plan.{key} must be an int, got {value!r}.") from exc


def _split_qualified(field: str) -> tuple[str | None, str]:
    if not field:
        return None, ""
    if "." in field:
        view, _, name = field.partition(".")
        return view.strip() or None, name.strip()
    return None, field.strip()


async def _ensure_semantic_model(
    dataset_id: int,
    model_plan: dict[str, Any],
    existing_model: dict[str, Any],
) -> int:
    existing_model_id = existing_model.get("model_id")
    if existing_model_id:
        return int(existing_model_id)

    body = _drop_none(
        {
            "name": model_plan.get("name") or f"dataset_{dataset_id}_model",
            "dataset_id": dataset_id,
            "description": model_plan.get("description"),
        }
    )
    result = await _request("POST", "/semantic/models", json_body=body)
    if not isinstance(result, dict) or result.get("id") is None:
        raise RuntimeError(f"Failed to create semantic model: {result!r}")
    return int(result["id"])


# NOTE (Phase-12.5, 2026-05-16): Removed `_unqualify_role_config` from this
# file as well — it was a duplicate of the one in appbi_chart.py and had no
# call sites. See the longer note in appbi_chart.py for the full reasoning:
# the BE routing oracle now correctly handles qualified field refs, so MCP
# must NOT strip them. Stripping would silently demote dataset-scope (Phase
# 12) measures to the live_query path and lose JOINs.


def _build_chart_config_from_spec(chart_spec: dict[str, Any]) -> dict[str, Any]:
    """Translate a blueprint chart spec into the AppBI Explore config shape.

    Charts in the blueprint are intentionally compact (chart_type,
    dataset_table_id, role_config, layout). The chart endpoint expects
    the full Explore config with queryMode/roleConfig/generatedRoleConfig
    triplet. Build it here so the blueprint stays human-readable.

    IMPORTANT: preserve qualified semantic refs (`view.field`) when they
    are present. The backend chart runtime now decides whether the chart
    stays on the legacy single-table path or routes to semantic runtime.

    All metrics + role fields go through ``_normalize_role_config`` so the
    Explore FE never sees a metric with missing ``agg`` or a stray
    aggregation string the renderer doesn't understand — Phase-9 422 / FE
    crash class of bugs that surfaced for MCP-created charts only.
    """
    from appbi_chart import _normalize_role_config

    chart_type = str(chart_spec.get("chart_type") or "").upper()
    raw_role = dict(chart_spec.get("role_config") or {})
    role_config = _normalize_role_config(chart_type, raw_role)
    return {
        "chartType": chart_type,
        "queryMode": "generated",
        "roleConfig": role_config,
        "generatedRoleConfig": role_config,
        "customRoleConfig": {"metrics": []},
        "styleConfig": chart_spec.get("style_config") or {},
        "filters": chart_spec.get("filters") or [],
        "baseFilters": chart_spec.get("base_filters") or chart_spec.get("filters") or [],
    }


async def _runtime_preview_preflight(
    *,
    dataset_table_id: int,
    chart_type: str,
    config: dict[str, Any],
) -> list[str]:
    """Legacy str-list shape. Prefer _runtime_preview_diagnose for new callers."""
    diag = await _runtime_preview_diagnose(
        dataset_table_id=dataset_table_id,
        chart_type=chart_type,
        config=config,
    )
    return diag["errors"] if diag else []


async def _runtime_preview_diagnose(
    *,
    dataset_table_id: int,
    chart_type: str,
    config: dict[str, Any],
) -> dict[str, Any] | None:
    """Structured preview diagnosis — delegated to appbi_chart for shared impl."""
    from appbi_chart import _runtime_preview_diagnose as _impl
    return await _impl(
        dataset_table_id=dataset_table_id,
        chart_type=chart_type,
        config=config,
    )


async def _rollback_created_charts(created_charts: list[dict[str, Any]]) -> dict[str, Any]:
    deleted_ids: list[int] = []
    cleanup_errors: list[dict[str, Any]] = []
    for created in reversed(created_charts):
        chart_id = created.get("id")
        if chart_id is None:
            continue
        try:
            await _request("DELETE", f"/charts/{int(chart_id)}", expect_json=False)
            deleted_ids.append(int(chart_id))
        except RuntimeError as exc:
            cleanup_errors.append({"chart_id": int(chart_id), "error": str(exc)})
            logger.warning("Rollback delete failed for chart %s: %s", chart_id, exc)
    return {
        "deleted_chart_ids": deleted_ids,
        "cleanup_errors": cleanup_errors,
    }


__all__: list[str] = []
