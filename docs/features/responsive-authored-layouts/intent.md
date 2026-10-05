# Device-specific dashboard layouts — intent

**Status:** shipped
**Date:** 2026-10-06

## Problem

A report has one authored layout (desktop). Tablet and phone layouts are derived
from it at render time and cannot be adjusted: an author who wants the phone
view to lead with two KPIs and drop a chart lower has no way to say so. The
derivation was also re-implemented per surface (Builder narrow canvas, Builder
tablet preview, the public grid) with different inputs, and the public grid
measured its width twice.

## Goal

Desktop stays the canonical authored layout. Tablet and phone default to the
derived layout (AUTO, exactly as before) and an author may customise either,
per page. A customised layout goes through Draft → Publish like the rest of the
report and is drawn identically by the Builder, Studio, `/d`, stable `/embed`
and `emb_` at the same container width. No device layout silently changes
another, and the data never depends on the device.

## Out of scope

- AI-generated device layouts.
- Per-tile partial overrides (a CUSTOM layout is a whole page).
- Changing chart queries, filters or data authority by device.
- PDF/export using a device layout (export keeps the desktop layout).

## Constraints

- Existing dashboards (no device layouts) must render byte-identically (AUTO =
  the old published pipeline, locked by golden vectors).
- The current per-author draft lifecycle, its row lock and its conflict model.
- Public/embed security model unchanged; public gets only published state.
- One width authority per rendered report (breakpoints 640 / 1024).

## Acceptance criteria

See `docs/responsive-dashboard-layouts.md` (the contract) and the test matrix in
`plan.md`.
