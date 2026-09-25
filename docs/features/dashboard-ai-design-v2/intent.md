# Dashboard AI Design v2 — intent

**Human-directed, AI-designed.** The author owns the content and the layout of a
dashboard. AI Design is a design copilot: by default it changes how the page looks
and never where things are. It rearranges only when the user's words ask for it, and
only as far as they ask. Locks and data meaning hold on every path.

Before this change, every whole-page AI request recompiled the whole layout. A
"make it prettier" request re-packed the page, and locked tiles moved with it. The
model saw shapes (type, title, width), not meaning. The design audit that motivated
this is in the session record; the product contract is in `spec.md`.

No new modes for the user to learn. They select visuals if they want to narrow the
scope, lock what they want to keep, describe the look, preview, and apply or undo.
