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
                "Search for charts in the BI system. Uses chart name, description, AND semantic metadata "
                "(domain, intent, metrics, dimensions, tags) for matching. "
                "Call this first to discover relevant charts before running them."
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
                "Execute a chart and return the actual data rows for analysis. "
                "Also returns the explore_config (roleConfig) so the frontend can render the chart. "
                "Use after search_charts to get real data."
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
            "name": "list_workspace_tables",
            "description": "List all workspace tables available in the BI system. Shows workspace names, table names, and column schemas.",
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
            "name": "run_workspace_table",
            "description": (
                "Fetch raw data from a workspace table. "
                f"Returns up to {settings.ai_workspace_table_limit} rows for analysis. "
                "Use when there is no saved chart for the data you need."
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
]


# ─────────────────────────────────────────────────────────────────────────────
# Tool executor
# ─────────────────────────────────────────────────────────────────────────────

def _fuzzy_score(query: str, text: str) -> int:
    """Simple word-overlap scoring (no external dep needed)."""
    q_words = set(query.lower().split())
    t_words = set(text.lower().split())
    return len(q_words & t_words)


async def execute_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatch tool call and return structured result dict."""

    # ── search_charts ──────────────────────────────────────────────────────────
    if name == "search_charts":
        query = args.get("query", "")
        chart_type_filter = args.get("chart_type")
        limit = min(int(args.get("limit", 10)), 20)

        charts = await bi_client.list_charts(limit=200)

        # Fetch metadata for each chart in parallel (fire-and-forget pattern)
        import asyncio
        metadata_list = await asyncio.gather(
            *[bi_client.get_chart_metadata(c["id"]) for c in charts],
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
                "description": c.get("description", ""),
                "chart_type": c.get("chart_type", ""),
                "workspace_table_id": c.get("workspace_table_id"),
                "dataset_id": c.get("dataset_id"),
                "metadata": meta or {},
            })

        return {
            "count": len(results),
            "charts": results,
        }

    # ── run_chart ──────────────────────────────────────────────────────────────
    elif name == "run_chart":
        chart_id = int(args["chart_id"])
        result = await bi_client.get_chart_data(chart_id)

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
        dashboards = await bi_client.list_dashboards()

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
        workspaces = await bi_client.list_workspaces()

        result = []
        for ws in workspaces:
            if workspace_id_filter and ws["id"] != workspace_id_filter:
                continue
            # Fetch full workspace (includes tables + columns)
            full_ws = await bi_client.get_workspace(ws["id"])
            tables = full_ws.get("tables", [])
            result.append({
                "workspace_id": ws["id"],
                "workspace_name": ws["name"],
                "tables": [
                    {
                        "table_id": t["id"],
                        "display_name": t.get("display_name", ""),
                        "source_kind": t.get("source_kind", ""),
                        "columns": t.get("columns", []),
                    }
                    for t in tables
                ],
            })

        return {"workspaces": result}

    # ── run_workspace_table ────────────────────────────────────────────────────
    elif name == "run_workspace_table":
        workspace_id = int(args["workspace_id"])
        table_id = int(args["table_id"])
        limit = min(int(args.get("limit", settings.ai_workspace_table_limit)), settings.ai_workspace_table_limit)

        result = await bi_client.preview_workspace_table(workspace_id, table_id, limit=limit)
        return {
            "workspace_id": workspace_id,
            "table_id": table_id,
            "columns": result.get("columns", []),
            "rows": result.get("rows", []),
            "row_count": result.get("row_count", 0),
        }

    else:
        return {"error": f"Unknown tool: {name}"}
