# AppBI User Guide

This guide explains the current end-user workflow in AppBI, including the split AI features, AI Description behavior, and the latest AI Agent flow.

## Table of Contents

1. Sign In
2. Connect a Data Source
3. Sync Data
4. Create a Workspace
5. Use AI Description on Tables and Charts
6. Build Charts in Explore
7. Build Dashboards
8. Share Resources
9. Manage Permissions
10. Use AI Chat
11. Use AI Agent
12. Typical Workflow
13. Troubleshooting
14. Related Docs

## 1. Sign In

Open `http://localhost:3000` and sign in with your AppBI account.

What to expect:
- the sidebar only shows modules your account can access
- deactivated users cannot sign in
- login is rate-limited for security

## 2. Connect a Data Source

Use `Data Sources` to register the systems that AppBI can ingest.

Typical flow:
1. Open `Data Sources`.
2. Click `New Data Source`.
3. Choose the connector type.
4. Fill in the connection details.
5. Test the connection.
6. Save.

Common connector types:
- PostgreSQL
- MySQL
- BigQuery
- Google Sheets
- file upload

Good practice:
- use readable names like `Postgres - Sales Prod`
- verify credentials before saving
- keep source credentials updated when upstream systems change

## 3. Sync Data

AppBI analyzes synced data, not the upstream source directly for every chart request.

What sync does:
- pulls data from the source
- stores it in the AppBI analysis layer
- makes it available to workspaces, charts, dashboards, AI Chat, and AI Agent

Typical flow:
1. Open a data source.
2. Click `Sync Now`.
3. Wait for the sync job to finish.
4. Confirm the latest sync status.

Important:
- if data has not been synced, charts and AI flows may be empty or incomplete
- scheduled sync is configured from the datasource sync settings

## 4. Create a Workspace

A workspace is the modeling layer where analysis-ready tables are collected.

Typical flow:
1. Open `Workspaces`.
2. Click `New Workspace`.
3. Name the workspace.
4. Add one or more workspace tables.

You can add tables in two ways:
- physical table
- SQL-backed table

Good practice:
- group tables by a clear business domain such as `Sales`, `Finance`, or `Operations`
- only include the tables analysts really need
- preview the data before building charts

## 5. Use AI Description on Tables and Charts

AppBI includes backend-generated AI Description for:
- workspace tables
- charts

This is separate from AI Chat and AI Agent.

### Table AI Description

Use it to:
- understand what a workspace table contains
- inspect AI-generated summary, common questions, and related metadata
- manually refine the description if needed

Current behavior:
- AI Description generation runs through explicit states like `queued`, `processing`, `succeeded`, `failed`, and `stale`
- the UI reflects these states more clearly than before
- manual edits do not silently get overwritten
- schema changes can mark a description as stale

### Chart AI Description

Use it to:
- understand the chart intent and logic
- inspect AI-generated rationale and related metadata
- regenerate the description when the chart changes significantly

Important distinction:
- `manual chart note` and `AI Description` are different things in the UI
- the chart page now makes that distinction more explicit

## 6. Build Charts in Explore

Charts are created from workspace tables in `Explore`.

Typical flow:
1. Open `Explore`.
2. Choose a workspace and table.
3. Select a chart type.
4. Configure dimensions, metrics, and filters.
5. Preview the result.
6. Save the chart.

Common chart types:
- bar
- line
- area
- pie
- KPI
- table
- time series
- scatter

If a preview looks wrong:
- verify the source table
- verify filters
- verify time grain
- verify metric aggregation

## 7. Build Dashboards

Dashboards combine saved charts into a report layout.

Typical flow:
1. Open `Dashboards`.
2. Click `New Dashboard`.
3. Name the dashboard.
4. Add saved charts.
5. Arrange the layout.
6. Save changes.

Behavior notes:
- removing a chart from a dashboard does not delete the underlying saved chart
- layout is stored separately from chart definitions
- sharing a dashboard may cascade access to its dependent resources

## 8. Share Resources

AppBI supports resource-level sharing on top of module permissions.

Shareable resources include:
- data sources
- workspaces
- charts
- dashboards
- chat sessions where supported

Sharing rules:
- module permission decides whether the module is available at all
- resource sharing decides which specific objects a user can open
- ownership and resource-level checks still apply even when a module is visible

Typical flow:
1. Open the resource.
2. Click `Share`.
3. Select a user.
4. Grant `view` or `edit`.
5. Save.

## 9. Manage Permissions

AppBI uses module-level permissions with object-level enforcement.

Main modules:
- `data_sources`
- `datasets`
- `workspaces`
- `explore_charts`
- `dashboards`
- `ai_chat`
- `ai_agent`
- `settings`

Permission levels:
- `none`
- `view`
- `edit`
- `full`

Important notes:
- module permission alone is not enough to open every object
- resource ownership and sharing are enforced separately
- AI Agent requires both module permission and view access on the selected workspace tables

## 10. Use AI Chat

AI Chat is the reactive assistant.

Use AI Chat when you want to:
- ask questions in natural language
- inspect accessible data interactively
- summarize patterns
- generate a single chart during a conversation
- keep a session history and reopen it later

Requirements:
- `ai_chat >= view`
- access to the underlying data
- `ai-chat-service` must be running for live chat actions

Where it lives:
- UI entry: `/chat`
- service: `ai-service/`
- default port: `8001`

Behavior notes:
- the chat page still loads if the chat service is offline
- the UI shows a clear warning when chat is unavailable
- AI Chat is independent from AI Agent

## 11. Use AI Agent

AI Agent is the proactive report builder.

Use AI Agent when you want to:
- define a business goal
- select one or more workspace tables
- generate a dashboard plan first
- review and edit that plan
- build multiple charts and a complete dashboard automatically

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

### Current AI Agent flow

1. Open the Agent wizard from the dashboards page.
2. Search and choose one or more workspace tables.
3. Review the selected scope panel.
4. Fill in the structured brief.
5. Generate a plan.
6. Review and edit sections and charts.
7. Build the dashboard.
8. Open the result.

### Choose Tables step

The current table selection step is designed for larger numbers of workspaces and tables than the first version.

Current capabilities:
- search by workspace or table name
- expand or collapse workspaces
- `Select shown` and `Clear shown` per workspace
- selected scope summary on the right side
- remove selected tables directly from the summary panel
- workspace and table counts at the top of the step

Important rule:
- the Agent only uses the tables selected by the user
- it does not pull extra datasets outside that scope

### Write the Brief step

Current brief fields:
- business goal
- audience
- timeframe
- KPIs
- questions the dashboard must answer

This is enough for:
- initial dashboard generation
- one-off report creation
- review and edit before build

Current limitation:
- reusable saved report specs are not implemented yet
- if you want a new long-term report variant, you currently go through the wizard again

### Plan review

Before building, you can:
- rename the dashboard
- edit the dashboard summary
- edit section titles and intents
- rename charts
- edit chart rationale
- disable charts before build
- regenerate the plan
- reset your plan edits

### Current v1 scope rules

- multi-dataset means section-based composition only
- v1 does not blend or join across selected datasets
- build behavior follows:
  - `docs/GUIDED_API_CHART.md`
  - `docs/GUIDED_API_DASHBOARD.md`
  - `docs/GUIDED_API_AI_AGENT_REPORT.md`

## 12. Typical Workflow

Typical first workflow:
1. Connect a data source.
2. Run sync.
3. Create a workspace.
4. Add workspace tables.
5. Build charts in Explore.
6. Create or generate a dashboard.
7. Share the result.
8. Use AI Chat for ad hoc analysis.
9. Use AI Agent when you want a dashboard generated from a structured brief.

## 13. Troubleshooting

### Charts show no data
- confirm the source has been synced
- confirm the workspace table points to the expected source
- recheck chart filters and aggregation

### A user cannot open a shared dashboard
- confirm the user has at least `dashboards=view`
- confirm the dashboard is actually shared to that user
- confirm dependent resources are accessible

### AI Chat page loads but live chat fails
- confirm `ai-chat-service` is running
- confirm the user has `ai_chat` permission
- confirm the service can reach the backend

### AI Agent wizard opens but generation fails
- confirm `ai-agent-service` is running
- confirm the user has `ai_agent`, `dashboards`, and `explore_charts` permissions at the required levels
- confirm at least one accessible workspace table is selected

### AI Description stays stale or fails
- confirm backend AI keys are configured correctly
- check whether the table or chart was manually edited and is now marked stale
- retry regeneration from the modal

## 14. Related Docs

- [README.md](../README.md)
- [docs/DOCKER.md](./DOCKER.md)
- [docs/SETUP.md](./SETUP.md)
- [docs/API.md](./API.md)
- [docs/AI_AGENT.md](./AI_AGENT.md)
- [docs/GUIDED_API_CHART.md](./GUIDED_API_CHART.md)
- [docs/GUIDED_API_DASHBOARD.md](./GUIDED_API_DASHBOARD.md)
- [docs/GUIDED_API_AI_AGENT_REPORT.md](./GUIDED_API_AI_AGENT_REPORT.md)
