"""
Tool definitions exposed to the LLM.

Each tool:
 - has an OpenAI-compatible JSON schema (used for function calling)
 - has an execute() coroutine that returns a plain dict
"""
import json
from typing import Any, AsyncGenerator, Dict, List, Optional

from app.clients.bi_client import bi_client
from app.config import settings


# ─────────────────────────────────────────────────────────────────────────────
# JSON Schemas (OpenAI function-calling format)
# ─────────────────────────────────────────────────────────────────────────────

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "search_charts",
            "description": (
                "Search for pre-built charts in the BI system. Call this FIRST for any data question. "
                "Returns top_chart_data with real data rows if a chart matches — read those rows to analyze."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query (e.g. 'FIFA rankings points', 'top scorers goals')"
                    },
                    "chart_type": {
                        "type": "string",
                        "enum": ["BAR", "LINE", "PIE", "TABLE", "KPI", "AREA", "STACKED_BAR", "GROUPED_BAR", "SCATTER", "TIME_SERIES"],
                        "description": "Optional: filter to a specific chart type"
                    },
                    "limit": {
                        "type": "integer",
                        "default": 10,
                        "description": "Max number of results to return"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_chart",
            "description": (
                "Execute a pre-built chart and return its data rows. "
                "The chart is automatically rendered on the user's screen. "
                "Only needed if search_charts did not include top_chart_data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_id": {
                        "type": "integer",
                        "description": "ID of the chart to execute"
                    }
                },
                "required": ["chart_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_dashboards",
            "description": "Search for dashboards by name or description. Useful when user asks about a dashboard or topic overview.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_dataset_tables",
            "description": "List all dataset tables with their column names and types. Call this before query_table to know exact column names available.",
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {
                        "type": "integer",
                        "description": "Optional: filter to a specific dataset ID"
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "query_table",
            "description": (
                "Run an aggregated analytical query on a dataset table. "
                "Supports GROUP BY (dimensions), aggregations (measures: sum/avg/count/min/max/count_distinct), "
                "WHERE filters, ORDER BY, and LIMIT. "
                "Always prefer this over run_dataset_table to avoid loading raw data. "
                "Measure result columns are aliased as {field}_{function} (e.g. total_points_sum). "
                "Use order_by with the aliased measure name to rank results."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {"type": "integer", "description": "Dataset ID"},
                    "table_id": {"type": "integer", "description": "Table ID within the dataset"},
                    "dimensions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Column names to GROUP BY (e.g. [\"team_name\", \"confederation\"])"
                    },
                    "measures": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": "string", "description": "Column to aggregate"},
                                "function": {
                                    "type": "string",
                                    "enum": ["sum", "avg", "count", "min", "max", "count_distinct"],
                                    "description": "Aggregation function"
                                }
                            },
                            "required": ["field", "function"]
                        },
                        "description": "Aggregations to compute. Result column = {field}_{function}"
                    },
                    "filters": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": "string"},
                                "operator": {"type": "string", "enum": ["=", "!=", ">", "<", ">=", "<=", "LIKE", "IN"]},
                                "value": {"type": "string"}
                            },
                            "required": ["field", "operator", "value"]
                        },
                        "description": "Optional WHERE conditions"
                    },
                    "order_by": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": "string", "description": "Column or aliased measure to sort by"},
                                "direction": {"type": "string", "enum": ["ASC", "DESC"], "default": "DESC"}
                            },
                            "required": ["field"]
                        },
                        "description": "Sort order (use measure alias like total_points_sum)"
                    },
                    "limit": {
                        "type": "integer",
                        "default": 20,
                        "description": "Max rows to return (default 20, max 200)"
                    }
                },
                "required": ["dataset_id", "table_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_dataset_table",
            "description": (
                "Fetch a sample of raw rows from a dataset table (no aggregation). "
                f"Use only for exploring data shape/samples. "
                "PREFER query_table for any analytical question. "
                f"Returns up to {settings.ai_dataset_table_limit} rows."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {
                        "type": "integer",
                        "description": "Dataset ID"
                    },
                    "table_id": {
                        "type": "integer",
                        "description": "Table ID within the dataset"
                    },
                    "limit": {
                        "type": "integer",
                        "default": 50,
                        "description": f"Number of rows to fetch (max {settings.ai_dataset_table_limit})"
                    }
                },
                "required": ["dataset_id", "table_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_chart",
            "description": (
                "Create a new chart visualization from a dataset table. "
                "Use when no existing chart matches what the user needs and you have identified the right table and columns. "
                "Call list_dataset_tables first to get dataset_id and table_id. "
                "With save=false returns a chart preview; save=true persists the chart permanently."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Chart title (descriptive, e.g. 'Revenue by Region')"
                    },
                    "dataset_id": {
                        "type": "integer",
                        "description": "Dataset ID (from list_dataset_tables)"
                    },
                    "table_id": {
                        "type": "integer",
                        "description": "Table ID within the dataset (from list_dataset_tables)"
                    },
                    "chart_type": {
                        "type": "string",
                        "enum": ["BAR", "LINE", "AREA", "PIE", "SCATTER", "GROUPED_BAR", "STACKED_BAR", "TABLE", "KPI", "TIME_SERIES"],
                        "description": "Chart type"
                    },
                    "config": {
                        "type": "object",
                        "properties": {
                            "dimensions": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Column names for X-axis / grouping (GROUP BY)"
                            },
                            "metrics": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "column": {"type": "string", "description": "Column to aggregate"},
                                        "aggregation": {
                                            "type": "string",
                                            "enum": ["sum", "avg", "count", "min", "max", "count_distinct"],
                                            "description": "Aggregation function"
                                        }
                                    },
                                    "required": ["column", "aggregation"]
                                },
                                "description": "Metrics to aggregate"
                            },
                            "limit": {
                                "type": "integer",
                                "default": 100,
                                "description": "Max data rows for the chart"
                            }
                        },
                        "description": "Chart configuration"
                    },
                    "save": {
                        "type": "boolean",
                        "description": "If true, save chart permanently to the system. Default false (preview only)."
                    }
                },
                "required": ["name", "dataset_id", "table_id", "chart_type", "config"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "explore_data",
            "description": (
                "Profile a dataset table to discover patterns, distributions, and data quality. "
                "Use when user says 'tell me about this data', 'what columns does this table have?', "
                "'anything interesting?', or before creating charts. "
                "Returns column stats, sample values, cardinality, null rates, and data patterns."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {
                        "type": "integer",
                        "description": "Dataset ID (from list_dataset_tables)"
                    },
                    "table_id": {
                        "type": "integer",
                        "description": "Table ID to profile (from list_dataset_tables)"
                    },
                    "analysis_type": {
                        "type": "string",
                        "enum": ["overview", "distribution", "time_patterns"],
                        "description": (
                            "overview: row count, column types, top values per column. "
                            "distribution: value counts per categorical column. "
                            "time_patterns: trend over time for numeric columns."
                        )
                    },
                    "focus_columns": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Specific columns to analyze. If empty, analyze all (up to 10)."
                    }
                },
                "required": ["dataset_id", "table_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "explain_insight",
            "description": (
                "Drill down into a metric to find root cause of a change. "
                "Use when user asks 'why did X change?', 'what caused the drop in Y?', 'explain this trend'. "
                "Compares current period vs previous period and breaks down by dimension columns to find the biggest contributors."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {
                        "type": "integer",
                        "description": "Dataset ID"
                    },
                    "table_id": {
                        "type": "integer",
                        "description": "Table ID to analyze"
                    },
                    "metric_column": {
                        "type": "string",
                        "description": "Numeric column to analyze (e.g. 'revenue', 'Points')"
                    },
                    "aggregation": {
                        "type": "string",
                        "enum": ["sum", "avg", "count", "max", "min"],
                        "description": "Aggregation function for the metric"
                    },
                    "time_column": {
                        "type": "string",
                        "description": "Date/time column for period comparison (required for time-based comparison)"
                    },
                    "comparison": {
                        "type": "string",
                        "enum": ["week_over_week", "month_over_month", "quarter_over_quarter", "year_over_year"],
                        "description": "Time comparison window"
                    },
                    "dimension_columns": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Columns to group by for drill-down analysis (e.g. ['Country', 'Confederation'])"
                    }
                },
                "required": ["dataset_id", "table_id", "metric_column", "aggregation", "dimension_columns"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_dashboard",
            "description": (
                "Automatically generate a complete dashboard with multiple charts from dataset tables. "
                "Use when user asks 'build me a dashboard', 'create a dashboard for X', "
                "'I need a monitoring page'. Auto-selects chart types based on data schema."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Dashboard topic / business domain (e.g. 'FIFA Rankings', 'Sales Overview')"
                    },
                    "tables": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "dataset_id": {"type": "integer"},
                                "table_id": {"type": "integer"},
                                "table_name": {"type": "string"}
                            },
                            "required": ["dataset_id", "table_id"]
                        },
                        "description": "Tables to use (from list_dataset_tables). Include dataset_id + table_id."
                    },
                    "chart_count": {
                        "type": "integer",
                        "description": "Number of charts to create (4-8). Default 6.",
                        "default": 6
                    }
                },
                "required": ["topic", "tables"]
            }
        }
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Tool executor
# ─────────────────────────────────────────────────────────────────────────────

def _fuzzy_score(query: str, text: str) -> int:
    """Simple word-overlap scoring (no external dep needed)."""
    q_words = set(query.lower().split())
    t_words = set(text.lower().split())
    return len(q_words & t_words)


async def execute_tool(name: str, args: Dict[str, Any], token: str = "") -> Dict[str, Any]:
    """Dispatch tool call and return structured result dict."""

    # ── search_charts ──────────────────────────────────────────────────────────
    if name == "search_charts":
        query = args.get("query", "")
        chart_type_filter = args.get("chart_type")
        limit = min(int(args.get("limit", 10)), 20)

        # --- Try vector search first ---
        vector_hits = await bi_client.search_similar_charts(query, limit=limit * 2, token=token)
        if chart_type_filter:
            vector_hits = [h for h in vector_hits if h.get("chart_type", "").upper() == chart_type_filter.upper()]

        if vector_hits:
            # Vector search succeeded — use semantic results
            results = [
                {
                    "id": h["id"],
                    "name": h["name"],
                    "chart_type": h.get("chart_type", ""),
                    "description": h.get("description", ""),
                }
                for h in vector_hits[:limit]
            ]
        else:
            # --- Fallback: fuzzy keyword search on chart name only ---
            # (metadata lookup removed — all charts return 404 until AutoTaggingService runs)
            charts = await bi_client.list_charts(limit=200, token=token)

            scored = []
            for c in charts:
                if chart_type_filter and c.get("chart_type", "").upper() != chart_type_filter.upper():
                    continue
                search_text = " ".join(filter(None, [
                    c.get("name", ""),
                    c.get("description", ""),
                ]))
                score = _fuzzy_score(query, search_text)
                if score > 0:
                    scored.append((score, c))

            scored.sort(key=lambda x: x[0], reverse=True)
            results = []
            for _, c in scored[:limit]:
                results.append({
                    "id": c["id"],
                    "name": c["name"],
                    "chart_type": c.get("chart_type", ""),
                    "description": c.get("description", ""),
                })

        if results:
            # Auto-run the top chart so data is always fetched
            top_chart_data = None
            if results:
                try:
                    top_id = results[0]["id"]
                    cresult = await bi_client.get_chart_data(top_id, token=token)
                    cmeta = cresult.get("chart", {})
                    cdata = cresult.get("data", [])
                    config = (cmeta.get("config") or {})
                    top_chart_data = {
                        "chart_id": top_id,
                        "chart_name": cmeta.get("name", ""),
                        "chart_type": cmeta.get("chart_type", ""),
                        "role_config": config.get("roleConfig"),
                        "rows": cdata,
                        "row_count": len(cdata),
                    }
                except Exception:
                    pass
            result = {
                "count": len(results),
                "charts": results,
            }
            if top_chart_data:
                # auto_chart: used by orchestrator to emit ChartEvent (stripped before sending to model)
                result["auto_chart"] = top_chart_data

                # Sort rows by the first numeric column descending so "top/most" answers read correctly
                model_rows = list(top_chart_data["rows"])
                role_cfg = top_chart_data.get("role_config") or {}
                metric_fields = [m.get("field") for m in role_cfg.get("metrics", []) if m.get("field")]
                sort_key = None
                if metric_fields:
                    sort_key = metric_fields[0]
                else:
                    # Fallback: first numeric column
                    for row in model_rows[:1]:
                        for k, v in row.items():
                            if isinstance(v, (int, float)):
                                sort_key = k
                                break
                if sort_key:
                    try:
                        model_rows.sort(key=lambda r: r.get(sort_key, 0), reverse=True)
                    except Exception:
                        pass

                # top_chart_data: sent to model so it can read rows[] for analysis
                result["top_chart_data"] = {
                    "chart_id": top_chart_data["chart_id"],
                    "chart_name": top_chart_data["chart_name"],
                    "chart_type": top_chart_data["chart_type"],
                    "rows": model_rows,
                    "row_count": top_chart_data["row_count"],
                }
            return result
        return {"count": 0, "charts": []}

    # ── run_chart ──────────────────────────────────────────────────────────────
    elif name == "run_chart":
        chart_id = int(args["chart_id"])
        result = await bi_client.get_chart_data(chart_id, token=token)

        chart_meta = result.get("chart", {})
        data = result.get("data", [])

        # Extract roleConfig from chart config so frontend can render correctly
        config = chart_meta.get("config", {}) or {}
        role_config = config.get("roleConfig")

        return {
            "chart_id": chart_id,
            "chart_name": chart_meta.get("name", ""),
            "chart_type": chart_meta.get("chart_type", ""),
            "role_config": role_config,
            "columns": list(data[0].keys()) if data else [],
            "rows": data,
            "row_count": len(data),
        }

    # ── search_dashboards ──────────────────────────────────────────────────────
    elif name == "search_dashboards":
        query = args.get("query", "")
        dashboards = await bi_client.list_dashboards(token=token)

        scored = []
        for d in dashboards:
            search_text = " ".join(filter(None, [d.get("name", ""), d.get("description", "")]))
            score = _fuzzy_score(query, search_text)
            if score > 0:
                scored.append((score, d))

        scored.sort(key=lambda x: x[0], reverse=True)
        results = [
            {
                "id": d["id"],
                "name": d["name"],
                "description": d.get("description", ""),
                "chart_count": len(d.get("charts", [])),
            }
            for _, d in scored[:10]
        ]
        return {"count": len(results), "dashboards": results}

    # ── list_dataset_tables ──────────────────────────────────────────────────
    elif name == "list_dataset_tables":
        dataset_id_filter = args.get("dataset_id")
        datasets = await bi_client.list_datasets(token=token)

        result = []
        for ws in datasets:
            if dataset_id_filter and ws["id"] != dataset_id_filter:
                continue
            full_ws = await bi_client.get_dataset(ws["id"], token=token)
            tables = full_ws.get("tables", [])
            result.append({
                "dataset_id": ws["id"],
                "dataset_name": ws["name"],
                "tables": [
                    {
                        "table_id": t["id"],
                        "display_name": t.get("display_name", ""),
                        "source_kind": t.get("source_kind", ""),
                        # Show columns with name + type for the AI to reference
                        "columns": [
                            {"name": c.get("name", c) if isinstance(c, dict) else c,
                             "type": c.get("type", "unknown") if isinstance(c, dict) else "unknown"}
                            for c in (
                                lambda cc: cc.get("columns", []) if isinstance(cc, dict) else (cc or [])
                            )(t.get("columns_cache") or t.get("columns"))
                        ],
                    }
                    for t in tables
                ],
            })

        return {"datasets": result}

    # ── query_table ────────────────────────────────────────────────────────────
    elif name == "query_table":
        dataset_id = int(args["dataset_id"])
        table_id = int(args["table_id"])
        dimensions = args.get("dimensions") or []
        measures = args.get("measures") or []
        filters = args.get("filters") or []
        order_by = args.get("order_by") or []
        limit = min(int(args.get("limit", 20)), 200)

        result = await bi_client.execute_table_query(
            dataset_id=dataset_id,
            table_id=table_id,
            dimensions=dimensions if dimensions else None,
            measures=measures if measures else None,
            filters=filters if filters else None,
            order_by=order_by if order_by else None,
            limit=limit,
            token=token,
        )

        # Flatten column metadata to simple list for token efficiency
        columns = [c.get("name", c) if isinstance(c, dict) else c for c in result.get("columns", [])]
        rows = result.get("rows", [])
        return {
            "dataset_id": dataset_id,
            "table_id": table_id,
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
        }

    # ── run_dataset_table ────────────────────────────────────────────────────
    elif name == "run_dataset_table":
        dataset_id = int(args["dataset_id"])
        table_id = int(args["table_id"])
        limit = min(int(args.get("limit", settings.ai_dataset_table_limit)), settings.ai_dataset_table_limit)

        result = await bi_client.preview_dataset_table(dataset_id, table_id, limit=limit, token=token)
        return {
            "dataset_id": dataset_id,
            "table_id": table_id,
            "columns": result.get("columns", []),
            "rows": result.get("rows", []),
            "row_count": result.get("row_count", 0),
        }

    # ── create_chart ───────────────────────────────────────────────────────────
    elif name == "create_chart":
        import datetime as _dt
        dataset_id = int(args["dataset_id"])
        table_id = int(args["table_id"])
        chart_type = args.get("chart_type", "BAR").upper()
        config = args.get("config") or {}
        chart_name = args.get("name", "AI Chart")
        save = bool(args.get("save", False))

        # Convert chart config metrics → execute measures
        metrics_cfg = config.get("metrics") or []
        measures = [
            {"field": m["column"], "function": m.get("aggregation", "sum")}
            for m in metrics_cfg if m.get("column")
        ]
        dimensions = config.get("dimensions") or []
        limit = min(int(config.get("limit", 100)), 500)

        # Execute query to get chart data
        exec_result = await bi_client.execute_table_query(
            dataset_id=dataset_id,
            table_id=table_id,
            dimensions=dimensions or None,
            measures=measures or None,
            limit=limit,
            token=token,
        )
        rows = exec_result.get("rows", [])

        chart_id = None
        saved = False
        if save:
            try:
                saved_chart = await bi_client.ai_chart_preview(
                    dataset_table_id=table_id,
                    chart_type=chart_type,
                    config=config,
                    name=chart_name,
                    save=True,
                    token=token,
                )
                chart_id = saved_chart.get("chart_id")
                saved = saved_chart.get("saved", False)
            except Exception as exc:
                pass  # Preview still returned data; saving failed silently

        return {
            "chart_preview": True,  # signal orchestrator to emit chart WS event
            "chart_name": chart_name,
            "chart_type": chart_type,
            "data": rows,
            "row_count": len(rows),
            "chart_id": chart_id,
            "saved": saved,
            "config": config,
            "dataset_id": dataset_id,
            "table_id": table_id,
        }

    # ── explore_data ───────────────────────────────────────────────────────────
    elif name == "explore_data":
        dataset_id = int(args["dataset_id"])
        table_id = int(args["table_id"])
        analysis_type = args.get("analysis_type", "overview")
        focus_columns: List[str] = args.get("focus_columns") or []

        # Step 1: get a sample to discover columns
        sample = await bi_client.preview_dataset_table(dataset_id, table_id, limit=50, token=token)
        columns_raw = sample.get("columns", [])
        all_columns = [c if isinstance(c, str) else c.get("name", str(c)) for c in columns_raw]
        rows_sample = sample.get("rows", [])
        total_rows_in_sample = len(rows_sample)

        target_cols = [c for c in all_columns if not focus_columns or c in focus_columns][:10]

        if analysis_type == "overview":
            # Compute per-column stats from sample
            col_stats = {}
            for col in target_cols:
                values = [r.get(col) for r in rows_sample if r.get(col) is not None]
                non_null_count = len(values)
                null_count = total_rows_in_sample - non_null_count
                unique_vals = list({str(v) for v in values[:20]})
                numeric_vals = [v for v in values if isinstance(v, (int, float))]
                col_stats[col] = {
                    "non_null": non_null_count,
                    "null_count": null_count,
                    "unique_sample": len(set(str(v) for v in values)),
                    "sample_values": unique_vals[:5],
                    "is_numeric": len(numeric_vals) > 0 and len(numeric_vals) == non_null_count,
                    "min": min(numeric_vals) if numeric_vals else None,
                    "max": max(numeric_vals) if numeric_vals else None,
                }
            return {
                "analysis_type": "overview",
                "table_id": table_id,
                "dataset_id": dataset_id,
                "sample_rows": total_rows_in_sample,
                "columns": all_columns,
                "column_stats": col_stats,
                "note": "Stats based on sample of up to 50 rows",
            }

        elif analysis_type == "distribution":
            # For each categorical column, get value counts
            results = {}
            categorical_cols = [
                c for c in target_cols
                if any(not isinstance(r.get(c), (int, float)) for r in rows_sample if r.get(c) is not None)
            ][:5]
            for col in categorical_cols:
                try:
                    dist = await bi_client.execute_table_query(
                        dataset_id=dataset_id,
                        table_id=table_id,
                        dimensions=[col],
                        measures=[{"field": col, "function": "count"}],
                        order_by=[{"field": f"{col}_count", "direction": "DESC"}],
                        limit=20,
                        token=token,
                    )
                    results[col] = dist.get("rows", [])[:10]
                except Exception:
                    pass
            return {
                "analysis_type": "distribution",
                "distributions": results,
                "columns_analyzed": list(results.keys()),
            }

        elif analysis_type == "time_patterns":
            # Find date columns and numeric columns for trend analysis
            date_cols = [
                c for c in all_columns
                if any(kw in c.lower() for kw in ("date", "time", "year", "month", "week", "day", "created", "updated"))
            ]
            numeric_cols = [
                c for c in target_cols
                if rows_sample and isinstance(rows_sample[0].get(c), (int, float))
            ]
            if not date_cols or not numeric_cols:
                return {
                    "analysis_type": "time_patterns",
                    "note": "No obvious date or numeric columns found. Try 'overview' first.",
                    "columns": all_columns,
                }
            time_col = date_cols[0]
            metric_col = numeric_cols[0]
            try:
                trend = await bi_client.execute_table_query(
                    dataset_id=dataset_id,
                    table_id=table_id,
                    dimensions=[time_col],
                    measures=[{"field": metric_col, "function": "sum"}, {"field": metric_col, "function": "count"}],
                    order_by=[{"field": time_col, "direction": "ASC"}],
                    limit=100,
                    token=token,
                )
                return {
                    "analysis_type": "time_patterns",
                    "time_column": time_col,
                    "metric_column": metric_col,
                    "trend_data": trend.get("rows", []),
                    "row_count": trend.get("row_count", 0),
                }
            except Exception as exc:
                return {"analysis_type": "time_patterns", "error": str(exc)}

        return {"error": f"Unknown analysis_type: {analysis_type}"}

    # ── explain_insight ────────────────────────────────────────────────────────
    elif name == "explain_insight":
        import datetime as _dt
        dataset_id = int(args["dataset_id"])
        table_id = int(args["table_id"])
        metric_col = args["metric_column"]
        agg = args.get("aggregation", "sum")
        time_col = args.get("time_column")
        comparison = args.get("comparison", "month_over_month")
        dimension_cols: List[str] = args.get("dimension_columns") or []

        # ── Overall metric without time filter (if no time_column) ──
        if not time_col:
            # Just compute overall metric per dimension
            drill_results = []
            for dim in dimension_cols[:5]:
                try:
                    res = await bi_client.execute_table_query(
                        dataset_id=dataset_id,
                        table_id=table_id,
                        dimensions=[dim],
                        measures=[{"field": metric_col, "function": agg}],
                        order_by=[{"field": f"{metric_col}_{agg}", "direction": "DESC"}],
                        limit=10,
                        token=token,
                    )
                    drill_results.append({"dimension": dim, "data": res.get("rows", [])})
                except Exception as exc:
                    drill_results.append({"dimension": dim, "error": str(exc)})
            return {
                "type": "breakdown",
                "metric_column": metric_col,
                "aggregation": agg,
                "drill_downs": drill_results,
                "note": "No time_column provided — showing breakdown by dimension only",
            }

        # ── Compute date ranges for comparison ──
        today = _dt.date.today()
        if comparison == "week_over_week":
            curr_start = today - _dt.timedelta(days=today.weekday())  # Monday this week
            curr_end = today
            prev_start = curr_start - _dt.timedelta(weeks=1)
            prev_end = curr_start - _dt.timedelta(days=1)
        elif comparison == "month_over_month":
            curr_start = today.replace(day=1)
            curr_end = today
            prev_month = (curr_start - _dt.timedelta(days=1)).replace(day=1)
            prev_start = prev_month
            prev_end = curr_start - _dt.timedelta(days=1)
        elif comparison == "quarter_over_quarter":
            quarter_month = ((today.month - 1) // 3) * 3 + 1
            curr_start = today.replace(month=quarter_month, day=1)
            curr_end = today
            prev_quarter_end = curr_start - _dt.timedelta(days=1)
            prev_quarter_start_month = ((prev_quarter_end.month - 1) // 3) * 3 + 1
            prev_start = prev_quarter_end.replace(month=prev_quarter_start_month, day=1)
            prev_end = prev_quarter_end
        else:  # year_over_year
            curr_start = today.replace(month=1, day=1)
            curr_end = today
            prev_start = curr_start.replace(year=curr_start.year - 1)
            prev_end = curr_start - _dt.timedelta(days=1)

        curr_filters = [
            {"field": time_col, "operator": ">=", "value": str(curr_start)},
            {"field": time_col, "operator": "<=", "value": str(curr_end)},
        ]
        prev_filters = [
            {"field": time_col, "operator": ">=", "value": str(prev_start)},
            {"field": time_col, "operator": "<=", "value": str(prev_end)},
        ]

        # ── Overall metric current vs previous ──
        try:
            curr_res = await bi_client.execute_table_query(
                dataset_id=dataset_id, table_id=table_id,
                measures=[{"field": metric_col, "function": agg}],
                filters=curr_filters, limit=1, token=token,
            )
            prev_res = await bi_client.execute_table_query(
                dataset_id=dataset_id, table_id=table_id,
                measures=[{"field": metric_col, "function": agg}],
                filters=prev_filters, limit=1, token=token,
            )
            curr_val = float(list(curr_res.get("rows", [{}])[0].values())[0] or 0) if curr_res.get("rows") else 0
            prev_val = float(list(prev_res.get("rows", [{}])[0].values())[0] or 0) if prev_res.get("rows") else 0
        except Exception:
            curr_val = prev_val = 0

        change_pct = round((curr_val - prev_val) / prev_val * 100, 1) if prev_val else 0

        # ── Drill down by each dimension ──
        drill_results = []
        for dim in dimension_cols[:5]:
            try:
                curr_dim = await bi_client.execute_table_query(
                    dataset_id=dataset_id, table_id=table_id,
                    dimensions=[dim],
                    measures=[{"field": metric_col, "function": agg}],
                    filters=curr_filters,
                    order_by=[{"field": f"{metric_col}_{agg}", "direction": "DESC"}],
                    limit=10, token=token,
                )
                prev_dim = await bi_client.execute_table_query(
                    dataset_id=dataset_id, table_id=table_id,
                    dimensions=[dim],
                    measures=[{"field": metric_col, "function": agg}],
                    filters=prev_filters,
                    order_by=[{"field": f"{metric_col}_{agg}", "direction": "DESC"}],
                    limit=10, token=token,
                )
                # Merge current vs previous by dimension value
                prev_map = {}
                metric_key = f"{metric_col}_{agg}"
                for row in prev_dim.get("rows", []):
                    dim_val = str(row.get(dim, ""))
                    prev_map[dim_val] = float(row.get(metric_key, 0) or 0)

                contributions = []
                for row in curr_dim.get("rows", []):
                    dim_val = str(row.get(dim, ""))
                    cv = float(row.get(metric_key, 0) or 0)
                    pv = prev_map.get(dim_val, 0)
                    dim_change = round((cv - pv) / pv * 100, 1) if pv else 0
                    abs_impact = round((cv - pv) / (curr_val - prev_val) * 100, 1) if (curr_val - prev_val) else 0
                    contributions.append({
                        "value": dim_val,
                        "current": cv,
                        "previous": pv,
                        "change_pct": dim_change,
                        "contribution_pct": abs_impact,
                    })
                drill_results.append({"dimension": dim, "contributions": contributions})
            except Exception as exc:
                drill_results.append({"dimension": dim, "error": str(exc)})

        return {
            "type": "period_comparison",
            "metric_column": metric_col,
            "aggregation": agg,
            "comparison": comparison,
            "periods": {
                "current": {"start": str(curr_start), "end": str(curr_end), "value": curr_val},
                "previous": {"start": str(prev_start), "end": str(prev_end), "value": prev_val},
                "change_pct": change_pct,
            },
            "drill_downs": drill_results,
        }

    # ── create_dashboard ───────────────────────────────────────────────────────
    elif name == "create_dashboard":
        topic = args.get("topic", "Dashboard")
        tables_arg: List[Dict] = args.get("tables") or []
        chart_count = min(int(args.get("chart_count", 6)), 8)

        if not tables_arg:
            return {"error": "No tables provided. Call list_dataset_tables first to find table IDs."}

        # Analyse first table to understand schema
        first = tables_arg[0]
        ws_id = int(first["dataset_id"])
        tbl_id = int(first["table_id"])
        tbl_name = first.get("table_name", f"table_{tbl_id}")

        sample = await bi_client.preview_dataset_table(ws_id, tbl_id, limit=20, token=token)
        all_cols = [c if isinstance(c, str) else c.get("name", str(c)) for c in sample.get("columns", [])]
        rows_sample = sample.get("rows", [])

        # Detect numeric vs categorical columns
        numeric_cols = [
            c for c in all_cols
            if rows_sample and isinstance(rows_sample[0].get(c), (int, float))
        ]
        categorical_cols = [c for c in all_cols if c not in numeric_cols]
        date_cols = [
            c for c in all_cols
            if any(kw in c.lower() for kw in ("date", "time", "year", "month", "day", "created"))
        ]

        # Dashboard template slots
        DEFAULT_LAYOUT = [
            {"i": "kpi-0",     "x": 0, "y": 0, "w": 3, "h": 2},
            {"i": "kpi-1",     "x": 3, "y": 0, "w": 3, "h": 2},
            {"i": "trend",     "x": 0, "y": 2, "w": 6, "h": 4},
            {"i": "breakdown", "x": 0, "y": 6, "w": 4, "h": 4},
            {"i": "pie",       "x": 4, "y": 6, "w": 2, "h": 4},
            {"i": "table",     "x": 0, "y": 10, "w": 6, "h": 4},
        ]

        chart_specs = []
        if numeric_cols:
            chart_specs.append(("KPI", f"{topic} — {numeric_cols[0]} Total", {
                "dimensions": [], "metrics": [{"column": numeric_cols[0], "aggregation": "sum"}]
            }))
        if len(numeric_cols) > 1:
            chart_specs.append(("KPI", f"{topic} — {numeric_cols[1]} Avg", {
                "dimensions": [], "metrics": [{"column": numeric_cols[1], "aggregation": "avg"}]
            }))
        if date_cols and numeric_cols:
            chart_specs.append(("LINE", f"{topic} — Trend over time", {
                "dimensions": [date_cols[0]],
                "metrics": [{"column": numeric_cols[0], "aggregation": "sum"}],
                "limit": 100
            }))
        if categorical_cols and numeric_cols:
            chart_specs.append(("BAR", f"{topic} — {numeric_cols[0]} by {categorical_cols[0]}", {
                "dimensions": [categorical_cols[0]],
                "metrics": [{"column": numeric_cols[0], "aggregation": "sum"}],
                "limit": 20
            }))
        if len(categorical_cols) > 1 and numeric_cols:
            chart_specs.append(("PIE", f"{topic} — {numeric_cols[0]} by {categorical_cols[1]}", {
                "dimensions": [categorical_cols[1]],
                "metrics": [{"column": numeric_cols[0], "aggregation": "sum"}],
                "limit": 10
            }))
        chart_specs.append(("TABLE", f"{topic} — Data Table", {
            "dimensions": categorical_cols[:3] if categorical_cols else [],
            "metrics": [{"column": c, "aggregation": "sum"} for c in numeric_cols[:2]],
            "limit": 20
        }))
        chart_specs = chart_specs[:chart_count]

        # Create charts via AI preview (save=true)
        created_chart_ids = []
        chart_errors = []
        for i, (chart_type, chart_name, chart_cfg) in enumerate(chart_specs):
            try:
                preview = await bi_client.ai_chart_preview(
                    dataset_table_id=tbl_id,
                    chart_type=chart_type,
                    config=chart_cfg,
                    name=chart_name,
                    save=True,
                    token=token,
                )
                cid = preview.get("chart_id")
                if cid:
                    created_chart_ids.append((cid, DEFAULT_LAYOUT[i]["i"] if i < len(DEFAULT_LAYOUT) else f"chart-{i}"))
            except Exception as exc:
                chart_errors.append(f"Chart '{chart_name}': {str(exc)[:100]}")

        if not created_chart_ids:
            return {"error": "Failed to create any charts", "details": chart_errors}

        # Create dashboard
        try:
            dash = await bi_client.create_dashboard(
                name=f"{topic} Dashboard",
                description=f"Auto-generated by AI Agent from table: {tbl_name}",
                token=token,
            )
            dashboard_id = dash.get("id")
        except Exception as exc:
            return {"error": f"Failed to create dashboard: {str(exc)}"}

        # Add charts to dashboard
        for cid, slot_id in created_chart_ids:
            try:
                await bi_client.add_chart_to_dashboard(dashboard_id, cid, {}, token=token)
            except Exception:
                pass

        # Update layout
        layouts = []
        for i, (cid, slot_id) in enumerate(created_chart_ids):
            tmpl = DEFAULT_LAYOUT[i] if i < len(DEFAULT_LAYOUT) else {"x": 0, "y": i * 4, "w": 6, "h": 4}
            layouts.append({"chart_id": cid, **{k: tmpl[k] for k in ("x", "y", "w", "h")}})
        try:
            await bi_client.update_dashboard_layout(dashboard_id, layouts, token=token)
        except Exception:
            pass

        return {
            "dashboard_id": dashboard_id,
            "dashboard_name": f"{topic} Dashboard",
            "chart_count": len(created_chart_ids),
            "chart_ids": [cid for cid, _ in created_chart_ids],
            "errors": chart_errors if chart_errors else None,
            "message": f"Created dashboard '{topic} Dashboard' with {len(created_chart_ids)} charts. Navigate to /dashboards/{dashboard_id} to view it.",
        }

    else:
        return {"error": f"Unknown tool: {name}"}
