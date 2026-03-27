# GUIDED_API_AI_AGENT_REPORT.md - AI Agent Report Builder Guide

> Source-of-truth for the standalone `ai-agent-service` report builder.
> This document sits on top of `GUIDED_API_CHART.md` and `GUIDED_API_DASHBOARD.md`.
> When implementation and older AI code disagree, the guided API docs win.
> Last updated: 2026-03-27

---

## 1. Scope

`AI Agent` is a proactive report builder.

It is intentionally separate from `AI Chat`:
- `AI Chat` answers questions, explores, and may create one chart when needed.
- `AI Agent` plans a report, creates multiple charts, assembles a full dashboard, and generates narrative insights.

V1 constraints:
- Entry point is `/ai-reports` (wizard) or `/ai-reports/new`
- User must explicitly choose `1..n` workspace tables
- Agent only uses selected tables
- No cross-dataset join or blending in V1
- Output is a complete dashboard plus narrative insight report

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

AI Agent env vars (in `docker-compose.agent.yml`):
- `OPENROUTER_API_KEY` (required)
- `LLM_MODEL` (default model)
- `AI_AGENT_ENRICHMENT_MODEL` (brief enrichment phase)
- `AI_AGENT_PLANNING_MODEL` (dashboard strategy phase)
- `AI_AGENT_INSIGHT_MODEL` (insight generation phase)
- `AI_AGENT_NARRATIVE_MODEL` (blueprint narrative phase)
- `AI_AGENT_LLM_FALLBACK_CHAIN` (comma-separated fallback models)
- `AI_AGENT_LLM_TIMEOUT_SECONDS` (timeout in seconds)

---

## 3. Planning Pipeline

The planning flow runs when the user submits a brief in Step 2:

1. **`parse_brief`** (rule-based) — creates baseline `ParsedBriefArtifact` from 6 fields
2. **`load_table_contexts`** — fetches workspace metadata, table preview (40 rows), table descriptions
3. **`enrich_brief`** (LLM Call 1) — enriches the baseline with:
   - `business_domain` — identified industry
   - `primary_kpis` / `secondary_kpis` — inferred from goal + columns
   - `must_answer_questions` — 4-6 domain-specific questions
   - `table_relationships` — cross-table join opportunities
   - `narrative_arc` — story arc from opening to closing action
   - `important_dimensions` / `risk_focus`
4. **`profile_table`** — column type inference, metric/dimension/time candidates
5. **`build_profiling_report`** — null risk, freshness, grain analysis
6. **`build_dataset_fit_report`** — per-table fit scoring with `dimension_cardinality`
7. **`evaluate_quality_gate`** — blockers, warnings, confidence penalties
8. **`build_analysis_plan`** — question-to-table mapping (per question, not global)
9. **`_generate_strategy_with_llm`** (LLM Call 2) — dashboard sections and chart specs
10. **`_review_plan_quality`** — quality scoring, warning deduplication

---

## 4. API Contracts

### 4.1 Plan endpoint (streaming)

```http
POST /agent/plan/stream
Authorization: Bearer <jwt>
Content-Type: application/json
```

Request body (`AgentBriefRequest`):

```json
{
  "output_language": "auto",
  "goal": "Phân tích doanh thu Q4 theo vùng miền",
  "audience": "manager",
  "timeframe": "Q4 2025",
  "comparison_period": "same_period",
  "detail_level": "overview",
  "notes": "Dữ liệu tháng 12 có thể chưa đầy đủ",
  "planning_mode": "deep",
  "selected_tables": [
    {"workspace_id": 1, "table_id": 2},
    {"workspace_id": 1, "table_id": 3}
  ]
}
```

Stream events (NDJSON):

```json
{"type":"phase","phase":"parse_brief","message":"Interpreting the business brief..."}
{"type":"phase","phase":"enrich_brief","message":"Analyzing domain, inferring KPIs..."}
{"type":"phase","phase":"profile_tables","message":"Profiling metrics, time fields, segments..."}
{"type":"phase","phase":"dataset_fit","message":"Scoring table fit against questions..."}
{"type":"phase","phase":"quality_gate","message":"Checking data coverage and risk..."}
{"type":"phase","phase":"analysis_plan","message":"Building analysis logic..."}
{"type":"phase","phase":"report_strategy","message":"Building dashboard strategy..."}
{"type":"phase","phase":"chart_candidates","message":"Translating strategy into charts..."}
{"type":"phase","phase":"plan_review","message":"Reviewing draft quality..."}
{"type":"done","phase":"done","message":"Draft ready for review.","plan":{...}}
```

Response plan includes:
- `dashboard_title`, `dashboard_summary`, `strategy_summary`
- `sections[]` — business-intent titled sections with `chart_keys`
- `charts[]` — chart specs with `hypothesis`, `why_this_chart`, `confidence`, `config`
- `parsed_brief` — enriched brief with `business_domain`, `table_relationships`, `narrative_arc`
- `dataset_fit_report[]`, `profiling_report[]`, `quality_gate_report`, `analysis_plan`
- `quality_score`, `quality_breakdown`, `warnings` (deduplicated)

### 4.2 Build endpoint (streaming)

```http
POST /agent/build/stream
Authorization: Bearer <jwt>
Content-Type: application/json
```

Request body (`AgentBuildRequest`):

```json
{
  "brief": {"...": "same AgentBriefRequest"},
  "plan": {"...": "approved AgentPlanResponse"},
  "build_mode": "new_dashboard",
  "report_spec_id": 13,
  "report_run_id": 12
}
```

Stream events:

```json
{"type":"phase","phase":"validate","message":"Validated permissions and selected plan."}
{"type":"chart_created","phase":"building_charts","message":"Created chart...","chart_id":42}
{"type":"phase","phase":"generating_insights","message":"Reading chart data and drafting insights."}
{"type":"phase","phase":"composing_report","message":"Composing AI report reader..."}
{"type":"done","phase":"done","message":"Done.","dashboard_id":11,"dashboard_url":"/dashboards/11","report_url":"/ai-reports/13"}
```

### 4.3 Report Spec CRUD (backend)

```
GET    /api/v1/agent-report-specs/              — list user's specs
POST   /api/v1/agent-report-specs/              — create spec
GET    /api/v1/agent-report-specs/{id}          — get spec with runs
PUT    /api/v1/agent-report-specs/{id}          — update spec
DELETE /api/v1/agent-report-specs/{id}          — delete spec
POST   /api/v1/agent-report-specs/{id}/runs/    — create run
PATCH  /api/v1/agent-report-specs/{id}/runs/{rid} — update run status
```

`AgentReportSpec` fields:
- `name`, `description`, `status` (draft/ready/running/failed/archived)
- `current_step` (select/brief/plan/building)
- `selected_tables_snapshot`, `brief_json`, `approved_plan_json`
- `latest_dashboard_id`, `runs[]`

`AgentReportRun.result_summary_json` contains:
- `created_chart_count`, `build_mode`
- `executive_summary`, `top_findings`, `headline_risks`, `priority_actions`
- `insight_report` — full `InsightReportArtifact` (section + chart insights)
- `dashboard_blueprint` — reading order, section intros, chart captions

---

## 5. Build Sequence

1. Validate JWT and module permissions.
2. Preflight: validate chart configs (required roleConfig fields).
3. Create charts via `POST /charts/` and verify each with `GET /charts/{id}/data`.
4. Create dashboard via `POST /dashboards/`.
5. Attach charts to dashboard with computed layouts.
6. Generate insight report from actual chart data (includes actual values in evidence).
7. Compose dashboard blueprint with narrative flow.
8. Update run with `result_summary_json`.
9. Return dashboard URL and report URL.

---

## 6. Rules Borrowed From GUIDED_API_CHART.md

The Agent builder must enforce these rules in code:
- Chart payload must include `name`, `chart_type`, `workspace_table_id`, and `config`.
- `chart_type` must be uppercase.
- `config.workspace_id` is required.
- `config.chartType` must match `chart_type`.
- `config.roleConfig` is required.
- `config.filters` should always be present, default `[]`.
- Metric `agg` values must use the API format from the chart guide.

---

## 7. Rules Borrowed From GUIDED_API_DASHBOARD.md

- Dashboard is created first, then charts are attached.
- Layout update uses `PUT /dashboards/{id}/layout`.
- `chart_layouts[].id` is `DashboardChart.id` (not the original `chart_id`).

---

## 8. Multi-Dataset V1 Rules

V1 multi-dataset means composition, not blending.

Allowed:
- One dashboard with multiple sections
- Each section tied to one selected table
- Different charts may come from different selected tables
- Cross-table relationship hints in enrichment (for narrative, not SQL joins)

Not allowed in V1:
- SQL join between selected tables
- Derived chart that references columns from two tables

---

## 9. Frontend UX Contract

The AI Reports wizard lives at `/ai-reports/new` (new) and `/ai-reports/{id}/edit` (existing).

4-step wizard:
1. **Select tables** — checkbox list with inline descriptions, selected chips
2. **Write brief** — 6-field form with sidebar showing table descriptions and readiness
3. **Review plan** — single-scroll page with sections containing inline chart cards; technical details collapsible
4. **Build and view** — progress checklist during build; inline report after completion (executive summary, findings, risks, actions, section narratives, chart insights)

State persistence:
- Wizard state is persisted as `AgentReportSpec` in the backend
- Returning to `/ai-reports/{id}/edit` restores the wizard at the correct step
- Build results are restored from `result_summary_json` of the latest successful run
- Step 4 shows the inline report even after navigation away and back

Frontend must:
- Hide or disable Agent CTA when required module permissions are missing
- Handle `ai-agent-service` unavailable state gracefully
- Keep `AI Chat` independent from Agent UI and transport

---

## 10. Insight Generation Data Contract

The insight generator receives actual chart data rows and produces:

Per chart:
- `caption` — headline summary
- `finding` — analytical insight (different from caption)
- `evidence_summary` — actual values: total, avg, top segment + share%, trend%
- `confidence` — 0.0–1.0
- `warning_if_any` — data caveat if applicable

Per section:
- `summary`, `key_findings[]`, `caveats[]` (from chart warnings + quality gate), `recommended_actions[]`

Executive level:
- `executive_summary` — includes cross-table relationship context
- `top_findings[]`, `headline_risks[]` (deduplicated), `priority_actions[]`

---

## 11. Definition Of Done

Feature is considered complete when:
- Chat and Agent run as separate Docker services
- Agent uses its own API/router/service code path
- `ai_agent` module permission is enforced backend + frontend
- Build payloads follow chart and dashboard guided docs
- Dashboard generation works with one or many selected tables
- Partial failure is handled without creating empty dashboards
- Chat flow remains unchanged
- Report specs are persisted and restorable
- Build results include narrative insights with actual data evidence
- Wizard supports full Vietnamese and English language
