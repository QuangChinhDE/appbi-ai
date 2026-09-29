# Report Studio: release, migration and rollback (PR stack #5 → #6 → #7)

This document is for the person who deploys the stacked Report Studio change and who may have to roll it back. It covers four things:

- the order of operations;
- what each migration does to existing reports;
- what a rollback can and cannot restore;
- the checks to run after deploying.

Nothing here has been deployed. Deployment and merge need explicit owner authorization.

## 1. What ships

| PR | Branch | Base | Migrations |
|---|---|---|---|
| #5 | `feat/dashboard-design-engine-v2` | `demo` | none |
| #6 | `feat/report-experience` | #5 | `20260926_0001`: audit values for AI Design content proposals (enum values only). `20260926_0201`: no-op merge with Agent Flow's line |
| #7 | `feat/report-studio-v3` | #6 | `20260928_0001`: canvas reports become grid reports. `20260929_0001`: the slicer bar becomes controls on the grid. `20260930_0001`: no-op merge |

- All three branches carry `demo` at `30a048f4`, which includes Agent Flow V3 (PR #3, PR #4) and its migrations `20260925_0001` → `20260926_0101`.
- Alembic graph: see "Combined with Agent Flow" in §4. After each PR lands, `demo` has a single head: `20260926_0101` after #5, `20260926_0201` after #6, `20260930_0001` after #7.
- New layout keys: `sectionId` and `emphasis`. They are written by the builder and by AI Design; they are not columns.
- New widget types: `narrative` and `slicer`. They are stored in the existing `widget_type` string column; there is no schema change for them.
- No other schema change.

## 2. Order of operations

1. **Merge in stack order.**
   - #5 into `demo`, then retarget #6 to `demo` and merge it, then #7.
   - Wait for green CI after each merge.
   - Do not merge #7 alone: it depends on #6's content-proposal audit and narrative widgets.
2. **Back up the database** (`pg_dump`) immediately before migrating.
   - `20260928` and `20260929` rewrite report layouts. The backup is the only complete undo for reports that authors edit afterwards (§4).
3. **Run the migrations once**, from the new backend image: `alembic upgrade head`.
   - Expect one log line per revision. On a `demo` database already at Agent Flow's `20260926_0101`, the full stack runs these five (the two merges do nothing but join the graph):
   - Stop if the command reports anything other than a single head.

   ```
   Running upgrade 20260914_0002 -> 20260926_0001, Audit values for AI Design content proposals.
   Running upgrade 20260926_0101, 20260926_0001 -> 20260926_0201, Join Agent Flow's line and the Report Experience line …
   Running upgrade 20260926_0001 -> 20260928_0001, Canvas dashboards become Grid dashboards.
   Running upgrade 20260928_0001 -> 20260929_0001, The slicer bar becomes controls on the grid.
   Running upgrade 20260926_0201, 20260929_0001 -> 20260930_0001, Join the combined Agent Flow + Report Experience line …
   ```

   Alembic may print the two branches' revisions in a different interleaving; the set is what matters.

4. **Deploy the backend, then the frontend.**
   - The new frontend relies on the new backend's widget normalizer: canonical report-header keys, the neutral callout tone, and draft-only additions.
   - An old backend would store a new header's title under a key the renderer then ignores.
5. **Rebuild the frontend image.**
   - `./run.sh` bakes sources into the image; copying files over a running container does not change the bundle (see AGENTS.md, "two modes").

## 3. What the migrations do to existing reports

- **`20260926_0001`** adds enum values.
  - Its downgrade is a no-op by design: Postgres cannot drop enum values.
  - The values stay after a downgrade and are harmless to older code.
- **`20260928_0001`** converts each canvas report to a grid report.
  - It derives grid cells from the canvas pixel positions.
  - It records `canvas_config.migratedFromCanvas` with the tiles it derived.
  - The downgrade restores `layout_mode='canvas'` and removes only the cells it derived.
- **`20260929_0001`** handles the slicer bar, per report and per page:
  - every filter the old slicer bar drew becomes a `slicer` control in a band at the top of the page;
  - the page's tiles move down by the band's height, in the live rows and in every pending draft;
  - it records `slicer_cluster_layout.migratedToGrid` with the controls it created and the shifts it applied;
  - no filter's field, operator, value, scope or link restriction changes;
  - a report whose filter UI was hidden gets no control.

## 4. Rollback: what can and cannot be restored

The full stack was rehearsed on a copy of the rig database (`CREATE DATABASE … TEMPLATE`): 58 reports and 709 tiles, down to `20260914_0002` and back up to head. The evidence is in `evidence/a7-migration-roundtrip.json`, and every figure in this section comes from that run.

**What the downgrade restores:**

- It deleted exactly the 38 controls the migration had made, and moved their tiles back up.
- The canvas report (445) returned to `layout_mode='canvas'`.
- The re-upgrade recreated the controls. Tile counts are identical at both ends (709 → 692 → 709). The round trip adds no overlap: the 32 stored overlaps that exist at head (settled at render, as viewers see them) are the same 32 after it.

**What the downgrade does not restore:**

1. **Controls an author placed after the upgrade stay as rows.** The rehearsal had 34. The same is true for `narrative` blocks, which are new in #6/#7. Pre-stack frontend code renders both as an "Unknown widget type" box, on the builder and on public links. Before switching the code back, find them with this read-only query:

   ```sql
   SELECT dashboard_id, widget_type, count(*)
   FROM dashboard_charts
   WHERE widget_type IN ('slicer', 'narrative')
   GROUP BY 1, 2 ORDER BY 1;
   ```

   Then either remove those rows from the reports they appear in, with the owners' agreement, or restore the pre-upgrade backup.

2. **Reports edited after the upgrade may not return to their exact layout.** Report 574 had a control placed next to the migration's control:
   - The downgrade moved back only the tiles whose destination was free. It never overlaps; it leaves a gap instead.
   - A later re-upgrade shifts the page again, so 574 ended 3 rows lower.
   - No filter or data changed. Only positions did.

3. **Copies of reports** made after the upgrade inherit their source's marker.
   - The scoped downgrade leaves the source's rows alone and drops the inherited marker (21 copies in the rehearsal).
   - No tile in a copy changes.

4. **New layout keys stay** after a rollback: `sectionId` and `emphasis`.
   - Older code ignores them, and lays out and renders by geometry exactly as before.
   - A callout saved with the new `neutral` tone renders with the accent tone in older code.

**The rollback paths, in order of preference:**

- **Frontend only** (keep the backend and schema): new data renders in the previous frontend of this stack. Section membership and emphasis are ignored. Nothing is lost.
- **Before any author uses the new controls:** run `alembic downgrade 20260914_0002` with the *new* image (it holds the downgrade code), then deploy the old code. This is a clean return.
- **After authors have edited:** restore the pre-upgrade backup for an exact state; edits made since are lost. Alternatively, downgrade and clean up with the query above, accepting the layout drift described in item 2.

**Combined with Agent Flow.** Both streams branch off `20260914_0002`:

- Agent Flow V3: `20260925_0001` → `20260926_0101`.
- Report Studio: `20260926_0001` → `20260928_0001` → `20260929_0001`.

Agent Flow landed in `demo` first. Report Studio joins the two lines with two no-op merge revisions, so that `demo` has one head after each PR:

- `20260926_0201` (#6): `down_revision = ("20260926_0101", "20260926_0001")`.
- `20260930_0001` (#7): `down_revision = ("20260926_0201", "20260929_0001")`.

`20260928_0001` keeps its parent `20260926_0001`. Re-parenting it onto the merge would let a database already at `20260929_0001` read as past Agent Flow's migrations and never run them. (An earlier plan used one merge at the top; it would have left `demo` with two heads between #6 and #7.)

Agent Flow originally shipped its migration under `20260926_0001`, the same ID Report Studio uses. A database that applied Agent Flow's under that old ID is re-labelled to `20260926_0101` by `app/core/alembic_reconcile.py`, which reads the schema to decide. #6 adds one rule to it (`fa180520`, reviewed by the Agent Flow owner): when `20260926_0101` is already recorded, a `20260926_0001` row is Report Studio's and is left alone. That state exists between the two lines and their merge. `20260926_0001` commits the version table mid-upgrade, so an interrupted upgrade can leave it. Re-labelling it would have hit `alembic_version`'s primary key and stopped the backend from starting.

**Rehearsed on real Postgres** (`evidence/integration-migration-rehearsal.json`). Each scenario ran on its own copy of the rig database (62 reports, 762 tiles) or on a fresh database; every copy was dropped afterwards.

| Start | Path | End |
|---|---|---|
| Report Studio lineage, `20260929_0001` | `upgrade head` | `20260930_0001` |
| Agent Flow lineage, `20260926_0101` (demo today) | → `20260926_0201` (demo after #6) → `head` (after #7) | `20260930_0001` |
| Agent Flow under its old ID `20260926_0001` | `upgrade head` (re-labelled first) | `20260930_0001` |
| Both lines recorded, merge not yet | `upgrade head` | `20260930_0001` |
| Fresh, empty | `upgrade head` (173 revisions) | `20260930_0001` |

- All five end with an identical schema: columns, enum values and indexes.
- The Agent Flow line changes no report content. The Agent Flow-lineage path differs from the Report Studio-lineage path only in report 574: the same 8 tiles as item 2 above, because that path rolls Report Studio back to `20260914_0002` first. A control run that never applies Agent Flow gives the identical result.

At a merge point, `alembic downgrade -1` is ambiguous. Name the target instead:

- to undo only #7's data migrations, `alembic downgrade 20260926_0201`;
- to undo all of Report Studio and keep Agent Flow, `alembic downgrade 20260926_0101`;
- to go below both streams, `alembic downgrade 20260914_0002`.

The first two were rehearsed from the combined head on the data copy: each re-upgrade returned the same reports and tiles, and Agent Flow's columns stayed. The third was rehearsed from the combined head on a fresh database. All 7 revisions went down, no Agent Flow column remained, and the re-upgrade produced the same schema. Its effect on report data is the Report Studio round trip above.

The Agent Flow migrations are additive. The Report Studio ones rewrite layouts, so the limits above still apply to them.

## 5. Post-deploy checks

- `SELECT version_num FROM alembic_version` returns exactly one row, `20260930_0001`.
- Controls exist for reports with visible filters, and no report has a filter area outside its grid:

  ```sql
  SELECT count(*) FROM dashboards
  WHERE slicer_cluster_layout ? 'migratedToGrid';
  ```

  Spot-check three reports (one with pages, one with a public link that locks a field, one former canvas report). The builder and the public link must show the same tiles and the same filter statements. The public link must not show a control for a locked field.
- **Reading a report:**
  - open one report as a viewer at 1440, 820 and 390 px, with no sideways scroll;
  - the report header states the period and the filters in force;
  - on a phone, each section heading is directly followed by its own charts.
- **Export one PDF** of a long report, in each language. The sheets carry the report's title, description, page, filters and "data as of". A report that prints small is reported as a note, not as missing data.
- **Watch the backend log** for 5xx on the following during the first hour:
  - `/dashboards/{id}` (builder);
  - `/public/dashboards/{token}`;
  - `/dashboards/{id}/widgets`.

## 6. Behaviour changes a publisher should know

- **The report description is now shown on public links.**
  - It appears in the report header, in the masthead when a page has no header, and on every PDF sheet.
  - It was already in the public payload, so this exposes nothing new. But no link setting hides it, because the link's `summary`/`show_summary` fields are not settable today.
  - Review descriptions of reports shared externally before deploying.
- **The report header and PDF state the link's title for its audience:** the headline, else the link name, else the report name. This is the same as the masthead and the link manager's contract.
- **A parameter switcher on a public link shows no selection when it is bound to a field or to a chart's what-if slot.** The public data path does not apply parameters, so showing one would state a filter the charts ignore. A text-only switcher shows its default.

## 7. Not verified here

- **BigQuery-backed gates:** BLOCKED.
  - This machine has no warehouse credentials. The `GCP_SERVICE_ACCOUNT_*` variables are empty, there is no gcloud application-default credential, and the BigQuery connector is not authorized.
  - The `galaxy_golden` and `distinct_cascade_bq` harnesses are declared `missing` in `guardrail_rules.yaml`: they have never been committed.
  - No BigQuery result is claimed.
- **Fixed in code, not yet executed on BigQuery:** text filters (contains, not_contains, starts_with, ends_with).
  - The report WHERE clause, the live-query path and the distinct-value cascade used `LIKE … ESCAPE '\'`, which GoogleSQL rejects.
  - BigQuery now gets `STRPOS` / `STARTS_WITH` / `ENDS_WITH` from one helper, `app/services/sql_pattern.py`. An empty value is stated explicitly, so both engines agree.
  - Postgres SQL is byte-for-byte unchanged, locked by `test_dialect_structural.py`.
- **Known and deliberately unchanged** (changing these would move saved numbers during release closure):
  - A measure's own text filter (`LIKE '%' || 'x' || '%'`, valid GoogleSQL) treats `%` and `_` in the value as wildcards, and drops a `not_contains` filter.
  - A backslash in a pattern value is not escaped, so `ends_with 'a\'` errors on Postgres.
  - `ESCAPE '\'` on MySQL is not verified.
- **Open finding, not changed:** string literals are escaped by doubling the quote (`'O''Brien'`) on every dialect, and `test_dialect_structural.py::test_quote_escaping_is_dialect_independent` locks that for BigQuery. GoogleSQL is documented to use `\'` instead. If a BigQuery run confirms this, that test is wrong and the literal helpers need a dialect branch. Per repository rules, the test is reported here rather than changed without that proof.
- **Production-size data:** not verified. The rehearsal ran on the rig database (58 reports); a production copy has not been migrated.
- **Human product acceptance:** pending. It is the owner's decision, not an assistant's.
