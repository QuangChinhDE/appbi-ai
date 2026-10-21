# AppBI Analyst (M2 MVP) — plan and what was built

PO mandate 2026-10-21 ("Full product completion"): M1 Governed Execution + M2 Analyst MVP
authorised for non-production engineering; merge and release stay with authorised humans.

## Deviation from intelligence-foundation/plan.md (declared)

plan.md 1G names the existing `/semantic/query` router as GQS's first consumer. That
router is in the protected semantic layer and serves human chart rendering; delegating it
is a behaviour-preserving refactor with its own golden-suite gate. The mandate's M2 needs
an AI consumer, so the **Analyst is the first consumer** (behind its flag) and the
`/semantic/query` delegation remains a separate, protected work item.

## Commits (branch `feat/gqs-1c-1d-bounds-cancel`, stacked on #63)

| SHA | Scope |
|---|---|
| e93b1616 | 1D Postgres cancellation through the registry |
| e81c4776 | 1E ledger table + migration 20261021_0001; pid-reuse-safe cancel |
| c6f26171 | 1D/1C MySQL cancellation + bounds |
| c0a29ce1 | 1D/1C BigQuery job identity, labels, warehouse cancel (QA project) |
| d0ab6090 | 1E ledger service, atomic budgets, cross-worker cancel |
| f556838c | CI: BigQuery runtime module wired (skips without credential) |
| e6f1382d | 1F signed single-use drop-filter consent; migration 20261021_0002 |
| 089f6d50 | 1G + Analyst backend behind ANALYST_ENABLED; route contract |
| 725fe3d8 | Analyst UI |
| b39e0d52 | truncated result draws no trend; browser acceptance spec |
| 8ae31015 | plan validation hardening from the BigQuery evaluation |
| 09810b17 | identifiers, synonyms, breakdown coverage |
| ad08f704 | cancellers decrypt stored config; MySQL full path; unique draft names |

## Open (not done here)

- `/semantic/query` delegation to GQS (protected; separate PR).
- Own permission-matrix key for the Analyst (product decision).
- Relationship key probes on BigQuery are refused (`policy_unenforceable`) until the
  protected relationship guard takes GQS bounds.
- Row-level policies (operational datasets) are refused, not enforced (ADR-002).
- Dashboard drafts; streaming steps (the UI shows steps while one request runs).
- Narrative: no warning when the "recent" window spans non-consecutive periods.
