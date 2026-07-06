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
.\bootstrap-pat.ps1      # mints your PAT and writes it into .env (see below)
.\run-mcp.ps1            # launches the server (profile=all)
```

macOS / Linux:

```bash
cd /path/to/appbi-workboard-mcp
cp .env.example .env     # set APPBI_BASE_URL if not http://localhost:8000
./bootstrap-pat.sh       # mints your PAT and writes it into .env
./run-mcp.sh             # bootstraps .venv on first run
```

## Get your PAT (the token that connects the MCP)

The MCP authenticates to AppBI with a **Personal Access Token (PAT)**. A PAT
cannot mint itself (the call that creates it needs a logged-in account), so
this is the one credential you supply once. Three ways, no hand-written code:

1. **Shipped helper (recommended for first run).** `bootstrap-pat.ps1` /
   `./bootstrap-pat.sh` (or `python bootstrap_pat.py`) asks for your AppBI
   base URL, email and password, mints the token, and writes `APPBI_PAT` +
   `APPBI_BASE_URL` into `.env`. Add `--print-only` to just print it.
2. **From inside your MCP client.** If the server is already registered, call
   the `bootstrap_personal_access_token` tool with an AppBI email + password —
   it mints the PAT, connects the running session immediately, and saves it to
   `.env`. (`health_check` returns `needs_pat` until you do.)
3. **Manually.** AppBI UI → Settings → Personal Access Tokens → create one,
   then paste it into `.env` as `APPBI_PAT=...`.

The token needs these scopes (the helpers grant them for you):

- `data_sources` — discover and create Google Sheets / file sources.
- `datasets` — create datasets, tables, the relationship model.
- `explore_charts` + `dashboards` — embedded dashboard screens.
- `workboards` (**full**) — build workboards, app users, public links, and
  create/manage delivery workspaces.

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

## Hit an error while building? Want to extend the MCP?

See **[MAINTAINERS.md](MAINTAINERS.md)** — the debug + upgrade guide:

- **Mental model:** the AppBI backend is the single gatekeeper; this MCP is thin
  tools + a design guide. Most "the MCP can't build X" issues are a *design-guide
  gap*, not missing code (because `apply` sends `layout_json` straight through).
- **Which layer failed** — MCP pre-check (`validate_workboard_bundle`) vs backend
  gate (the `backend_error` envelope with a Pydantic field path in `detail`) vs
  runtime (`audit_workboard` / smoke test) — and where each fix goes.
- **The debugging loop** (reproduce with `validate`, read the 422 `detail`, curl
  the backend with the same PAT, `APPBI_MCP_LOG_LEVEL=DEBUG`).
- **The upgrade playbook** — 3 cases (document a backend-supported field · relax a
  false pre-check · add a new tool) with exact edit locations, plus a
  test-before-ship checklist.
- A **common-errors → cause → fix** table.

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
