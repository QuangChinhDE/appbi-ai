# Relationship authoring ↔ join resolver (Pair Audit #1) — intent

**Status:** in progress
**Owner:** semantic layer
**Date:** 2026-10-01

## Problem

A relationship is written by six paths (Data Model canvas → dataset API, MCP →
the same API, the direct `/semantic` explores API, auto FK detection, auto
calendar, regeneration / drift repair) and read by six consumers (join resolver,
grain graph, semantic health, field pickers, the model response, the live
filter adapter). Before this change the writers were strict and the readers
were lenient, and each reader had its own lenient rule:

- a persisted `cardinality: "bogus"` (or none) was read as **many-to-one** — the
  non-fanning edge the grain guard trusts;
- `is_active: "false"` was `bool("false") == True` — an inactive route was used;
- an invalid `cross_filter` was read as `single`;
- a reverse edge kept only the first column of a composite key and turned a
  calendar `CAST(ts AS DATE) = date` into `date = ts` (matches only midnight);
- semantic health parsed keys with its own regex and missed LookML / reversed
  conditions, so a duplicate one-side key went unreported;
- a failed add-join could leave the primary key changed (two commits);
- editing a relationship's keys added a second relationship; deleting without
  keys removed every join to the view; regeneration re-created removed auto
  joins and could overwrite a user's edit of one; two editors could lose each
  other's changes;
- nothing checked at query time that a declared N:1 key is actually unique.

Several of these return a plausible number that is wrong, with no error.

## Goal

One authored relationship = one persisted contract = one runtime contract.
Invalid, ambiguous or unverifiable relationship state never silently becomes a
stronger semantic assumption: it is canonicalized by an explicit rule, or it is
refused loudly.

## Out of scope

- Redesigning the Data Model UI; only the edit/delete identity it sends changes.
- Optimistic concurrency for API clients that replace an explore's joins
  wholesale without sending `expected_updated_at` (the PUT is a full replace by
  contract; no in-repo client uses it).
- The engine's measure-filter-from-a-dimension-base SQL defect found during the
  audit (loud Postgres error, pre-existing, not in this boundary).

## Constraints

- Semantic layer is a protected subsystem: smallest surgical change, golden
  gates must stay green, SQL valid on BigQuery and Postgres.
- No schema change; existing rows must keep working (lazy canonicalization).
- Public-link and router authorization unchanged.

## Acceptance criteria

1. Every persisted form in `backend/tests/fixtures/relationship_legacy_v1.json`
   reads as SUPPORTED (stated canonical meaning) or INVALID (excluded from the
   graph, every query on the model refused, shown in Data Model and health).
2. No unknown/missing cardinality is ever many-to-one; "false" is never active;
   an invalid cross filter is never single.
3. Reverse edges keep composite keys and calendar expressions (executed values).
4. Health and the resolver read the same key from the same parser.
5. PK + relationship commit once or not at all.
6. Edit replaces, delete is alias-aware and never a wildcard, regeneration
   keeps user edits and never resurrects a removed auto join, the direct API
   stores only what the reader accepts.
7. Concurrent writers of one model serialize (no lost update, no partial state).
8. A declared to-one key with duplicates, or that cannot be verified, refuses
   the query before it runs.
9. Golden matrix, golden SQL, golden replay, parity and router access stay green.
