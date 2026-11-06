# Report import readiness — intent

## Problem

A pasted HTML report reaches the reader with errors that the app only shows after the page renders, or never shows at all:

- data places left as `"missing"`;
- design sample numbers that were never bound;
- figures in the wrong row or card;
- false warnings from the in-browser audit.

The same mistakes come back on every re-import.

Two more costs come with it:

- **AI on every slot.** `importer.propose()` asks the model to map every slot against the whole candidate list on every analyse, even when the rules are already certain.
- **Three disconnected checks.** `dangling_references` (server, at publish), `sample_marks` (server, at publish) and the row/association audit (`runtime.js`, browser, Studio only) do not know about each other. Authors find problems one at a time, after the page renders.

## Outcome wanted

1. **A page written to the contract imports in one pass, with ~0 AI tokens.** It uses `@cN` / `@fN` from the Context Pack, which the compatible import path already binds without the model.
2. **Problems are reported once, per place, before the page renders.** When the author presses Import or Publish, they get one readiness report from the server.
3. **Certain fixes are applied without AI and listed.** Examples: row addresses for hand-built tables (`semantics.check_rows(fix=True)`), and stale "static / sample / demo" sentences flagged for review.
4. **AI is called only for the places the rules are unsure about**, and is sent only those places.
5. **One publish gate.** Blocking issues block; heuristics only warn.
   - Blocking: dangling anchors, sample numbers, an unsafe origin configuration.
   - Warning only: the heuristic association and provenance checks.

## Non-goals

- No new data path. The BI Core stays the only source of figures.
- No change to how bindings are queried, permissioned or filtered.
- No migration. Readiness is computed from the revision.
- The DevOps report-docs subdomain is not part of this work; that is configuration.
