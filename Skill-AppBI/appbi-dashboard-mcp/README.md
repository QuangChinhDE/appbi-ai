# AppBI Orchestrator MCP

A Model Context Protocol server that lets Claude drive AppBI end-to-end: connect a
data source, model a dataset, design semantic views and explores, build charts,
and publish dashboards. Successor to `appbi-import-source-mcp`.

> Heads-up: this MCP ships with a **profile system** that lets you trim the tool
> surface Claude sees per session, so it is faster and picks the right tool more
> reliably. See [Profiles](#profiles) below.

---

## Quick start

### Windows

```powershell
Set-Location D:\Appv2\appbi-ai\Skill-AppBI\appbi-dashboard-mcp
Copy-Item .env.example .env
# Edit .env: set APPBI_BASE_URL and APPBI_PAT
.\run-mcp.ps1                 # default = full tool surface (profile=all)
.\run-mcp-report.ps1          # only report-creation tools
.\run-mcp-dataset.ps1         # only dataset create/edit tools
.\run-mcp-explore.ps1         # only semantic/explore create/edit tools
```

### macOS / Linux

```bash
cd /path/to/appbi-ai/Skill-AppBI/appbi-dashboard-mcp
cp .env.example .env
chmod +x run-mcp*.sh
./run-mcp.sh                  # default = full tool surface
./run-mcp-report.sh
./run-mcp-dataset.sh
./run-mcp-explore.sh
```

The first run creates `.venv` and installs dependencies. Subsequent runs reuse it.

### Required PAT scopes

- `data_sources=edit`
- `datasets=edit`
- `dashboards=edit`

Generate at AppBI: **Settings → Personal Access Tokens**.

---

## Profiles

A naive MCP exposes every tool every session — that costs tokens (each tool
schema lands in the request) and confuses model tool-selection. This server
instead lets you pick a **profile** that registers only the tools relevant to
the workflow you're starting.

Set the profile via env var `APPBI_MCP_PROFILE`, or use the matching wrapper
script.

| Profile | When to use | Tool count |
|---|---|---|
| `all` | Default. Everything is registered. Use for debugging or one-off tasks that mix flows. | ~99 |
| `report` | Creating a **new** dashboard/report end-to-end (Source → Dataset → Semantic → Charts → Dashboard → public link). Skips delete/edit-of-existing tools. | 35 |
| `dataset` | Creating or editing a Dataset: import physical/SQL/calculated tables, enable date table, write descriptions, run auto-generate model. | 30 |
| `explore` | Creating or editing semantic models / views / explores (Stage 3 design work). | 33 |

Profiles can be combined with a comma, e.g. `APPBI_MCP_PROFILE=dataset,explore`.

### Wiring multiple profiles into Claude Desktop

Add one entry per profile so you can toggle them like normal MCPs:

```json
{
  "mcpServers": {
    "appbi-report": {
      "command": "powershell",
      "args": ["-File", "D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-dashboard-mcp\\run-mcp-report.ps1"]
    },
    "appbi-dataset": {
      "command": "powershell",
      "args": ["-File", "D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-dashboard-mcp\\run-mcp-dataset.ps1"]
    },
    "appbi-explore": {
      "command": "powershell",
      "args": ["-File", "D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-dashboard-mcp\\run-mcp-explore.ps1"]
    }
  }
}
```

mac/Linux: replace `command` with `/bin/bash` and the `.ps1` paths with the
matching `.sh`.

---

## Tool ↔ profile matrix

`✓` = registered for that profile.
`✓¹` = registered, with a note in the footer.
Tools tagged `all` only show up when the profile is `all`.

### Stage 1 — Source ([appbi_source.py](appbi_source.py))

| Tool | report | dataset | explore | all |
|---|:-:|:-:|:-:|:-:|
| list_data_sources | ✓ | ✓ |   | ✓ |
| get_data_source | ✓ | ✓ |   | ✓ |
| test_data_source_connection |   | ✓ |   | ✓ |
| inspect_source_schema | ✓ | ✓ |   | ✓ |
| inspect_source_table | ✓ | ✓ |   | ✓ |
| get_watermark_candidates |   | ✓ |   | ✓ |
| run_source_query |   | ✓ |   | ✓ |
| validate_source_sql |   | ✓ |   | ✓ |

### Stage 2 — Dataset ([appbi_dataset.py](appbi_dataset.py))

| Tool | report | dataset | explore | all |
|---|:-:|:-:|:-:|:-:|
| list_datasets | ✓ | ✓ | ✓ | ✓ |
| get_dataset | ✓ | ✓ | ✓ | ✓ |
| list_dataset_tables | ✓ | ✓ | ✓ | ✓ |
| get_table_profile | ✓ | ✓ | ✓ | ✓ |
| get_table_description |   | ✓ | ✓ | ✓ |
| get_column_summary | ✓ | ✓ | ✓ | ✓ |
| get_dataset_dictionary |   | ✓ | ✓ | ✓ |
| search_dataset_tables |   | ✓ | ✓ | ✓ |
| list_source_tables_for_dataset |   | ✓ |   | ✓ |
| create_dataset | ✓ | ✓ |   | ✓ |
| update_dataset |   | ✓¹ |   | ✓ |
| delete_dataset |   | ✓ |   | ✓ |
| add_table_to_dataset | ✓² | ✓² |   | ✓ |
| update_dataset_table |   | ✓ |   | ✓ |
| remove_table_from_dataset |   | ✓ |   | ✓ |
| update_table_description | ✓ | ✓ |   | ✓ |
| update_dataset_dictionary |   | ✓ |   | ✓ |

¹ `update_dataset` is also the way to enable a **date table** (set
`settings.calendar_dimension.enabled=true`). The backend then materialises a
`generated_calendar` table automatically.
² `add_table_to_dataset` covers physical / SQL / calculated tables via
`source_kind ∈ {physical_table, sql_query, derived_table}`. Date table is *not*
created here — use `update_dataset` as above.

### Stage 3 — Semantic / Explore ([appbi_semantic.py](appbi_semantic.py))

| Tool | report | dataset | explore | all |
|---|:-:|:-:|:-:|:-:|
| list_semantic_views |   |   | ✓ | ✓ |
| get_semantic_view |   |   | ✓ | ✓ |
| list_semantic_models |   |   | ✓ | ✓ |
| get_semantic_model |   |   | ✓ | ✓ |
| list_semantic_explores | ✓ | ✓ | ✓ | ✓ |
| get_semantic_explore | ✓ | ✓ | ✓ | ✓ |
| get_semantic_explore_by_name | ✓ |   | ✓ | ✓ |
| get_dataset_model | ✓ | ✓ | ✓ | ✓ |
| get_distinct_field_values | ✓ |   | ✓ | ✓ |
| create_semantic_view |   |   | ✓ | ✓ |
| update_semantic_view |   |   | ✓ | ✓ |
| delete_semantic_view |   |   | ✓ | ✓ |
| create_semantic_model |   |   | ✓ | ✓ |
| update_semantic_model |   |   | ✓ | ✓ |
| delete_semantic_model |   |   | ✓ | ✓ |
| create_semantic_explore |   |   | ✓ | ✓ |
| update_semantic_explore |   |   | ✓ | ✓ |
| delete_semantic_explore |   |   | ✓ | ✓ |
| add_dataset_model_join |   |   | ✓ | ✓ |
| remove_dataset_model_join |   |   | ✓ | ✓ |
| generate_dataset_model |   | ✓³ | ✓ | ✓ |
| execute_semantic_query | ✓ |   | ✓ | ✓ |

³ `generate_dataset_model` is the "auto-generate model" button on a dataset
detail page. It scans `columns_cache` and writes a starter view / explore /
join set without any LLM call. It is exposed in both `dataset` and `explore`
profiles because the trigger lives on a dataset but the artifacts are semantic
objects.

### Blueprint (Stages 3+4) ([appbi_blueprint.py](appbi_blueprint.py))

| Tool | report | dataset | explore | all |
|---|:-:|:-:|:-:|:-:|
| propose_semantic_model | ✓ |   | ✓ | ✓ |
| commit_semantic_model | ✓ |   | ✓ | ✓ |
| propose_dashboard_blueprint | ✓ |   |   | ✓ |
| commit_dashboard_blueprint | ✓ |   |   | ✓ |
| audit_chart_semantic_health |   |   |   | ✓ |
| repair_chart_semantic_binding |   |   |   | ✓ |

### Stage 4 — Charts ([appbi_chart.py](appbi_chart.py))

| Tool | report | dataset | explore | all |
|---|:-:|:-:|:-:|:-:|
| list_charts | ✓ |   |   | ✓ |
| get_chart | ✓ |   |   | ✓ |
| get_chart_data |   |   |   | ✓ |
| preview_chart_data | ✓ |   |   | ✓ |
| get_chart_description |   |   |   | ✓ |
| list_chart_parameters |   |   |   | ✓ |
| search_charts |   |   |   | ✓ |
| create_chart | ✓ |   |   | ✓ |
| update_chart |   |   |   | ✓ |
| delete_chart |   |   |   | ✓ |
| update_chart_description | ✓ |   |   | ✓ |
| upsert_chart_metadata |   |   |   | ✓ |
| replace_chart_parameters |   |   |   | ✓ |

### Stage 5 — Dashboard ([appbi_dashboard.py](appbi_dashboard.py))

| Tool | report | dataset | explore | all |
|---|:-:|:-:|:-:|:-:|
| list_dashboards | ✓ |   |   | ✓ |
| list_accessible_dashboards_summary |   |   |   | ✓ |
| get_dashboard | ✓ |   |   | ✓ |
| get_dashboard_filter_fields | ✓ |   |   | ✓ |
| list_public_links |   |   |   | ✓ |
| create_dashboard | ✓ |   |   | ✓ |
| update_dashboard |   |   |   | ✓ |
| delete_dashboard |   |   |   | ✓ |
| add_chart_to_dashboard | ✓ |   |   | ✓ |
| add_widget_to_dashboard |   |   |   | ✓ |
| update_widget_config |   |   |   | ✓ |
| remove_chart_from_dashboard |   |   |   | ✓ |
| update_dashboard_layout | ✓ |   |   | ✓ |
| add_dashboard_filter | ✓ |   |   | ✓ |
| remove_dashboard_filter |   |   |   | ✓ |
| share_dashboard |   |   |   | ✓ |
| unshare_dashboard |   |   |   | ✓ |
| create_public_link | ✓ |   |   | ✓ |
| update_public_link |   |   |   | ✓ |
| delete_public_link |   |   |   | ✓ |

Phase-15.14 additions:
- `list_accessible_dashboards_summary` — slim list (id+name+description+permission), use when picking a dashboard for a workboard screen.
- `update_widget_config` — edit a placed widget's config in place; previously required delete + re-add.
- `share_dashboard` / `unshare_dashboard` — legacy single share-token mechanism. Prefer `create_public_link` for multi-link sharing.
- `create_dashboard` now accepts `public_filters_config` + `pages_config` upfront (previously had to follow up with `update_dashboard`).

### Cross-cutting

| Module | Tools | Profiles |
|---|---|---|
| [appbi_core.py](appbi_core.py) | `health_check` | all profiles |
| [appbi_html_import.py](appbi_html_import.py) | `get_html_dashboard_spec`, `analyze_html_import`, `validate_html_import_plans`, `dry_run_build_html_dashboard_import`, `build_dashboard_from_html` | `all` only |
| [appbi_quality.py](appbi_quality.py) | 10 quality-rule tools | `all` only |
| [appbi_sharing.py](appbi_sharing.py) | 4 cross-resource share tools | `all` only |

If you need any of these during a focused profile session, either start a
secondary `all` session or extend the tag set in the source file (see
[Extending profiles](#extending-profiles)).

---

## Dataset table kinds (important context for Claude)

AppBI's `DatasetTable.source_kind` has **four** values. They map to UI options
on the dataset detail page:

| `source_kind` | UI label | How to create via MCP |
|---|---|---|
| `physical_table` | Import from datasource | `add_table_to_dataset(source_kind="physical_table", datasource_id=…, source_table_name="schema.table")` |
| `sql_query` | SQL query table | `add_table_to_dataset(source_kind="sql_query", datasource_id=…, source_query="SELECT …")` |
| `derived_table` | Calculated table | `add_table_to_dataset(source_kind="derived_table", source_query="SELECT … FROM other_imported_table …")` — **no** `datasource_id` |
| `generated_calendar` | Date table | `update_dataset(settings={"calendar_dimension": {"enabled": true, …}})` — backend materialises the table |

There is **no** separate "measure table" kind. In AppBI, measures live on a
`SemanticView` (Stage 3, the `explore` profile), not on a dedicated table.
This differs from Power BI.

### Why this matters for charts

Charts target a `dataset_table_id`, not a table kind. The backend transparently
builds the right SQL for `derived_table` / `generated_calendar` / `sql_query`,
so chart creation does **not** need to know what kind of table it points at.
Side-effect: a chart bound to a calculated/date table works through the
identical `create_chart` call as any other.

---

## The 5-stage flow

```
Source  →  Dataset  →  Semantic Model  →  Charts  →  Dashboard
```

The recommended path for a full dashboard:

1. `propose_semantic_model(dataset_id, business_intent)`
2. `commit_semantic_model(plan_json, user_confirmed=true)`
3. `propose_dashboard_blueprint(dataset_id, business_intent)`
4. `commit_dashboard_blueprint(blueprint_json, user_confirmed=true)`

For one-off ad-hoc charts:

1. `preview_chart_data(...)`
2. `create_chart(..., user_confirmed=true)`

**Saved-chart limitation:** persist only measures/dimensions from the chart's
bound/base view. Joined-view fields like `orders.customer_name` are not safe to
save even if the semantic explore can conceptually reach them, because the
stored chart config is executed against bare column names at render time.

---

## Preview-then-confirm

Every mutating tool takes `user_confirmed: bool = False`. The first call returns:

```json
{
  "status": "requires_confirmation",
  "action": "create_chart",
  "plan": { "...": "..." }
}
```

Claude is instructed to present `plan` to the human, wait for explicit consent,
then call the same tool again with `user_confirmed=true`. Read-only tools
(`list_*`, `get_*`, `preview_*`, `execute_semantic_query`) do not require
confirmation.

---

## What's different from the legacy MCP

| | Legacy `appbi-import-source-mcp` | This MCP |
|---|---|---|
| Description authoring | Backend OpenRouter LLM | Claude writes it |
| Chart suggestions | `ai_chart_preview` (backend LLM) | Claude designs config |
| Quality rule suggestions | `ai_suggest_quality_rule` (backend LLM) | Claude proposes rules |
| Mutation safety | Mixed | Every write needs `user_confirmed` |
| HTML import flow | Yes | Yes (`appbi_html_import`, `all` profile only) |
| Tool surface | ~159 tools, all-or-nothing | ~99 tools, profile-trimmable to ~30 |

The legacy MCP keeps running side-by-side; nothing here breaks the existing
HTML import skill.

---

## Extending profiles

The tagging lives entirely in source decorators. To move a tool into another
profile, find its `@tool(...)` line and edit the set.

Example — give the `dataset` profile access to `delete_chart`:

```python
# in appbi_chart.py
-@tool("all")
+@tool({"all", "dataset"})
 async def delete_chart(...):
```

A tool tagged `all` only ships when the profile is `all` (default). Tagging it
with any specific profile *also* makes it appear in `all` (the `all` profile
behaves as a superset).

The mechanism is implemented in [appbi_core.py](appbi_core.py) — see the
`tool(profiles=...)` decorator. It reads `APPBI_MCP_PROFILE` once at import
time and skips registration for tools whose tag set does not intersect the
active profiles. Unregistered tools remain importable Python functions but
FastMCP never sees them, so they do not consume tool-schema tokens.

---

## Backend changes this MCP relies on

- `POST /api/v1/datasets/{dataset_id}/tables/{table_id}/profile` — bundles
  schema + sample rows + per-column stats in one call. See
  [`backend/app/api/datasets.py`](../../backend/app/api/datasets.py).
- Generic semantic create routes that persist `dataset_id` on models and
  `dataset_table_id` on views, and can derive `sql_table_name` from a dataset
  table when the caller omits it.

Without those semantic-route fixes, Stage 3 can write incomplete objects and
later cause chart/runtime failures.

---

## Files in this folder

| File | Role |
|---|---|
| `appbi_orchestrator_mcp.py` | Entry point — imports every stage module so its tools register. |
| `appbi_core.py` | FastMCP instance, `_request`, `_requires_confirmation`, profile decorator. |
| `appbi_source.py` | Stage 1 — read-only source inspection. |
| `appbi_dataset.py` | Stage 2 — dataset + table CRUD, descriptions. |
| `appbi_semantic.py` | Stage 3 — semantic view / model / explore CRUD, joins, queries. |
| `appbi_blueprint.py` | Stage 3+4 design-and-commit flow. |
| `appbi_chart.py` | Stage 4 — chart CRUD. |
| `appbi_dashboard.py` | Stage 5 — dashboard assembly, filters, public links. |
| `appbi_html_import.py` | Stage 5 supplement — bulk dashboard creation from an HTML mockup. |
| `appbi_quality.py` | Optional — data-quality rule CRUD. |
| `appbi_sharing.py` | Cross-resource sharing. |
| `run-mcp.ps1` / `run-mcp.sh` | Generic launcher; accepts profile via parameter or `APPBI_MCP_PROFILE`. |
| `run-mcp-{report,dataset,explore}.{ps1,sh}` | Thin wrappers that lock the profile. |
