# Vibe Report data integrity — spec

## S1 Integer conversion never rounds (semantic layer, surgical)

`type_override_service` DuckDB `integer`: `CASE WHEN regexp_full_match(cleaned,
'-?[0-9]+') THEN TRY_CAST(cleaned AS BIGINT) ELSE NULL END` — the Postgres/MySQL
contract. Consequences: the type probe counts `71.3` invalid -> `float` wins; an
existing `integer` override over decimals yields NULL (visible, like every other
dialect) instead of a wrong number. Re-inferring the table's types repairs it.

## S2 Data rights on every report→data path

`_require_binding_access(db, user, bindings)` = `_check_chart_access` for every binding.
Applied to: `/data` (already), `export-html`, `duplicate` (caller), `publish` and
`create/update public link` (the actor vouches for what the link serves). Refused = 403,
nothing partial is exported or copied.

Export HTML = a **snapshot** of the **published** revision (draft when never published),
minted under the caller's rights with the revision's default filter state; the footer
states revision, period and time of the snapshot.

## S3 One period, one state

A declared filter may carry `default: "latest"` (single-select). `bindings.resolve_state`
fills an absent key with the latest value of the filter field (BI Core distinct values,
ordered desc) — used by `/data`, public `/data`, export and the AI Bot scope, so every
surface sees the same period. Runtime: `data-rac-filter-text="f1"` renders the current
value's label (`opts.prefix`, `opts.empty`).

## S4 Repeat binding (runtime)

`<tr data-rac-repeat="b7" data-rac-opts='{"limit":10,"sort":"-m"}'>` is a template:
cloned once per result row (the first clone keeps the authored markup; all clones are
regenerated on every result). Inside a template:

- `data-rac-cell="<field key | dim | m | m2…>"` — dimension label or formatted measure;
- `data-rac-bar="<measure>"` — `style.width` = value / max of the column (%);
- `data-rac-tone="<measure>"` + opts `{"bands":[[0.85,"bad"],[1,"warn"],[null,"ok"]]}`
  — sets `data-rac-tone` to the band for CSS.

A matrix = repeat over rows with `data-rac-cell` columns. No engine work: rows are the
binding's DTO rows.

## S5 Importer: repeated structures

`detect_slots` groups ≥2 sibling elements with the same tag+class signature whose text
contains numbers into a `list` slot: `{kind:"list", rows:n, columns:[{index, sample,
numeric}]}`. Mapping a list slot = a category/time candidate + per-column field
(`dim` / a measure key / `static`). Apply keeps the FIRST sibling as the template
(design preserved), marks it `data-rac-repeat`, replaces mapped columns with
`data-rac-cell`, removes the other siblings.

## S6 Sample numbers are explicit

Apply wraps every detected numeric slot left "keep as is" in
`<span data-rac-sample>…</span>`. Publish refuses (400, lists them) while any
`data-rac-sample` remains unless `allow_samples=true`; view mode renders them with a
"số mẫu" marker. The studio Problems panel lists them.
