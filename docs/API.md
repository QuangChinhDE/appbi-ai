# AppBI — REST API Reference

Base URL: `http://localhost:8000/api/v1`
Interactive docs (Swagger UI): `http://localhost:8000/api/v1/docs`
OpenAPI JSON: `http://localhost:8000/openapi.json`

All request/response bodies are **JSON**. Protected endpoints require a JWT token in the `Authorization: Bearer <token>` header (obtained from `/auth/login`).

---

## Table of Contents

1. [Auth](#1-auth)
2. [Users](#2-users)
3. [Permissions](#3-permissions)
4. [Shares](#4-shares)
5. [Data Sources](#5-data-sources)
6. [Dataset Workspaces](#6-dataset-workspaces)
7. [Charts](#7-charts)
8. [Dashboards](#8-dashboards)
9. [Semantic Views](#9-semantic-views)
10. [Common Types](#10-common-types)

---

## 1. Auth

### `POST /auth/login`

Login and receive a JWT token.

> Rate-limited: **5 requests/minute** per IP.

**Request body**
```json
{ "email": "admin@appbi.io", "password": "your-password" }
```

**Response 200** — also sets `Set-Cookie: access_token=<token>; HttpOnly; Max-Age=86400; SameSite=lax`
```json
{
  "access_token": "eyJhbGci...",
  "token_type": "bearer",
  "user": {
    "id": "uuid",
    "email": "admin@appbi.io",
    "full_name": "Admin",
    "status": "active",
    "permissions": {
      "dashboards": "full",
      "explore_charts": "full",
      "workspaces": "full",
      "data_sources": "full",
      "ai_chat": "full",
      "user_management": "full",
      "settings": "full"
    },
    "last_login_at": "2026-03-22T10:00:00Z",
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-22T10:00:00Z"
  }
}
```

---

### `GET /auth/me`

Get current user profile.

**Response 200** — `UserResponse` (see [Users](#2-users))

---

### `POST /auth/change-password`

Change current user's password.

**Request body**
```json
{ "old_password": "current", "new_password": "newpassword123" }
```

**Response 200** — `{ "message": "Password changed successfully" }`
**Error 401** — old password incorrect
**Error 422** — `new_password` must be at least 8 characters

---

### `POST /auth/logout`

Invalidate the current session. Sets `Set-Cookie: access_token=""; Max-Age=0` to clear the cookie.

**Response 200** — `{ "message": "Logged out" }`

---

## 2. Users

> Requires module permission `user_management >= view`. Write operations require `full`.

### `GET /users/`

List all users.

**Response 200** — array of `UserResponse`

```json
[
  {
    "id": "b8dcae67-119c-46ac-94cb-c70e7394bcbc",
    "email": "admin@appbi.io",
    "full_name": "Admin",
    "status": "active",
    "permissions": { "dashboards": "full", "explore_charts": "full" },
    "last_login_at": "2026-03-22T10:00:00Z",
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-22T10:00:00Z"
  }
]
```

---

### `GET /users/shareable`

List all users available for resource sharing.

**Response 200** — array of `{ id, email, full_name }`

---

### `POST /users/`

Create a user (admin only).

**Request body**
```json
{
  "email": "user@company.com",
  "full_name": "Jane Doe",
  "password": "secure123"
}
```

**Response 201** — `UserResponse`
**Error 409** — email already exists

---

### `GET /users/{user_id}`

Get a single user.

---

### `PUT /users/{user_id}`

Update user's name or status.

**Request body** (all fields optional)
```json
{
  "full_name": "Jane Smith",
  "status": "active"
}
```

`status` values: `active` · `deactivated`

---

### `DELETE /users/{user_id}`

Delete a user. Cannot delete yourself.

---

## 3. Permissions

Module-level access control. Each user has a permission level per module.

| Module key | Controls |
|---|---|
| `dashboards` | Dashboard list, create, edit, delete |
| `explore_charts` | Chart/explore builder |
| `workspaces` | Dataset workspaces |
| `data_sources` | DataSource connections |
| `ai_chat` | AI chat agent |
| `user_management` | User admin panel |
| `settings` | System settings |

Permission levels: `none` → `view` → `edit` → `full`

---

### `GET /permissions/me`

Get current user's module permissions.

**Response 200**
```json
{
  "permissions": {
    "data_sources": "full",
    "datasets": "none",
    "workspaces": "full",
    "explore_charts": "full",
    "dashboards": "full",
    "ai_chat": "full",
    "settings": "full"
  },
  "module_levels": {
    "data_sources":    ["none", "view", "full"],
    "datasets":        ["none", "view", "edit", "full"],
    "workspaces":      ["none", "view", "edit", "full"],
    "explore_charts":  ["none", "view", "edit", "full"],
    "dashboards":      ["none", "view", "edit", "full"],
    "ai_chat":         ["none", "view", "edit"],
    "settings":        ["none", "full"]
  }
}
```

> Note: `module_levels` shows the valid levels for each module — not all modules support all levels. `data_sources` has no `edit`; `ai_chat` has no `full`; `settings` is either `none` or `full` only.

---

### `GET /permissions/presets`

List available permission presets.

**Response 200**
```json
{
  "presets": {
    "admin":   { "data_sources": "full",  "datasets": "full",  "workspaces": "full",  "explore_charts": "full",  "dashboards": "full",  "ai_chat": "edit", "settings": "full" },
    "editor":  { "data_sources": "view",  "datasets": "edit",  "workspaces": "edit",  "explore_charts": "edit",  "dashboards": "edit",  "ai_chat": "edit", "settings": "none" },
    "viewer":  { "data_sources": "view",  "datasets": "view",  "workspaces": "view",  "explore_charts": "view",  "dashboards": "view",  "ai_chat": "view", "settings": "none" },
    "minimal": { "data_sources": "none",  "datasets": "none",  "workspaces": "none",  "explore_charts": "none",  "dashboards": "view",  "ai_chat": "none", "settings": "none" }
  }
}
```

Preset names: `admin` · `editor` · `viewer` · `minimal`

---

### `GET /permissions/matrix`

Get permissions for all users (admin view).

**Response 200**
```json
{
  "modules": ["data_sources", "datasets", "workspaces", "explore_charts", "dashboards", "ai_chat", "settings"],
  "module_levels": { "data_sources": ["none","view","full"], "dashboards": ["none","view","edit","full"], ... },
  "users": [
    {
      "user_id": "uuid",
      "email": "user@company.com",
      "full_name": "Name",
      "permissions": { "dashboards": "edit", "workspaces": "view", ... }
    }
  ]
}
```

---

### `PUT /permissions/{user_id}`

Set module permissions for a user.

**Request body**
```json
{
  "permissions": {
    "data_sources":   "view",
    "datasets":       "none",
    "workspaces":     "edit",
    "explore_charts": "edit",
    "dashboards":     "edit",
    "ai_chat":        "view",
    "settings":       "none"
  }
}
```

**Response 200** — `{ "status": "ok", "updated": 7, "permissions": { ... } }`

> Only include the modules you want to change. Any module not in the body retains its current value.

---

### `PUT /permissions/{user_id}/preset`

Apply a permission preset to a user.

**Request body** — `{ "preset": "editor" }`

**Response 200** — `{ "status": "ok", "preset": "editor", "permissions": { ... } }`
**Error 400** — invalid preset name

---

## 4. Shares

Resource-level sharing between users.

`resource_type` values: `dashboard` · `chart` · `workspace` · `datasource` · `chat_session`
`permission` values: `view` · `edit`

---

### `GET /shares/{resource_type}/{resource_id}`

List all shares for a resource.

**Response 200** — array of `ShareResponse`
```json
[
  {
    "id": 1,
    "resource_type": "dashboard",
    "resource_id": 5,
    "user_id": "uuid",
    "permission": "view",
    "shared_by": "uuid",
    "created_at": "2026-03-22T10:00:00Z",
    "user": { "id": "uuid", "email": "user@co.com", "full_name": "Jane", "status": "active", "permissions": {}, "last_login_at": null, "created_at": "...", "updated_at": "..." }
  }
]
```

---

### `POST /shares/{resource_type}/{resource_id}`

Share a resource with a user.

**Request body**
```json
{ "user_id": "uuid", "permission": "view" }
```

**Response 201** — `ShareResponse`

---

### `PUT /shares/{resource_type}/{resource_id}/{user_id}`

Update share permission.

**Request body** — `{ "permission": "edit" }`

**Response 200** — updated `ShareResponse`

---

### `DELETE /shares/{resource_type}/{resource_id}/{user_id}`

Remove a share.

**Response 204** — no body

---

### `POST /shares/{resource_type}/{resource_id}/all-team`

Share with all users on the team at once.

**Request body** — `{ "permission": "view" }`

**Response 204** — no body

---

## 5. Data Sources

Connections to external databases/files. Credentials are encrypted at rest.

### `GET /datasources/`

List all datasources (owned + shared).

**Response 200** — array of `DataSourceResponse`
```json
[
  {
    "id": 1,
    "name": "Production DB",
    "type": "postgresql",
    "description": null,
    "config": { "host": "db.internal", "port": 5432, "database": "prod" },
    "owner_id": "uuid",
    "user_permission": "full",
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-22T00:00:00Z"
  }
]
```

> Credential fields (e.g. `password`, `credentials_json`) are returned as `"__stored__"` — the actual value is never exposed.

---

### `POST /datasources/`

Create a datasource.

**Request body**
```json
{
  "name": "My Datasource",
  "type": "postgresql",
  "description": "Optional",
  "config": { ... }
}
```

**`type` and required `config` fields:**

| `type` | Required `config` fields |
|---|---|
| `postgresql` | `host`, `port` (int), `database`, `username`, `password`, `schema` (optional, default `public`) |
| `mysql` | `host`, `port` (int), `database`, `username`, `password` |
| `bigquery` | `project_id`, `credentials_json` (Service Account JSON as string), `default_dataset` (optional) |
| `google_sheets` | `credentials_json` (Service Account JSON as string), `spreadsheet_id`, `sheet_name` (optional) |
| `manual` | *(no config — upload file via `/manual/parse-file` first)* |

**PostgreSQL example**
```json
{
  "name": "Production DB",
  "type": "postgresql",
  "config": {
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "username": "appbi_user",
    "password": "secret",
    "schema": "public"
  }
}
```

**Google Sheets example**
```json
{
  "name": "Sales Sheet",
  "type": "google_sheets",
  "config": {
    "credentials_json": "{\"type\":\"service_account\",\"project_id\":\"...\",\"private_key\":\"...\",\"client_email\":\"...\"}",
    "spreadsheet_id": "1BaEOS27NFTDQzM3aK3QF_qWpMs0TnbU_d6E1qDsWs1I",
    "sheet_name": "Sheet1"
  }
}
```

**Response 201** — `DataSourceResponse`
**Error 400** — invalid config for the given type

---

### `GET /datasources/{data_source_id}`

Get a single datasource.

---

### `PUT /datasources/{data_source_id}`

Update name, description, or config.

**Request body** (all fields optional)
```json
{
  "name": "New Name",
  "description": "Updated",
  "config": { "host": "new-host" }
}
```

---

### `DELETE /datasources/{data_source_id}`

Delete a datasource. Returns `409` if workspace tables depend on it.

---

### `POST /datasources/test`

Test a connection **without saving**.

**Request body** — same as create (name + type + config)

**Response 200**
```json
{ "success": true, "message": "Connection successful" }
```

---

### `POST /datasources/query`

Execute an ad-hoc SQL query against a datasource.

**Request body**
```json
{
  "data_source_id": 1,
  "sql_query": "SELECT COUNT(*) FROM orders",
  "limit": 100,
  "timeout_seconds": 30
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `data_source_id` | int | required | Target datasource |
| `sql_query` | string | required | SQL to execute |
| `limit` | int (1–10000) | null | Optional row cap |
| `timeout_seconds` | int (1–300) | 30 | Query timeout |

**Response 200**
```json
{
  "columns": ["col1", "col2"],
  "data": [{"col1": "value", "col2": 42}],
  "row_count": 1,
  "execution_time_ms": 120
}
```

---

### `GET /datasources/{data_source_id}/schema`

List all tables/sheets available in the datasource.

**Response 200**
```json
{
  "schemas": [
    { "schema": "public", "tables": ["orders", "customers"] }
  ]
}
```

---

### `GET /datasources/{data_source_id}/tables/{schema_name}/{table_name}`

Get column metadata for a specific table.

**Response 200** — `{ columns: [{ name, type, nullable }], row_count? }`

---

### `GET /datasources/{data_source_id}/tables/{schema_name}/{table_name}/watermarks`

Get sync watermarks (incremental sync state) for a table.

---

### `GET /datasources/{data_source_id}/sync-config`

Get the sync schedule configuration.

---

### `PUT /datasources/{data_source_id}/sync-config`

Update sync schedule.

**Request body**
```json
{
  "schedule": "hourly",
  "enabled": true,
  "tables": ["orders", "customers"]
}
```

---

### `POST /datasources/{data_source_id}/sync`

Trigger a manual sync (async — returns immediately).

**Response 202**
```json
{ "job_id": 1, "status": "running", "message": "Sync started" }
```

---

### `GET /datasources/{data_source_id}/sync-jobs`

List sync job history.

**Response 200**
```json
{
  "jobs": [
    {
      "id": 1,
      "status": "success",
      "mode": "manual",
      "started_at": "2026-03-22T10:44:33Z",
      "finished_at": "2026-03-22T10:44:45Z",
      "duration_seconds": 12.07,
      "rows_synced": 37422,
      "rows_failed": 0,
      "error_message": null,
      "triggered_by": "manual"
    }
  ]
}
```

`status` values: `running` · `success` · `failed` · `partial`

---

### `POST /datasources/manual/parse-file`

Upload a CSV or Excel file for a `manual` datasource.

**Request** — `multipart/form-data`, field name: `file`
Accepted: `.csv`, `.xlsx`, `.xls` (max 50 MB)

**Response 200**
```json
{
  "sheets": [
    {
      "name": "Sheet1",
      "rows": [{"col1": "val", "col2": 123}],
      "columns": [{"name": "col1", "type": "string"}, {"name": "col2", "type": "integer"}]
    }
  ],
  "total_rows": 82
}
```

After parsing, create the datasource with `type: "manual"` and include the sheet data in `config.sheets`.

---

## 6. Dataset Workspaces

Workspaces group multiple tables from different datasources into a single virtual schema. Charts are built on top of workspace tables.

### `GET /dataset-workspaces/`

List all workspaces (owned + shared).

**Response 200**
```json
[
  {
    "id": 1,
    "name": "Sales Analytics",
    "description": "Sales data from CRM + sheets",
    "owner_id": "uuid",
    "user_permission": "full",
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-22T00:00:00Z"
  }
]
```

---

### `POST /dataset-workspaces/`

Create a workspace.

**Request body**
```json
{ "name": "My Workspace", "description": "Optional" }
```

**Response 201** — `WorkspaceResponse`

---

### `GET /dataset-workspaces/{workspace_id}`

Get workspace with all its tables.

**Response 200**
```json
{
  "id": 1,
  "name": "Sales Analytics",
  "tables": [
    {
      "id": 2,
      "workspace_id": 1,
      "datasource_id": 1,
      "display_name": "Orders",
      "source_kind": "physical_table",
      "source_table_name": "orders",
      "source_query": null,
      "enabled": true,
      "transformations": [],
      "type_overrides": null,
      "column_formats": null,
      "columns_cache": {
        "columns": [
          {"name": "order_id", "type": "integer", "nullable": false},
          {"name": "amount", "type": "number", "nullable": true}
        ]
      },
      "created_at": "2026-03-01T00:00:00Z",
      "updated_at": "2026-03-22T00:00:00Z"
    }
  ]
}
```

---

### `PUT /dataset-workspaces/{workspace_id}`

Update workspace name or description.

**Request body** (all optional)
```json
{ "name": "New Name", "description": "Updated" }
```

---

### `DELETE /dataset-workspaces/{workspace_id}`

Delete workspace and all its tables.

---

### `GET /dataset-workspaces/{workspace_id}/tables`

List tables for a workspace.

---

### `POST /dataset-workspaces/{workspace_id}/tables`

Add a table to a workspace.

**Request body**
```json
{
  "datasource_id": 1,
  "source_kind": "physical_table",
  "source_table_name": "orders",
  "display_name": "Orders",
  "enabled": true,
  "transformations": []
}
```

For `source_kind: "sql_query"`, use `source_query` instead of `source_table_name`:
```json
{
  "datasource_id": 1,
  "source_kind": "sql_query",
  "source_query": "SELECT * FROM orders WHERE status = 'completed'",
  "display_name": "Completed Orders",
  "enabled": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `datasource_id` | int | ✓ | Source datasource |
| `source_kind` | `"physical_table"` \| `"sql_query"` | ✓ | Table type |
| `source_table_name` | string | if physical | Full table name (e.g. `"schema.table"`) |
| `source_query` | string | if sql_query | SQL SELECT query |
| `display_name` | string | ✓ | Name shown in UI |
| `enabled` | bool | default `true` | Whether table is active |
| `transformations` | array | optional | List of transformation steps (see below) |

**Transformation steps (`transformations` array)**

| `type` | `params` | Description |
|---|---|---|
| `add_column` | `newField`, `expression` (SQL expr) | Add computed column via SQL CASE/expression |
| `select_columns` | `columns[]` | Keep only specified columns |
| `rename_columns` | `mapping` `{old: new}` | Rename columns |
| `js_formula` | `newField`, `formula` OR `code` | Add computed column evaluated client-side (Excel formula engine) |

**`js_formula` — Excel-style formula examples:**
```
IF([status]="active", 1, 0)
ROUND([amount]/[qty], 2)
LEFT([last_update], 4)
[country]&" ("&[region]&")"
```

Supported functions: `IF`, `AND`, `OR`, `NOT`, `ROUND`, `ABS`, `LEN`, `LEFT`, `RIGHT`, `MID`, `UPPER`, `LOWER`, `TRIM`, `CONCAT`, `TEXT`, `VALUE`, `TODAY`, `NOW`, `YEAR`, `MONTH`, `DAY`, `DATEDIF`, `VLOOKUP`, `IFERROR`, `ISBLANK`, plus arithmetic, comparison, and `&` string concat.

**Response 201** — `TableResponse`

---

### `PUT /dataset-workspaces/{workspace_id}/tables/{table_id}`

Update a workspace table.

**Request body** (all fields optional)
```json
{
  "display_name": "Renamed Table",
  "source_query": "SELECT * FROM orders WHERE year = 2026",
  "enabled": true,
  "transformations": [
    {
      "type": "add_column",
      "enabled": true,
      "params": {
        "newField": "is_active_flag",
        "expression": "CASE WHEN is_active = 'active' THEN 1 ELSE 0 END"
      }
    }
  ],
  "type_overrides": {
    "amount": "currency",
    "created_at": "date"
  },
  "column_formats": {
    "amount": { "formatType": "currency", "decimals": 2, "thousandsSep": true }
  }
}
```

> When `source_query` is updated, the backend validates the SQL before saving.

---

### `DELETE /dataset-workspaces/{workspace_id}/tables/{table_id}`

Remove a table. Returns `409` with constraint details if charts depend on it.

---

### `POST /dataset-workspaces/{workspace_id}/tables/{table_id}/preview`

Preview table data (runs via DuckDB if synced, otherwise live source).

**Request body**
```json
{ "limit": 200, "offset": 0 }
```

**Response 200**
```json
{
  "columns": [
    {"name": "order_id", "type": "string", "nullable": true},
    {"name": "amount", "type": "number", "nullable": true}
  ],
  "rows": [{"order_id": "abc", "amount": 99.9}],
  "total": 37422,
  "has_more": true
}
```

**Error 422** `{ "code": "NOT_SYNCED", "message": "Table not synced to DuckDB" }` — table exists but hasn't been synced yet.

---

### `POST /dataset-workspaces/{workspace_id}/tables/{table_id}/execute`

Execute a structured aggregation query against the table.

**Request body**
```json
{
  "dimensions": ["project_id", "status"],
  "measures": [
    {"field": "revenue", "function": "sum", "alias": "total_revenue"},
    {"field": "id",      "function": "count", "alias": "record_count"}
  ],
  "filters": [],
  "order_by": [],
  "limit": 1000
}
```

> Field name is `function` (not `agg`). Supported functions: `sum`, `count`, `avg`, `min`, `max`, `count_distinct`.
> If `alias` is omitted, the column name is `{field}_{function}` (e.g. `revenue_sum`).

**Response 200**
```json
{
  "columns": [{"name": "project_id", "type": "string", "nullable": true}, {"name": "total_revenue", "type": "number", "nullable": true}],
  "rows": [{"project_id": "base-datateam", "total_revenue": 16099}]
}
```

---

### `GET /dataset-workspaces/tables/search`

Search tables across all workspaces by name similarity.

**Query params** — `?q=<search_term>&limit=10`

**Response 200**
```json
[
  {
    "id": 2,
    "workspace_id": 1,
    "display_name": "Data Lake Segment",
    "auto_description": "AI-generated table description...",
    "columns": [{"name": "key", "type": "string", "nullable": true}],
    "similarity": 0.87
  }
]
```

---

### `GET /dataset-workspaces/datasources/{datasource_id}/tables`

List physical tables available from a datasource.

**Response 200** — `[{ "name": "table_name", "schema": "public", "table_type": "table" }]`

---

### `GET /dataset-workspaces/datasources/{datasource_id}/tables/columns`

Get column metadata for a specific table in a datasource.

**Query params** — `?table=<table_name>` (required)

**Response 200**
```json
{
  "columns": [
    {"name": "key", "type": "VARCHAR"},
    {"name": "amount", "type": "DOUBLE"}
  ]
}
```

> Column `type` here is the raw SQL/connector type (e.g. `VARCHAR`, `DOUBLE`, `TIMESTAMP`), not the normalized AppBI type.

---

## 7. Charts

Charts are saved Explore configurations — chart type, data source, field mapping, and filters.

### `GET /charts/`

List all charts (owned + shared).

**Query params** — `?skip=0&limit=50`

**Response 200** — array of `ChartResponse`
```json
[
  {
    "id": 4,
    "name": "Records by Project",
    "description": null,
    "chart_type": "BAR",
    "workspace_table_id": 2,
    "config": {
      "workspace_id": 1,
      "chartType": "BAR",
      "roleConfig": {
        "dimension": "project_id",
        "metrics": [{"field": "key", "agg": "count"}],
        "breakdown": null,
        "timeField": null
      },
      "filters": []
    },
    "owner_id": "uuid",
    "user_permission": "full",
    "metadata": {
      "domain": "operations",
      "intent": "distribution",
      "metrics": ["Records"],
      "dimensions": ["Project"],
      "tags": ["records", "projects"]
    },
    "parameters": [],
    "created_at": "2026-03-22T10:00:00Z",
    "updated_at": "2026-03-22T10:00:00Z"
  }
]
```

---

### `GET /charts/search`

Search charts by name similarity.

**Query params** — `?q=<term>&limit=10` (max 20)

**Response 200** — `[{ "id": 4, "name": "Records by Project", "chart_type": "BAR", "similarity": 0.63 }]`

---

### `POST /charts/ai-preview`

Execute a chart from an AI-generated config and optionally save it. Used by the AI agent's `create_chart` tool.

> Requires `ai_chat >= view` permission.

**Request body**
```json
{
  "workspace_table_id": 2,
  "chart_type": "BAR",
  "config": {
    "dimensions": ["region"],
    "metrics": [
      { "column": "revenue", "aggregation": "sum" }
    ],
    "limit": 500
  },
  "name": "Revenue by Region",
  "description": "Optional description",
  "save": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `workspace_table_id` | int | Yes | Source workspace table |
| `chart_type` | string | Yes | Any `ChartType` value (case-insensitive) |
| `config.dimensions` | string[] | No | Column names to GROUP BY |
| `config.metrics` | object[] | No | `{ column, aggregation }` — agg defaults to `"sum"` |
| `config.limit` | int | No | Max rows, default 500, capped at 2000 |
| `name` | string | No | Chart name if saving, default `"AI Chart"` |
| `description` | string | No | Optional description |
| `save` | bool | No | If `true`, persists as a real chart and triggers embedding |

**Response 200** — preview only (`save: false`)
```json
{
  "chart_type": "BAR",
  "config": { "dimensions": ["region"], "metrics": [...], "limit": 500 },
  "data": [{ "region": "Asia", "revenue_sum": 12000 }],
  "row_count": 1,
  "saved": false,
  "chart_id": null
}
```

**Response 200** — with save (`save: true`) — adds `saved`, `chart_id`, `chart_name`
```json
{
  "chart_type": "BAR",
  "config": {...},
  "data": [...],
  "row_count": 1,
  "saved": true,
  "chart_id": 7,
  "chart_name": "Revenue by Region"
}
```

| Status | Meaning |
|--------|---------|
| 200 | Success (preview or saved) |
| 403 | Insufficient permission (`ai_chat < view`) |
| 404 | `workspace_table_id` not found |
| 422 | Table not synced to DuckDB, or query execution failed |

---

### `POST /charts/`

Create a chart.

**Request body**
```json
{
  "name": "Revenue by Region",
  "description": "Optional",
  "chart_type": "BAR",
  "workspace_table_id": 2,
  "config": {
    "workspace_id": 1,
    "chartType": "BAR",
    "roleConfig": {
      "dimension": "region",
      "metrics": [
        {"field": "revenue", "agg": "sum"},
        {"field": "orders", "agg": "count"}
      ],
      "breakdown": null,
      "timeField": null
    },
    "filters": [
      {"field": "status", "operator": "eq", "value": "completed"}
    ]
  }
}
```

**`chart_type` values (uppercase):**
`BAR` · `LINE` · `AREA` · `PIE` · `SCATTER` · `GROUPED_BAR` · `STACKED_BAR` · `TABLE` · `KPI` · `TIME_SERIES` · `COMBO`

**`config` structure:**

| Field | Type | Description |
|---|---|---|
| `workspace_id` | int | Workspace that owns the table (used by explore builder to restore state) |
| `chartType` | string | Same as `chart_type` but uppercase string |
| `roleConfig` | object | Field mapping (see below) |
| `filters` | array | Pre-aggregation filters applied in backend SQL |

**`roleConfig` fields:**

| Field | Type | Chart types | Description |
|---|---|---|---|
| `dimension` | string | BAR, LINE, AREA, PIE, GROUPED_BAR, STACKED_BAR | X-axis / group-by field |
| `timeField` | string | TIME_SERIES | Date/time field for X-axis |
| `metrics` | `MetricConfig[]` | all except TABLE | Y-axis aggregations |
| `breakdown` | string | STACKED_BAR, LINE, AREA | Second grouping dimension (creates series) |
| `scatterX` | string | SCATTER | X-axis field |
| `scatterY` | string | SCATTER | Y-axis field |
| `selectedColumns` | string[] | TABLE | Columns to display (undefined = show all) |

**`MetricConfig` object:**
```json
{ "field": "revenue", "agg": "sum" }
```

| `agg` value | SQL |
|---|---|
| `sum` | `SUM(field)` |
| `avg` | `AVG(field)` |
| `count` | `COUNT(field)` |
| `count_distinct` | `COUNT(DISTINCT field)` |
| `min` | `MIN(field)` |
| `max` | `MAX(field)` |

**`filters` item:**
```json
{ "field": "status", "operator": "eq", "value": "completed" }
```

| `operator` | SQL equivalent |
|---|---|
| `eq` | `= value` |
| `neq` | `!= value` |
| `gt` | `> value` |
| `gte` | `>= value` |
| `lt` | `< value` |
| `lte` | `<= value` |
| `in` | `IN (value[])` |
| `not_in` | `NOT IN (value[])` |
| `contains` | `LIKE '%value%'` |
| `is_null` | `IS NULL` |
| `is_not_null` | `IS NOT NULL` |

**Response 201** — `ChartResponse`

---

### `GET /charts/{chart_id}`

Get a single chart.

---

### `PUT /charts/{chart_id}`

Update chart name, type, config, or workspace_table_id.

**Request body** (all fields optional)
```json
{
  "name": "Updated Name",
  "chart_type": "LINE",
  "workspace_table_id": 3,
  "config": { ... }
}
```

---

### `DELETE /charts/{chart_id}`

Delete a chart.

> Requires `explore_charts = full`.

**Response 204** — no body

**Response 409** — chart is still in one or more dashboards:
```json
{
  "detail": {
    "message": "Chart \"Revenue by Region\" is used in 2 dashboards and cannot be deleted.",
    "constraints": [
      { "type": "dashboard", "id": 1, "name": "Q1 Overview" }
    ]
  }
}
```

> Remove the chart from all dashboards first, then retry.

---

### `GET /charts/{chart_id}/data`

Execute the chart query and return aggregated chart-ready data.

> **Auth required.** Returns `403` if user has no access to this chart.

**Response 200**
```json
{
  "chart": { ... },
  "data": [
    {"project_id": "base-datateam", "count__key": 16099},
    {"project_id": "other-project", "count__key": 423}
  ],
  "pre_aggregated": true
}
```

**`pre_aggregated` flag:**
- `true` — backend ran `GROUP BY` aggregation in DuckDB; data rows use aliased metric column names (e.g. `"sum__revenue"`, `"count__key"`, `"avg__price"`)
- `false` — live source fallback; raw rows returned, client-side aggregation applies

**Aggregated column naming convention:**
```
{agg}__{field}   →   sum__revenue, count__orders, avg__price, min__qty, max__qty, count_distinct__user_id
```

**Row limits by chart type:**

| Chart type | Limit | Reason |
|---|---|---|
| `TABLE` | **500 rows** | Prevents large JSON payloads over HTTP; UI displays at most 50–200 rows |
| `SCATTER` | 5,000 rows | Raw points — enough for density representation |
| All aggregated types (`BAR`, `LINE`, `KPI`, etc.) | No limit | GROUP BY result sets are inherently small |
| Live fallback (no DuckDB) | 1,000 rows | Safety cap when querying live source directly |

> `TABLE` charts apply `add_column` / `select_columns` transformations before the LIMIT, so computed columns are always available.

**Computed columns in aggregation:**
Columns added via `add_column` workspace table transformations (server-side SQL expressions) are fully supported in `GROUP BY` and `WHERE` clauses. `js_formula` columns (client-side Excel-syntax formulas) are evaluated in the browser and are not available for server-side aggregation.

**Error 422** `{ "code": "NOT_SYNCED" }` — table not yet synced to DuckDB and live fallback unavailable.

---

### Chart Metadata

Semantic metadata for AI search and categorization.

#### `PUT /charts/{chart_id}/metadata`

**Request body**
```json
{
  "domain": "sales",
  "intent": "comparison",
  "metrics": ["Revenue", "Orders"],
  "dimensions": ["Region", "Product"],
  "tags": ["revenue", "quarterly", "regional"]
}
```

| Field | Values |
|---|---|
| `domain` | `sales` · `marketing` · `finance` · `operations` · `hr` · `product` · `logistics` · `other` |
| `intent` | `trend` · `comparison` · `ranking` · `summary` · `distribution` · `composition` |

#### `GET /charts/{chart_id}/metadata`

Returns `ChartMetadataResponse`.

#### `DELETE /charts/{chart_id}/metadata`

Remove metadata.

---

### Chart Parameters

Parameters enable dynamic filtering when a chart is placed in a dashboard.

#### `GET /charts/{chart_id}/parameters`

List parameters.

**Response 200** — array of `ChartParameterResponse`
```json
[
  {
    "id": 1,
    "chart_id": 4,
    "parameter_name": "start_date",
    "parameter_type": "time_range",
    "column_mapping": { "column": "order_date", "type": "date" },
    "default_value": "2026-01-01",
    "description": "Filter start date",
    "created_at": "2026-03-01T00:00:00Z"
  }
]
```

> `column_mapping` is a **JSON object** (e.g. `{"column": "order_date", "type": "date"}`), not a plain string.

#### `PUT /charts/{chart_id}/parameters`

Replace all parameters (bulk). Returns `200` with the new array.

**Request body** — array of `ChartParameterCreate`
```json
[
  {
    "parameter_name": "region_filter",
    "parameter_type": "dimension",
    "column_mapping": { "column": "region", "type": "string" },
    "default_value": null,
    "description": "Filter by region"
  }
]
```

| `parameter_type` | Description |
|---|---|
| `time_range` | Date/time filter |
| `dimension` | Categorical filter |
| `measure` | Numeric threshold |

#### `POST /charts/{chart_id}/parameters`

Add a single parameter.

#### `PUT /charts/{chart_id}/parameters/{param_id}`

Update a parameter.

#### `DELETE /charts/{chart_id}/parameters/{param_id}`

Delete a parameter.

---

## 8. Dashboards

Dashboards compose multiple charts in a drag-and-drop grid layout.

### `GET /dashboards/`

List all dashboards (owned + shared).

**Query params** — `?skip=0&limit=50`

**Response 200** — array of `DashboardResponse` (each includes full `dashboard_charts` array)

---

### `POST /dashboards/`

Create a dashboard. Can optionally include charts at creation time.

> Requires `dashboards >= edit`.

**Request body**
```json
{
  "name": "Sales Overview",
  "description": "Optional",
  "filters_config": [
    {
      "id": "f1",
      "field": "region",
      "op": "eq",
      "value": "APAC"
    }
  ],
  "charts": []
}
```

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Required, 1–255 chars |
| `description` | string | Optional |
| `filters_config` | array | Optional global filter definitions (client-side applied) |
| `charts` | array of `DashboardChartItem` | Optional, add charts at creation; each item has `{chart_id, layout}` |

**Response 201** — `DashboardResponse`

---

### `GET /dashboards/{dashboard_id}`

Get dashboard with all chart tiles, layout, and filter config.

**Response 200**
```json
{
  "id": 1,
  "name": "Sales Overview",
  "description": null,
  "owner_id": "uuid",
  "user_permission": "full",
  "filters_config": [],
  "dashboard_charts": [
    {
      "id": 10,
      "chart_id": 4,
      "layout": {
        "i": "4",
        "x": 0, "y": 0,
        "w": 6, "h": 4
      },
      "parameters": null,
      "chart": { "...ChartResponse..." }
    }
  ],
  "created_at": "2026-03-01T00:00:00Z",
  "updated_at": "2026-03-22T00:00:00Z"
}
```

> `dashboard_charts[].id` is the `DashboardChart` join-table ID (used in layout updates).
> `dashboard_charts[].chart_id` is the actual `Chart.id`.

---

### `PUT /dashboards/{dashboard_id}`

Update name, description, or filters_config.

**Request body** — all fields optional
```json
{
  "name": "Updated Name",
  "description": "New desc",
  "filters_config": []
}
```

**Response 200** — updated `DashboardResponse`

---

### `DELETE /dashboards/{dashboard_id}`

Delete dashboard. Charts are NOT deleted, only unlinked.

> Requires `dashboards = full`.

**Response 204** — no body

---

### `POST /dashboards/{dashboard_id}/charts`

Add a chart to a dashboard.

> Requires `dashboards >= edit`.

**Request body**
```json
{
  "chart_id": 4,
  "layout": { "x": 0, "y": 0, "w": 6, "h": 4 },
  "parameters": { "min_revenue": "1000" }
}
```

| `layout` field | Type | Range | Description |
|---|---|---|---|
| `x` | int | 0–11 | Column position (grid is 12 columns wide) |
| `y` | int | ≥ 0 | Row position (each row = 80px) |
| `w` | int | 1–12 | Width in grid columns |
| `h` | int | ≥ 1 | Height in grid rows |

> **Grid dimensions**: 12-column grid, row height = 80px. A tile with `w=6, h=4` is 50% wide × 320px tall.

**Response 200** — updated `DashboardResponse` (full dashboard with all charts)

---

### `DELETE /dashboards/{dashboard_id}/charts/{chart_id}`

Remove a chart from a dashboard.

> `{chart_id}` is the **Chart ID** (not the DashboardChart join-table ID).

> Requires `dashboards >= edit`.

**Response 200** — updated `DashboardResponse`

---

### `PUT /dashboards/{dashboard_id}/layout`

Bulk-update chart positions after drag-and-drop. Saves the new layout for all tiles.

> Requires `dashboards >= edit`.

**Request body**
```json
{
  "chart_layouts": [
    {
      "id": 10,
      "layout": { "x": 0, "y": 0, "w": 6, "h": 4 }
    },
    {
      "id": 11,
      "layout": { "x": 6, "y": 0, "w": 6, "h": 4 }
    }
  ]
}
```

> `id` is `DashboardChart.id` (the join-table row ID from `dashboard_charts[].id`), **NOT** the `chart_id`.

**Response 200** — updated `DashboardResponse`

---

## 9. Semantic Layer

A LookML-style semantic layer for AI-driven query generation. Three resource types: **Views** (table mappings), **Models** (groupings), and **Explores** (query contexts with joins).

> **Note**: These endpoints do **not** require authentication — they are internal infrastructure for AI and query engine use.

---

### Semantic Views

A View maps a database table to named dimensions and measures with LookML-style SQL expressions.

#### `GET /semantic/views`

List all views. Query params: `?skip=0&limit=100`

**Response 200** — array of `SemanticView`

#### `POST /semantic/views`

Create a semantic view.

**Request body**
```json
{
  "name": "players_view",
  "sql_table_name": "players_data",
  "description": "FIFA players data",
  "dimensions": [
    {
      "name": "nationality",
      "type": "string",
      "sql": "nationality_name",
      "label": "Nationality",
      "description": null,
      "hidden": false
    }
  ],
  "measures": [
    {
      "name": "total_value",
      "type": "sum",
      "sql": "value_eur",
      "label": "Total Value EUR"
    },
    {
      "name": "player_count",
      "type": "count",
      "label": "Player Count"
    }
  ]
}
```

| Dimension/Measure field | Type | Notes |
|---|---|---|
| `name` | string | Field identifier (used in queries as `view.name`) |
| `type` (dimension) | `string` · `number` · `date` · `datetime` · `yesno` | Column data type |
| `type` (measure) | `count` · `sum` · `avg` · `min` · `max` · `count_distinct` · `percent_of_total` | Aggregation function |
| `sql` | string | SQL expression, can use `${TABLE}.column` syntax |
| `label` | string | Display label |
| `hidden` | bool | Hide from UI, default `false` |

**Response 201** — `SemanticView`
```json
{
  "id": 1,
  "name": "players_view",
  "sql_table_name": "players_data",
  "description": "FIFA players data",
  "dimensions": [ { "name": "nationality", "type": "string", "sql": "nationality_name", "label": "Nationality", "description": null, "hidden": false } ],
  "measures": [ { "name": "total_value", "type": "sum", "sql": "value_eur", "label": "Total Value EUR", "description": null, "hidden": false } ],
  "created_at": "2026-03-22T13:08:37.411940",
  "updated_at": "2026-03-22T13:08:37.411940"
}
```

> Error `400` if a view with the same `name` already exists, or if `sql_table_name` is missing.

#### `GET /semantic/views/{view_id}`

Get a single view by ID. **Response 200** — `SemanticView`. **404** if not found.

#### `PUT /semantic/views/{view_id}`

Update a view. All fields optional. **Response 200** — updated `SemanticView`.

#### `DELETE /semantic/views/{view_id}`

Delete a view. **Response 204** — no body.

---

### Semantic Models

A Model groups multiple Explores under a logical namespace.

#### `GET /semantic/models`

List all models. Query params: `?skip=0&limit=100`

**Response 200** — array of `SemanticModel` (each includes `explores` array)

#### `POST /semantic/models`

Create a model.

**Request body**
```json
{ "name": "football_model", "description": "FIFA football analytics" }
```

**Response 201** — `SemanticModel`
```json
{
  "id": 1,
  "name": "football_model",
  "description": "FIFA football analytics",
  "explores": [],
  "created_at": "...",
  "updated_at": "..."
}
```

> Error `400` if `name` already exists.

#### `GET /semantic/models/{model_id}`

Get model by ID. **Response 200** — `SemanticModel`. **404** if not found.

#### `PUT /semantic/models/{model_id}`

Update model name/description. **Response 200** — updated `SemanticModel`.

#### `DELETE /semantic/models/{model_id}`

Delete model. **Response 204** — no body.

---

### Semantic Explores

An Explore defines a query context: a base view plus optional joins. Queries reference explores by name.

#### `GET /semantic/explores`

List all explores. Query params: `?skip=0&limit=100`

**Response 200** — array of `SemanticExplore`

#### `POST /semantic/explores`

Create an explore.

**Request body**
```json
{
  "name": "players_explore",
  "model_id": 1,
  "base_view_id": 1,
  "base_view_name": "players_view",
  "joins": [
    {
      "name": "clubs",
      "view": "clubs_view",
      "type": "left",
      "sql_on": "${players_view.club_id} = ${clubs_view.id}",
      "relationship": "many_to_one"
    }
  ],
  "default_filters": {},
  "description": "Players explore"
}
```

| `joins[]` field | Type | Notes |
|---|---|---|
| `name` | string | Join alias |
| `view` | string | Name of the view to join |
| `type` | `left` · `inner` · `right` · `full` | Join type, default `left` |
| `sql_on` | string | Join condition with `${view.field}` placeholders |
| `relationship` | `one_to_one` · `one_to_many` · `many_to_one` · `many_to_many` | Optional cardinality |

**Response 201** — `SemanticExplore`
```json
{
  "id": 1,
  "name": "players_explore",
  "model_id": 1,
  "base_view_id": 1,
  "base_view_name": "players_view",
  "joins": [],
  "default_filters": {},
  "description": "Players explore",
  "created_at": "...",
  "updated_at": "..."
}
```

> Errors: `404` if `model_id` or `base_view_id` not found.

#### `GET /semantic/explores/{explore_id}`

Get explore by ID. **Response 200** — `SemanticExplore`.

#### `GET /semantic/explores/by-name/{explore_name}`

Get explore by name (used by AI query engine). **Response 200** — `SemanticExplore`. **404** if not found.

#### `PUT /semantic/explores/{explore_id}`

Update an explore. All fields optional. **Response 200** — updated `SemanticExplore`.

#### `DELETE /semantic/explores/{explore_id}`

Delete an explore. **Response 204** — no body.

---

### Semantic Query Execution

#### `POST /semantic/query`

Execute a semantic query. Generates SQL from semantic definitions and runs it against the configured datasource.

**Request body**
```json
{
  "explore": "players_explore",
  "dimensions": ["players_view.nationality", "players_view.league"],
  "measures": ["players_view.total_value", "players_view.player_count"],
  "filters": {
    "players_view.nationality": { "operator": "eq", "value": "France" }
  },
  "sorts": [
    { "field": "players_view.total_value", "direction": "desc" }
  ],
  "limit": 100,
  "pivots": [],
  "window_functions": [],
  "calculated_fields": [],
  "time_grains": {},
  "top_n": null
}
```

| Field | Type | Notes |
|-------|------|-------|
| `explore` | string | Explore name (required) |
| `dimensions` | string[] | Qualified field names: `"view.field"` |
| `measures` | string[] | Qualified field names: `"view.measure"` |
| `filters` | object | Keys are qualified field names; values are `{ operator, value }` |
| `sorts` | object[] | `{ field, direction: "asc"/"desc" }` |
| `limit` | int | 1–10000, default 500 |
| `pivots` | string[] | Dimensions to pivot (max 1) |
| `window_functions` | object[] | Running totals, ranks — see schema |
| `calculated_fields` | object[] | Ad-hoc SQL expressions — see schema |
| `time_grains` | object | `{ "view.date_dim": "month" }` — truncate dates |
| `top_n` | object | `{ field, n }` — filter to top N by field |

**Filter operators**: `eq` · `ne` · `gt` · `gte` · `lt` · `lte` · `in` · `not_in` · `contains` · `starts_with` · `ends_with`

**Response 200**
```json
{
  "sql": "SELECT nationality_name, COUNT(*) AS player_count FROM players_data GROUP BY nationality_name ORDER BY player_count DESC LIMIT 100",
  "columns": ["nationality_name", "player_count"],
  "data": [
    { "nationality_name": "France", "player_count": 1200 }
  ],
  "row_count": 1,
  "execution_time_ms": 42.5,
  "pivoted_columns": [],
  "warnings": []
}
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Invalid semantic reference or filter |
| 404 | Explore not found, or no datasource available |
| 500 | SQL generation or execution failed |

---

## 10. Common Types

### Column types
`string` · `integer` · `number` (float) · `boolean` · `date` · `datetime` · `unknown`

### UserStatus
`active` · `deactivated`

### Permission levels
`none` · `view` · `edit` · `full`

### ResourceType (for shares)
`dashboard` · `chart` · `workspace` · `datasource` · `chat_session`

### SharePermission
`view` · `edit`

### Aggregation functions (metrics)
`sum` · `avg` · `count` · `count_distinct` · `min` · `max`

### Filter operators
`eq` · `neq` · `gt` · `gte` · `lt` · `lte` · `in` · `not_in` · `contains` · `is_null` · `is_not_null`

---

## Error Responses

| Status | Meaning |
|---|---|
| `400` | Bad request — invalid input |
| `401` | Unauthorized — missing or invalid token |
| `403` | Forbidden — insufficient permission |
| `404` | Not found |
| `409` | Conflict — dependency constraint (e.g. cannot delete datasource used by tables) |
| `422` | Unprocessable — validation error or `NOT_SYNCED` |
| `500` | Internal server error |

Error body format:
```json
{ "detail": "Human-readable error message" }
```

Or for `NOT_SYNCED`:
```json
{ "detail": { "code": "NOT_SYNCED", "message": "Table not synced to DuckDB" } }
```

---

## Full Create Flow (Automation Reference)

```
1. POST /auth/login                                  → get token
2. POST /datasources/                                → create datasource
3. POST /datasources/{id}/sync                       → sync data to DuckDB
4. POST /dataset-workspaces/                         → create workspace
5. POST /dataset-workspaces/{id}/tables              → add table (physical or sql_query)
6. POST /charts/                                     → create chart with roleConfig
7. GET  /charts/{id}/data                            → verify aggregated data
8. POST /dashboards/                                 → create dashboard
9. POST /dashboards/{id}/charts                      → add chart to dashboard
```
