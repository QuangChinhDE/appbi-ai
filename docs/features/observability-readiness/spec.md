# Observability production readiness — spec

Contracts after the change. Verified IDs refer to the audit matrix in `plan.md`.

## 1. Native monitors (H01)

- `GET  /observability/datasets/{id}/monitors` — the dataset's monitors with last result
  and per-table **suggestions** (time columns for freshness). Needs dataset view.
- `PUT  /observability/datasets/{id}/monitors` — create/update/disable monitors
  (`kind`, `dataset_table_id`, `config`, `severity`, `is_active`). Needs dataset **edit**.
  Validates that the time column exists in the table and that `max_lag_hours` and
  `z_threshold` are within bounds.
- `DELETE /observability/monitors/{id}` — dataset edit. Its open incident is resolved with
  reason `monitor_removed`, never left orphaned.
- `POST /observability/datasets/{id}/scan` — runs **this dataset's** monitors and folds its
  quality, anomaly and semantic state. Needs dataset edit. Takes the same lock as the global
  scan and returns 409 if one is running.
- UI: the dataset's "Checks" tab gets an **Automatic checks** section (freshness / volume /
  schema per table, with on/off, configure and last result) above the existing quality
  rules. "Set up dataset" leads there, and enabling schema + volume is one click.

## 2. Incident lifecycle (H02, H06, N1)

- Upserts flush, so an incident opened earlier in the same scan is seen.
- A partial unique index `(dedup_key) WHERE status <> 'resolved'` makes duplicates
  impossible. The migration first merges existing duplicates (keeps the oldest open one,
  resolves the rest with `detail.merged_into`).
- Anomaly folding is per metric. Only alerts **newer than the last resolution** of
  that metric's incident can open one. The incident auto-resolves once the metric has had
  no alert for `max(2 × check interval, 3 days)`.
- `resolve` means "fixed". If the cause persists, the next scan re-opens it, which is
  honest. A schema incident gets a separate action, **`accept_schema`** (confirmation in
  the UI, audit-logged). It records the new baseline and resolves. `resolve` alone never
  changes the baseline.
- Every lifecycle action writes `detail.history` entries `{action, by, at}`.

## 3. Alert delivery (H03, N2)

- New table `observability_alert_deliveries (incident_id, channel_id, status
  pending|sent|failed|dead, attempts, last_error, next_attempt_at, sent_at)` with UNIQUE
  `(incident_id, channel_id)`.
- On open: one `pending` row per matching active channel. The dispatcher sends `pending`
  rows and `failed` rows that are due. Backoff is 5 min × 2^n; after 6 attempts the row is
  `dead`. Each send commits its own row, so a crash re-sends at most the one in flight
  (at-least-once). Webhooks carry `idempotency_key = "appbi-incident-{id}"`.
- The dispatcher runs at the end of every scan and from a 10-minute job under the
  same advisory-lock mechanism. Resolved incidents' pending rows are cancelled.
- Email HTML is escaped.
- The channel list shows delivery health (failed and dead counts, last error).

## 4. Volume baseline (H04)

Baseline = the last 30 checks with status `ok` only. While breached, the comparison stays
against the pre-incident baseline, so a sustained anomaly stays `breached` until it returns
to the normal band, or until a person accepts the new level (`accept_volume_baseline`,
same pattern as schema).

## 5. Health contract (H08, H11, H12)

- Dataset health stays `semantic_invalid > breached > error > unknown >
  not_monitored > healthy`. The UI uses `health` only, never `openIncidents`, to decide
  danger.
- The "Needs attention" filter = health in {semantic_invalid, breached, error}. Its label
  says so and its count comes from the same rule.
- Rows show **Checks**: active monitors + enabled rules, split into passing / failing /
  errored / not run. Paused or disabled checks are not counted.
- Every fetch in the module has Loading / Error (with retry) / Empty states. Errors never
  render as empty or healthy. 403 → No access, 404 → Not found.

## 6. Incidents feed (H05, H07, H13)

- `GET /observability/incidents` returns `{items, total, limit, offset}` with `q`
  (title search), `status`, `severity`, `pillar` (incl. `semantic`), `dataset_id` and
  stable sorting (severity, last_seen, id). The frontend is the only caller.
- `GET /observability/incidents/{id}` — single incident with `capabilities.act`. Returns 404
  when the incident is missing or the caller has no access.
- Overview: a **Needs attention** panel lists the top open incidents across datasets
  (critical first) and links to the incident.
- `?incident={id}` resolves the incident, then routes to `?dataset=X&dt=incidents&incident=id`,
  where that incident is expanded and scrolled into view. Not-found and no-access get their
  own state. Back and forward work, because routing uses `useUrlNav`.

## 7. Permissions (H09, H10, N4)

| Action | Requirement |
|---|---|
| view health, incidents, lineage | observability view + dataset view |
| acknowledge / resolve / reopen / accept baseline | observability edit + dataset **edit** |
| configure monitors, dataset scan | observability edit + dataset edit |
| global scan, global channels | observability full (admin) |
| dataset channel | observability edit + dataset edit (manage: owner or admin) |

- Incident and channel payloads carry `capabilities`. The UI hides or disables actions from
  them. Scan Now is shown only to admins; dataset editors get "Run checks" on the dataset.
- The channel modal gets a scope picker: Global (admin only) or a Dataset (the ones the user
  can edit). Manage buttons follow `capabilities.manage`, and every action reports failure.
- Lineage lists only charts and dashboards the caller can open. Others are counted
  (`hiddenCharts`, `hiddenDashboards`) but not named. Field usage is labelled *inferred*.

## 8. Scan runs — observability of observability (H15)

- New table `observability_scan_runs (id, scope global|dataset, dataset_id, trigger
  schedule|manual, started_at, finished_at, status running|succeeded|partial|failed,
  counts JSONB, errors JSONB)`.
- `scan_all` / `scan_dataset` record a run. Per-monitor errors make it `partial`. A failed
  commit makes it `failed` and the API returns 500. It never reports success. The bogus
  `dataset_id=0` incident is removed.
- Manual scans take the scheduler's advisory lock (`observability_scan`). A concurrent
  request gets 409.
- `GET /observability/status` — last scan run, scheduler next-run, failed/dead delivery
  counts and `stale` (no successful scan in 26 h). The overview shows a banner when stale,
  failed or partial.
- Check history retention: keep 90 days of `observability_checks`, pruned by the scan.
  Accepted baselines are never pruned.
