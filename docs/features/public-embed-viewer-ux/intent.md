# Public Dashboard & Embed Viewer UX hardening — intent

**Status:** in review
**Owner:** Product (PO directive 2026-10), implemented by Claude Code
**Date:** 2026-10-19

## Problem

A report that reads well in the Builder did not read well on `/d/{token}`, `/embed/{token}`
or an integration `emb_` link. Measured in a real browser on the same published reports
(sidebar-free viewer, anonymous context):

| Symptom | Evidence (before) |
|---|---|
| Wide screens stretch the report edge to edge | canvas 1844 / 2484 / 3364 px at 1920 / 2560 / 3440; widest tile 7.4 : 1, 10.1 : 1, 13.8 : 1 (5.4 : 1 at 1440); title at the far left, Export at the far right |
| Embedded report never told the host its real height | `appbi:resize` sent 2 messages, both equal to the iframe's own height (600/900) while the report was 5 306 px; the host showed an inner scrollbar |
| Embedded report could never shrink the host | frame widened 390 → 1024: report 9 178 → 5 210 px, host stayed 9 178 px; switching to a shorter page sent nothing (9 178 px of mostly blank frame) |
| Loading pushed the whole report down and back | layout shift (CLS) 0.07 – 0.19 on every load: a "Đang tải biểu đồ…" row was inserted into the masthead and removed a second later |
| Table headers split mid-word | "TRANSACTI / ON_ID", "PRODU / CT_ / NAME" at 820 and 3440 px |

## Causes, from the code

- No maximum width anywhere on the viewer (`mx-auto` sat on `w-full` elements), while row
  height is a fixed pixel value (`computeReportRowHeight` ignores width). Wider canvas ⇒
  wider, never taller tiles.
- `useParentResize` reported `document.documentElement.scrollHeight` (never below the
  iframe's current height) and observed `<body>` (one viewport tall, so it never changed).
- Transient progress was rendered in the masthead flow (`showLiveState`).
- Table column floors estimated the header's longest word at 7.6 px per character — body
  text — while headers are bold, tracked and upper-case.

## Goal

On a wide screen the report is balanced; on a narrow one it is readable; in an iframe it
follows the real container — without changing any stored layout, AUTO/CUSTOM semantics,
data, theme or security behaviour.

## Out of scope

Builder redesign, chart engine internals, theme/branding, backend, public-surface i18n.

## Acceptance criteria

1. ≥ 1920 px: one centred report frame (≤ 1600 px); masthead aligned with the canvas;
   1920, 2560 and 3440 resolve the identical layout; ≤ 1600 px windows are unchanged.
2. Same report-container width ⇒ same resolved layout on Builder, Studio, `/d`, `/embed`, `emb_`.
3. A host honouring `appbi:resize` grows to the report after its data, shrinks when the
   frame widens or the page gets shorter, receives no repeated heights and no messages
   once the report has settled (no loop); nothing scrolls inside the frame.
4. Loading does not move the report (CLS caused by the viewer ≈ 0).
5. Table headers never split inside a word when the column can hold it.
6. No horizontal page overflow at 320 – 3440 px; existing responsive, parity, data,
   snapshot and permission assertions unchanged.
