# Semantic core remediation — intent

**Status:** in progress (branch `fix/semantic-core-remediation`)
**Owner:** semantic layer
**Date:** 2026-09-30

## Problem

A deep audit of the semantic engine at `d4ad0fe9` reproduced, by executing the
generated SQL against hand-computed answers, a class of requests that
**succeed, return a plausible number, and are wrong — silently**:

- the same chart gave different numbers depending on the ORDER relationships
  were created (a diamond of two routes to one dimension); a slicer through it
  returned the intersection of both routes — a third number;
- a measure with `ALL` / `ALLEXCEPT` / `USERELATIONSHIP` was computed as if the
  modifier were absent;
- on Postgres/MySQL/DuckDB datasets a date slicer fanned over several date
  columns AND-ed them (the calendar was recognised by BigQuery SQL text);
- the multi-fact stitch dropped the time grain (a mid-month target became its
  own row), ignored Top-N and sort, and let one fact's measure filter act as a
  row filter on another;
- a measure filter's `not_contains` was dropped and `%`/`_` acted as wildcards;
- live charts silently dropped `ends_with`, `not_between`, `date_eq`,
  `date_between`, `matches_regex` and unknown operators, and a live filter
  through a 1:N hop repeated base rows;
- a cached chart kept serving the old number for up to 300 s after a measure
  was edited;
- a declared many-to-one relationship whose one side had duplicate keys fanned
  every total through it, and nothing checked;
- `/semantic/*` checked only the module permission: any Datasets user could
  read, rewrite and query any dataset's model.

## Goal

Zero requests that succeed with a wrong number and say nothing. Every such path
either returns the number the model means (with a value-level regression test)
or refuses with a Vietnamese message that says why and where to fix it (with a
regression test). Access to semantic objects follows their dataset.

## Out of scope

- Implementing context modifiers (they are refused, not built).
- PowerBI's "(Blank) passes a negation" NULL rule (the current SQL rule is
  documented and kept; changing it would move saved numbers).
- Applying the `week_start_day = sunday` dataset setting (ISO Monday is the
  enforced, consistent convention).
- Turning ON the feature flags that are OFF (propagation v2, per-measure
  isolation, symmetric aggregates).
- Deploying.
