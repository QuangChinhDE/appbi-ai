# AppBI — REST API Reference

Base URL (Docker / production): `http://localhost:8000/api/v1`  
Interactive docs (Swagger UI): `http://localhost:8000/api/v1/docs`  
OpenAPI JSON: `http://localhost:8000/openapi.json`

All request/response bodies are **JSON**. No authentication is required in the default configuration.

---

## Table of Contents

1. [Health](#1-health)
2. [Data Sources](#2-data-sources)
3. [Datasets](#3-datasets)
4. [Dataset Workspaces](#4-dataset-workspaces)
5. [Charts](#5-charts)
6. [Dashboards](#6-dashboards)
7. [Common Types](#7-common-types)

---

## 1. Health

### `GET /health`

Returns application status.

**Response 200**
```json
{ "status": "ok" }
```

---

## 2. Data Sources

### `GET /api/v1/datasources/`

List all data sources.

**Response 200** — array of `DataSourceResponse`

---

### `POST /api/v1/datasources/`

Create a new data source.

**Request body**
```json
{
  "name": "My Postgres",
  "source_type": "postgresql",
  "connection_config": {
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "username": "user",
    "password": "secret",
    "schema": "public"
  }
}
```

| `source_type` | Required connection_config fields |
|---|---|
| `postgresql` | `host`, `port`, `database`, `username`, `password`, `schema` (optional) |
| `mysql` | `host`, `port`, `database`, `username`, `password` |
| `bigquery` | `project_id`, `credentials_json` (Service Account JSON string) |
| `google_sheets` | `credentials_json`, `spreadsheet_id` |
| `manual` | *(no config — upload file separately via `/parse-file`)* |

**Response 201** — `DataSourceResponse`

---

### `POST /api/v1/datasources/test`

Test a connection **without** saving it (used before create/update).

**Request body** — same schema as create  
**Response 200**
```json
{ "success": true, "message": "Connection successful" }
```

---

### `POST /api/v1/datasources/manual/parse-file`

Upload a CSV or Excel file for a `manual` datasource.

**Request** — `multipart/form-data`
- `file`: the file (`.csv`, `.xlsx`, `.xls`)

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

After parsing, create the datasource with `source_type: "manual"` and include the parsed data in `connection_config.sheets`.

---

### `POST /api/v1/datasources/query`

Execute a raw SQL query against an existing data source.

**Request body**
```json
{
  "data_source_id": 1,
  "query": "SELECT * FROM my_table LIMIT 10"
}
```

**Response 200**
```json
{
  "columns": [{"name": "col1", "type": "string"}],
  "rows": [{"col1": "val"}],
  "row_count": 1
}
```

---

### `GET /api/v1/datasources/{data_source_id}`

Get a single data source by ID.

---

### `PUT /api/v1/datasources/{data_source_id}`

Update name and/or connection config of an existing data source.

**Request body** — partial update (any fields from create body)

---

### `DELETE /api/v1/datasources/{data_source_id}`

Delete a data source. Fails with `409` if datasets or workspace tables depend on it.

---

## 3. Datasets

Datasets are saved SQL queries with optional **transformation pipelines** (v2). Columns are inferred by executing the pipeline.

### `GET /api/v1/datasets/`

List all datasets.

**Response 200**
```json
[
  {
    "id": 1,
    "name": "FIFA Rankings",
    "description": "...",
    "data_source_id": 1,
    "sql_query": "SELECT * FROM fifa_world_rankings_jan_2026",
    "transformation_version": 2,
    "transformations": [],
    "columns": [{"name": "Rank", "type": "integer"}, {"name": "Country", "type": "string"}],
    "created_at": "2026-03-15T10:00:00",
    "updated_at": "2026-03-15T10:00:00"
  }
]
```

---

### `POST /api/v1/datasets/`

Create a dataset. Columns are automatically inferred from the SQL + transformations.

**Request body**
```json
{
  "name": "Rankings Elite",
  "description": "Top countries with Performance_Tier column",
  "data_source_id": 1,
  "sql_query": "SELECT * FROM fifa_world_rankings_jan_2026",
  "transformation_version": 2,
  "transformations": [
    {
      "id": "step_add_tier",
      "type": "add_column",
      "enabled": true,
      "params": {
        "newField": "Performance_Tier",
        "expression": "CASE WHEN Points > 1800 THEN 'Elite' WHEN Points > 1700 THEN 'Strong' ELSE 'Average' END"
      }
    },
    {
      "id": "step_filter",
      "type": "filter_rows",
      "enabled": true,
      "params": {
        "conditions": [{"field": "Performance_Tier", "operator": "in", "value": ["Elite", "Strong"]}],
        "logic": "AND"
      }
    },
    {
      "id": "step_sort",
      "type": "sort",
      "enabled": true,
      "params": {"by": [{"field": "Points", "direction": "desc"}]}
    }
  ]
}
```

**Supported transformation types**

| type | params keys | Description |
|---|---|---|
| `add_column` | `newField`, `expression` (SQL expr) | Adds a new column via CASE/expression |
| `filter_rows` | `conditions[]` {field, operator, value}, `logic` AND\|OR | WHERE filter |
| `group_by` | `by[]`, `aggregations[]` {field, agg, as} | GROUP BY with aggregations |
| `sort` | `by[]` {field, direction asc\|desc} | ORDER BY |
| `limit` | `count` | LIMIT rows |
| `select_columns` | `columns[]` | Keep only specified columns |
| `remove_column` | `field` | DROP column |
| `rename_column` | `field`, `newField` | Rename column |
| `duplicate_column` | `field`, `newField` | Copy column |
| `merge_columns` | `fields[]`, `separator`, `newField` | Concatenate columns |
| `fill_null` | `field`, `value` | COALESCE null values |
| `cast_column` | `field`, `targetType` | CAST column type |
| `distinct` | *(no params)* | SELECT DISTINCT |
| `custom_sql` | `sql` | Raw SQL CTE wrapping |

**Response 201** — `DatasetResponse`

---

### `POST /api/v1/datasets/preview`

Ad-hoc preview — runs SQL + transformations without saving.

**Request body**
```json
{
  "data_source_id": 1,
  "sql_query": "SELECT * FROM my_table",
  "transformations": [],
  "stop_at_step_id": null,
  "limit": 50
}
```

**Response 200**
```json
{
  "columns": [{"name": "col", "type": "string"}],
  "rows": [{"col": "val"}],
  "row_count": 1,
  "compiled_sql": "SELECT * FROM my_table LIMIT 50",
  "step_id": null
}
```

---

### `GET /api/v1/datasets/{dataset_id}`

Get a single dataset.

---

### `PUT /api/v1/datasets/{dataset_id}`

Update dataset name, query, or transformations. Columns are re-inferred.

---

### `DELETE /api/v1/datasets/{dataset_id}`

Delete a dataset.

---

### `POST /api/v1/datasets/{dataset_id}/execute`

Execute the dataset and return all rows (no limit).

**Response 200**
```json
{
  "columns": [{"name": "col", "type": "string"}],
  "rows": [{"col": "val"}],
  "row_count": 42
}
```

---

### `POST /api/v1/datasets/{dataset_id}/preview`

Preview the saved dataset (runs the SQL + transformations, returns up to 200 rows).

---

---

## 4. Dataset Workspaces

Workspaces are collections of **workspace tables**. Each table is either a physical table from a datasource, or a custom SQL query. Tables can have `js_formula` transformation steps that add computed columns evaluated client-side with an Excel-style formula engine.

### `GET /api/v1/dataset-workspaces/`

List all workspaces (without tables).

**Response 200**
```json
[
  {
    "id": 1,
    "name": "FIFA World Rankings",
    "description": "...",
    "created_at": "2026-03-15T10:00:00"
  }
]
```

---

### `POST /api/v1/dataset-workspaces/`

Create a workspace.

**Request body**
```json
{
  "name": "My Workspace",
  "description": "Optional description"
}
```

**Response 201** — `WorkspaceResponse`

---

### `GET /api/v1/dataset-workspaces/{workspace_id}`

Get a workspace with all its tables (including `transformations`, `column_formats`, `type_overrides`).

**Response 200**
```json
{
  "id": 1,
  "name": "FIFA World Rankings",
  "tables": [
    {
      "id": 1,
      "workspace_id": 1,
      "display_name": "Full Rankings",
      "source_kind": "sql_query",
      "source_query": "SELECT * FROM fifa_world_rankings_jan_2026 ORDER BY Rank",
      "datasource_id": 1,
      "enabled": true,
      "transformations": [
        {
          "id": "step_rank_group",
          "type": "js_formula",
          "enabled": true,
          "params": {
            "newField": "Rank_Group",
            "formula": "IF([Rank]<=10,\"Top 10\",IF([Rank]<=25,\"Top 25\",\"Rest\"))"
          }
        }
      ],
      "column_formats": {},
      "type_overrides": {}
    }
  ]
}
```

---

### `PUT /api/v1/dataset-workspaces/{workspace_id}`

Update workspace name/description.

---

### `DELETE /api/v1/dataset-workspaces/{workspace_id}`

Delete workspace and all its tables.

---

### `GET /api/v1/dataset-workspaces/{workspace_id}/tables`

List tables for a workspace.

---

### `POST /api/v1/dataset-workspaces/{workspace_id}/tables`

Add a table to a workspace.

**Request body**
```json
{
  "datasource_id": 1,
  "source_kind": "sql_query",
  "source_query": "SELECT * FROM my_table",
  "display_name": "My Table",
  "enabled": true,
  "transformations": [
    {
      "id": "step_formula1",
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "MyComputedCol",
        "formula": "IF([Points]>1800,\"Elite\",\"Other\")"
      }
    }
  ]
}
```

For `source_kind: "physical_table"`, use `source_table_name` instead of `source_query`.

**`js_formula` params**

| Key | Type | Description |
|---|---|---|
| `newField` | string | Name of the new column |
| `formula` | string | Excel-style formula. Reference columns with `[ColumnName]`. Supports: `IF`, `AND`, `OR`, `ROUND`, `ABS`, `LEN`, `LEFT`, `RIGHT`, `MID`, `UPPER`, `LOWER`, `TRIM`, `CONCAT`, `TEXT`, `VALUE`, `TODAY`, `NOW`, `YEAR`, `MONTH`, `DAY`, `DATEDIF`, `VLOOKUP`, `LOOKUP`, `IFERROR`, `ISBLANK`, arithmetic (`+`, `-`, `*`, `/`, `^`), comparison (`=`, `<>`, `<`, `>`, `<=`, `>=`), text concat (`&`) |
| `code` | string | Raw JavaScript expression (alternative to `formula`) — row is `$row`, index is `$index` |

**Excel formula examples**
```
IF([Points]>1800,"Elite","Other")
ROUND([Points]/[World_Cup_Titles],2)
[Country]&" ("&[Confederation]&")"
IF([Goals]>=5,"Legend",IF([Goals]>=4,"Star","Notable"))
```

**Response 201** — `TableResponse`

---

### `PUT /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}`

Update a workspace table — change SQL, display name, transformations, column formats, or type overrides.

**Request body** (all fields optional)
```json
{
  "display_name": "Renamed Table",
  "source_query": "SELECT * FROM new_query",
  "enabled": true,
  "transformations": [],
  "type_overrides": {"price": "currency", "created_at": "date"},
  "column_formats": {
    "Points": {"formatType": "number", "decimals": 1, "thousandsSep": true}
  }
}
```

---

### `DELETE /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}`

Remove a table from the workspace. Returns `409` with constraint details if charts depend on this table.

---

### `POST /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}/preview`

Preview the table data (SQL + server-side transformations). `js_formula` steps are evaluated client-side by the frontend.

**Request body**
```json
{ "limit": 200 }
```

**Response 200**
```json
{
  "columns": [{"name": "Rank", "type": "integer"}, {"name": "Country", "type": "string"}],
  "rows": [{"Rank": 1, "Country": "Argentina"}],
  "row_count": 1,
  "total_rows": 210
}
```

---

### `POST /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}/execute`

Execute table query without limit (returns all rows).

---

### `GET /api/v1/dataset-workspaces/datasources/{datasource_id}/tables`

List available physical tables from a datasource (used in AddTableModal to pick a table).

---

## 5. Charts

Charts store the Explore configuration (data source, chart type, axis mapping, filters).

### `GET /api/v1/charts/`

List all charts.

**Response 200**
```json
[
  {
    "id": 1,
    "name": "Top 10 Points",
    "description": "Bar chart of top 10 FIFA points",
    "chart_type": "bar",
    "workspace_table_id": 3,
    "explore_config": {
      "workspace_id": 1,
      "chartType": "bar",
      "roleConfig": {
        "dimension": "Country",
        "metrics": ["Points"]
      },
      "filters": []
    },
    "created_at": "2026-03-15T10:00:00"
  }
]
```

---

### `POST /api/v1/charts/`

Create a chart (save an Explore configuration).

**Request body**
```json
{
  "name": "Avg Points by Confederation",
  "description": "Bar chart grouping by Confederation",
  "chart_type": "bar",
  "workspace_table_id": 3,
  "explore_config": {
    "workspace_id": 1,
    "chartType": "bar",
    "roleConfig": {
      "dimension": "Confederation",
      "metrics": ["avg_points"]
    },
    "filters": [
      {"field": "Confederation", "operator": "=", "value": "UEFA"}
    ]
  }
}
```

**Supported `chart_type` values**

| Value | Description |
|---|---|
| `bar` | Vertical bar chart |
| `line` | Line chart |
| `area` | Area chart |
| `pie` | Pie / Donut chart |
| `scatter` | Scatter / Bubble chart |
| `grouped_bar` | Grouped bar (multiple metrics side-by-side) |
| `stacked_bar` | Stacked bar chart |
| `table` | Tabular data view |
| `kpi` | Single-value KPI tile |
| `time_series` | Time series line chart |

**`explore_config` structure**

```json
{
  "workspace_id": 1,
  "chartType": "bar",
  "roleConfig": {
    "dimension": "Country",       // X-axis / group-by field
    "metrics": ["Points"],        // Y-axis fields
    "breakdown": "Confederation"  // Optional second group dimension
  },
  "filters": [
    {
      "field": "Confederation",
      "operator": "=",
      "value": "UEFA"
    }
  ],
  "parameters": {}
}
```

**Response 201** — `ChartResponse`

---

### `GET /api/v1/charts/{chart_id}`

Get a single chart.

---

### `PUT /api/v1/charts/{chart_id}`

Update a chart's name, config, or explore_config.

---

### `DELETE /api/v1/charts/{chart_id}`

Delete a chart. Also removes it from any dashboards.

---

### `GET /api/v1/charts/{chart_id}/data`

Execute the chart's Explore query and return chart-ready data.

**Response 200**
```json
{
  "chart_type": "bar",
  "data": [
    {"Country": "Argentina", "Points": 1947},
    {"Country": "France", "Points": 1866}
  ],
  "columns": [{"name": "Country", "type": "string"}, {"name": "Points", "type": "number"}],
  "row_count": 10
}
```

---

### Chart Metadata

#### `PUT /api/v1/charts/{chart_id}/metadata`
#### `GET /api/v1/charts/{chart_id}/metadata`
#### `DELETE /api/v1/charts/{chart_id}/metadata`

Store arbitrary JSON metadata on a chart (tile settings, custom labels, etc.).

**Request body (PUT)**
```json
{ "title_override": "My Custom Title", "color_scheme": "blue" }
```

---

### Chart Parameters

Parameters allow dynamic filtering in dashboards.

#### `GET /api/v1/charts/{chart_id}/parameters`

List parameters for a chart.

#### `PUT /api/v1/charts/{chart_id}/parameters`

Replace all parameters.

**Request body**
```json
[
  {
    "name": "min_points",
    "label": "Minimum Points",
    "type": "number",
    "default_value": 1600
  }
]
```

#### `POST /api/v1/charts/{chart_id}/parameters`

Add a single parameter.

#### `PUT /api/v1/charts/{chart_id}/parameters/{param_id}`

Update a parameter.

#### `DELETE /api/v1/charts/{chart_id}/parameters/{param_id}`

Delete a parameter.

---

## 6. Dashboards

Dashboards compose multiple charts into a grid layout with optional filter bars.

### `GET /api/v1/dashboards/`

List all dashboards.

---

### `POST /api/v1/dashboards/`

Create a dashboard.

**Request body**
```json
{
  "name": "FIFA World Rankings Overview",
  "description": "Overview of FIFA rankings with Confederation filter",
  "filters_config": [
    {
      "field": "Confederation",
      "operator": "=",
      "value": "UEFA",
      "label": "Confederation"
    }
  ]
}
```

**`filters_config`** — pre-applied global filters (dimension / pre-aggregation). These are passed to all chart queries in the dashboard.

**Response 201** — `DashboardResponse`

---

### `GET /api/v1/dashboards/{dashboard_id}`

Get dashboard with all chart tiles (includes `layout`, `charts`, `filters_config`).

**Response 200**
```json
{
  "id": 1,
  "name": "FIFA World Rankings Overview",
  "charts": [
    {
      "chart_id": 1,
      "position": {"x": 0, "y": 0, "w": 6, "h": 4},
      "title_override": null,
      "having_filters": []
    }
  ],
  "layout": [],
  "filters_config": [{"field": "Confederation", "operator": "=", "value": "UEFA"}]
}
```

---

### `PUT /api/v1/dashboards/{dashboard_id}`

Update dashboard name, description, or `filters_config`.

---

### `DELETE /api/v1/dashboards/{dashboard_id}`

Delete a dashboard (charts are not deleted, only removed from the dashboard).

---

### `POST /api/v1/dashboards/{dashboard_id}/charts`

Add a chart to a dashboard.

**Request body**
```json
{
  "chart_id": 5,
  "position": {"x": 0, "y": 0, "w": 6, "h": 4}
}
```

**Response 200** — updated dashboard

---

### `DELETE /api/v1/dashboards/{dashboard_id}/charts/{chart_id}`

Remove a chart from a dashboard.

---

### `PUT /api/v1/dashboards/{dashboard_id}/layout`

Update the full grid layout of a dashboard (called after drag-and-drop).

**Request body**
```json
[
  {"chart_id": 1, "x": 0, "y": 0, "w": 6, "h": 4},
  {"chart_id": 2, "x": 6, "y": 0, "w": 6, "h": 4}
]
```

---

## 7. Common Types

### `ColumnMetadata`
```json
{ "name": "Country", "type": "string", "nullable": true }
```

### Column types
`string` · `integer` · `number` (float) · `boolean` · `date` · `datetime` · `unknown`

### Filter operators
`=` · `!=` · `<` · `<=` · `>` · `>=` · `in` · `not_in` · `like` · `is_null` · `is_not_null`

### Aggregation functions (group_by)
`count` · `sum` · `avg` · `min` · `max` · `count_distinct`

---

## Seed Demo Data (API automation)

The file `seed_demo.py` at the repo root is a reference implementation showing the full automated flow:

```
1. POST /api/v1/datasources/manual/parse-file   → upload Excel file
2. POST /api/v1/datasources/                     → create Manual datasource
3. POST /api/v1/datasets/            (×6)        → create datasets with transformations
4. POST /api/v1/dataset-workspaces/  (×3)        → create workspaces
5. POST /api/v1/dataset-workspaces/{id}/tables   → add tables with js_formula steps
6. POST /api/v1/charts/              (×18)       → create charts via workspace_table_id
7. POST /api/v1/dashboards/          (×3)        → create dashboards with filters_config
8. POST /api/v1/dashboards/{id}/charts           → attach charts to dashboards
```

Run it against any running AppBI instance:

```bash
BASE_URL=http://localhost:8000/api/v1 python3 seed_demo.py
```
