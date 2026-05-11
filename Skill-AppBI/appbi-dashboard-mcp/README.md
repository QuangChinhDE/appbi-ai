# AppBI Orchestrator MCP

A Model Context Protocol server that lets Claude take a user from a raw
data source to a finished AppBI dashboard end-to-end. Successor to
`appbi-import-source-mcp`.

## What's different from the legacy MCP

| | Legacy `appbi-import-source-mcp` | This MCP |
|---|---|---|
| Description authoring | Backend OpenRouter LLM | **Claude writes it** |
| Chart suggestions | `ai_chart_preview` (backend LLM) | **Claude designs config** |
| Quality rule suggestions | `ai_suggest_quality_rule` (backend LLM) | **Claude proposes rules** |
| Mutation safety | Mixed — some tools wrote immediately | **Every write needs `user_confirmed`** |
| HTML import flow | Yes | Yes (`appbi_html_import` for mockup-driven bulk builds) |
| Tool surface | ~159 tools | ~85 tools, focused on the 5-stage flow |

The legacy MCP keeps running side-by-side; nothing here breaks the existing
HTML import skill.

## The 5-stage flow

```
Source  →  Dataset  →  Semantic Model  →  Charts  →  Dashboard
```

Each stage has its own module file. Tools are deliberately small and
read/write-segregated so Claude can compose them under user oversight.

See [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) for the design rationale and
[`TOOL_SURFACE.md`](TOOL_SURFACE.md) for the full tool inventory.

## Chart contract

The chart tools use the current AppBI Explore contract, not the legacy
`{dimensions, measures}` examples.

For full dashboards, the safe path is:

1. `propose_semantic_model`
2. `commit_semantic_model`
3. `propose_dashboard_blueprint`
4. `commit_dashboard_blueprint`

For one-off charts, use:

1. `preview_chart_data`
2. `create_chart` after user confirmation

Important limitation: saved charts must use measures and dimensions from
their bound/base view only. Joined-view fields such as `orders.customer_name`
are not safe to persist yet, even if the semantic explore can conceptually
reach them.

Supported chart types include: `TABLE`, `MATRIX`, `KPI`, `GAUGE`, `BULLET`,
`PODIUM`, `BAR`, `HORIZONTAL_BAR`, `GROUPED_BAR`, `STACKED_BAR`, `BAR_LINE`,
`WATERFALL`, `LINE`, `AREA`, `TIME_SERIES`, `RIBBON`, `TIMELINE`, `PIE`,
`DONUT`, `POLAR_AREA`, `TREEMAP`, `FUNNEL`, `WORD_CLOUD`, `SCATTER`,
`BUBBLE`, `HEATMAP`, `BOXPLOT`, `RADAR`, `SANKEY`, `SUNBURST`,
`MAP_POINT`, and `MAP_REGION`.

## Setup

### Windows

```powershell
Set-Location D:\Appv2\appbi-ai\Skill-AppBI\appbi-orchestrator-mcp
Copy-Item .env.example .env
# Edit .env: set APPBI_BASE_URL and APPBI_PAT
.\run-mcp.ps1
```

### macOS / Linux

```bash
cd /path/to/appbi-ai/Skill-AppBI/appbi-orchestrator-mcp
cp .env.example .env
# Edit .env: set APPBI_BASE_URL and APPBI_PAT
chmod +x run-mcp.sh
./run-mcp.sh
```

The first run creates `.venv` and installs dependencies. Subsequent runs
reuse it.

## Required PAT scopes

- `data_sources=edit`
- `datasets=edit`
- `dashboards=edit`

Generate at AppBI: **Settings → Personal Access Tokens**.

## Wiring up Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "appbi-orchestrator": {
      "command": "powershell",
      "args": [
        "-File",
        "D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-orchestrator-mcp\\run-mcp.ps1"
      ]
    }
  }
}
```

(Mac/Linux: replace `command` with `/bin/bash` and `args` with the path to
`run-mcp.sh`.)

## Preview-then-confirm

Every tool that mutates AppBI takes `user_confirmed: bool = False`. The
first call returns:

```json
{
  "status": "requires_confirmation",
  "action": "create_chart",
  "plan": { ... }
}
```

Claude is instructed to present `plan` to the human, wait for explicit
consent, and only then call again with `user_confirmed=true`. Read-only
tools (`list_*`, `get_*`, `preview_*`, `execute_semantic_query`) do not
require confirmation.

## Backend changes

This MCP relies on two backend pieces:

- `POST /api/v1/datasets/{dataset_id}/tables/{table_id}/profile` — bundles
  schema + sample rows + per-column stats in one call. See
  [`backend/app/api/datasets.py`](../../backend/app/api/datasets.py) at
  the `get_table_profile` route.

- Generic semantic create routes that persist `dataset_id` on models and
  `dataset_table_id` on views, and can derive `sql_table_name` from a
  dataset table when the caller does not provide it.

Without those semantic-route fixes, the canonical Stage 3 flow can create
incomplete semantic objects and later cause chart/runtime failures.
