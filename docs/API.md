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

**Request body**
```json
{ "email": "admin@appbi.io", "password": "your-password" }
```

**Response 200**
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
**Error 400** — old password incorrect

---

### `POST /auth/logout`

Invalidate the current session (clears httpOnly cookie).

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

List users that resources can be shared with (excludes current user).

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
    "dashboards": "full",
    "explore_charts": "edit",
    "workspaces": "view",
    "data_sources": "none"
  },
  "module_levels": {
    "dashboards": ["none", "view", "edit", "full"],
    "explore_charts": ["none", "view", "edit", "full"]
  }
}
```

---

### `GET /permissions/presets`

List available permission presets.

**Response 200**
```json
{
  "presets": {
    "admin": { "dashboards": "full", "explore_charts": "full", ... },
    "editor": { "dashboards": "edit", "explore_charts": "edit", ... },
    "viewer": { "dashboards": "view", "explore_charts": "view", ... }
  }
}
```

---

### `GET /permissions/matrix`

Get permissions for all users (admin view).

**Response 200** — `{ modules: string[], module_levels: {...}, users: [...] }`

---

### `PUT /permissions/{user_id}`

Set module permissions for a user.

**Request body**
```json
{
  "permissions": {
    "dashboards": "edit",
    "explore_charts": "view",
    "workspaces": "edit",
    "data_sources": "none",
    "ai_chat": "view",
    "user_management": "none",
    "settings": "none"
  }
}
```

---

### `PUT /permissions/{user_id}/preset`

Apply a preset to a user.

**Request body** — `{ "preset": "editor" }`

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
    "user": { "id": "uuid", "email": "user@co.com", "full_name": "Jane" }
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

---

### `DELETE /shares/{resource_type}/{resource_id}/{user_id}`

Remove a share.

---

### `POST /shares/{resource_type}/{resource_id}/all-team`

Share with all users on the team at once.

**Request body** — `{ "permission": "view" }`

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
    "sync_config": null,
    "owner_id": "uuid",
    "user_permission": "full",
    "created_at": "2026-03-01T00:00:00Z",
    "updated_at": "2026-03-22T00:00:00Z"
  }
]
```

> Credentials are never returned — `config` only contains non-sensitive fields.

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
  "columns": [{"name": "COUNT(*)", "type": "integer"}],
  "rows": [{"COUNT(*)": 42381}],
  "row_count": 1
}
```

---

### `GET /datasources/{data_source_id}/schema`

List all tables/sheets available in the datasource.

**Response 200** — array of `{ name, schema, row_count?, columns? }`

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
    {"name": "order_id", "type": "integer", "nullable": false},
    {"name": "amount", "type": "number", "nullable": true}
  ],
  "rows": [{"order_id": 1, "amount": 99.9}],
  "row_count": 200,
  "total_rows": 37422
}
```

**Error 422** `{ "code": "NOT_SYNCED", "message": "Table not synced to DuckDB" }` — table exists but hasn't been synced yet.

---

### `POST /dataset-workspaces/{workspace_id}/tables/{table_id}/execute`

Execute table query without row limit (returns all rows).

**Response 200** — same shape as preview

---

### `GET /dataset-workspaces/tables/search`

Search tables across all workspaces.

**Query params** — `?q=<search_term>`

---

### `GET /dataset-workspaces/datasources/{datasource_id}/tables`

List physical tables available from a datasource (used by AddTableModal).

---

## 7. Charts

Charts are saved Explore configurations — chart type, data source, field mapping, and filters.

### `GET /charts/`

List all charts (owned + shared).

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

Search charts by name.

**Query params** — `?q=<term>&workspace_table_id=<id>`

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

Delete a chart. Returns `409` if chart is used in dashboards.

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
    "column_mapping": "order_date",
    "default_value": "2026-01-01",
    "description": "Filter start date"
  }
]
```

#### `PUT /charts/{chart_id}/parameters`

Replace all parameters (bulk).

**Request body** — array of `ChartParameterCreate`
```json
[
  {
    "parameter_name": "min_revenue",
    "parameter_type": "measure",
    "column_mapping": "revenue",
    "default_value": "0",
    "description": "Minimum revenue threshold"
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

**Response 200** — array of `DashboardResponse`

---

### `POST /dashboards/`

Create a dashboard.

**Request body**
```json
{
  "name": "Sales Overview",
  "description": "Optional",
  "filters_config": [
    {
      "id": "f1",
      "field": "region",
      "operator": "eq",
      "value": "APAC",
      "label": "Region"
    }
  ]
}
```

`filters_config` — optional pre-set global filters applied to all charts.

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
  "charts": [
    {
      "id": 10,
      "chart_id": 4,
      "dashboard_id": 1,
      "layout": {
        "i": "4",
        "x": 0, "y": 0,
        "w": 6, "h": 4
      },
      "parameters": null,
      "chart": { ... }
    }
  ],
  "created_at": "2026-03-01T00:00:00Z",
  "updated_at": "2026-03-22T00:00:00Z"
}
```

---

### `PUT /dashboards/{dashboard_id}`

Update name, description, or filters_config.

---

### `DELETE /dashboards/{dashboard_id}`

Delete dashboard (charts are NOT deleted, only removed from dashboard).

---

### `POST /dashboards/{dashboard_id}/charts`

Add a chart to a dashboard.

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
| `x` | int | 0–11 | Column position |
| `y` | int | ≥ 0 | Row position |
| `w` | int | 1–12 | Width in grid columns |
| `h` | int | ≥ 1 | Height in grid rows |
| `i` | string | optional | Identifier (auto-set to chart ID string) |

**Response 200** — updated `DashboardResponse`

---

### `DELETE /dashboards/{dashboard_id}/charts/{chart_id}`

Remove a chart from a dashboard.

---

### `PUT /dashboards/{dashboard_id}/layout`

Update chart positions after drag-and-drop.

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

> `id` here is the `DashboardChart.id` (join table), NOT `chart_id`.

**Response 200** — updated `DashboardResponse`

---

## 9. Semantic Views

Semantic views map workspace tables to named business concepts for AI search.

### `GET /semantic/views`

List semantic views.

### `POST /semantic/views`

Create a semantic view.

**Request body**
```json
{
  "name": "Monthly Revenue",
  "sql_table_name": "revenue_monthly",
  "workspace_table_id": 2,
  "columns": [
    {"name": "month", "type": "date", "description": "Month of revenue"},
    {"name": "amount", "type": "number", "description": "Total revenue"}
  ]
}
```

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
