# Ocean Blue light theme — intent

**Status:** APPROVED by the product owner (2026-10-17), executed without a further
proposal round at their explicit instruction.

## Problem

The app chrome ran on a Linear-inspired indigo light palette that had drifted:

- 21 of 34 measured text/control pairs failed WCAG 2.2 AA (quaternary text 3.05:1 on the
  page, status badges 2.8–4.1:1, input borders 1.46:1).
- Primary buttons got *lighter* on hover and press (white text fell to 3.84:1 / 2.87:1).
- The dashboard builder toolbar still carried ~70 dark-era `rgba(255,255,255,…)` borders
  and hovers: invisible on the light surfaces.
- A report's accent re-pointed `--brand` for everything inside the report wrapper,
  including AppBI's own toolbar, menus, dialogs and focus rings.
- Selected options in editor segmented controls were painted solid primary, competing
  with the real primary action next to them.

## Goal

One Ocean Blue light theme for the AppBI application chrome, with a clear action
hierarchy and AA contrast, **without** redesigning layouts, flows or the header baseline
from PR #43, and without touching report content (charts, report themes, exports,
public/embed reports).

## Out of scope

Dark mode (the `.dark` block is kept as is), business logic, schema/API, user dashboard
colours, the Workboard runtime portal's own theme (`lib/wb-theme.ts`), production deploy.
