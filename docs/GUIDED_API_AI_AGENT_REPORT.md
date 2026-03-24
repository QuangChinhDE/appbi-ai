# GUIDED_API_AI_AGENT_REPORT.md - AI Agent Report Builder Guide

> Source-of-truth for the standalone `ai-agent-service` report builder.
> This document sits on top of `GUIDED_API_CHART.md` and `GUIDED_API_DASHBOARD.md`.
> When implementation and older AI code disagree, the guided API docs win.
> Last updated: 2026-03-24

---

## 1. Scope

`AI Agent` is a proactive report builder.

It is intentionally separate from `AI Chat`:
- `AI Chat` answers questions, explores, and may create one chart when needed.
- `AI Agent` plans a report, creates multiple charts, and assembles a full dashboard.

V1 constraints:
- Entry point is `/dashboards`
- User must explicitly choose `1..n` workspace tables
- Agent only uses selected tables
- No cross-dataset join or blending in V1
- Output is a complete dashboard, not a chat transcript

---

## 2. Runtime Boundaries

Services are split by Docker/runtime:
- Base stack: `db`, `backend`, `frontend`
- Chat overlay: `ai-chat-service`
- Agent overlay: `ai-agent-service`

Required frontend env vars:
- `NEXT_PUBLIC_AI_CHAT_WS_URL`
- `NEXT_PUBLIC_AI_CHAT_HTTP_URL`
- `NEXT_PUBLIC_AI_AGENT_HTTP_URL`

Required backend/module permissions for Agent:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- object-level `view` access on every selected table/workspace

---

## 3. API Contracts

### 3.1 Plan endpoint

```http
POST /agent/plan
Authorization: Bearer <jwt>
Content-Type: application/json
```

Request body:

```json
{
  "goal": "Build an executive revenue dashboard",
  "audience": "Executive team",
  "timeframe": "Last 30 days",
  "kpis": ["Revenue", "Order volume", "Growth"],
  "questions": [
    "What is the main trend?",
    "Which segment contributes the most?",
    "What anomaly needs attention?"
  ],
  "selected_tables": [
    {"workspace_id": 12, "table_id": 31},
    {"workspace_id": 15, "table_id": 42}
  ]
}
```

Response body:

```json
{
  "dashboard_title": "Build an executive revenue dashboard",
  "dashboard_summary": "Dashboard generated for goal: Build an executive revenue dashboard",
  "sections": [
    {
      "title": "Sales Workspace / Orders",
      "workspace_id": 12,
      "workspace_table_id": 31,
      "workspace_name": "Sales Workspace",
      "table_name": "Orders",
      "intent": "Section answering Build an executive revenue dashboard",
      "chart_keys": ["sales-orders-1", "sales-orders-2"]
    }
  ],
  "charts": [
    {
      "key": "sales-orders-1",
      "title": "Orders - Total Records",
      "chart_type": "KPI",
      "workspace_id": 12,
      "workspace_table_id": 31,
      "workspace_name": "Sales Workspace",
      "table_name": "Orders",
      "rationale": "Baseline volume KPI for Orders.",
      "config": {
        "workspace_id": 12,
        "chartType": "KPI",
        "roleConfig": {
          "metrics": [{"field": "id", "agg": "count", "label": "Total Records"}]
        },
        "filters": []
      }
    }
  ],
  "warnings": []
}
```

### 3.2 Build endpoint

```http
POST /agent/build/stream
Authorization: Bearer <jwt>
Content-Type: application/json
Accept: application/x-ndjson
```

Request body:

```json
{
  "brief": {"...": "same brief used for plan"},
  "plan": {"...": "approved plan returned from /agent/plan"}
}
```

Stream events are NDJSON lines:

```json
{"type":"phase","phase":"validate","message":"Validated permissions and selected plan."}
{"type":"phase","phase":"create_charts","message":"Creating charts from approved plan."}
{"type":"chart_created","phase":"create_charts","message":"Created chart 'Orders - Trend Over Time'.","chart_id":17}
{"type":"dashboard_created","phase":"assemble_dashboard","message":"Dashboard 'Executive Revenue Dashboard' created.","dashboard_id":5,"dashboard_url":"/dashboards/5"}
{"type":"done","phase":"done","message":"AI Agent finished building the dashboard.","dashboard_id":5,"dashboard_url":"/dashboards/5"}
```

---

## 4. Build Sequence

The builder must follow this sequence:
1. Validate JWT and module permissions.
2. Validate selected table visibility by reading workspace/table metadata through the backend.
3. Inspect schema and preview rows for each selected table.
4. Produce a structured plan.
5. Normalize every chart payload to the chart guide contract.
6. Create charts.
7. Verify each chart with `GET /charts/{id}/data`.
8. Abort with a clear error if every chart fails.
9. Create the dashboard shell.
10. Attach each successful chart to the dashboard.
11. Update the dashboard layout using `dashboard_charts[].id`.
12. Return the final dashboard URL.

---

## 5. Rules Borrowed From GUIDED_API_CHART.md

The Agent builder must enforce these rules in code, not just prompt text:
- Chart payload must include top-level `name`, `chart_type`, `workspace_table_id`, and `config`.
- `chart_type` must be uppercase.
- `config.workspace_id` is required.
- `config.chartType` must match `chart_type`.
- `config.roleConfig` is required.
- `config.filters` should always be present, default `[]`.
- Metric `agg` values must use the API format from the chart guide.

Minimum normalized payload shape:

```json
{
  "name": "Orders - Trend Over Time [20260324094500]",
  "description": "Trend chart to monitor order_value over created_at.",
  "workspace_table_id": 31,
  "chart_type": "TIME_SERIES",
  "config": {
    "workspace_id": 12,
    "chartType": "TIME_SERIES",
    "roleConfig": {
      "timeField": "created_at",
      "metrics": [{"field": "order_value", "agg": "sum", "label": "Order Value"}]
    },
    "filters": []
  }
}
```

---

## 6. Rules Borrowed From GUIDED_API_DASHBOARD.md

The Agent builder must enforce these dashboard rules:
- Dashboard is created first, then charts are attached.
- Layout update must use `PUT /dashboards/{id}/layout`.
- Layout payload must be:

```json
{
  "chart_layouts": [
    {"id": 101, "layout": {"x": 0, "y": 0, "w": 6, "h": 4}}
  ]
}
```

Important:
- `chart_layouts[].id` is `DashboardChart.id`
- It is not the original `chart_id`
- Builder must read it from `dashboard.dashboard_charts[].id` after the chart is attached

---

## 7. Multi-Dataset V1 Rules

V1 multi-dataset means composition, not blending.

Allowed:
- One dashboard with multiple sections
- Each section tied to one selected table
- Different charts may come from different selected tables

Not allowed in V1:
- SQL join between selected tables
- Derived chart that references columns from two tables
- Cross-dataset blending logic hidden inside the planner

Validation rule:
- Every `charts[].workspace_table_id` must reference exactly one selected table.

---

## 8. Failure Handling

Expected behavior:
- If one chart fails: continue building the rest.
- If some charts succeed: create dashboard with successful charts only.
- If all charts fail: emit error event and do not create an empty dashboard.
- If layout update fails after dashboard creation: return an error and log the dashboard id for recovery.

Recommended emitted phases:
- `validate`
- `create_charts`
- `assemble_dashboard`
- `done`
- `error`

---

## 9. Frontend UX Contract

Agent UX on `/dashboards` should be a wizard, not a chat panel.

Steps:
1. Select tables
2. Fill brief
3. Review plan
4. Generate dashboard
5. Stream progress
6. Redirect to `/dashboards/{id}`

Frontend must:
- Hide or disable Agent CTA when required module permissions are missing
- Handle `ai-agent-service` unavailable state gracefully
- Keep `AI Chat` independent from Agent UI and transport

---

## 10. Definition Of Done

Feature is considered complete when:
- Chat and Agent run as separate Docker services
- Agent uses its own API/router/service code path
- `ai_agent` module permission is enforced backend + frontend
- Build payloads follow chart and dashboard guided docs
- Dashboard generation works with one or many selected tables
- Partial failure is handled without creating empty dashboards
- Chat flow remains unchanged
