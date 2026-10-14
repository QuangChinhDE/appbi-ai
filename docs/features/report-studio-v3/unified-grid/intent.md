# Report Studio V3 — Unified Grid & Slicer Freedom: intent

A scope inside Report Studio V3, not a V4. V3's acceptance (S1–S8) stays in force.

## The problem

A report had two authoring surfaces and one fixed filter area.

- **Two layout engines.** Grid and Canvas were both layout engines, but only Grid ever reached a viewer. Public,
  Embed and PDF render the grid coordinates and never read Canvas pixels. Canvas authoring was already switched off
  in the UI, yet its code, its conversion and its toggle stayed.
- **Slicers could not be placed.** Every slicer lived in one SlicerCluster docked above, beside or in a drawer. An
  author could not put a date range above the page, a region list next to the chart it explains, or a category
  control in a section. The cluster, not the slicer, was the unit that moved.
- **AI and manual worked differently.** AI Design could only move the cluster dock. A person could not do more.

## What we want

**One report foundation, two authoring experiences.**

The Grid is the only layout. Everything on a report is a grid element: charts, KPIs, tables, text, headings,
sections, callouts, narrative, images, shapes and slicer controls.

A slicer control is presentation. It can sit anywhere on the grid, be resized, be restyled, and move between
sections. The filter it controls is unchanged: dataset, field, operator, value, scope, permissions and public
constraints. Placement never implies targeting. A control on a chart's shoulder still filters exactly what its scope
says.

Manual authoring and AI Design use the same grid elements through the same commit path. What the AI makes, a person
can move, resize, lock and delete.

## Out of scope

- A pixel canvas under another name: overlap, z-order and free pixels.
- Visual-level slicer targeting ("this control filters only that chart"). It is not supported end to end by the
  filter pipeline, so it is not advertised.
- A second backend filter pipeline.
