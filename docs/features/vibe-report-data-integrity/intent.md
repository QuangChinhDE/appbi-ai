# Vibe Report data integrity — intent

## Problem (found on demo c1a254d8, benchmark report #33)

1. **Wrong numbers from the source.** An uploaded file's decimal column (OCC 71.3,
   plan 74.97, KPI score 91.8) is auto-typed `integer`; on DuckDB the integer
   conversion is `TRY_CAST(x AS BIGINT)`, which **rounds** (`'71.3' -> 71`) where
   BigQuery `SAFE_CAST` / Postgres / MySQL yield NULL. The type probe uses the same
   expression, so `integer` reports zero invalid values and beats `float`. Every
   decimal in every manual (CSV/XLSX) and Sheets-via-DuckDB table typed this way is
   silently rounded. OCC attainment 96.44% vs source 96.40% is this bug.
2. **Period mismatch.** The report headline says "Tháng 08/2026" while the numbers
   aggregate all six months: there is no default period and no text bound to the
   filter, so static text and governed numbers disagree.
3. **Only single numbers bind.** Lists, tables, alert rows and matrices in a pasted
   design stay as the sample's numbers and are published as if they were live.
4. **Data-rights bypass.** `export-html` mints every binding without the chart/dataset
   check `/data` applies. A person shared *view* on a report (no data rights) can also
   duplicate it, own the copy, publish it and open a public link whose data endpoint
   checks nobody's rights — publishing data they cannot read.

## Outcome

- A decimal is never rounded by a type conversion, on any dialect.
- The period a report shows is one fact: filter state (default = latest period),
  the headline text and every bound number read the same state.
- Free HTML/CSS/JS keeps its design; repeated structures (rows, list items, matrix
  cells, alert rows) bind to governed results and re-render on every filter change.
- A sample number cannot reach a published report unmarked.
- Every path that turns a report into data (data, export, duplicate, publish, public
  link) requires the actor to read each bound chart and its dataset lineage.

## Non-goals

UI/UX polish; a second query engine (all numbers stay ChartService/semantic engine);
AI-driven remapping.
