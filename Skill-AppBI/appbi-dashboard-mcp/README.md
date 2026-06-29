# AppBI Orchestrator MCP

A Model Context Protocol server with **two jobs**:

1. **Discovery** — tell Claude what data exists (connected sources, their
   tables & columns, sample rows, a dataset's semantic model) so Claude can
   design a report itself.
2. **Materialization** — when the user has approved Claude's design, write the
   final report (dataset → model → measures → charts → filters → dashboard)
   to AppBI instead of building it by hand in the UI.

> **Design lives in Claude, not in the MCP.** Claude explores the data, draws
> its own report mock-up (an HTML artifact it renders), tunes measures, and
> confirms with the user. The MCP is only called to discover data and to
> create the final, approved report — typically one `create_report(spec)`
> call. This keeps token cost low and avoids paying for ~70 "design helper"
> tool schemas every turn.

Successor to `appbi-import-source-mcp`.

---

## Quick start

### Windows

```powershell
Set-Location D:\Appv2\appbi-ai\Skill-AppBI\appbi-dashboard-mcp
Copy-Item .env.example .env
# Edit .env: set APPBI_BASE_URL and APPBI_PAT
.\run-mcp.ps1                 # default = lean `core` surface (discovery + materialize)
```

### macOS / Linux

```bash
cd /path/to/appbi-ai/Skill-AppBI/appbi-dashboard-mcp
cp .env.example .env
chmod +x run-mcp*.sh
./run-mcp.sh                  # default = lean `core` surface
```

The first run creates `.venv` and installs dependencies. Subsequent runs reuse it.

### Required PAT scopes

- `data_sources=edit`
- `datasets=edit`
- `dashboards=edit`

Generate at AppBI: **Settings → Personal Access Tokens**.

---

## The flow

1. **Discover** (read-only): `list_data_sources` → `inspect_source_schema` →
   `inspect_source_table` (Sheets: `list_gsheet_tabs` / `read_gsheet_rows`).
   For an existing dataset: `get_dataset` + `get_dataset_model`
   (`generate_dataset_model` if it has no model). Pull real numbers with
   `run_source_query` / `execute_semantic_query` / `preview_chart_data` /
   `get_distinct_field_values` so Claude's mock-up is accurate.
2. **Design** (Claude, outside the MCP): draw the report mock-up artifact,
   iterate with the user until approved.
3. **Materialize**: `create_report(spec, user_confirmed=true)` — one call
   builds dataset?/model?/measures/charts/filters/dashboard. For small edits
   use the granular `create_*` / `update_*` tools. Filters land as DRAFT —
   `publish_dashboard_draft` only when the user asks.

---

## Profiles

Each registered tool's schema costs tokens every turn. The **default `core`**
profile registers only Discovery + Materialization, so non-technical Claude
Desktop sessions stay cheap. Optional helpers are opt-in via the
`APPBI_MCP_PROFILE` env var (comma-combinable, e.g. `core,design`).

| Profile | What it adds | ~Tools |
|---|---|---|
| `core` | **Default.** Discovery (sources/tables/data/model reads) + Materialization (`create_report` + granular `create_*`/`update_*`/`delete_*`). | ~91 |
| `design` | Legacy design helpers: 32 chart wrappers, 8 measure wrappers, 6 dashboard presets, `propose_*`/`commit_*`/`build_dashboard_from_design` blueprint flow, `get_design_recommendations`. Claude normally designs these itself. | +59 |
| `admin` | Data-quality rules + cross-resource sharing. | +13 |
| `all` | Everything (debugging). | ~163 |

The legacy `report` / `dataset` / `explore` profiles still work (intersection
matching) for anyone who wired them previously.

---

## Tool ↔ profile matrix (legacy reference)

> This matrix documents the older `report`/`dataset`/`explore` tagging and is
> kept for reference. Under the current model, the **default `core`** profile
> registers every tool below EXCEPT those tagged `design` (chart/measure/
> dashboard wrappers, `propose_*`/`commit_*`/`build_dashboard_from_design`,
> `get_design_recommendations`) or `admin` (quality, sharing). The new
> `create_report` tool (in `core`) is the recommended one-call materialiser.

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
| list_gsheet_tabs | ✓ | ✓ |   | ✓ |
| read_gsheet_rows | ✓ | ✓ |   | ✓ |

Google Sheets datasources use `list_gsheet_tabs` / `read_gsheet_rows`
instead of `inspect_source_schema` / `inspect_source_table` — call
`get_data_source(id).type` to branch.

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
| add_dataset_model_join | ✓ |   | ✓ | ✓ |
| remove_dataset_model_join | ✓ |   | ✓ | ✓ |
| suggest_dataset_model_join | ✓ |   | ✓ | ✓ |
| generate_dataset_model |   | ✓³ | ✓ | ✓ |
| execute_semantic_query | ✓ |   | ✓ | ✓ |

³ `generate_dataset_model` is the "auto-generate model" button on a dataset
detail page. It scans `columns_cache` and writes a starter view / explore /
join set without any LLM call. It is exposed in both `dataset` and `explore`
profiles because the trigger lives on a dataset but the artifacts are semantic
objects.

### Blueprint (Stages 3+4) ([appbi_blueprint.py](appbi_blueprint.py))

The **2-confirm workspace flow** is the canonical path for a brand-new
dashboard. The legacy `propose_*_blueprint` / `commit_*_blueprint` tools
remain for incremental work on existing artifacts.

| Tool | report | dataset | explore | all |
|---|:-:|:-:|:-:|:-:|
| propose_dataset_workspace | ✓ |   |   | ✓ |
| commit_dataset_workspace (**Confirm 1**) | ✓ |   |   | ✓ |
| build_dashboard_from_design (**Confirm 2**) | ✓ |   |   | ✓ |
| commit_full_dashboard |   |   |   | ✓ |
| propose_semantic_model | ✓ |   | ✓ | ✓ |
| commit_semantic_model |   |   | ✓ | ✓ |
| propose_dashboard_blueprint | ✓ |   |   | ✓ |
| commit_dashboard_blueprint |   |   |   | ✓ |
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
| get_chart_type_schema | ✓ |   | ✓ | ✓ |
| create_chart |   |   |   | ✓ |
| update_chart |   |   |   | ✓ |
| delete_chart |   |   |   | ✓ |
| update_chart_description | ✓ |   |   | ✓ |
| upsert_chart_metadata |   |   |   | ✓ |
| replace_chart_parameters |   |   |   | ✓ |

#### Chart pattern library ([appbi_chart_library.py](appbi_chart_library.py))

32 thin wrappers, one per chart type — Claude picks by user intent. All
tagged `report`. Every wrapper now routes through `/charts/dry-run-create`
so validation + runtime-preview + fe_unrecognised_keys warnings fire
before commit (same gate as `create_chart`).

Categories: KPI/GAUGE/BULLET/PODIUM · BAR family · LINE/AREA/TIME_SERIES/
RIBBON/TIMELINE · PIE/DONUT/POLAR_AREA/TREEMAP/FUNNEL/WORD_CLOUD ·
HEATMAP/SANKEY/SUNBURST · SCATTER/BUBBLE/RADAR/BOXPLOT ·
MAP_POINT/MAP_REGION · TABLE/MATRIX.

#### Measure pattern library ([appbi_measure_library.py](appbi_measure_library.py))

7 thin wrappers appending one measure to an existing SemanticView (read-
modify-write). All tagged `report`:

`add_sum_measure`, `add_avg_measure`, `add_count_measure`,
`add_count_distinct_measure`, `add_min_max_measure`,
`add_ratio_measure`, `add_percent_of_total_measure`.

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
| update_dashboard_draft_filters |   |   |   | ✓ |
| list_dashboard_filters | ✓ |   |   | ✓ |
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

Phase-15.81 v9–v13 (filter pipeline):
- **Filter slot edits stage into draft_snapshot** (sibling of layout drafts). `add_dashboard_filter`, `remove_dashboard_filter`, `add_date_filter_recipe`, `add_dropdown_filter_recipe` all PUT `/dashboards/{id}/draft-filters` now. Public link viewer keeps seeing the last-published config until you call `publish_dashboard_draft`.
- **Two filter scopes** on the dashboard itself: `filters_config` (all-pages) and `pages_config[i].filters` (per-page). `scope='all'|'page'` + `page_id` on the granular helpers routes the slot.
- **Per-link hidden constraints** (Loại 2 — silent WHERE) stay on `DashboardPublicLink.filters_config` via `create_public_link`. Viewer never sees these in UI but BE AND-merges them into every chart-data request.
- `update_dashboard_draft_filters` — set BOTH scopes in one call (e.g. push a fully composed `pages_config` array).
- `list_dashboard_filters` — read the current slot list (draft overlay applied) with a `has_draft` flag so you know whether the slots are pending publish.
- `publish_dashboard_draft` now flushes layout + filter drafts together; `discard_dashboard_draft` clears both.
- BaseFilter wire shape: `{id, field, semanticField?, datasetId?, fieldKey?, type, operator, value, label, linkedFields?, datePreset?}` — see [`appbi_dashboard.py`](appbi_dashboard.py) module docstring.

### Cross-cutting

| Module | Tools | Profiles |
|---|---|---|
| [appbi_core.py](appbi_core.py) | `health_check`, `get_design_recommendations`, `get_mcp_logs_dir` | report / dataset / explore |
| [appbi_quality.py](appbi_quality.py) | 9 quality-rule tools | `all` only |
| [appbi_sharing.py](appbi_sharing.py) | 4 cross-resource share tools | `all` only |

`get_design_recommendations()` returns the Markdown cheatsheet mapping
user intent (VN/EN phrasings) → exact library tool name. Call it at the
start of a design session or whenever unsure which `add_*` tool fits.

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

**Recommended (2-confirm) path for a fresh dashboard:**

1. `propose_dataset_workspace(business_intent, ...)` — read-only plan template.
2. `commit_dataset_workspace(plan, user_confirmed=true)` — **Confirm 1**:
   writes dataset + tables + semantic + relationships, logs planned charts.
3. `build_dashboard_from_design()` — renders HTML preview.
4. `build_dashboard_from_design(user_confirmed=true)` — **Confirm 2**: creates
   charts + dashboard from the logged design.

**Incremental edits on existing artifacts:**

- One chart: pick the right `add_*_chart` from the library (e.g.
  `add_bar_chart`) or `create_chart` for raw `config` control.
- New measure on an existing view: `add_sum_measure` /
  `add_ratio_measure` / etc.
- Add semantic view: `propose_semantic_model` → `commit_semantic_model`.
- Add dashboard filter / public link: granular Stage-5 tools.

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
| HTML import flow | Yes | Removed — superseded by the blueprint flow (`propose_dashboard_blueprint` → `commit_dashboard_blueprint`) |
| Tool surface | ~159 tools, all-or-nothing | ~94 tools, profile-trimmable to ~30 |

The blueprint flow covers the same "design → materialise" pattern with strict
JSON validation, so HTML-mockup ingestion is no longer needed here.

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
| `appbi_core.py` | FastMCP instance, `_request`, `_requires_confirmation`, profile decorator, master instructions, design cheatsheet, session-log helpers. |
| `appbi_source.py` | Stage 1 — read-only source inspection (SQL + Google Sheets). |
| `appbi_dataset.py` | Stage 2 — dataset + table CRUD, descriptions, dictionary. |
| `appbi_semantic.py` | Stage 3 — semantic view / model / explore CRUD, joins, queries. |
| `appbi_measure_library.py` | Stage 3 — 7 pattern tools that append one measure to an existing view. |
| `appbi_blueprint.py` | Stage 3+4 — 2-confirm workspace flow + legacy blueprint flow + audit/repair. |
| `appbi_chart.py` | Stage 4 — chart CRUD (uses BE `/charts/dry-run-create` as single gatekeeper). |
| `appbi_chart_library.py` | Stage 4 — 32 pattern tools, one per chart type (also dry-run-gated). |
| `appbi_dashboard.py` | Stage 5 — dashboard assembly, filters, public links. |
| `appbi_quality.py` | Optional — data-quality rule CRUD. |
| `appbi_sharing.py` | Cross-resource sharing. |
| `run-mcp.ps1` / `run-mcp.sh` | Generic launcher; accepts profile via parameter or `APPBI_MCP_PROFILE`. |
| `run-mcp-{report,dataset,explore}.{ps1,sh}` | Thin wrappers that lock the profile. |
