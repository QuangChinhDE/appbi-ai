# Observability production readiness — intent

## Problem (evidence: audit of demo@96b94da8, 2026-10-08)

Observability looks like a working module, but on a real backend and Postgres:

- Freshness, volume and schema checks **never run**. No code path creates an
  `ObservabilityMonitor` (`grep` across backend, frontend and scripts finds the
  model, the migration and one test only). "Set up dataset" just opens the Quality tab.
- When the API fails, the UI shows **"All monitors are healthy"** (browser,
  backend stopped). That is the worst outcome a monitoring tool can have.
- A resolved anomaly comes back as a **new incident on every scan for 14 days** and is never
  auto-resolved. Two alerts for one metric open **two** incidents (autoflush=False).
- Once any channel is healthy, every scan **re-sends every open incident** to every
  channel. A failed delivery has no state of its own.
- A sustained volume drop **becomes the baseline**: 0 rows reads `breached` once, then `ok`.
- A dataset **view** share can acknowledge and resolve incidents. Lineage gives a dataset
  viewer the **names of private charts and dashboards**.
- A dataset failing a quality check is hidden by "Only issues" until the daily scan runs.
  A notification link (`?incident=`) opens the generic list.
- A scan whose commit fails returns an ordinary result (its fallback incident has
  `dataset_id=0`, which violates the FK).

## Outcome

A user opening Observability can trust what it says: healthy only when checks ran and
passed, failures shown as failures, every problem findable, alerts sent once and retried
when they fail, and every action honest about what it changes.

## Non-goals

- A new anomaly-detection engine (the Phase-4 engine stays; only its folding changes).
- Refactoring Dataset Quality, Source, Chart or Dashboard.
- Production deployment (needs separate approval).
