# AppBI — REST API Reference

> **Last updated**: 2026-04-01 — auto-generated from source code review.

## Network Exposure Summary

| Service | Port | Nginx Location | Accessible from Internet | Notes |
|---------|------|----------------|--------------------------|-------|
| **Frontend** (Next.js) | 3000 | `/` | ✅ Public | SSR pages, static assets |
| **Backend** (FastAPI) | 8000 | `/api/v1/` | ✅ Public (via nginx) | REST API — auth-protected except `/public/*` |
| **AI Chat** | 8001 | `/chat/` | ✅ Public (via nginx) | WebSocket + REST — JWT required |
| **AI Agent** | 8002 | `/agent/` | ✅ Public (via nginx) | SSE streams — JWT required |
| **Database** (PostgreSQL) | 5432 | — | ❌ Internal only | Docker network only, no port mapping |

### Internal-Only Endpoints (not exposed through nginx)

| Endpoint | Port | Purpose |
|----------|------|---------|
| `GET /` (backend root) | 8000 | App info — no nginx route |
| `GET /health` (backend) | 8000 | Docker healthcheck only |
| `GET /agent/health` | 8002 | Docker healthcheck only |
| `POST /chat/cleanup` | 8001 | Manual session cleanup — should be admin/internal only |

### Public (No Auth) Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/auth/login` | Login |
| `POST /api/v1/public/dashboards/{token}/auth` | Authenticate password-protected public link |
| `GET  /api/v1/public/dashboards/{token}` | View shared dashboard (rate-limited) |
| `GET  /api/v1/public/dashboards/{token}/charts/{chart_id}/data` | Chart data for shared dashboard (rate-limited) |

All other endpoints require `Authorization: Bearer <token>` or `access_token` httpOnly cookie.

---

## Base URLs

| Service | Base URL | Interactive Docs |
|---------|----------|------------------|
| Backend API | `http://localhost:8000/api/v1` | `http://localhost:8000/docs` |
| AI Chat | `http://localhost:8001` | — |
| AI Agent | `http://localhost:8002` | — |

All request/response bodies are **JSON** unless stated otherwise. Protected endpoints require a JWT token via `Authorization: Bearer <token>` header or `access_token` httpOnly cookie (set by `/auth/login`).

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
9. [Public Links](#9-public-links)
10. [Semantic Layer](#10-semantic-layer)
11. [Anomaly Detection](#11-anomaly-detection)
12. [AI Feedback](#12-ai-feedback)
13. [Chat Sessions](#13-chat-sessions)
14. [Agent Report Specs](#14-agent-report-specs)
15. [AI Chat Service](#15-ai-chat-service)
16. [AI Agent Service](#16-ai-agent-service)
17. [Common Types](#17-common-types)

---

## 1. Auth

Prefix: `/auth`

### `POST /auth/login`

Login and receive a JWT token pair (access + refresh).

> Rate-limited: **5 requests/minute** per IP.
> 🌐 **Public** — no auth required.

**Request body**
```json
{ "email": "admin@appbi.io", "password": "your-password" }
```

**Response 200** — sets `Set-Cookie: access_token` (httpOnly, 1 hour) + `Set-Cookie: refresh_token` (httpOnly, 7 days, path `/api/v1/auth/refresh`)
```json
{
  "access_token": "eyJhbGci...",
  "token_type": "bearer",
  "user": {
    "id": "uuid",
    "email": "admin@appbi.io",
    "full_name": "Admin",
    "status": "active",
    "preferred_language": "vi",
    "permissions": {
      "data_sources": "full",
      "datasets": "full",
      "workspaces": "full",
      "explore_charts": "full",
      "dashboards": "full",
      "ai_chat": "edit",
      "ai_agent": "edit",
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

**Response 200** — `UserResponse`

---

### `POST /auth/change-password`

Change current user's password.

> Rate-limited: **3 requests/minute** per IP.

**Request body**
```json
{ "old_password": "current", "new_password": "newpassword123" }
```

**Response 200** — `{ "message": "Password changed successfully" }`

---

### `PATCH /auth/preferences`

Update current user's UI preferences (e.g. language).

**Request body**
```json
{ "preferred_language": "vi" }
```

**Response 200** — `UserResponse`

---

### `POST /auth/logout`

Invalidate the current session. Revokes the access token server-side and clears both cookies.

**Response 200** — `{ "message": "Logged out" }`

---

### `POST /auth/refresh`

Exchange a valid refresh token for a new access + refresh token pair (token rotation).

> Rate-limited: **10 requests/minute** per IP.
> Refresh token is read from the `refresh_token` httpOnly cookie (path-scoped to `/api/v1/auth/refresh`).
> Each refresh token can only be used once — reuse is treated as potential token theft.

**Response 200** — `TokenResponse` (same as login)

---

## 2. Users

Prefix: `/users`
> Requires module permission `settings >= view`. Write operations require `settings = full`.

### `GET /users/`

List all users. Query params: `?skip=0&limit=100`

**Response 200** — array of `UserResponse`

---

### `GET /users/shareable`

List active users available for sharing dialogs (id, email, full_name only).

---

### `POST /users/`

Create a user (admin only, requires `settings = full`).

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

Get a single user. Requires `settings = full`.

---

### `PUT /users/{user_id}`

Update user name or status. Requires `settings = full`. Admin cannot deactivate themselves.

**Request body** (all optional)
```json
{ "full_name": "Jane Smith", "status": "active" }
```

---

### `DELETE /users/{user_id}`

Soft-delete (deactivate) a user. Cannot deactivate yourself.

---

## 3. Permissions

Prefix: `/permissions`

Module-level access control. Each user has a permission level per module.

| Module key | Controls |
|---|---|
| `data_sources` | DataSource connections |
| `datasets` | Semantic layer resources |
| `workspaces` | Dataset workspaces |
| `explore_charts` | Chart/explore builder |
| `dashboards` | Dashboard list, create, edit, delete |
| `ai_chat` | AI chat assistant |
| `ai_agent` | AI dashboard/report builder |
| `settings` | System settings & user management |

Permission levels: `none` → `view` → `edit` → `full`

---

### `GET /permissions/me`

Get current user's module permissions with allowed levels per module.

**Response 200**
```json
{
  "permissions": {
    "data_sources": "full",
    "datasets": "none",
    "workspaces": "full",
    "explore_charts": "full",
    "dashboards": "full",
    "ai_chat": "edit",
    "ai_agent": "edit",
    "settings": "full"
  },
  "module_levels": {
    "data_sources":    ["none", "view", "edit", "full"],
    "datasets":        ["none", "view", "edit", "full"],
    "workspaces":      ["none", "view", "edit", "full"],
    "explore_charts":  ["none", "view", "edit", "full"],
    "dashboards":      ["none", "view", "edit", "full"],
    "ai_chat":         ["none", "view", "edit", "full"],
    "ai_agent":        ["none", "view", "edit", "full"],
    "settings":        ["none", "full"]
  }
}
```

---

### `GET /permissions/presets`

List available permission presets. Requires `settings = full`.

**Response 200**
```json
{
  "presets": {
    "admin":   { "data_sources": "full", "datasets": "full", ... },
    "editor":  { "data_sources": "view", "datasets": "edit", ... },
    "viewer":  { "data_sources": "view", "datasets": "view", ... },
    "minimal": { "data_sources": "none", "datasets": "none", ... }
  }
}
```

---

### `GET /permissions/matrix`

Get full permission matrix for all active users. Requires `settings = full`.

**Response 200**
```json
{
  "modules": ["data_sources", "datasets", "workspaces", ...],
  "module_levels": { ... },
  "users": [
    { "user_id": "uuid", "email": "user@co.com", "full_name": "Name", "permissions": { ... } }
  ]
}
```

---

### `PUT /permissions/{user_id}`

Set module permissions for a user. Only include modules to change. Requires `settings = full`.

**Request body**
```json
{ "permissions": { "dashboards": "edit", "ai_chat": "view" } }
```

**Response 200** — `{ "status": "ok", "updated": 2, "permissions": { ... } }`

---

### `PUT /permissions/{user_id}/preset`

Apply a permission preset to a user. Requires `settings = full`.

**Request body** — `{ "preset": "editor" }`

**Response 200** — `{ "status": "ok", "preset": "editor", "permissions": { ... } }`

---

## 4. Shares

Prefix: `/shares`

Resource-level sharing between users, with cascade support for dashboards.

`resource_type` values: `dashboard` · `chart` · `workspace` · `datasource` · `chat_session`
`permission` values: `view` · `edit`

---

### `GET /shares/{resource_type}/{resource_id}`

List all shares for a resource. Only owner or admin can list.

---

### `POST /shares/{resource_type}/{resource_id}`

Share a resource with a user. Dashboards trigger cascade-share (charts → workspaces).

**Request body**
```json
{ "user_id": "uuid", "permission": "view" }
```

**Response 201** — `ShareResponse`

---

### `PUT /shares/{resource_type}/{resource_id}/{user_id}`

Update share permission on an existing share.

**Request body** — `{ "permission": "edit" }`

---

### `DELETE /shares/{resource_type}/{resource_id}/{user_id}`

Revoke a share. For dashboards, also revokes cascaded chart/workspace shares.

**Response 204**

---

### `POST /shares/{resource_type}/{resource_id}/all-team`

Share with all active users at once.

**Request body** — `{ "permission": "view" }`

**Response 204**

---

## 5. Data Sources

Prefix: `/datasources`

Connections to external databases/files. Credentials are encrypted at rest.

### `GET /datasources/platform-gcp-info`

Returns platform-level GCP service account info (email, project IDs available for BigQuery). Used by frontend to show "grant access" instructions.

**Response 200**
```json
{
  "service_account_email": "appbi@project.iam.gserviceaccount.com",
  "available": true
}
```

---

### `GET /datasources/`

List all datasources (owned + shared). Query params: `?skip=0&limit=100`

> Credential fields (`password`, `credentials_json`) are returned as `"__stored__"`.

---

### `POST /datasources/`

Create a datasource. Requires `data_sources >= edit`.

**`type` and required `config` fields:**

| `type` | Required `config` fields |
|---|---|
| `postgresql` | `host`, `port`, `database`, `username`, `password`, `schema` (optional) |
| `mysql` | `host`, `port`, `database`, `username`, `password` |
| `bigquery` | `project_id`, `credentials_json`, `default_dataset` (optional) |
| `google_sheets` | `credentials_json`, `spreadsheet_id`, `sheet_name` (optional) |
| `manual` | *(no config — upload file via `/manual/parse-file` first)* |

**Response 201** — `DataSourceResponse`

---

### `GET /datasources/{data_source_id}`

Get a single datasource. Requires `data_sources >= view`.

---

### `PUT /datasources/{data_source_id}`

Update name, description, or config. Requires `data_sources >= edit`.

---

### `DELETE /datasources/{data_source_id}`

Delete a datasource. Returns `409` if workspace tables depend on it. Requires `data_sources = full`.

---

### `POST /datasources/test`

Test a connection without saving. Requires `data_sources >= view`.

**Request body** — same as create (name + type + config)

**Response 200** — `{ "success": true, "message": "Connection successful" }`

---

### `POST /datasources/query`

Execute an ad-hoc SQL query against a datasource.

> Rate-limited: **20 requests/minute** per IP.

**Request body**
```json
{
  "data_source_id": 1,
  "sql_query": "SELECT COUNT(*) FROM orders",
  "limit": 100,
  "timeout_seconds": 30
}
```

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

List all tables/views available in the datasource with row count estimates. Requires `data_sources >= view`.

---

### `GET /datasources/{data_source_id}/tables/{schema_name}/{table_name}`

Get column metadata + optional preview rows for a specific table. Query param: `?preview_rows=5`. Requires `data_sources >= view`.

---

### `GET /datasources/{data_source_id}/tables/{schema_name}/{table_name}/watermarks`

List columns usable as watermark for incremental sync. Requires `data_sources >= view`.

---

### `GET /datasources/{data_source_id}/sync-config`

Get the sync schedule configuration. Requires `data_sources >= view`.

---

### `PUT /datasources/{data_source_id}/sync-config`

Update sync schedule. Requires `data_sources >= edit`.

**Request body**
```json
{ "schedule": "hourly", "enabled": true, "tables": ["orders", "customers"] }
```

---

### `GET /datasources/{data_source_id}/sync-jobs`

List sync job history. Query param: `?limit=10`. Requires `data_sources >= view`.

---

### `POST /datasources/{data_source_id}/sync`

Trigger a manual sync (async). Requires `data_sources >= edit`.

**Response 202** — `{ "job_id": 1, "status": "running", "message": "Sync started" }`

---

### `POST /datasources/manual/parse-file`

Upload a CSV or Excel file for a `manual` datasource. Requires `data_sources >= edit`.

**Request** — `multipart/form-data`, field name: `file`. Accepted: `.csv`, `.xlsx`, `.xls` (max 50 MB)

**Response 200**
```json
{
  "sheets": [
    {
      "name": "Sheet1",
      "rows": [{"col1": "val"}],
      "columns": [{"name": "col1", "type": "string"}]
    }
  ],
  "total_rows": 82
}
```

---

## 6. Dataset Workspaces

Prefix: `/dataset-workspaces`

Workspaces group multiple tables from different datasources into a single virtual schema. Charts are built on workspace tables.

### `GET /dataset-workspaces/`

List all workspaces (owned + shared). Query params: `?skip=0&limit=100`

---

### `POST /dataset-workspaces/`

Create a workspace. Requires `workspaces >= edit`.

**Request body** — `{ "name": "My Workspace", "description": "Optional" }`

**Response 201** — `WorkspaceResponse`

---

### `GET /dataset-workspaces/{workspace_id}`

Get workspace with all its tables. Requires `workspaces >= view`.

---

### `PUT /dataset-workspaces/{workspace_id}`

Update workspace name or description. Requires `workspaces >= edit`.

---

### `DELETE /dataset-workspaces/{workspace_id}`

Delete workspace and all its tables. Blocked if tables are used by charts. Requires `workspaces = full`.

---

### `GET /dataset-workspaces/{workspace_id}/tables`

List tables for a workspace. Requires `workspaces >= view`.

---

### `POST /dataset-workspaces/{workspace_id}/tables`

Add a table to a workspace. Requires `workspaces >= edit`.

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

For `source_kind: "sql_query"`, use `source_query` instead of `source_table_name`.

**Transformation steps (`transformations` array)**

| `type` | `params` | Description |
|---|---|---|
| `add_column` | `newField`, `expression` | Add computed column via SQL expression |
| `select_columns` | `columns[]` | Keep only specified columns |
| `rename_columns` | `mapping {old: new}` | Rename columns |
| `js_formula` | `newField`, `formula` or `code` | Client-side Excel formula |

**Response 201** — `TableResponse`

---

### `PUT /dataset-workspaces/{workspace_id}/tables/{table_id}`

Update a workspace table. Requires `workspaces >= edit`.

---

### `DELETE /dataset-workspaces/{workspace_id}/tables/{table_id}`

Remove a table. Returns `409` if charts depend on it. Requires `workspaces >= edit`.

---

### `POST /dataset-workspaces/{workspace_id}/tables/{table_id}/preview`

Preview table data (DuckDB if synced, otherwise live source). Requires `workspaces >= view`.

**Request body** — `{ "limit": 200, "offset": 0 }`

**Response 200**
```json
{
  "columns": [{"name": "order_id", "type": "string", "nullable": true}],
  "rows": [{"order_id": "abc"}],
  "total": 37422,
  "has_more": true
}
```

---

### `POST /dataset-workspaces/{workspace_id}/tables/{table_id}/execute`

Execute a structured aggregation query against the table. Requires `workspaces >= view`.

**Request body**
```json
{
  "dimensions": ["project_id", "status"],
  "measures": [
    {"field": "revenue", "function": "sum", "alias": "total_revenue"}
  ],
  "filters": [{"field": "status", "operator": "=", "value": "active"}],
  "order_by": [],
  "limit": 1000
}
```

Supported aggregate functions: `sum`, `count`, `avg`, `min`, `max`, `count_distinct`.

Filter operators (SQL): `=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `IN`.

---

### `GET /dataset-workspaces/{workspace_id}/tables/{table_id}/description`

Get AI-generated description and knowledge fields for a table. Requires `workspaces >= view`.

**Response 200**
```json
{
  "auto_description": "This table contains order records...",
  "user_description": null,
  "query_aliases": ["orders", "sales"],
  "knowledge_summary": "Key columns: order_id, amount, status",
  "source": "ai"
}
```

---

### `PUT /dataset-workspaces/{workspace_id}/tables/{table_id}/description`

Update description fields manually (sets `source='user'`, triggers re-embedding). Requires `workspaces >= edit`.

**Request body** (all optional)
```json
{
  "user_description": "Custom description...",
  "query_aliases": ["my_orders"],
  "knowledge_summary": "Key metrics: revenue, count"
}
```

---

### `POST /dataset-workspaces/{workspace_id}/tables/{table_id}/description/regenerate`

Force-regenerate AI description. Requires `workspaces >= edit`.

---

### `GET /dataset-workspaces/tables/search`

Search tables across all workspaces by vector similarity.

**Query params** — `?q=<search_term>&limit=10` (max 20)

**Response 200**
```json
[
  {
    "id": 2,
    "workspace_id": 1,
    "display_name": "Orders",
    "auto_description": "...",
    "columns": [...],
    "similarity": 0.87
  }
]
```

---

### `GET /dataset-workspaces/datasources/{datasource_id}/tables`

List physical tables available from a datasource. Query param: `?search=<term>`. Requires `data_sources >= view`.

---

### `GET /dataset-workspaces/datasources/{datasource_id}/tables/columns`

Get column metadata for a specific table in a datasource.

**Query param** — `?table=<table_name>` (required)

**Response 200** — `{ "columns": [{"name": "key", "type": "VARCHAR"}] }`

---

## 7. Charts

Prefix: `/charts`

Charts are saved Explore configurations — chart type, data source, field mapping, and filters.

### `GET /charts/`

List all charts (owned + shared). Query params: `?skip=0&limit=50`

---

### `GET /charts/search`

Vector similarity search for charts.

**Query params** — `?q=<term>&limit=10` (max 20)

---

### `POST /charts/ai-preview`

Execute a chart from an AI-generated config and optionally save it. Used by AI chat/agent.

> Requires `ai_chat >= view`.

**Request body**
```json
{
  "workspace_table_id": 2,
  "chart_type": "BAR",
  "config": {
    "dimensions": ["region"],
    "metrics": [{"column": "revenue", "aggregation": "sum"}],
    "limit": 500
  },
  "name": "Revenue by Region",
  "save": false
}
```

**Response 200** — `{ "chart_type": "BAR", "data": [...], "saved": false, "chart_id": null }`

---

### `POST /charts/`

Create a chart. Requires `explore_charts >= edit`.

**`chart_type` values**: `BAR` · `LINE` · `AREA` · `PIE` · `SCATTER` · `GROUPED_BAR` · `STACKED_BAR` · `TABLE` · `KPI` · `TIME_SERIES` · `COMBO`

**Request body**
```json
{
  "name": "Revenue by Region",
  "chart_type": "BAR",
  "workspace_table_id": 2,
  "config": {
    "workspace_id": 1,
    "chartType": "BAR",
    "roleConfig": {
      "dimension": "region",
      "metrics": [{"field": "revenue", "agg": "sum"}],
      "breakdown": null,
      "timeField": null
    },
    "filters": []
  }
}
```

> **⚠️** Always include all 4 fields in `config`: `workspace_id`, `chartType`, `roleConfig`, `filters`. Missing `workspace_id` or `chartType` breaks the Explore UI.

**Response 201** — `ChartResponse`

---

### `GET /charts/{chart_id}`

Get a single chart. Requires `explore_charts >= view`.

---

### `PUT /charts/{chart_id}`

Update chart. Requires `explore_charts >= edit`.

---

### `DELETE /charts/{chart_id}`

Delete a chart. Returns `409` if used by dashboards. Requires `explore_charts = full`.

---

### `GET /charts/{chart_id}/data`

Execute the chart query and return aggregated data. Auth required.

**Response 200**
```json
{
  "chart": { ... },
  "data": [{"project_id": "base-datateam", "sum__revenue": 16099}],
  "pre_aggregated": true
}
```

Aggregated column naming: `{agg}__{field}` (e.g. `sum__revenue`, `count__orders`).

---

### Chart Description (AI-generated)

#### `GET /charts/{chart_id}/description`

Get AI-generated description and knowledge fields.

#### `PUT /charts/{chart_id}/description`

Update description fields manually (sets `source='user'`, re-embeds). Requires `explore_charts >= edit`.

#### `POST /charts/{chart_id}/description/regenerate`

Force-regenerate AI description. Requires `explore_charts >= edit`.

---

### Chart Metadata (Semantic)

#### `PUT /charts/{chart_id}/metadata`

Create/replace semantic metadata. Requires `explore_charts >= edit`.

```json
{
  "domain": "sales",
  "intent": "comparison",
  "metrics": ["Revenue"],
  "dimensions": ["Region"],
  "tags": ["revenue", "quarterly"]
}
```

#### `GET /charts/{chart_id}/metadata`

Get chart metadata.

#### `DELETE /charts/{chart_id}/metadata`

Delete chart metadata. Requires `explore_charts >= edit`.

---

### Chart Parameters

Parameters enable dynamic filtering when a chart is placed in a dashboard.

#### `GET /charts/{chart_id}/parameters`

List parameters. Requires `explore_charts >= view`.

#### `PUT /charts/{chart_id}/parameters`

Replace all parameters (bulk). Requires `explore_charts >= edit`.

#### `POST /charts/{chart_id}/parameters`

Add a single parameter. Requires `explore_charts >= edit`.

#### `PUT /charts/{chart_id}/parameters/{param_id}`

Update a parameter. Requires `explore_charts >= edit`.

#### `DELETE /charts/{chart_id}/parameters/{param_id}`

Delete a parameter. Requires `explore_charts >= edit`.

---

## 8. Dashboards

Prefix: `/dashboards`

Dashboards compose multiple charts in a 12-column drag-and-drop grid layout.

### `GET /dashboards/`

List all dashboards (owned + shared). Query params: `?skip=0&limit=50`

---

### `POST /dashboards/`

Create a dashboard. Requires `dashboards >= edit`.

**Request body**
```json
{
  "name": "Sales Overview",
  "description": "Optional",
  "filters_config": [],
  "charts": [{"chart_id": 4, "layout": {"x": 0, "y": 0, "w": 6, "h": 4}}]
}
```

**Response 201** — `DashboardResponse`

---

### `GET /dashboards/{dashboard_id}`

Get dashboard with all chart tiles, layout, and filter config. Requires `dashboards >= view`.

---

### `PUT /dashboards/{dashboard_id}`

Update name, description, or filters_config. Requires `dashboards >= edit`.

---

### `DELETE /dashboards/{dashboard_id}`

Delete dashboard (charts are NOT deleted, only unlinked). Requires `dashboards = full`.

---

### `POST /dashboards/{dashboard_id}/charts`

Add a chart to a dashboard. Requires `dashboards >= edit`.

**Request body**
```json
{
  "chart_id": 4,
  "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
  "parameters": {"min_revenue": "1000"}
}
```

**Response 200** — updated `DashboardResponse`

---

### `DELETE /dashboards/{dashboard_id}/charts/{chart_id}`

Remove a chart from a dashboard. Requires `dashboards >= edit`.

---

### `PUT /dashboards/{dashboard_id}/layout`

Bulk-update chart positions after drag-and-drop. Requires `dashboards >= edit`.

**Request body**
```json
{
  "chart_layouts": [
    {"id": 10, "layout": {"x": 0, "y": 0, "w": 6, "h": 4}},
    {"id": 11, "layout": {"x": 6, "y": 0, "w": 6, "h": 4}}
  ]
}
```

> `id` is `DashboardChart.id` (join-table row), **NOT** `chart_id`.

---

### `POST /dashboards/{dashboard_id}/share`

Generate (or return existing) legacy public share token. Requires `dashboards >= edit`.

---

### `DELETE /dashboards/{dashboard_id}/share`

Revoke legacy public share token. Requires `dashboards >= edit`.

---

### Public Links (Multi-link System)

#### `GET /dashboards/{dashboard_id}/public-links`

List all public links for a dashboard. Requires `dashboards >= view`.

#### `POST /dashboards/{dashboard_id}/public-links`

Create a new named public link with optional password, expiry, max access count, and filter config. Requires `dashboards >= edit`.

**Response 201**

#### `PATCH /dashboards/{dashboard_id}/public-links/{link_id}`

Update name, filters, active state, or password of a public link. Requires `dashboards >= edit`.

#### `DELETE /dashboards/{dashboard_id}/public-links/{link_id}`

Delete a public link permanently. Requires `dashboards >= edit`.

---

## 9. Public Links

Prefix: `/public`

Unauthenticated endpoints for viewing shared dashboards via token-based links.

> 🌐 **No auth required** — accessible to anyone with a valid link token.
> Rate-limited: **30 req/min** for data, **10 req/min** for auth.

### `POST /public/dashboards/{token}/auth`

Authenticate a password-protected public link. Returns a short-lived session token (JWT, 2 hours).

**Request body** — `{ "password": "secret" }`

**Response 200** — `{ "session_token": "eyJ...", "expires_in": 7200 }`

> Send the session token as `X-Public-Session` header on subsequent requests.

---

### `GET /public/dashboards/{token}`

Return dashboard structure for a public shared link. Password-protected links require `X-Public-Session` header.

**Response 200** — `DashboardResponse` (with `user_permission: "view"`)

**Error 401** — password required (header `X-Link-Password-Required: true`)
**Error 410** — link expired or access limit reached

---

### `GET /public/dashboards/{token}/charts/{chart_id}/data`

Return chart data for a public shared link. Validates that `chart_id` belongs to the shared dashboard. Link-level filters are applied server-side.

---

## 10. Semantic Layer

Prefix: `/semantic`

A LookML-style semantic layer for AI-driven query generation. Three resource types: **Views**, **Models**, and **Explores**.

> Requires `datasets` module permission.

### Semantic Views

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/semantic/views` | `datasets >= view` | List all views |
| `POST` | `/semantic/views` | `datasets >= edit` | Create a view |
| `GET` | `/semantic/views/{view_id}` | `datasets >= view` | Get view by ID |
| `PUT` | `/semantic/views/{view_id}` | `datasets >= edit` | Update a view |
| `DELETE` | `/semantic/views/{view_id}` | `datasets = full` | Delete a view |

### Semantic Models

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/semantic/models` | `datasets >= view` | List all models |
| `POST` | `/semantic/models` | `datasets >= edit` | Create a model |
| `GET` | `/semantic/models/{model_id}` | `datasets >= view` | Get model by ID |
| `PUT` | `/semantic/models/{model_id}` | `datasets >= edit` | Update a model |
| `DELETE` | `/semantic/models/{model_id}` | `datasets = full` | Delete a model |

### Semantic Explores

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/semantic/explores` | `datasets >= view` | List all explores |
| `POST` | `/semantic/explores` | `datasets >= edit` | Create an explore |
| `GET` | `/semantic/explores/{explore_id}` | `datasets >= view` | Get explore by ID |
| `GET` | `/semantic/explores/by-name/{name}` | `datasets >= view` | Get explore by name |
| `PUT` | `/semantic/explores/{explore_id}` | `datasets >= edit` | Update an explore |
| `DELETE` | `/semantic/explores/{explore_id}` | `datasets = full` | Delete an explore |

### Semantic Query

#### `POST /semantic/query`

Execute a semantic query (generates SQL from semantic definitions and runs it).

**Request body**
```json
{
  "explore": "players_explore",
  "dimensions": ["players_view.nationality"],
  "measures": ["players_view.total_value"],
  "filters": {"players_view.nationality": {"operator": "eq", "value": "France"}},
  "sorts": [{"field": "players_view.total_value", "direction": "desc"}],
  "limit": 100
}
```

**Response 200**
```json
{
  "sql": "SELECT ... FROM ... GROUP BY ...",
  "columns": ["nationality_name", "total_value"],
  "data": [...],
  "row_count": 1,
  "execution_time_ms": 42.5
}
```

---

## 11. Anomaly Detection

Prefix: `/anomaly`

Proactive intelligence — monitored metrics and anomaly alerts.

### Monitored Metrics

#### `GET /anomaly/metrics`

List all monitored metrics owned by the current user.

#### `POST /anomaly/metrics`

Create a new monitored metric. Requires `ai_chat >= edit`.

**Request body**
```json
{
  "workspace_table_id": 2,
  "metric_column": "revenue",
  "aggregation": "sum",
  "time_column": "order_date",
  "dimension_columns": ["region"],
  "check_frequency": "daily",
  "threshold_z_score": 2.0
}
```

**Response 201** — `MonitoredMetricResponse`

#### `PATCH /anomaly/metrics/{metric_id}/toggle`

Toggle active/inactive for a monitored metric.

#### `DELETE /anomaly/metrics/{metric_id}`

Delete a monitored metric and all its alerts.

### Anomaly Alerts

#### `GET /anomaly/alerts`

List anomaly alerts for the current user's metrics.

**Query params** — `?unread_only=false&limit=50` (max 200)

**Response 200** — array of `AnomalyAlertResponse`
```json
[
  {
    "id": 1,
    "monitored_metric_id": 5,
    "detected_at": "2026-03-22T08:00:00Z",
    "current_value": 15000,
    "expected_value": 10000,
    "z_score": 3.2,
    "change_pct": 50.0,
    "dimension_values": {"region": "Asia"},
    "severity": "high",
    "is_read": false,
    "explanation": "Revenue spike detected...",
    "metric_column": "revenue",
    "table_name": "Orders"
  }
]
```

#### `PATCH /anomaly/alerts/{alert_id}/read`

Mark an alert as read.

#### `DELETE /anomaly/alerts/{alert_id}`

Delete an alert.

#### `POST /anomaly/scan`

Manually trigger an anomaly scan for all active metrics. Results are stored as alerts.

---

## 12. AI Feedback

Prefix: `/ai`

Feedback-driven knowledge system — captures AI correction feedback.

### `POST /ai/feedback`

Submit AI correction feedback. Triggers background knowledge update.

**Request body**
```json
{
  "session_id": "uuid-string",
  "message_id": "uuid-string",
  "user_query": "show me revenue",
  "feedback_type": "wrong_table",
  "correct_resource_type": "workspace_table",
  "correct_resource_id": 5,
  "ai_matched_resource_type": "workspace_table",
  "ai_matched_resource_id": 3,
  "notes": "Should have used the sales table",
  "is_positive": false
}
```

`feedback_type` values: `wrong_table` · `wrong_chart` · `unclear` · `other`

**Response 200** — `{ "status": "ok", "feedback_id": "uuid" }`

---

### `GET /ai/feedback/stats`

Get feedback statistics. Requires `settings = full`.

**Query params** — `?month=2026-03` (optional, omit for all-time)

**Response 200**
```json
{
  "total": 42,
  "positive_count": 30,
  "negative_count": 12,
  "top_corrected_tables": [{"resource_id": 5, "count": 8}],
  "top_corrected_charts": [{"resource_id": 3, "count": 4}]
}
```

---

## 13. Chat Sessions

Prefix: `/chat-sessions`

Persistent storage for AI chat history. Used by both the frontend and the AI chat service.

### `GET /chat-sessions`

List all sessions owned by (or shared with) the current user, newest first.

**Response 200**
```json
[
  {
    "session_id": "abc-123",
    "title": "Revenue Analysis",
    "created_at": "2026-03-22T10:00:00Z",
    "last_active": "2026-03-22T11:30:00Z",
    "message_count": 12,
    "is_owner": true
  }
]
```

---

### `POST /chat-sessions`

Create or update a session (upsert by `session_id`).

**Request body**
```json
{
  "session_id": "abc-123",
  "title": "Revenue Analysis",
  "owner_user_id": "uuid"
}
```

**Response 201** — `{ "session_id": "abc-123", "created": true }`

---

### `GET /chat-sessions/{session_id}`

Get session detail with full message history. Owner or shared users.

---

### `DELETE /chat-sessions/{session_id}`

Delete a session and all messages. Owner only.

**Response 204**

---

### `POST /chat-sessions/{session_id}/messages`

Append a batch of messages to a session (called by AI service after each turn).

**Request body**
```json
{
  "messages": [
    {"role": "user", "content": "Show me revenue"},
    {"role": "assistant", "content": "Here's the chart...", "message_id": "msg-1", "charts": [...]}
  ]
}
```

**Response 201** — `{ "appended": 2 }`

---

### `PUT /chat-sessions/{session_id}/messages/{message_id}/feedback`

Update thumbs up/down feedback on an AI message. Owner only.

**Request body** — `{ "rating": "up", "comment": "Great answer" }`

---

## 14. Agent Report Specs

Prefix: `/agent-report-specs`

Persisted AI Agent report specification and run history.

### `GET /agent-report-specs/`

List all report specs owned by current user. Requires `ai_agent >= view`.

---

### `POST /agent-report-specs/`

Create a new report spec. Requires `ai_agent >= edit`.

**Request body**
```json
{
  "name": "Q1 Sales Report",
  "description": "Quarterly analysis",
  "status": "draft",
  "current_step": "select_tables",
  "selected_tables_snapshot": [...],
  "brief_json": {...},
  "approved_plan_json": {...}
}
```

**Response 201** — `AgentReportSpecResponse`

---

### `GET /agent-report-specs/{spec_id}`

Get report spec with all runs. Requires `ai_agent >= view`.

---

### `PUT /agent-report-specs/{spec_id}`

Update a report spec. Requires `ai_agent >= edit`.

---

### `DELETE /agent-report-specs/{spec_id}`

Delete a report spec and all its runs. Requires `ai_agent >= edit`.

**Response 204**

---

### Run History

#### `GET /agent-report-specs/{spec_id}/runs`

List all runs for a spec. Requires `ai_agent >= view`.

#### `POST /agent-report-specs/{spec_id}/runs`

Create a new run (starts a build). Requires `ai_agent >= edit`.

**Request body**
```json
{
  "build_mode": "full",
  "status": "queued",
  "input_brief_json": {...},
  "plan_json": {...},
  "target_dashboard_id": null
}
```

**Response 201** — `AgentReportRunResponse`

#### `PATCH /agent-report-specs/{spec_id}/runs/{run_id}`

Update run status/results (called by agent service during build). Requires `ai_agent >= edit`.

Run status values: `queued` · `parsing_brief` · `selecting_datasets` · `profiling_data` · `quality_gate` · `planning_analysis` · `planning_charts` · `planning` · `building` · `building_dashboard` · `generating_insights` · `composing_report` · `succeeded` · `failed`

---

## 15. AI Chat Service

Base URL: `http://localhost:8001` — Nginx path: `/chat/`

Reactive conversational AI with streaming tool-calling. Requires JWT auth.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `WS` | `/chat/ws?token=<jwt>` | JWT query param | Streaming AI chat (WebSocket) |
| `POST` | `/chat/stream` | Bearer JWT | REST streaming fallback (NDJSON) |
| `GET` | `/chat/sessions` | Bearer JWT | List sessions (from backend DB) |
| `POST` | `/chat/sessions` | Bearer JWT | Create empty session |
| `GET` | `/chat/sessions/{session_id}` | Bearer JWT | Get session + messages |
| `DELETE` | `/chat/sessions/{session_id}` | Bearer JWT | Delete session |
| `POST` | `/chat/sessions/{sid}/messages/{mid}/feedback` | Bearer JWT | Submit message feedback |
| `POST` | `/chat/cleanup` | Bearer JWT | Trigger expired session cleanup ⚠️ |

> ⚠️ `/chat/cleanup` - consider restricting to internal/admin access only.

### WebSocket Protocol

Connect to `ws://HOST/chat/ws?token=<jwt>`. Messages are JSON:

**Client → Server**:
```json
{
  "type": "message",
  "session_id": "abc-123",
  "content": "Show me revenue by region",
  "chart_context": null
}
```

**Server → Client**: Streaming chunks with `type` field:
- `thinking` — AI is processing
- `text` — Text content chunk
- `tool_call` — Tool invocation (create_chart, query_data, etc.)
- `tool_result` — Tool execution result
- `chart` — Chart data ready for rendering
- `done` — Stream complete

---

## 16. AI Agent Service

Base URL: `http://localhost:8002` — Nginx path: `/agent/`

Proactive dashboard builder with plan → build flow. Requires JWT with permissions: `ai_agent >= edit`, `dashboards >= edit`, `explore_charts >= edit`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/agent/health` | None | Health check (internal only) |
| `POST` | `/agent/plan` | Bearer JWT + perms | Generate dashboard plan (JSON response) |
| `POST` | `/agent/plan/stream` | Bearer JWT + perms | Stream dashboard plan as NDJSON |
| `POST` | `/agent/build/stream` | Bearer JWT + perms | Stream dashboard build execution as NDJSON |

### Plan Request

```json
{
  "tables": [
    {
      "workspace_table_id": 2,
      "workspace_id": 1,
      "display_name": "Orders",
      "columns": [{"name": "revenue", "type": "number"}]
    }
  ],
  "brief": "Analyze Q1 sales performance by region",
  "language": "vi"
}
```

### Build Stream

The build stream emits NDJSON events as the agent creates charts and assembles the dashboard:

```
{"event":"status","phase":"parsing_brief","message":"Parsing brief..."}
{"event":"status","phase":"profiling_data","message":"Profiling data..."}
{"event":"status","phase":"planning_charts","message":"Planning charts..."}
{"event":"chart_created","chart_id":7,"section":"Revenue Overview"}
{"event":"dashboard_ready","dashboard_id":3}
{"event":"done","dashboard_id":3,"report":{...}}
```

---

## 17. Common Types

### Column types
`string` · `integer` · `number` (float) · `boolean` · `date` · `datetime` · `unknown`

### UserStatus
`active` · `deactivated`

### Permission levels
`none` → `view` → `edit` → `full`

### ResourceType (for shares)
`dashboard` · `chart` · `workspace` · `datasource` · `chat_session`

### SharePermission
`view` · `edit`

### Aggregation functions
`sum` · `avg` · `count` · `count_distinct` · `min` · `max`

### Chart filter operators (config-level)
`eq` · `neq` · `gt` · `gte` · `lt` · `lte` · `in` · `not_in` · `contains` · `is_null` · `is_not_null`

### Execute query filter operators (SQL-level)
`=` · `!=` · `>` · `<` · `>=` · `<=` · `LIKE` · `IN`

### Semantic filter operators
`eq` · `ne` · `gt` · `gte` · `lt` · `lte` · `in` · `not_in` · `contains` · `starts_with` · `ends_with`

---

## Error Responses

| Status | Meaning |
|---|---|
| `400` | Bad request — invalid input |
| `401` | Unauthorized — missing or invalid token |
| `403` | Forbidden — insufficient permission |
| `404` | Not found |
| `409` | Conflict — dependency constraint |
| `410` | Gone — expired public link |
| `422` | Unprocessable — validation error or `NOT_SYNCED` |
| `429` | Too many requests — rate limit exceeded |
| `500` | Internal server error |

Error body format:
```json
{ "detail": "Human-readable error message" }
```

---

## Full Endpoint Inventory

### Backend API (`/api/v1`)

| # | Method | Path | Auth | Exposure |
|---|--------|------|------|----------|
| 1 | `POST` | `/auth/login` | 🌐 Public | External |
| 2 | `GET` | `/auth/me` | JWT | External |
| 3 | `POST` | `/auth/change-password` | JWT | External |
| 4 | `PATCH` | `/auth/preferences` | JWT | External |
| 5 | `POST` | `/auth/logout` | JWT | External |
| 6 | `POST` | `/auth/refresh` | Refresh cookie | External |
| 7 | `GET` | `/users/` | JWT + `settings≥view` | External |
| 8 | `GET` | `/users/shareable` | JWT + `settings≥view` | External |
| 9 | `POST` | `/users/` | JWT + `settings=full` | External |
| 10 | `GET` | `/users/{user_id}` | JWT + `settings=full` | External |
| 11 | `PUT` | `/users/{user_id}` | JWT + `settings=full` | External |
| 12 | `DELETE` | `/users/{user_id}` | JWT + `settings=full` | External |
| 13 | `GET` | `/permissions/me` | JWT | External |
| 14 | `GET` | `/permissions/presets` | JWT + `settings=full` | External |
| 15 | `GET` | `/permissions/matrix` | JWT + `settings=full` | External |
| 16 | `PUT` | `/permissions/{user_id}` | JWT + `settings=full` | External |
| 17 | `PUT` | `/permissions/{user_id}/preset` | JWT + `settings=full` | External |
| 18 | `GET` | `/shares/{type}/{id}` | JWT + owner | External |
| 19 | `POST` | `/shares/{type}/{id}` | JWT + owner | External |
| 20 | `PUT` | `/shares/{type}/{id}/{user_id}` | JWT + owner | External |
| 21 | `DELETE` | `/shares/{type}/{id}/{user_id}` | JWT + owner | External |
| 22 | `POST` | `/shares/{type}/{id}/all-team` | JWT + owner | External |
| 23 | `GET` | `/datasources/platform-gcp-info` | JWT | External |
| 24 | `GET` | `/datasources/` | JWT | External |
| 25 | `POST` | `/datasources/` | JWT + `data_sources≥edit` | External |
| 26 | `GET` | `/datasources/{id}` | JWT + `data_sources≥view` | External |
| 27 | `PUT` | `/datasources/{id}` | JWT + `data_sources≥edit` | External |
| 28 | `DELETE` | `/datasources/{id}` | JWT + `data_sources=full` | External |
| 29 | `POST` | `/datasources/test` | JWT + `data_sources≥view` | External |
| 30 | `POST` | `/datasources/query` | JWT (rate-limited) | External |
| 31 | `GET` | `/datasources/{id}/schema` | JWT + `data_sources≥view` | External |
| 32 | `GET` | `/datasources/{id}/tables/{schema}/{table}` | JWT + `data_sources≥view` | External |
| 33 | `GET` | `/datasources/{id}/tables/{schema}/{table}/watermarks` | JWT + `data_sources≥view` | External |
| 34 | `GET` | `/datasources/{id}/sync-config` | JWT + `data_sources≥view` | External |
| 35 | `PUT` | `/datasources/{id}/sync-config` | JWT + `data_sources≥edit` | External |
| 36 | `GET` | `/datasources/{id}/sync-jobs` | JWT + `data_sources≥view` | External |
| 37 | `POST` | `/datasources/{id}/sync` | JWT + `data_sources≥edit` | External |
| 38 | `POST` | `/datasources/manual/parse-file` | JWT + `data_sources≥edit` | External |
| 39 | `GET` | `/dataset-workspaces/` | JWT | External |
| 40 | `POST` | `/dataset-workspaces/` | JWT + `workspaces≥edit` | External |
| 41 | `GET` | `/dataset-workspaces/{id}` | JWT + `workspaces≥view` | External |
| 42 | `PUT` | `/dataset-workspaces/{id}` | JWT + `workspaces≥edit` | External |
| 43 | `DELETE` | `/dataset-workspaces/{id}` | JWT + `workspaces=full` | External |
| 44 | `GET` | `/dataset-workspaces/{id}/tables` | JWT + `workspaces≥view` | External |
| 45 | `POST` | `/dataset-workspaces/{id}/tables` | JWT + `workspaces≥edit` | External |
| 46 | `PUT` | `/dataset-workspaces/{id}/tables/{tid}` | JWT + `workspaces≥edit` | External |
| 47 | `DELETE` | `/dataset-workspaces/{id}/tables/{tid}` | JWT + `workspaces≥edit` | External |
| 48 | `POST` | `/dataset-workspaces/{id}/tables/{tid}/preview` | JWT + `workspaces≥view` | External |
| 49 | `POST` | `/dataset-workspaces/{id}/tables/{tid}/execute` | JWT + `workspaces≥view` | External |
| 50 | `GET` | `/dataset-workspaces/{id}/tables/{tid}/description` | JWT + `workspaces≥view` | External |
| 51 | `PUT` | `/dataset-workspaces/{id}/tables/{tid}/description` | JWT + `workspaces≥edit` | External |
| 52 | `POST` | `/dataset-workspaces/{id}/tables/{tid}/description/regenerate` | JWT + `workspaces≥edit` | External |
| 53 | `GET` | `/dataset-workspaces/tables/search` | JWT | External |
| 54 | `GET` | `/dataset-workspaces/datasources/{id}/tables` | JWT + `data_sources≥view` | External |
| 55 | `GET` | `/dataset-workspaces/datasources/{id}/tables/columns` | JWT + `data_sources≥view` | External |
| 56 | `GET` | `/charts/` | JWT | External |
| 57 | `GET` | `/charts/search` | JWT | External |
| 58 | `POST` | `/charts/ai-preview` | JWT + `ai_chat≥view` | External |
| 59 | `POST` | `/charts/` | JWT + `explore_charts≥edit` | External |
| 60 | `GET` | `/charts/{id}` | JWT + `explore_charts≥view` | External |
| 61 | `PUT` | `/charts/{id}` | JWT + `explore_charts≥edit` | External |
| 62 | `DELETE` | `/charts/{id}` | JWT + `explore_charts=full` | External |
| 63 | `GET` | `/charts/{id}/data` | JWT | External |
| 64 | `GET` | `/charts/{id}/description` | JWT | External |
| 65 | `PUT` | `/charts/{id}/description` | JWT + `explore_charts≥edit` | External |
| 66 | `POST` | `/charts/{id}/description/regenerate` | JWT + `explore_charts≥edit` | External |
| 67 | `PUT` | `/charts/{id}/metadata` | JWT + `explore_charts≥edit` | External |
| 68 | `GET` | `/charts/{id}/metadata` | JWT | External |
| 69 | `DELETE` | `/charts/{id}/metadata` | JWT + `explore_charts≥edit` | External |
| 70 | `GET` | `/charts/{id}/parameters` | JWT + `explore_charts≥view` | External |
| 71 | `PUT` | `/charts/{id}/parameters` | JWT + `explore_charts≥edit` | External |
| 72 | `POST` | `/charts/{id}/parameters` | JWT + `explore_charts≥edit` | External |
| 73 | `PUT` | `/charts/{id}/parameters/{pid}` | JWT + `explore_charts≥edit` | External |
| 74 | `DELETE` | `/charts/{id}/parameters/{pid}` | JWT + `explore_charts≥edit` | External |
| 75 | `GET` | `/dashboards/` | JWT | External |
| 76 | `POST` | `/dashboards/` | JWT + `dashboards≥edit` | External |
| 77 | `GET` | `/dashboards/{id}` | JWT + `dashboards≥view` | External |
| 78 | `PUT` | `/dashboards/{id}` | JWT + `dashboards≥edit` | External |
| 79 | `DELETE` | `/dashboards/{id}` | JWT + `dashboards=full` | External |
| 80 | `POST` | `/dashboards/{id}/charts` | JWT + `dashboards≥edit` | External |
| 81 | `DELETE` | `/dashboards/{id}/charts/{cid}` | JWT + `dashboards≥edit` | External |
| 82 | `PUT` | `/dashboards/{id}/layout` | JWT + `dashboards≥edit` | External |
| 83 | `POST` | `/dashboards/{id}/share` | JWT + `dashboards≥edit` | External |
| 84 | `DELETE` | `/dashboards/{id}/share` | JWT + `dashboards≥edit` | External |
| 85 | `GET` | `/dashboards/{id}/public-links` | JWT + `dashboards≥view` | External |
| 86 | `POST` | `/dashboards/{id}/public-links` | JWT + `dashboards≥edit` | External |
| 87 | `PATCH` | `/dashboards/{id}/public-links/{lid}` | JWT + `dashboards≥edit` | External |
| 88 | `DELETE` | `/dashboards/{id}/public-links/{lid}` | JWT + `dashboards≥edit` | External |
| 89 | `POST` | `/public/dashboards/{token}/auth` | 🌐 Public | External |
| 90 | `GET` | `/public/dashboards/{token}` | 🌐 Public | External |
| 91 | `GET` | `/public/dashboards/{token}/charts/{cid}/data` | 🌐 Public | External |
| 92 | `POST` | `/semantic/views` | JWT + `datasets≥edit` | External |
| 93 | `GET` | `/semantic/views` | JWT + `datasets≥view` | External |
| 94 | `GET` | `/semantic/views/{id}` | JWT + `datasets≥view` | External |
| 95 | `PUT` | `/semantic/views/{id}` | JWT + `datasets≥edit` | External |
| 96 | `DELETE` | `/semantic/views/{id}` | JWT + `datasets=full` | External |
| 97 | `POST` | `/semantic/models` | JWT + `datasets≥edit` | External |
| 98 | `GET` | `/semantic/models` | JWT + `datasets≥view` | External |
| 99 | `GET` | `/semantic/models/{id}` | JWT + `datasets≥view` | External |
| 100 | `PUT` | `/semantic/models/{id}` | JWT + `datasets≥edit` | External |
| 101 | `DELETE` | `/semantic/models/{id}` | JWT + `datasets=full` | External |
| 102 | `POST` | `/semantic/explores` | JWT + `datasets≥edit` | External |
| 103 | `GET` | `/semantic/explores` | JWT + `datasets≥view` | External |
| 104 | `GET` | `/semantic/explores/{id}` | JWT + `datasets≥view` | External |
| 105 | `GET` | `/semantic/explores/by-name/{name}` | JWT + `datasets≥view` | External |
| 106 | `PUT` | `/semantic/explores/{id}` | JWT + `datasets≥edit` | External |
| 107 | `DELETE` | `/semantic/explores/{id}` | JWT + `datasets=full` | External |
| 108 | `POST` | `/semantic/query` | JWT + `datasets≥view` | External |
| 109 | `GET` | `/anomaly/metrics` | JWT | External |
| 110 | `POST` | `/anomaly/metrics` | JWT + `ai_chat≥edit` | External |
| 111 | `PATCH` | `/anomaly/metrics/{id}/toggle` | JWT | External |
| 112 | `DELETE` | `/anomaly/metrics/{id}` | JWT | External |
| 113 | `GET` | `/anomaly/alerts` | JWT | External |
| 114 | `PATCH` | `/anomaly/alerts/{id}/read` | JWT | External |
| 115 | `DELETE` | `/anomaly/alerts/{id}` | JWT | External |
| 116 | `POST` | `/anomaly/scan` | JWT | External |
| 117 | `POST` | `/ai/feedback` | JWT | External |
| 118 | `GET` | `/ai/feedback/stats` | JWT + `settings=full` | External |
| 119 | `GET` | `/chat-sessions` | JWT | External |
| 120 | `POST` | `/chat-sessions` | JWT | External |
| 121 | `GET` | `/chat-sessions/{sid}` | JWT | External |
| 122 | `DELETE` | `/chat-sessions/{sid}` | JWT (owner) | External |
| 123 | `POST` | `/chat-sessions/{sid}/messages` | JWT | External |
| 124 | `PUT` | `/chat-sessions/{sid}/messages/{mid}/feedback` | JWT (owner) | External |
| 125 | `GET` | `/agent-report-specs/` | JWT + `ai_agent≥view` | External |
| 126 | `POST` | `/agent-report-specs/` | JWT + `ai_agent≥edit` | External |
| 127 | `GET` | `/agent-report-specs/{id}` | JWT + `ai_agent≥view` | External |
| 128 | `PUT` | `/agent-report-specs/{id}` | JWT + `ai_agent≥edit` | External |
| 129 | `DELETE` | `/agent-report-specs/{id}` | JWT + `ai_agent≥edit` | External |
| 130 | `GET` | `/agent-report-specs/{id}/runs` | JWT + `ai_agent≥view` | External |
| 131 | `POST` | `/agent-report-specs/{id}/runs` | JWT + `ai_agent≥edit` | External |
| 132 | `PATCH` | `/agent-report-specs/{id}/runs/{rid}` | JWT + `ai_agent≥edit` | External |

### AI Chat Service (`/chat`)

| # | Method | Path | Auth | Exposure |
|---|--------|------|------|----------|
| 1 | `WS` | `/chat/ws` | JWT query param | External (via nginx) |
| 2 | `POST` | `/chat/stream` | Bearer JWT | External (via nginx) |
| 3 | `GET` | `/chat/sessions` | Bearer JWT | External (via nginx) |
| 4 | `POST` | `/chat/sessions` | Bearer JWT | External (via nginx) |
| 5 | `GET` | `/chat/sessions/{sid}` | Bearer JWT | External (via nginx) |
| 6 | `DELETE` | `/chat/sessions/{sid}` | Bearer JWT | External (via nginx) |
| 7 | `POST` | `/chat/sessions/{sid}/messages/{mid}/feedback` | Bearer JWT | External (via nginx) |
| 8 | `POST` | `/chat/cleanup` | Bearer JWT | ⚠️ Should be internal |

### AI Agent Service (`/agent`)

| # | Method | Path | Auth | Exposure |
|---|--------|------|------|----------|
| 1 | `GET` | `/agent/health` | None | ⚠️ Internal only (healthcheck) |
| 2 | `POST` | `/agent/plan` | Bearer JWT + perms | External (via nginx) |
| 3 | `POST` | `/agent/plan/stream` | Bearer JWT + perms | External (via nginx) |
| 4 | `POST` | `/agent/build/stream` | Bearer JWT + perms | External (via nginx) |

### Internal Health Endpoints (NOT exposed via nginx)

| Method | Path | Port | Purpose |
|--------|------|------|---------|
| `GET` | `/` | 8000 | Backend app info |
| `GET` | `/health` | 8000 | Backend Docker healthcheck |

---

## Full Create Flow (Automation Reference)

```
1. POST /auth/login                                  → get token
2. POST /datasources/                                → create datasource
3. POST /datasources/{id}/sync                       → sync data to DuckDB
4. POST /dataset-workspaces/                         → create workspace
5. POST /dataset-workspaces/{id}/tables              → add table
6. POST /charts/                                     → create chart with roleConfig
7. GET  /charts/{id}/data                            → verify aggregated data
8. POST /dashboards/                                 → create dashboard
9. POST /dashboards/{id}/charts                      → add chart to dashboard
```
