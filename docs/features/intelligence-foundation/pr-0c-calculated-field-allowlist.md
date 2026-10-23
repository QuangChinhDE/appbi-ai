# PR-0C — calculated-field AST allow-list (SEC-01) — plan for approval

**Status:** PLANNED. This touches the protected `semantic_layer`, so it needs explicit
approval before any code.

**Baseline:** `origin/demo` @ `1bac25e8`.

**Ledger:** SEC-01 and SEC-01b are reproduced as `xfail(strict)` in
`test_intelligence_phase0_security_repro.py`.

## Problem

`SemanticQueryEngine._validate_calculated_field_safety`
(`semantic_query_engine.py:3870-3880`) guards user-written calculated-field SQL with a
substring list (`DROP … EXECUTE`, `;`). It has two defects:

- **It lets through any expression that reads data it should not.** A scalar subquery,
  `(SELECT MAX(salary) FROM hr.payroll)`, compiles. It runs on the datasource's one
  credential, so it reads beyond the dataset grant and beyond GovernAIScope (SEC-01).
- **It rejects legitimate fields.** `updated_at` contains `UPDATE` (SEC-01b).

Since PR-0B3, `/semantic/query` requires `explore`, which narrows who can reach this
path. The validator itself is still the hole.

## Approach (smallest surgical change; no engine rewrite)

1. **Parse the template with `sqlglot`.**
   - `sqlglot` is already a dependency and is used in `dataset_table_sql_service.py`.
   - Parse in the engine's dialect, AFTER replacing each `${view.field}` with a
     placeholder identifier. The template is the user's text; the substitution
     afterwards is the engine's own trusted rendering.
2. **Allow-list, never deny-list.**
   - **Allowed nodes:**
     - placeholder columns;
     - literals;
     - arithmetic, comparison, boolean and `CASE` / `IF`;
     - `CAST` to scalar types;
     - parentheses;
     - an allow-listed function set: `COALESCE`, `NULLIF`, `ROUND`, `ABS`, `GREATEST`,
       `LEAST`, string functions, date-part and date-diff functions, and the aggregates
       the engine already renders (`SUM`, `AVG`, `MIN`, `MAX`, `COUNT`).
   - **Refused:**
     - `Select` / `Subquery` / `Union` / any table reference;
     - window functions inside a template (windows have their own spec field);
     - unknown functions;
     - any bare column that is not a placeholder (a raw column name escapes the field's
       view);
     - more than one statement.
3. **Unchanged:**
   - `${}` substitution;
   - `normalize_division`;
   - every renderer.
   - Only the check before rendering changes.

## Rollout: evidence before enforcement

Saved charts may already carry calculated fields that a strict allow-list would refuse,
for example raw column names. There is no evidence today of how many, because
production data cannot be read from here.

- **Step 1 — `CALC_FIELD_POLICY=report`** (default in this PR).
  - The allow-list runs.
  - A violation is logged and counted, with the chart id and the node type. Never the
    SQL text.
  - The old substring check stays as the enforcing check.
  - SEC-01b is fixed in this step: the substring check matches whole words, not
    substrings.
- **Step 2 — `enforce`.** Only after the violation counts from a real deployment have
  been reviewed. This is a separate one-line PR. SEC-01's `xfail` is removed here.
- **For AI surfaces:** GQS (Phase 1) refuses `calculated_fields` with
  `unsupported_expression` regardless of mode (spec §2.3).

## Tests

- **Flip SEC-01b in step 1.** Flip SEC-01 in step 2.
- **Allow / refuse matrix:** every allowed node class compiles, and every refused class
  is reported (step 1) or refused (step 2).
- **Dialect structure:** the rendered SQL for allowed fields is asserted on BigQuery AND
  Postgres. This is `policy.dialect_blindness`.
- **Must stay green, unchanged:** all of `protected.semantic_layer.required_tests`
  (`measure_render`, `dialect_structural`, golden suites, `pair1`–`pair5`,
  `semantic_foundation`).

## Open questions for the approver

1. Is the report-then-enforce rollout acceptable, or should step 1 enforce for
   `/semantic/query` only (no saved-chart risk there) and report for saved charts?
2. Is the function allow-list above sufficient for current calculated fields? Telemetry
   from step 1 answers this.
