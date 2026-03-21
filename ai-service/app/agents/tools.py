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
            "name": "execute_sql",
            "description": (
                "Execute a SELECT SQL query directly against a datasource. "
                "Use this when no chart exists or you need custom aggregations not available via charts. "
                "Refer to the DATABASE SCHEMA in your context for exact table/column names. "
                "Only SELECT statements are allowed — no INSERT/UPDATE/DELETE/DROP. "
                "Always include ORDER BY + LIMIT for ranked queries."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "datasource_id": {
                        "type": "integer",
                        "description": "ID of the datasource to query (see DATABASE SCHEMA)"
                    },
                    "sql": {
                        "type": "string",
                        "description": (
                            "SELECT SQL query. Examples:\n"
                            "  SELECT Country, Points FROM fifa_world_rankings_jan_2026 ORDER BY Points DESC LIMIT 10\n"
                            "  SELECT Confederation, COUNT(*) as teams, ROUND(AVG(Points),2) as avg_pts "
                            "FROM fifa_world_rankings_jan_2026 GROUP BY Confederation ORDER BY avg_pts DESC\n"
                            "  SELECT Player, Country, Goals FROM fifa_world_cup_top_scorers ORDER BY Goals DESC LIMIT 5"
                        )
                    },
                    "limit": {
                        "type": "integer",
                        "default": 50,
                        "description": "Max rows to return (default 50, max 200)"
                    }
                },
                "required": ["datasource_id", "sql"]
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
            "name": "list_workspace_tables",
            "description": "List all workspace tables with their column names and types. Call this before query_table to know exact column names available.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "integer",
                        "description": "Optional: filter to a specific workspace ID"
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
                "Run an aggregated analytical query on a workspace table. "
                "Supports GROUP BY (dimensions), aggregations (measures: sum/avg/count/min/max/count_distinct), "
                "WHERE filters, ORDER BY, and LIMIT. "
                "Always prefer this over run_workspace_table to avoid loading raw data. "
                "Measure result columns are aliased as {field}_{function} (e.g. total_points_sum). "
                "Use order_by with the aliased measure name to rank results."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Workspace ID"},
                    "table_id": {"type": "integer", "description": "Table ID within the workspace"},
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
                "required": ["workspace_id", "table_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_workspace_table",
            "description": (
                "Fetch a sample of raw rows from a workspace table (no aggregation). "
                f"Use only for exploring data shape/samples. "
                "PREFER query_table for any analytical question. "
                f"Returns up to {settings.ai_workspace_table_limit} rows."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace_id": {
                        "type": "integer",
                        "description": "Workspace ID"
                    },
                    "table_id": {
                        "type": "integer",
                        "description": "Table ID within the workspace"
                    },
                    "limit": {
                        "type": "integer",
                        "default": 50,
                        "description": f"Number of rows to fetch (max {settings.ai_workspace_table_limit})"
                    }
                },
                "required": ["workspace_id", "table_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "query_dataset",
            "description": (
                "Execute a saved dataset and return its data rows. "
                "Datasets may be backed by DuckDB (Parquet) for fast analytics or by live source. "
                "Use list_workspace_tables to discover available datasets/tables first, "
                "then use this to fetch data from a specific dataset by ID."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {
                        "type": "integer",
                        "description": "ID of the dataset to execute"
                    },
                    "limit": {
                        "type": "integer",
                        "default": 50,
                        "description": "Max rows to return (default 50, max 200)"
                    }
                },
                "required": ["dataset_id"]
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

    # ── execute_sql ────────────────────────────────────────────────────────────
    if name == "execute_sql":
        import re
        sql = args.get("sql", "").strip()
        datasource_id = int(args["datasource_id"])
        limit = min(int(args.get("limit", 50)), 200)

        # Security: only allow SELECT statements
        sql_upper = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
        sql_upper = re.sub(r"--[^\n]*", "", sql_upper)
        first_word = sql_upper.strip().split()[0].upper() if sql_upper.strip() else ""
        if first_word not in ("SELECT", "WITH"):
            return {"error": "Only SELECT queries are allowed"}
        # Block forbidden keywords regardless of position
        forbidden = re.compile(
            r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE)\b",
            re.IGNORECASE,
        )
        if forbidden.search(sql_upper):
            return {"error": "Query contains forbidden operations"}

        result = await bi_client.execute_datasource_sql(
            datasource_id=datasource_id,
            sql=sql,
            limit=limit,
            token=token,
        )
        columns = result.get("columns", [])
        rows = result.get("data", [])
        return {
            "datasource_id": datasource_id,
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "execution_time_ms": result.get("execution_time_ms"),
        }

    # ── search_charts ──────────────────────────────────────────────────────────
    elif name == "search_charts":
        query = args.get("query", "")
        chart_type_filter = args.get("chart_type")
        limit = min(int(args.get("limit", 10)), 20)

        charts = await bi_client.list_charts(limit=200, token=token)

        # Fetch metadata for each chart in parallel (fire-and-forget pattern)
        import asyncio
        metadata_list = await asyncio.gather(
            *[bi_client.get_chart_metadata(c["id"], token=token) for c in charts],
            return_exceptions=True,
        )
        meta_map: Dict[int, Dict] = {}
        for c, m in zip(charts, metadata_list):
            if isinstance(m, dict):
                meta_map[c["id"]] = m

        scored = []
        for c in charts:
            if chart_type_filter and c.get("chart_type", "").upper() != chart_type_filter.upper():
                continue

            # Build searchable text: name + description + metadata fields
            search_text = " ".join(filter(None, [
                c.get("name", ""),
                c.get("description", ""),
            ]))
            meta = meta_map.get(c["id"], {})
            if meta:
                search_text += " " + " ".join(filter(None, [
                    meta.get("domain", ""),
                    meta.get("intent", ""),
                    " ".join(meta.get("metrics", [])),
                    " ".join(meta.get("dimensions", [])),
                    " ".join(meta.get("tags", [])),
                ]))

            score = _fuzzy_score(query, search_text)
            if score > 0:
                scored.append((score, c, meta))

        # Sort by score descending, take top N
        scored.sort(key=lambda x: x[0], reverse=True)
        results = []
        for _, c, meta in scored[:limit]:
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

    # ── list_workspace_tables ──────────────────────────────────────────────────
    elif name == "list_workspace_tables":
        workspace_id_filter = args.get("workspace_id")
        workspaces = await bi_client.list_workspaces(token=token)

        result = []
        for ws in workspaces:
            if workspace_id_filter and ws["id"] != workspace_id_filter:
                continue
            full_ws = await bi_client.get_workspace(ws["id"], token=token)
            tables = full_ws.get("tables", [])
            result.append({
                "workspace_id": ws["id"],
                "workspace_name": ws["name"],
                "tables": [
                    {
                        "table_id": t["id"],
                        "display_name": t.get("display_name", ""),
                        "source_kind": t.get("source_kind", ""),
                        # Show columns with name + type for the AI to reference
                        "columns": [
                            {"name": c.get("name", c) if isinstance(c, dict) else c,
                             "type": c.get("type", "unknown") if isinstance(c, dict) else "unknown"}
                            for c in (t.get("columns_cache") or t.get("columns") or [])
                        ],
                    }
                    for t in tables
                ],
            })

        return {"workspaces": result}

    # ── query_table ────────────────────────────────────────────────────────────
    elif name == "query_table":
        workspace_id = int(args["workspace_id"])
        table_id = int(args["table_id"])
        dimensions = args.get("dimensions") or []
        measures = args.get("measures") or []
        filters = args.get("filters") or []
        order_by = args.get("order_by") or []
        limit = min(int(args.get("limit", 20)), 200)

        result = await bi_client.execute_table_query(
            workspace_id=workspace_id,
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
            "workspace_id": workspace_id,
            "table_id": table_id,
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
        }

    # ── run_workspace_table ────────────────────────────────────────────────────
    elif name == "run_workspace_table":
        workspace_id = int(args["workspace_id"])
        table_id = int(args["table_id"])
        limit = min(int(args.get("limit", settings.ai_workspace_table_limit)), settings.ai_workspace_table_limit)

        result = await bi_client.preview_workspace_table(workspace_id, table_id, limit=limit, token=token)
        return {
            "workspace_id": workspace_id,
            "table_id": table_id,
            "columns": result.get("columns", []),
            "rows": result.get("rows", []),
            "row_count": result.get("row_count", 0),
        }

    # ── query_dataset ──────────────────────────────────────────────────────────
    elif name == "query_dataset":
        dataset_id = int(args["dataset_id"])
        limit = min(int(args.get("limit", 50)), 200)
        result = await bi_client.execute_dataset(dataset_id, limit=limit, token=token)
        columns = result.get("columns", [])
        data = result.get("data", [])
        return {
            "dataset_id": dataset_id,
            "columns": [c.get("name", c) if isinstance(c, dict) else c for c in columns],
            "rows": data,
            "row_count": len(data),
            "execution_time_ms": result.get("execution_time_ms"),
        }

    else:
        return {"error": f"Unknown tool: {name}"}
