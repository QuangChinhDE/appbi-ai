# AppBI Workboard MCP

Dedicated MCP server for building AppBI Workboard mini-apps from datasets,
Google Sheets tabs, app users, and workspace links.

## Why this MCP exists

Workboards are not dashboards:

- They write directly to physical tables or Google Sheets tabs.
- They rely on screen-level role rules.
- End users log in with app-user credentials, not AppBI platform auth.
- Workspace linking is part of the delivery path.

Claude therefore needs a narrower, schema-aware toolset than the general
dashboard orchestration MCP.

## Supported flows

### SQL-backed workboards

1. Discovery: `list_datasets`, `list_workboards`, `get_dataset`, `list_dataset_tables`, `get_dataset_table_profile`, `list_data_sources`, `list_datasource_tables`, `inspect_source_schema`, `inspect_source_table`
2. Dataset setup: `create_dataset`, `add_physical_table`
3. Blueprint design: `propose_workboard_blueprint`
4. Create/update: `commit_workboard_blueprint`, `update_workboard_blueprint`
5. App users: `create_app_users_batch`, `update_app_user`, `delete_app_user`
6. Workspace delivery: `create_workspace`, `link_workboard_to_workspace`, `preview_workboard`

### Google Sheets-backed workboards

1. Discovery: `list_data_sources`, `get_google_data_access_status`, `list_gsheet_tabs`, `read_gsheet_rows`
2. Sheet design: `prepare_gsheet_tab_schema`, `create_gsheet_tab`
3. Dataset attach: `create_dataset`, `attach_gsheet_tab_to_dataset`, `get_dataset_table_profile`
4. Blueprint design: `propose_workboard_blueprint`
5. Create/update: `commit_workboard_blueprint`, `update_workboard_blueprint`
6. Runtime QA: `run_workboard_runtime_smoke_test`

## Key improvements in this version

- Discovery tools now match the real backend routes.
- Dataset attach tools now send the real backend payload for `physical_table` rows, including `datasource_id` and `display_name`.
- Google Sheets helpers now normalize headers for workboard use and scaffold optimistic-lock expectations.
- Google Sheets write helpers now preflight the connected OAuth write scope before calling mutating endpoints.
- Blueprint commit/update now validate dataset table bindings and normalize `layout_json.audit.updated_at_column` for Google Sheets.
- A new `update_workboard_blueprint` tool gives Claude a safer update path than raw PATCH.

## Tool catalogue

| Tool | Stage | Purpose |
|------|-------|---------|
| `list_datasets` | 1 | List datasets |
| `get_dataset` | 1 | Fetch one dataset with table details |
| `list_dataset_tables` | 1 | List tables attached to a dataset |
| `get_dataset_table_profile` | 1 | Read schema, sample rows, and optional stats |
| `list_workboards` | 1 | List workboards |
| `get_workboard` | 1 | Read full workboard layout |
| `list_app_users` | 1 | List app users for one workboard |
| `list_data_sources` | 1 | List datasources |
| `get_data_source` | 1 | Read one datasource |
| `inspect_source_schema` | 1 | List SQL schemas in a datasource |
| `list_datasource_tables` | 1 | List live source tables/tabs before attach |
| `inspect_source_table` | 1 | Inspect one live source table before attach |
| `list_workspaces` | 1 | List workspaces |
| `get_workspace` | 1 | Read one workspace |
| `create_dataset` | 2 | Create a dataset |
| `add_physical_table` | 2 | Attach a SQL table or GSheets tab to a dataset |
| `attach_gsheet_tab_to_dataset` | 2 | Safer helper for attaching a GSheets tab |
| `get_google_data_access_status` | 1b | Check current AppBI user's Google OAuth scopes |
| `prepare_gsheet_tab_schema` | 1b | Normalize intended GSheets headers and recommended audit/lock fields |
| `create_gsheet_tab` | 1b | Create a tab with normalized headers |
| `read_gsheet_rows` | 1b | Read raw GSheets rows |
| `append_gsheet_row` | 1b | Direct seed/repair write to GSheets |
| `update_gsheet_row` | 1b | Direct seed/repair update to GSheets |
| `delete_gsheet_row` | 1b | Direct seed/repair delete from GSheets |
| `propose_workboard_blueprint` | 3 | Return dataset context plus a starter blueprint |
| `get_doc_screen_examples` | 3 | Copy-pasteable patterns for printable document screens |
| `get_dashboard_screen_examples` | 3 | Copy-pasteable patterns for embedded-dashboard screens |
| `validate_workboard_blueprint` | 3 | Dry-run validate a blueprint before commit |
| `commit_workboard_blueprint` | 4 | Validate, normalize, create, and publish a workboard |
| `update_workboard_blueprint` | 4 | Validate, normalize, and update an existing workboard |
| `update_workboard` | 4 | Low-level raw PATCH for expert use |
| `publish_workboard` | 4 | Publish an existing workboard |
| `delete_workboard` | 4 | Delete a workboard |
| `create_app_users_batch` | 5 | Create app users in bulk |
| `update_app_user` | 5 | Update one app user |
| `delete_app_user` | 5 | Delete one app user |
| `create_workspace` | 6 | Create a workspace |
| `link_workboard_to_workspace` | 6 | Upsert one workboard into workspace menu_config |
| `preview_workboard` | 6 | Start a preview session |
| `run_workboard_runtime_smoke_test` | 6 | Login as an app user, verify menu/list, optionally insert a test row and verify it appears |

## Important rules

1. Always profile the target dataset table before finalizing the blueprint.
2. Never use string values like `"edit"` inside `row_actions`; use full `ScreenAction` objects.
3. Never add `default` to `mini_app_nav`.
4. For Google Sheets, keep a stable `id` column and an `updated_at` column.
5. For Google Sheets, `id` and `updated_at` are system columns: keep them in the tab, but do not expose them as user-editable form fields.
6. For Google Sheets, `workboard.optimistic_lock_column` and `layout_json.audit.updated_at_column` should point to the same column.
7. Google Sheets writes require the stored Google OAuth grant to include `https://www.googleapis.com/auth/spreadsheets`; file ownership alone is not enough.
8. Raw `append_gsheet_row` / `update_gsheet_row` / `delete_gsheet_row` tools bypass workboard runtime validation and RLS. Use them only for setup, repair, or seeding.
9. Workspace create/link requires the MCP PAT to include `workboards: full`. A user's normal AppBI permissions are not enough if the PAT scopes are capped.
10. After publishing and linking a mini-app, run `run_workboard_runtime_smoke_test` with a real app user. For write flows, include a harmless test row and `user_confirmed=true`, then confirm the row appears in the list.

## Setup

```bash
cd Skill-AppBI/appbi-workboard-mcp
pip install -r requirements.txt
cp .env.example .env
```

Set:

- `APPBI_BASE_URL`
- `APPBI_PAT`

## Run

```bash
python appbi_workboard_mcp.py
```

## Claude Desktop example

```json
{
  "mcpServers": {
    "appbi-workboard": {
      "command": "python",
      "args": ["D:/Appv2/appbi-ai/Skill-AppBI/appbi-workboard-mcp/appbi_workboard_mcp.py"],
      "env": {
        "APPBI_BASE_URL": "http://localhost:8000",
        "APPBI_PAT": "your_token_here"
      }
    }
  }
}
```
