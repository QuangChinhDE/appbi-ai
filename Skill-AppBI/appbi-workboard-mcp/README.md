# AppBI Workboard MCP

This MCP builds a Workboard mini-app from an existing AppBI dataset. It follows
the same module/profile style as `appbi-dashboard-mcp`, but keeps the main
authoring path deliberately smaller:

```
dataset inspection -> one Workboard bundle -> validate -> apply -> audit/runtime smoke
```

Source ingestion, Google Sheets attachment, semantic modeling, charts, and
dashboard authoring stay in the dashboard MCP or the AppBI UI. Workboard MCP
owns mini-app screens, app users, doc webhooks, and workspace delivery.

## Setup

```powershell
Set-Location D:\Appv2\appbi-ai\Skill-AppBI\appbi-workboard-mcp
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe appbi_workboard_mcp.py
```

Set `APPBI_BASE_URL` and `APPBI_PAT` in `.env`. The PAT needs:

- `datasets=view` to inspect the source dataset.
- `workboards=edit` to build Workboards and app users.
- `workboards=full` when creating or changing delivery workspaces.

Use `APPBI_MCP_PROFILE=design`, `delivery`, or `all`. The default is `all`.
Profiles can be combined with commas.

## Bundle Contract

Call `get_workboard_design_guide()` for the live starter bundle and rules.
The main artifact has this shape:

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
  "layout_json": {
    "screens": [],
    "mini_app_nav": {"items": []}
  },
  "app_users": [],
  "webhooks": [],
  "workspace": {}
}
```

`layout_json` uses backend screen schemas directly: `form`, `table`, `doc`,
and `dashboard`. A table screen uses its `table` spec with
`editable_columns`; legacy `list` and `grid` screen specs are not valid.
Doc `data_table.sync_triggers[].webhook_ids` must refer to stable ids in the
top-level `webhooks` list.

For a demo similar to the dataset 47 seed while skipping Dashboard, design:

1. A form screen for data entry and `after_submit` navigation.
2. A table screen with filters, inline editable columns, lookup/computed
   columns, totals, detail panel, and row actions.
3. A doc screen with printable blocks, Excel export, pivot/report tables, and
   webhook sync triggers.
4. Master-data table screens relevant to lookups.
5. App users for `owner`, `admin`, `user`, and one inactive user.
6. A public-app-users workspace link when the mini-app must be demoed outside
   the builder.

## Tool Surface

| Tool | Profile | Purpose |
|---|---|---|
| `health_check` | design, delivery | Verify base URL/PAT runtime config |
| `list_datasets` | design | Pick an existing dataset |
| `inspect_dataset_for_workboard` | design | One-call table ids, columns, samples |
| `list_workboards`, `get_workboard`, `audit_workboard` | design, delivery | Reuse and verify Workboards |
| `list_workspaces`, `get_workspace` | design, delivery | Reuse delivery workspaces |
| `get_workboard_design_guide` | design | Bundle template and screen rules |
| `validate_workboard_bundle` | design | Dry-run references and bundle consistency |
| `apply_workboard_bundle` | design, delivery | One-confirm create/update path |
| `list_workboard_app_users` | design, delivery | Inspect mini-app users |
| `upsert_workboard_app_users` | delivery | Maintenance user upsert |
| `replace_workboard_webhooks`, `test_workboard_webhook` | delivery | Maintain/test doc webhooks |
| `list_workboard_webhooks`, `list_workboard_sync_runs` | design, delivery | Webhook verification |
| `deliver_workboard_to_workspace` | delivery | Link a Workboard into a workspace |
| `create_workspace_preview_session` | delivery | Admin preview session |
| `run_workboard_runtime_smoke_test` | delivery | Public login, menu, screen/table smoke; optional confirmed form write |

Every mutating tool returns a confirmation preview until
`user_confirmed=true`.

## Files

| File | Role |
|---|---|
| `appbi_workboard_mcp.py` | Entry point importing all modules |
| `appbi_wb_core.py` | FastMCP, profiles, HTTP client, confirmation helpers |
| `appbi_wb_discovery.py` | Dataset/Workboard/workspace read tools |
| `appbi_wb_build.py` | Bundle guide, validation, one-confirm apply |
| `appbi_wb_users.py` | App-user maintenance |
| `appbi_wb_webhooks.py` | Stable-id webhook maintenance and sync history |
| `appbi_wb_workspace.py` | Workspace delivery and runtime smoke |
