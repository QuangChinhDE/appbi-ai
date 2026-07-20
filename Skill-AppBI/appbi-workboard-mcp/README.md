# AppBI Workboard MCP

Build a working AppBI **Workboard mini-app end to end** — from raw data all the
way to a shareable app — through one self-contained MCP server:

```
Source  ->  Dataset  ->  Data Model  ->  Workboard  ->  Share
```

Connect or pick a data source, create a dataset and its tables, lay down a
relationship model, then author the mini-app (forms — incl. photo/OCR capture
and a satellite **map picker**; editable tables that can render as a photo
**gallery**; printable docs; embedded dashboards) with app users, doc webhooks,
public links and a delivery workspace. Every mutating tool previews a plan and
changes nothing until you confirm.

> Charts, full BI semantic measures/explores, and DB-credential source
> connections stay in the AppBI UI / dashboard MCP. This server owns the
> Workboard journey.

## Setup

```powershell
Set-Location D:\Appv2\appbi-ai\Skill-AppBI\appbi-workboard-mcp
.\setup-mcp.ps1          # creates .venv, installs deps, seeds .env
# edit .env -> APPBI_BASE_URL + APPBI_PAT
.\run-mcp.ps1            # launches the server (profile=all)
```

macOS / Linux:

```bash
cd /path/to/appbi-workboard-mcp
cp .env.example .env     # then edit APPBI_BASE_URL + APPBI_PAT
./run-mcp.sh             # bootstraps .venv on first run
```

The PAT (Personal Access Token, minted in AppBI) needs:

- `datasources=edit` — discover and create Google Sheets / file sources.
- `datasets=edit` — create datasets, tables, the relationship model.
- `workboards=edit` — build workboards + app users + public links.
- `workboards=full` — create/manage delivery workspaces.

## Register in an MCP client

Add to your client's MCP config (Claude Desktop `claude_desktop_config.json`,
or `.mcp.json` for Claude Code). Adjust paths for your OS:

```json
{
  "mcpServers": {
    "appbi-workboard": {
      "command": "D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-workboard-mcp\\.venv\\Scripts\\python.exe",
      "args": ["D:\\Appv2\\appbi-ai\\Skill-AppBI\\appbi-workboard-mcp\\appbi_workboard_mcp.py"],
      "env": {
        "APPBI_BASE_URL": "http://localhost:8000",
        "APPBI_PAT": "<your-token>",
        "APPBI_MCP_PROFILE": "all"
      }
    }
  }
}
```

Run `setup-mcp.ps1` once first so `.venv` exists.

## The journey (canonical workflow)

| Stage | Do this |
|---|---|
| **0 Source** | `list_data_sources`; inspect with `inspect_source_schema` / `list_gsheet_tabs` + `read_gsheet_rows`. Create with `create_google_sheets_source` (run `check_google_data_access` first), `create_manual_source_from_file`, or `create_manual_source`. |
| **1 Dataset** | `create_dataset` -> `add_table_to_dataset` per table -> `get_table_profile` on each (this populates `columns_cache`). Date table via `update_dataset` settings. Optional `update_table_description` / `update_dataset_dictionary`. |
| **2 Data Model** | `generate_dataset_model`, then refine with `suggest_dataset_model_join` -> `add_dataset_model_join`. `suggest_workboard_relationships` gives lookup-shaped join hints for mini-app forms/tables. |
| **3 Workboard** | `get_workboard_design_guide` (full screen schema) -> author one bundle -> `test_screen_js` for computed columns -> `validate_workboard_bundle` -> `apply_workboard_bundle(user_confirmed=true)`. |
| **4 Share** | `audit_workboard`; `create_workboard_public_link` (form/view URL) and/or `deliver_workboard_to_workspace` (full app behind app-user login); then `run_workboard_runtime_smoke_test`. |

## Profiles

Default `APPBI_MCP_PROFILE=all` exposes everything — testers need no config.
Power users can shrink the surface (comma-combinable):

`discover` (read-only) · `source` · `dataset` · `model` · `build` · `deliver`

```powershell
.\run-mcp.ps1 -Profile build          # author/validate/apply only
$env:APPBI_MCP_PROFILE = 'discover,build'; .\run-mcp.ps1
```

## Bundle contract

`get_workboard_design_guide()` returns the live contract + the full current
screen schema. The bundle:

```json
{
  "workboard": {
    "name": "Inventory Demo",
    "slug": "inventory-demo",
    "dataset_id": 47,
    "primary_table_id": 101,
    "primary_key_columns": ["id"],
    "publish": true
  },
  "layout_json": { "screens": [], "mini_app_nav": { "items": [] } },
  "app_users": [],
  "webhooks": [],
  "workspace": {}
}
```

Screen kinds: `form`, `table`, `doc`, `dashboard`. A table screen uses its
`table` spec (legacy `list`/`grid` are not valid). Screen schemas are strict —
only the fields listed in the design guide are accepted.

## Gotchas worth knowing (verified against the backend)

1. **Google Sheets `source_table_name` is the tab name only** — `"DM_SanPham"`,
   never `"<spreadsheet_id>.DM_SanPham"`.
2. **`columns_cache` fills after profiling** — call `get_table_profile` once on
   every newly added table before authoring model joins or screens against it.
3. **Pass `workboard.slug` explicitly** when delivering via a workspace — the
   backend does not auto-generate one, and workspace menus key by slug.
4. **Public links require the owner PIN rotated off the default** before
   `create_workboard_public_link` succeeds.
5. **POS scan-cart (`table.pos_cart`) line screen still needs `allow_add_row: true`
   + ≥1 `editable_column`** — the runtime bulk-insert of the cart lines is refused
   otherwise (`"Adding rows is disabled"`). Omit `amount_column` if the line total
   is a DB generated column.
6. **"Gom nhiều → 1" is `table.bulk_actions`** (checkbox multi-select → create one
   parent + link selected rows): e.g. gom nhiều đơn → 1 hóa đơn, gom nhiều hóa đơn
   → 1 chuyến giao. `set_column` (+`also_set` keys) must be in the screen's RLS
   `writable_columns`; `parent_screen_id` must be a screen that allows create.
7. **Rollup vs lookup**: `lookup_columns` pull ONE value from a related table;
   `rollup_columns` AGGREGATE child rows (đơn total = SUM of its lines). Both are
   read-only — their `name` goes in `columns`, never `editable_columns`.

## Files

| File | Role |
|---|---|
| `appbi_workboard_mcp.py` | Entry point — imports every stage module |
| `appbi_wb_core.py` | FastMCP, profiles, HTTP + multipart client, confirmation helpers |
| `appbi_wb_source.py` | Stage 0 — source discovery + Google Sheets/manual create |
| `appbi_wb_dataset.py` | Stage 1 — dataset, tables, profiling, descriptions |
| `appbi_wb_model.py` | Stage 2 — generate-model + relationships + lookup suggestions |
| `appbi_wb_discovery.py` | Dataset/Workboard/workspace reads + design-context aggregator |
| `appbi_wb_build.py` | Stage 3 — bundle guide, validation, one-confirm apply |
| `appbi_wb_authoring.py` | Stage 3 helpers — test-js, access audit, export, public links |
| `appbi_wb_users.py` | App-user maintenance |
| `appbi_wb_webhooks.py` | Doc-webhook maintenance + sync history |
| `appbi_wb_workspace.py` | Workspace delivery + runtime smoke test |
