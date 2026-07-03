# Golden — snowflake fixture (dataset 56): drift log

`regression_filter_matrix.py --verify --tag snowflake` replays all 16 ds56 cases
against the freshly-seeded fixture (`seed_snowflake_ci_fixture.py`). **All 16
pass and gate CI** (`.github/workflows/backend-contract-tests.yml`).

This file records 3 PowerBI-parity drifts a matrix-audit on this fixture
surfaced (HEAD vs the 2026-05-28 golden) and how each was **resolved**
(2026-06-03). They were genuine engine bugs, not fixture artifacts; each fix was
verified case-by-case on the fixture + the full unit suite (130 tests).

## ✅ RESOLVED — chasm group-by fan-out (`G_GRAIN`, now GATED)
`[snow] grain rev by deal-title (chasm)` = base **revenue**, `SUM(amount)` grouped
by `deal.title`. `deal` is another FACT reachable from revenue **only via the
shared owner/date dims (chasm)**. The old normal build LEFT-JOINed
`revenue → {date|owner} → deal` and **FANNED the SUM** — revenue counted once per
deal sharing a join key, **non-deterministically 4000 (date-path) or 3600
(owner-path)** vs the true 2400 (the cross-fact dispatch + multi-fact guard did
NOT fire — only ONE measure fact, so it reached the normal build).
**Fixed** by the **grain validator** (`SemanticQueryEngine._validate_group_grain`,
called in `generate_sql` on the normal-build path, skipped under isolation):
every group dimension/pivot must be M:1-reachable from each measure's fact
(`_m1_reachable_views`) or on that fact, else **fail loud** (status=error, no
number). `G_GRAIN` recaptured to `status=error` and **promoted into the gated
`--tag snowflake` set** (now 17/17) — locks that the chasm fails loud forever.
Unit-tested in `test_locked_contract.py` (`test_grain_validator_*`).

## A — Postgres numeric-filter coercion was BigQuery-only  ✅ FIXED
A numeric `eq`/`gt`/`between`/`in` filter on a column reached via EXISTS emitted
`TRY_CAST(REGEXP_REPLACE(…) AS DOUBLE)` — BigQuery/DuckDB syntax that Postgres
rejects (`syntax error at or near "AS"`; PG has no `TRY_CAST`, and the type is
`DOUBLE PRECISION`). Cases G07/G08/G15 5xx'd.
**Fix:** `type_override_service.build_safe_cast_sql` — the `integer`/`float`
branches now split DuckDB (`TRY_CAST … AS BIGINT/DOUBLE`, unchanged) from
Postgres/generic (`CASE WHEN <cleaned> ~ '<numeric-regex>' THEN CAST(<cleaned> AS
BIGINT|DOUBLE PRECISION) ELSE NULL END` — regex-guarded so non-numeric text → NULL,
mirroring the existing MySQL + date branches). Verified: date.year=2025→2100,
owner.kpi>90→2100, year in [..]→2400 (all valid SQL, correct numbers).

## B — multi shared-dim filter picked one arbitrary path  ✅ FIXED
`revenue ← deal.org_id=O1`: `bc_revenue` shares **two** conformed dims with
`bc_deal` (`bc_owner`, `bc_date`). The EXISTS builder correlated through **one**
arbitrary path (BFS/model-build order) — date → **2100**, owner → **1200** — so the
result was non-deterministic *and* usually wrong. PowerBI propagates the filter
through **every** active relationship and intersects (AND).
**Fix:** `semantic_query_engine._build_filter_exists_clause` — when the chosen
anchor is the BASE itself (`start_idx == 0`: a bare fact filtered by another
fact's attribute, no deeper joined node to scope to) and the target is reachable
via several equal-length paths through different shared dims, emit one EXISTS per
shared dim and **AND** them. When a path anchors **deeper** (the filter scopes a
joined measure's grain) the single deepest-anchor path is kept **unchanged** —
ANDing sibling-fact paths there would re-introduce the chasm-trap and
over-constrain the measure. Single-path targets are byte-identical (AND-of-one).
Verified: G09 `revenue←deal.org_id=O1` → **1200** deterministically
(`EXISTS(owner→deal) AND EXISTS(date→deal)`); G11 `activity←stage` → 135 (now the
AND value, correct for the right reason).
**G10 golden recaptured 1500 → 1000:** `revenue←stage.process=closed` was
captured under the old single owner-path (1500). The PowerBI-correct AND value is
**1000** — revenue where owner∈{K1,K4} (owners of closed-stage deals) **and**
date∈{2025-04-10, 2026-02-05} (dates of closed-stage deals) = R2(700)+R4(300).
Recaptured with `--capture --case G10_…` (commit-stamped `B-fix-AND-shared-dim-paths`).

## C — cross-table measure re-anchor dropped dimension members  ✅ FIXED
Owner-base chart, `dimension = owner.crm_name`, `metric = SUM(revenue.amount)`
re-anchored onto revenue (`FROM revenue LEFT JOIN owner`) → 3 rows; owner **Binh**
(no revenue) was dropped. PowerBI shows the dimension's full member set with a
blank measure → 4 rows.
**Fix:** `semantic_query_engine.generate_sql` single-cross-fact dispatch — when
the chart's BASE is itself on the measure-fact's M:1 spine (a dimension-table on
the 1-side) and the measure is a PLAIN (non-cross-SOURCE) measure, skip the
re-anchor and fall through to the normal build from the base (`FROM owner LEFT
JOIN revenue GROUP BY crm_name`), preserving all members; single fact → no
fan-out. Cross-SOURCE measures (their own grain / nested-WITH source) still
re-anchor. Verified: G14 → **4 rows** (Binh = blank `total_revenue`); base=revenue
(C2) correctly stays 3.

---
**To re-include a recaptured case after a future behavior change:** confirm it
matches PowerBI, `--capture --case <id>` with rationale in the commit message.
