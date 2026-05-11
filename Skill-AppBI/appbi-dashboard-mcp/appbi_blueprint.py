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

import json
from typing import Any

from appbi_core import (
    APPBI_LONG_TIMEOUT_SECONDS,
    Context,
    _drop_none,
    _request,
    _requires_confirmation,
    logger,
    mcp,
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
                {
                    "name": "<str — e.g. total_revenue>",
                    "type": "count|sum|avg|min|max|count_distinct|percent_of_total",
                    "sql": "${TABLE}.<col>  (column to aggregate; ignored if expression set)",
                    "label": "<str>",
                    "description": "<str — business meaning>",
                    "folder": "<str — optional UI grouping, e.g. 'Revenue'>",
                    # ── Phase-1 extensions (all optional, omit if not used) ──
                    # Use `expression` for arithmetic across columns; takes
                    # precedence over `sql`. e.g. "${TABLE}.amount - ${TABLE}.cost"
                    "expression": "<str — optional SQL expression, overrides sql>",
                    # Structured filters → CASE WHEN wrapper (Looker-style
                    # filtered measure). Example: revenue from paid orders only.
                    "filters": [
                        {
                            "field": "<str — bare column or view.col>",
                            "operator": "eq|ne|gt|gte|lt|lte|in|not_in|between|"
                                        "contains|starts_with|ends_with|"
                                        "is_null|is_not_null",
                            "value": "<scalar | [a,b,...] for in/not_in | [lo,hi] for between>",
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


@mcp.tool()
async def propose_semantic_model(
    dataset_id: int,
    business_intent: str,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """**Step 1 of canonical flow** — surface the design Claude is about to
    propose without writing anything yet.

    Use BEFORE creating any chart for a dataset that does not already
    have a semantic model. Pulls the dataset structure (tables + columns
    + relationships) and existing model state, returning the context
    Claude needs to author a plan that respects what's already there.

    Returns:
      - existing_model: snapshot of any SemanticView/Explore already
        attached to this dataset (so Claude doesn't propose duplicates).
      - tables: list of dataset tables with id, display_name, columns.
      - plan_template: the structured shape Claude must produce next as
        the `plan_json` argument to `commit_semantic_model`.
      - guidance: rules Claude must follow when writing measures.

    What Claude must do with this output:
      1. Read existing_model — if a view already covers a table, plan an
         UPDATE (via update_semantic_view), not a duplicate create.
      2. Profile any unfamiliar table via get_table_profile before
         picking dimension/measure types.
      3. Author the plan as JSON matching plan_template.
      4. Surface open_questions_for_user in chat — wait for the human
         to answer before calling commit_semantic_model.
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


@mcp.tool()
async def commit_semantic_model(
    plan_json: str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """**Step 2 of canonical flow** — execute a semantic model plan.

    Reads `plan_json` (the JSON-encoded plan Claude authored after
    `propose_semantic_model`), validates it client-side, then issues the
    underlying writes:
      1. Create or update SemanticModel for the dataset.
      2. For each entry in `views`: create or update SemanticView
         (matched by dataset_table_id when present, else by name).
      3. For each entry in `explores`: create or update SemanticExplore.

    The first call (without `user_confirmed=True`) returns a diff plan
    — what will be created vs updated, total measure count, any
    validation errors. The user reviews; only on consent do you re-call
    with `user_confirmed=True`.

    Refuses to write if any view has zero measures (dashboards built on
    that view will produce ad-hoc metrics — exactly what we are trying
    to prevent). Surface the error to the human and ask for measure
    definitions before retrying.
    """
    plan = _parse_plan_json(plan_json, "plan_json")

    dataset_id = _require_int(plan, "dataset_id")
    views_plan = plan.get("views") or []
    explores_plan = plan.get("explores") or []
    model_plan = plan.get("model") or {}

    if not isinstance(views_plan, list) or not views_plan:
        raise ValueError("plan must include at least one view in `views`.")

    validation_errors: list[str] = []
    _ALLOWED_FILTER_OPS = {
        "eq", "ne", "gt", "gte", "lt", "lte",
        "in", "not_in", "between",
        "contains", "starts_with", "ends_with",
        "is_null", "is_not_null",
    }
    _LIST_OPS = {"in", "not_in", "between"}
    _NO_VALUE_OPS = {"is_null", "is_not_null"}
    _ALLOWED_FORMAT_KINDS = {"number", "currency", "percent", "duration", "custom"}

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

            # depends_on — names must exist on the same view and never self-ref
            for dep in m.get("depends_on") or []:
                if dep == m_name:
                    validation_errors.append(
                        f"{loc}.depends_on includes self-reference '{dep}'."
                    )
                elif dep not in measure_names:
                    validation_errors.append(
                        f"{loc}.depends_on '{dep}' is not a measure on this view. "
                        f"Available: {sorted(measure_names)}."
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

        # Cycle detection across measures within the view (depends_on graph).
        if not validation_errors:
            graph = {
                str(m.get("name")): list(m.get("depends_on") or [])
                for m in measures if isinstance(m, dict) and m.get("name")
            }
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

            for start in graph:
                cycle = _walk(start, [])
                if cycle:
                    validation_errors.append(
                        f"views[{index}] '{view_name}' has a measure dependency "
                        f"cycle: {cycle}. Break the cycle before committing."
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


@mcp.tool()
async def propose_dashboard_blueprint(
    dataset_id: int,
    business_intent: str,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """**Step 3 of canonical flow** — design the dashboard before writing.

    Pulls the semantic model state (which measures exist, on which view,
    reachable via which explore) and returns the catalogue Claude must
    use when writing chart specs. Returns:

      - available_measures: full list of `view.measure_name` Claude can
        reference. Charts that use any other metric will be rejected at
        commit time.
      - available_dimensions: same for dimensions.
      - explores: which set of joined views each chart can pull from.
      - blueprint_template: the JSON shape for the next call.

    Forces Claude to write `metric_definitions` that EVERY chart spec
    references — this is the contract that prevents ad-hoc metrics. If
    a measure Claude wants is missing, the answer is to go back to
    `propose_semantic_model` and add it, not to invent it in the chart.
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
    for view in model.get("views") or []:
        view_name = view.get("name")
        if view.get("dataset_table_id") is not None:
            table_to_view[int(view["dataset_table_id"])] = view
        for measure in view.get("measures") or []:
            available_measures.append(
                {
                    "qualified_name": f"{view_name}.{measure.get('name')}",
                    "field": measure.get("name"),
                    "view": view_name,
                    "agg_type": measure.get("type"),
                    "label": measure.get("label"),
                    "description": measure.get("description"),
                }
            )
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
        "next_step": (
            "Author blueprint_json. Surface open_questions_for_user, get "
            "human approval, then call commit_dashboard_blueprint."
        ),
    }


@mcp.tool()
async def commit_dashboard_blueprint(
    blueprint_json: str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """**Step 4 of canonical flow** — materialise a dashboard from a
    blueprint authored after `propose_dashboard_blueprint`.

    Validates every chart against the live semantic model:
      - dataset_table_id resolves to a SemanticView
      - each metric `field` resolves to a measure on that bound view
      - chart_type role_config has the required role fields
      - the final stored config passes `preview_chart_data`

    On the first call returns a diff plan with validation results and
    refuses to write. On confirmation:
      1. Creates each chart via POST /charts/.
      2. Creates the dashboard with all chart placements via
         POST /dashboards/.
    """
    blueprint = _parse_plan_json(blueprint_json, "blueprint_json")
    dataset_id = _require_int(blueprint, "dataset_id")

    dashboard_meta = blueprint.get("dashboard") or {}
    if not dashboard_meta.get("name"):
        raise ValueError("blueprint.dashboard.name is required.")

    charts_plan = blueprint.get("charts") or []
    if not isinstance(charts_plan, list) or not charts_plan:
        raise ValueError("blueprint.charts must be a non-empty list.")

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
    measure_index: dict[str, set[str]] = {}
    dimension_index: dict[str, set[str]] = {}
    table_to_view_name: dict[int, str] = {}
    for view in model.get("views") or []:
        vname = str(view.get("name") or "")
        measure_index[vname] = {
            str(m.get("name")) for m in (view.get("measures") or []) if m.get("name")
        }
        dimension_index[vname] = {
            str(d.get("name")) for d in (view.get("dimensions") or []) if d.get("name")
        }
        if view.get("dataset_table_id") is not None:
            table_to_view_name[int(view["dataset_table_id"])] = vname

    # explore_reachable_views[base_view_name] = set of all view names reachable
    # via that explore's joins (includes base view itself).
    explore_reachable_views: dict[str, set[str]] = {}
    for explore in model.get("explores") or []:
        base = str(explore.get("base_view_name") or "")
        if not base:
            continue
        reachable = {base}
        for join in explore.get("joins") or []:
            jv = str(join.get("view") or "").strip()
            if jv:
                reachable.add(jv)
        # Union with any existing entry so multiple explores on same base merge.
        explore_reachable_views[base] = explore_reachable_views.get(base, set()) | reachable

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

    def _check_dim_field(
        role_config: dict[str, Any],
        key: str,
        view_name: str | None,
        reachable: set[str],
        errors: list[str],
    ) -> None:
        val = str(role_config.get(key) or "").strip()
        if not val:
            errors.append(f"role_config.{key} is required but missing.")
            return
        q_view, q_field = _split_qualified(val)
        target_view = q_view if q_view else view_name
        if target_view is None:
            errors.append(f"role_config.{key}='{val}': cannot resolve view.")
            return
        if q_view and q_view not in reachable:
            errors.append(
                f"role_config.{key}='{val}' references view '{q_view}' "
                "which is not reachable via the chart's explore joins."
            )
            return
        check_field = q_field if q_view else val
        # Accept qualified references (view.field) - they are already
        # resolved above.  For unqualified names just check the bound view.
        if q_view:
            if check_field not in dimension_index.get(q_view, set()):
                avail = sorted(dimension_index.get(q_view, set()))
                errors.append(
                    f"role_config.{key}='{val}' is not a dimension on view "
                    f"'{q_view}'. Available: {avail}."
                )
        else:
            if check_field not in dimension_index.get(target_view, set()):
                avail = sorted(dimension_index.get(target_view, set()))
                errors.append(
                    f"role_config.{key}='{val}' is not a dimension on view "
                    f"'{target_view}'. Available: {avail}."
                )

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
        reachable_views = explore_reachable_views.get(view_name or "", set()) if view_name else set()

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
                    errors.append(
                        f"metrics[{m_index}].field='{field}' is not a measure "
                        f"on view '{qualified_view}'. "
                        f"Available: {sorted(measure_index[qualified_view])}."
                    )
                elif qualified_view != view_name:
                    errors.append(
                        f"metrics[{m_index}].field='{field}' references joined "
                        f"view '{qualified_view}'. Saved charts currently support "
                        f"only measures from the bound view '{view_name}'."
                    )
            else:
                if view_name is None:
                    errors.append(
                        f"metrics[{m_index}].field='{field}' is unqualified "
                        "and chart has no resolvable view."
                    )
                elif field not in measure_index.get(view_name, set()):
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
                if q_view and q_view != view_name:
                    errors.append(
                        f"role_config.{dim_key}='{val}' references joined view "
                        f"'{q_view}'. Saved charts currently support only fields "
                        f"from the bound view '{view_name}'."
                    )
                elif q_view:
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
                elif qualified_view != view_name:
                    errors.append(
                        f"role_config.{metric_key}.field='{field}' references joined "
                        f"view '{qualified_view}'. Saved charts currently support "
                        f"only measures from the bound view '{view_name}'."
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
                elif qualified_view != view_name:
                    errors.append(
                        f"role_config.selectedColumns[{col_index}]='{field}' references "
                        f"joined view '{qualified_view}'. Saved charts currently support "
                        f"only fields from the bound view '{view_name}'."
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
    preview_validation: list[dict[str, Any]] = []
    for index, chart in enumerate(valid_specs):
        config = _build_chart_config_from_spec(chart)
        preview_errors = await _runtime_preview_preflight(
            dataset_table_id=int(chart["dataset_table_id"]),
            chart_type=str(chart.get("chart_type") or "").upper(),
            config=config,
        )
        if preview_errors:
            preview_validation.append(
                {
                    "index": index,
                    "title": chart.get("title") or chart.get("name") or f"chart_{index}",
                    "errors": preview_errors,
                    "valid": False,
                }
            )
            continue
        staged_specs.append({"chart": chart, "config": config})

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

    if not user_confirmed:
        return _requires_confirmation(
            "commit_dashboard_blueprint",
            {
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
            },
        )

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
        layout = chart.get("layout") or {"x": 0, "y": index * 4, "w": 12, "h": 4}
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

    return {
        "status": "committed",
        "dashboard_id": dashboard_result.get("id") if isinstance(dashboard_result, dict) else None,
        "dashboard_name": dashboard_meta.get("name"),
        "created_charts": created_charts,
        "placement_count": len(placements),
        "next_step": "Verify in the AppBI UI: dashboard renders, charts appear in Explore with their dataset_table bound, and dataset model UI lists the new measures.",
    }


# ---------------------------------------------------------------------------
# Audit + repair (for pre-blueprint legacy data)
# ---------------------------------------------------------------------------


@mcp.tool()
async def audit_chart_semantic_health(
    dataset_id: int | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Inventory charts whose data structure is *not* visible in the
    Explore / dataset-model UI even though they render.

    Flags three failure modes:
      - **orphan_dataset_table**: chart.dataset_table_id is NULL or the
        table no longer exists.
      - **no_semantic_view**: the chart's table has no SemanticView, so
        the chart's metrics cannot resolve to anything reusable.
      - **adhoc_metric**: a metric in the chart's config does not match
        any measure on the bound view.

    Read-only. Run before deciding which charts to repair vs delete.
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


@mcp.tool()
async def repair_chart_semantic_binding(
    chart_id: int,
    dataset_table_id: int | None = None,
    add_missing_measures: bool = True,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Fix a chart whose semantic binding is broken (per
    audit_chart_semantic_health).

    What it does:
      1. If `dataset_table_id` is provided, re-point the chart at it.
      2. Resolve the chart's bound view + missing measures.
      3. If `add_missing_measures=True`, append SUM measures to the
         view for any chart metric that doesn't yet exist (Claude can
         later edit the type/sql via update_semantic_view).

    Returns a confirmation plan first; only writes on user_confirmed.
    Does not delete or overwrite anything that was already correct.
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


def _unqualify_role_config(role_config: dict[str, Any]) -> dict[str, Any]:
    """Strip 'view.' prefix from all field names in a role_config dict.

    The backend's LiveQueryService.build_live_agg_query treats role_config
    field names as raw SQL column identifiers: it wraps them with
    _quote_identifier which produces `"view.field"` — an invalid SQL
    identifier. The semantic validation layer accepts qualified names for
    cross-view resolution, but the stored config must use bare column names.
    """
    def _bare(val: str) -> str:
        """Return the part after 'view.' if qualified, else the value unchanged."""
        if val and "." in val:
            _, _, name = val.partition(".")
            return name.strip() or val
        return val

    rc = dict(role_config)

    # Scalar dimension-like fields
    for key in ("dimension", "breakdown", "timeField", "scatterX", "scatterY",
                "tableRowDimension", "tableColumnDimension"):
        if isinstance(rc.get(key), str):
            rc[key] = _bare(rc[key])

    # metrics list
    if isinstance(rc.get("metrics"), list):
        rc["metrics"] = [
            {**m, "field": _bare(m["field"])} if isinstance(m, dict) and isinstance(m.get("field"), str) else m
            for m in rc["metrics"]
        ]

    # Single-metric special fields
    for key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
        if isinstance(rc.get(key), dict) and isinstance(rc[key].get("field"), str):
            rc[key] = {**rc[key], "field": _bare(rc[key]["field"])}

    # selectedColumns list
    if isinstance(rc.get("selectedColumns"), list):
        rc["selectedColumns"] = [_bare(c) if isinstance(c, str) else c for c in rc["selectedColumns"]]

    return rc


def _build_chart_config_from_spec(chart_spec: dict[str, Any]) -> dict[str, Any]:
    """Translate a blueprint chart spec into the AppBI Explore config shape.

    Charts in the blueprint are intentionally compact (chart_type,
    dataset_table_id, role_config, layout). The chart endpoint expects
    the full Explore config with queryMode/roleConfig/generatedRoleConfig
    triplet. Build it here so the blueprint stays human-readable.

    IMPORTANT: role_config field names are stripped of 'view.' qualifiers
    before storage. The backend's LiveQueryService uses them as raw SQL
    column identifiers; qualified names like 'orders.amount' would cause
    a 500 in Explore because the backend wraps them as \"orders.amount\"
    (invalid SQL column reference).
    """
    role_config = _unqualify_role_config(dict(chart_spec.get("role_config") or {}))
    chart_type = str(chart_spec.get("chart_type") or "").upper()
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
    try:
        await _request(
            "POST",
            "/charts/preview-data",
            json_body={
                "dataset_table_id": int(dataset_table_id),
                "chart_type": chart_type,
                "config": config,
            },
            timeout_seconds=APPBI_LONG_TIMEOUT_SECONDS,
        )
    except RuntimeError as exc:
        return [f"preview_chart_data failed for the final stored config: {exc}"]
    return []


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
