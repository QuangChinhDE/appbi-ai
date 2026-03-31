# AI Agent Report - Data Governance Domain Specification

> Status: implementation direction
> Scope: single-domain focus for `AI Agent Report`
> Audience: product, backend, frontend, AI/runtime developers
> Last updated: 2026-03-30

---

## 1. Purpose

This document narrows the `AI Agent Report` product scope to **one specialist domain only**:

- `data_governance`

The goal is to stop thinking about multi-domain architecture in the immediate term and instead build **one strong domain analyst** that works reliably, reads the right signals, and produces useful governance reports.

This document should be read together with:

- [AI_AGENT_REPORT_DOMAIN_STRATEGY.md](D:/appbi_code/Dashboard-App-v2/docs/AI_AGENT_REPORT_DOMAIN_STRATEGY.md)
- [GUIDED_API_AI_AGENT_REPORT.md](D:/appbi_code/Dashboard-App-v2/docs/GUIDED_API_AI_AGENT_REPORT.md)

---

## 2. Product Positioning

For this phase, `AI Agent Report` should behave as a:

**Senior Data Governance Analyst**

It is not trying to be:

- a generic BI analyst
- a generic dashboard generator
- a general business reporting AI

It should be best at:

- assessing governance health
- identifying metadata gaps
- surfacing stewardship risks
- prioritizing follow-up actions
- producing governance-focused narratives

---

## 3. Product Promise

The product promise for this domain is:

> "Give me the data inventory scope and the governance decision you need help with. I will assess metadata health, stewardship gaps, governance risks, and recommended actions like a senior governance analyst."

---

## 4. Primary Use Cases

The domain should cover these use cases first.

### 4.1 Governance health overview

Questions:

- How healthy is the current data inventory?
- Which governance dimensions are weakest?

### 4.2 Metadata completeness review

Questions:

- Which assets are missing critical metadata?
- Which domains or departments are weakest on coverage?

### 4.3 Stewardship and ownership review

Questions:

- Which assets do not have an owner or steward?
- Which teams need follow-up first?

### 4.4 Governance risk review

Questions:

- Which assets are riskiest from a governance perspective?
- Which sensitive assets are not properly described or classified?

### 4.5 Action prioritization

Questions:

- What should be fixed first?
- Which domains will create the most impact if improved first?

---

## 5. Non-Goals

The domain should **not** try to optimize for:

- revenue analysis
- sales performance
- growth reporting
- finance variance reporting
- product analytics
- support analytics

If the brief looks like one of those, the system should still stay in governance mode and interpret it through governance signals only.

---

## 6. User Input Model

The brief should remain compact.

## 6.1 Step 1

User selects the tables the agent is allowed to use.

The agent must stay bounded to this scope.

## 6.2 Step 2

Keep the short brief model.

Fields:

1. `goal` - required
2. `audience`
3. `timeframe`
4. `notes`
5. `comparison_period`
6. `detail_level`

### 6.3 How these fields should be interpreted in this domain

#### `goal`

Should represent a governance decision.

Examples:

- Which data domains should be prioritized for metadata cleanup?
- Where are the biggest governance gaps in the inventory?
- Which tables require stewardship follow-up first?

#### `audience`

Controls narrative style.

- `exec`: concise, risk-oriented, action-led
- `manager`: operational, ownership-focused
- `analyst`: deeper breakdown, more evidence

#### `timeframe`

Should be used only when the dataset supports time context.

If no valid time signal exists, the system should interpret the data as:

- inventory snapshot
- current-state governance review

#### `notes`

Used for important caveats only.

Examples:

- snapshot inventory only
- owner field is incomplete
- sensitivity tags are under migration

#### `comparison_period`

Used only when meaningful.

If no time-compatible data exists:

- do not force comparison narratives
- add a caveat that comparison is limited by the available snapshot structure

#### `detail_level`

Controls depth of:

- section count
- caveat detail
- action recommendations
- amount of breakdown

---

## 7. Domain Vocabulary

This domain should maintain a governance-specific vocabulary layer.

## 7.1 Core concepts

- metadata completeness
- ownership coverage
- stewardship
- classification
- sensitivity tagging
- freshness
- lifecycle health
- active vs inactive assets
- domain / department coverage
- governance risk

## 7.2 Important terms

The system should understand terms like:

- owner
- steward
- metadata
- description
- glossary
- sensitivity
- classification
- department
- domain
- criticality
- active
- deactive
- stale
- inventory
- asset
- coverage

## 7.3 Synonym mapping

The runtime should support synonyms for common fields.

Examples:

- `owner`, `data_owner`, `steward`, `asset_owner`
- `description`, `desc`, `table_description`
- `department`, `dept`, `domain`, `business_domain`
- `sensitivity`, `classification`, `is_sensitive`, `sensitivity_level`
- `status`, `active_flag`, `is_active`, `lifecycle_status`
- `updated_at`, `last_seen`, `snapshot_date`, `last_refresh`

---

## 8. Required Table Understanding

The system should perform strong column interpretation for this domain.

## 8.1 High-value column groups

The following are especially valuable:

- asset identifier
- asset name
- owner / steward
- description
- department / domain
- active status
- sensitivity / classification
- freshness / update timestamp
- layer / zone / source system
- criticality

## 8.2 If these columns do not exist

The system must not hallucinate.

Instead it should:

- reduce confidence
- narrow the analysis
- surface explicit caveats

---

## 9. Governance KPI Canon

The domain should maintain a KPI canon that the AI can infer from available columns.

## 9.1 Primary KPI set

- total assets / total tables
- active asset count
- inactive asset count
- owner coverage
- description coverage
- department/domain coverage
- sensitivity coverage
- freshness coverage
- critical metadata completeness
- follow-up candidate count

## 9.2 Secondary KPI set

- completeness score by domain
- completeness score by team
- orphaned asset count
- risky sensitive asset count
- stale asset count
- metadata inconsistency count

## 9.3 KPI selection rule

The user should not need to enter KPIs manually.

The runtime should infer KPI priorities from:

- available fields
- selected goal
- audience
- detail level

---

## 10. Default Question Framework

The domain should infer analytical questions from a fixed governance question framework.

## 10.1 Coverage questions

- How complete is the metadata coverage?
- Which critical metadata fields are most often missing?

## 10.2 Ownership questions

- Which assets are missing owner or steward information?
- Which domains have the weakest ownership coverage?

## 10.3 Risk questions

- Which assets are highest risk from a governance perspective?
- Which sensitive assets lack enough metadata or controls?

## 10.4 Lifecycle questions

- How healthy is the asset lifecycle?
- What proportion of assets are inactive, stale, or poorly maintained?

## 10.5 Action questions

- Which teams or domains should be addressed first?
- What are the highest-priority governance actions?

The planner should derive from this framework instead of inventing unrelated business questions.

---

## 11. Section Archetypes

The planner should prefer a stable set of governance-oriented section archetypes.

## 11.1 Recommended section set

1. `Governance Health Overview`
2. `Critical Metadata Coverage`
3. `Breakdown by Domain or Department`
4. `Governance Risk Hotspots`
5. `Priority Follow-Up Actions`

## 11.2 Notes

- The planner may rename sections for readability.
- It should not drift into generic performance section titles.
- Section names should reflect governance intent, not raw table names.

---

## 12. Chart Archetypes

This domain should prefer stable, readable chart choices over novelty.

## 12.1 Preferred chart types

- KPI
- BAR
- STACKED_BAR
- GROUPED_BAR
- TIME_SERIES only when time is valid
- TABLE

## 12.2 Restricted usage

- `PIE` should be used sparingly
- only when category count is small and composition is truly the point

## 12.3 Chart mapping rules

### Metadata completeness

Use:

- BAR
- STACKED_BAR

### Domain or department comparison

Use:

- ranked BAR
- GROUPED_BAR

### Active vs inactive

Use:

- KPI
- BAR

### Risk asset list

Use:

- TABLE

### Trend over time

Use:

- TIME_SERIES

Only when there is a reliable time field.

---

## 13. Governance Scoring

This domain should include deterministic scoring.

The LLM should narrate the result, not invent the scoring logic.

## 13.1 Governance health score

Recommended conceptual inputs:

- owner present
- description present
- department/domain present
- classification present
- active status present
- freshness signal present
- metadata consistency

Example score weights:

- owner present: 25
- description present: 20
- department/domain present: 15
- classification present: 15
- active status present: 10
- freshness present: 10
- consistency: 5

## 13.2 Governance risk score

Risk should increase when:

- missing owner
- missing description
- missing classification
- stale signal
- inactive but still high-value
- conflicting metadata
- sensitive asset with weak controls

## 13.3 Output usage

These scores should drive:

- ranking
- priority action selection
- executive summary emphasis

---

## 14. Deterministic vs LLM Responsibilities

This domain should be more deterministic than a generic BI domain.

## 14.1 Deterministic responsibilities

- field synonym resolution
- metadata completeness detection
- risk scoring
- coverage scoring
- ownership gap detection
- ranking by domain / team / asset
- trend eligibility checks

## 14.2 LLM responsibilities

- final section naming
- strategy summary
- executive summary
- narrative stitching
- action recommendation wording
- audience-sensitive tone

## 14.3 Important rule

The LLM should not be the source of truth for governance scoring.

It should explain and prioritize deterministic findings.

---

## 15. Prompting Rules

The domain-specific prompt should define the role clearly.

## 15.1 Required system framing

The model should be told:

- you are a Senior Data Governance Analyst
- your task is to assess governance health
- focus on metadata completeness, ownership, classification, lifecycle health, and actionable follow-up

## 15.2 The prompt must explicitly forbid

- generic business-growth insights
- generic sales/performance framing
- overconfident trend claims without time support
- positive claims without evidence

## 15.3 The prompt should explicitly require

- governance lens
- evidence-first reasoning
- caveats when the dataset is only a snapshot
- action prioritization

---

## 16. Expected Output Shape

## 16.1 Executive summary

Must answer:

- overall governance health
- main gap
- biggest risk area
- where to act first

## 16.2 Top findings

Should refer to:

- coverage gaps
- risky assets
- weak teams/domains
- meaningful score-based signals

## 16.3 Priority actions

Should be concrete.

Examples:

- complete ownership metadata for domain X
- backfill descriptions for assets in team Y
- validate sensitivity tags for critical assets in zone Z

---

## 17. Step 3 Review UX Requirements

Even if the current 4-step flow is kept, Step 3 should reflect governance logic clearly.

It should show:

- domain badge: `Data Governance`
- inferred governance lens
- selected governance checks
- section intent in governance language
- risk assumptions and caveats

The user should feel that the plan is reviewing governance health, not generic dashboard logic.

---

## 18. Backend Changes Needed

## 18.1 Near-term

For the single-domain phase, it is acceptable to:

- hard-focus planner behavior to governance
- avoid full multi-domain registry implementation

## 18.2 Recommended code organization even in single-domain mode

Still isolate governance logic into clear modules.

Suggested structure:

```text
ai-agent-service/app/domains/
  data_governance/
    __init__.py
    config.py
    glossary.py
    scoring.py
    heuristics.py
    prompts.py
    review.py
```

This keeps the code migration-friendly later.

## 18.3 Planner integration

Planner should call governance modules for:

- field mapping
- KPI inference
- question inference
- section recommendation
- risk scoring
- plan review

---

## 19. Frontend Changes Needed

## 19.1 Immediate

If the product is temporarily single-domain:

- no domain selector is required yet
- Step 2 copy should speak in governance language
- Step 3 labels should speak in governance language

## 19.2 Later

When multi-domain comes back:

- add a domain selector
- persist `domain_id` and `domain_version`

For now, keep FE simple and make the text/domain behavior governance-first.

---

## 20. Evaluation Plan

This domain should have a dedicated evaluation suite.

## 20.1 Required test datasets

1. inventory with strong metadata
2. inventory with weak ownership coverage
3. inventory with weak descriptions
4. inventory with sensitive assets missing classification
5. inventory with no valid time dimension
6. inventory with department/domain breakdown
7. inventory with high null and noisy metadata

## 20.2 Required evaluation checks

- does the AI stay in governance mode?
- does it avoid generic business insights?
- does it avoid false trend claims without time support?
- does it surface the right risks?
- does it produce useful actions?
- does it choose appropriate section structure?

---

## 21. Acceptance Criteria

The domain can be considered good enough when:

1. the planner consistently produces governance-oriented sections
2. the narrative uses governance language, not generic BI language
3. risky assets and weak coverage areas are ranked sensibly
4. time-based claims are only made when supported
5. recommendations are specific and actionable
6. reviewers can trust Step 3 as a governance review workspace

---

## 22. Recommended Implementation Order

### Phase 1 - Single-domain lock

- hard-focus the system on `data_governance`
- remove generic reporting language where it conflicts

### Phase 2 - Domain logic extraction

- build synonym mapping
- build KPI canon
- build question framework
- build section archetypes
- build governance scoring

### Phase 3 - Planner integration

- wire governance heuristics into the planner
- keep chart build/runtime generic

### Phase 4 - UX alignment

- update Step 2 copy
- update Step 3 review language
- make risk and governance logic visible

### Phase 5 - Evaluation hardening

- create fixtures
- define regression checks
- review outputs with product/domain expectations

---

## 23. Short Summary

To make `AI Agent Report` truly strong in `data_governance`, we should build it as:

- a **Data Governance Analyst engine**
- with **short user input**
- **deterministic governance logic**
- **LLM-assisted narrative and prioritization**
- **governance-specific review UX**

This is the shortest path to real quality.
