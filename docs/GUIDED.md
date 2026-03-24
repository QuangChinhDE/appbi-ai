# AppBI - User Guide

This guide walks through the normal AppBI workflow from first login to building dashboards, sharing them, and using the split AI features.

---

## Table of Contents

1. [Sign In](#1-sign-in)
2. [Connect a Data Source](#2-connect-a-data-source)
3. [Sync Data](#3-sync-data)
4. [Create a Workspace](#4-create-a-workspace)
5. [Build Charts](#5-build-charts)
6. [Build Dashboards](#6-build-dashboards)
7. [Share Resources](#7-share-resources)
8. [Manage Permissions](#8-manage-permissions)
9. [AI Chat](#9-ai-chat)
10. [AI Agent](#10-ai-agent)
11. [Typical Workflow](#11-typical-workflow)
12. [Troubleshooting](#12-troubleshooting)
13. [Related Docs](#13-related-docs)

---

## 1. Sign In

Open `http://localhost:3000` and sign in with your AppBI account.

After login, the sidebar only shows modules your account is allowed to access.

Notes:
- `/auth/login` is rate-limited to `5 requests/minute` per IP.
- If a user is deactivated, login is blocked even if the password is correct.

---

## 2. Connect a Data Source

Use the `Data Sources` module to register databases or files that AppBI can ingest.

Typical flow:
1. Open `Data Sources`.
2. Click `New Data Source`.
3. Choose the connector type.
4. Fill in connection details.
5. Test the connection.
6. Save.

Common connector types:
- PostgreSQL
- MySQL
- BigQuery
- Google Sheets
- Manual file upload

Good practice:
- Use readable names such as `Postgres - Sales Prod` or `Sheets - Marketing Pipeline`.
- Test credentials before saving.
- Keep source credentials updated if the upstream system changes.

---

## 3. Sync Data

AppBI analyzes synced data, not the remote source directly from every chart request.

What sync does:
- pulls data from the source
- stores it in the AppBI data layer
- makes it available for workspaces, charts, dashboards, and AI

Typical flow:
1. Open a data source.
2. Click `Sync Now`.
3. Wait for the sync job to finish.
4. Confirm row counts and last sync time.

Important:
- If a data source has not been synced yet, charts and AI flows may return empty or incomplete results.
- Scheduled sync can be configured in datasource sync settings.

---

## 4. Create a Workspace

A workspace is the modeling layer where you collect and organize tables for analysis.

Typical flow:
1. Open `Workspaces`.
2. Click `New Workspace`.
3. Name the workspace.
4. Add one or more tables.

You can add tables in two ways:
- Physical table: select a synced table from a data source.
- SQL table: define a query-backed table for filtered or transformed analysis.

Workspace tips:
- Keep workspace names aligned with a business domain such as `Sales`, `Operations`, or `Finance`.
- Only expose the tables analysts really need.
- Preview data before building charts.

---

## 5. Build Charts

Charts are created from workspace tables in the `Explore` flow.

Typical flow:
1. Open `Explore` or start from a workspace table.
2. Choose a workspace and table.
3. Pick a chart type.
4. Configure dimensions, metrics, and filters.
5. Run the chart preview.
6. Save the chart.

Common chart types:
- Bar
- Line
- Area
- Pie
- KPI
- Table
- Time series
- Scatter

Aggregation examples:
- `sum`
- `avg`
- `count`
- `count_distinct`
- `min`
- `max`

Tip:
- If a chart preview looks wrong, verify the source table, time grain, filters, and metric aggregation before saving.

---

## 6. Build Dashboards

Dashboards combine multiple saved charts into a report layout.

Typical flow:
1. Open `Dashboards`.
2. Click `New Dashboard`.
3. Name the dashboard.
4. Add existing charts.
5. Arrange the layout.
6. Save changes.

Dashboard behavior:
- Removing a chart from a dashboard does not delete the original saved chart.
- Layout changes are stored separately from chart definitions.
- Global filters apply across compatible charts in the same dashboard.

---

## 7. Share Resources

AppBI supports sharing on top of module permissions.

Resources that can be shared:
- data sources
- workspaces
- charts
- dashboards
- chat sessions where supported by the backend

Sharing rules:
- Module permission decides whether the module is visible at all.
- Resource sharing decides which specific items inside that module a user can open.
- Sharing a dashboard can cascade access to the charts and workspaces it depends on.

Typical flow:
1. Open a chart, dashboard, workspace, or data source.
2. Click `Share`.
3. Pick the user.
4. Grant `view` or `edit`.
5. Save.

---

## 8. Manage Permissions

AppBI uses module-level permissions for high-level access control.

### Modules

| Module | Purpose |
|---|---|
| `data_sources` | Manage and inspect data source connections |
| `datasets` | Semantic and dataset-level analysis features |
| `workspaces` | Build and manage dataset workspaces |
| `explore_charts` | Create and edit charts |
| `dashboards` | Create and edit dashboards |
| `ai_chat` | Use AI Chat |
| `ai_agent` | Use AI Agent report builder |
| `settings` | Admin and system settings |

### Permission levels

| Level | Meaning |
|---|---|
| `none` | Module hidden and API access denied |
| `view` | Read-only access |
| `edit` | Create and update, but not destructive admin actions |
| `full` | Full control where the module supports it |

Module-specific notes:
- `data_sources` supports `none`, `view`, and `full`.
- `ai_chat` supports `none`, `view`, and `edit`.
- `ai_agent` supports `none`, `view`, and `edit`.
- `settings` supports `none` and `full`.

Preset overview:
- `admin`: full BI control, plus `ai_chat=edit` and `ai_agent=edit`
- `editor`: edit most BI modules, plus `ai_chat=edit` and `ai_agent=edit`
- `viewer`: read-only BI access, `ai_chat=view`, `ai_agent=none`
- `minimal`: dashboard viewing only, no AI access

Important:
- Module permission alone is not enough to open every object.
- Resource-level ownership and shares are still enforced.

---

## 9. AI Chat

`AI Chat` is the reactive assistant.

Use it for:
- asking questions in natural language
- inspecting available workspaces and tables
- summarizing data patterns
- generating one chart when needed
- continuing a conversational analysis session

Requirements:
- `ai_chat >= view`
- access to the underlying workspace/table/chart data
- `ai-chat-service` must be running if you want live chat

Where it lives:
- UI entry: `/chat`
- service: `ai-service/`
- default port: `8001`

Behavior notes:
- Chat sessions are stored and can be reopened later.
- If chat service is offline, the chat page still loads but live chat actions are unavailable.
- Chat works independently from AI Agent.

---

## 10. AI Agent

`AI Agent` is the proactive report builder.

Use it for:
- turning a business brief into a dashboard plan
- generating multiple charts from selected workspace tables
- assembling a dashboard layout automatically
- building a report from one or more selected datasets without cross-dataset blending in v1

Requirements:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- view access on every selected workspace table
- `ai-agent-service` must be running

Where it lives:
- UI entry: `/dashboards`
- service: `ai-agent-service/`
- default port: `8002`

Current v1 flow:
1. Open the Agent wizard from the dashboards page.
2. Select one or more workspace tables.
3. Fill in the structured brief.
4. Review the generated plan.
5. Start generation.
6. Track progress while charts and dashboard sections are built.
7. Open the finished dashboard.

Rules:
- Agent only uses the tables selected by the user.
- Multi-dataset v1 means section-based composition, not SQL join or dataset blending.
- Build logic follows `docs/GUIDED_API_CHART.md`, `docs/GUIDED_API_DASHBOARD.md`, and `docs/GUIDED_API_AI_AGENT_REPORT.md`.

---

## 11. Typical Workflow

```text
1. Connect a data source
2. Run sync
3. Create a workspace
4. Add tables to the workspace
5. Build charts in Explore
6. Create a dashboard
7. Share the dashboard with the team
8. Use AI Chat for ad-hoc analysis
9. Use AI Agent when you want a full dashboard/report generated from a structured brief
```

---

## 12. Troubleshooting

**Charts show no data**
- Confirm the source has been synced.
- Confirm the workspace table points to the expected source table.
- Recheck chart filters and aggregation.

**A user cannot open a shared dashboard**
- Confirm the user has at least `dashboards=view`.
- Confirm the dashboard has actually been shared to that user or team.
- Confirm dependent charts and workspaces were shared correctly.

**Chat page opens but chat does not work**
- Confirm `ai-chat-service` is running.
- Confirm `NEXT_PUBLIC_AI_CHAT_HTTP_URL` and `NEXT_PUBLIC_AI_CHAT_WS_URL` are configured correctly.
- Confirm the user has `ai_chat` access.

**Agent entry is missing or generation is blocked**
- Confirm `ai-agent-service` is running.
- Confirm the user has `ai_agent >= edit`, `dashboards >= edit`, and `explore_charts >= edit`.
- Confirm the selected workspace tables are visible to that user.

**A dashboard name or generated title behaves strangely**
- Prefer simple ASCII punctuation in titles when testing automation.

---

## 13. Related Docs

- [README.md](../README.md)
- [DOCKER.md](./DOCKER.md)
- [SETUP.md](./SETUP.md)
- [API.md](./API.md)
- [AI_AGENT.md](./AI_AGENT.md)
- [GUIDED_API_CHART.md](./GUIDED_API_CHART.md)
- [GUIDED_API_DASHBOARD.md](./GUIDED_API_DASHBOARD.md)
- [GUIDED_API_AI_AGENT_REPORT.md](./GUIDED_API_AI_AGENT_REPORT.md)
