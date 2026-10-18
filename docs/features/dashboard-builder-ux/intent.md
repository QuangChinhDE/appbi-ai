# Dashboard Builder UX simplification — intent

**Status:** shipped
**Owner:** Product (PO directive 2026-10), implemented by Claude Code
**Date:** 2026-10-19

## Problem

The Builder showed every capability at once. Measured in a real browser on the same
dashboard at 1440px (sidebar excluded):

| State | Controls visible | Toolbar layers |
|---|---|---|
| Dashboard just opened | 14 | 2 (header + permanent Desktop/Tablet/Phone bar) |
| One chart selected | 22 | 3 (+ Arrange bar with Frame for a single chart) |
| Two charts selected | 29 | 3 (Arrange bar of 11 controls) |

Causes, from the code:

- Visibility was decided by **screen width** (does it fit?), never by **task** (is it
  needed now?). The device switcher (`device-bar`) was rendered on every Builder load.
- Selecting **one** chart opened a sticky Arrange bar (Frame Card/Subtle/Flush + clear),
  although arranging is a relation between tiles and Frame is already in the Inspector.
- Every hovered chart grew a **destructive** red ✕ (remove) and an Explore icon that
  duplicated "Open in Explore" in the tile menu.
- The header carried duplicates: a Slicer button (Slicer is in the Add palette), a
  separate Preview button, and a two-segment Manual|AI control for an on/off mode.
- A chart could not be selected by clicking its title or body: the whole tile is the
  drag handle, so the grid placeholder swallowed the click (widgets already handled this
  with the "still drag = click" rule; charts were excluded).

## Goal

Canvas-first, context-aware: a person sees the tools for what they are doing now, and
reaches the rest in one deliberate step — without losing any capability.

## Out of scope

- Layout algorithms, data schema, API, responsive resolver, public/embed rendering.
- Widget (non-chart) hover tools, the AI Design panel internals, FilterPane internals.
- Sidebar/navigation, other modules, report themes, chart palettes.

## Constraints

- Ocean Blue light theme and BEXAI identity unchanged.
- AUTO/CUSTOM device layouts, Save draft / Publish / Discard, Undo/Redo, conflict
  handling and public/embed output must behave exactly as before.
- Tests that assumed a permanently visible device bar change to the new entry point but
  keep every assertion about layout, save/publish, isolation, keyboard and permissions.

## Acceptance criteria

1. Opening a dashboard shows Desktop with **no** device bar; the device tool is opened
   from the header Preview menu (More at phone widths) and shows which device is active.
2. In Tablet/Phone the device bar carries AUTO/CUSTOM status and its actions; Desktop on
   it returns to the normal workspace; opening/closing the tool writes nothing.
3. One selected chart: no Arrange bar; the chart's own tools are visible while selected
   (and always on touch screens).
4. Two or more selected: one compact bar — count · Arrange ▾ · Frame ▾ · ✕.
5. Remove lives in the tile menu, behind the existing confirmation.
6. Clicking a chart's title or header area selects it; Shift adds.
7. Visible controls when one chart is selected drop by ≥30% at 1440px.
8. No header control overlaps another at 390/768/1024/1280/1440/1920, vi and en, clean
   and with unsaved changes.

## Open questions

None open. Pre-existing defects found during the audit are listed in `plan.md`.
