# Ocean Blue light theme — spec

## Behaviour

- Every AppBI screen renders on the Ocean Blue light tokens below. No user setting
  changes this (the app has no runtime theme switch; OS dark preference is ignored).
- Action hierarchy: **primary** (solid brand, darker on hover/press) for the one main
  action; **secondary/outline** (white, `border-stroke-strong`, hover to
  `border-stroke-control`); **tonal** (brand container) for recognisable-but-secondary
  and for *selected* options; **ghost** for toolbar/menu actions; **danger** only for
  destructive actions (darker on hover).
- Selected states (sidebar module, tabs, segmented options in editors) use the brand
  container + brand text, never solid primary.
- Inside a dashboard report the report theme still drives the report content (charts,
  KPI cards, slicer chips, background). The builder toolbar and every `Modal` /
  `AppModalShell` carry `.app-chrome`, which re-asserts the app tokens: a report accent
  or a dark report never recolours AppBI controls.

## Data / API

No schema change. No API change. Saved dashboard themes, chart palettes, snapshots and
PDF/PPTX/public/embed output are unchanged (chart series never read `--brand`).

## Final token mapping (`globals.css :root`, consumed via `tailwind.config.js`)

| Role | Token | Value | Tailwind |
|---|---|---|---|
| Page | `--surface-0` | #F6F8FC | `bg-surface-0` |
| Card / panel / header / dialog | `--surface-1` | #FFFFFF | `bg-surface-1` |
| Secondary toolbar, neutral hover | `--surface-2` | #F3F6FA | `bg-surface-2` |
| Segmented / pressed fill | `--surface-3` | #E8EEF6 | `bg-surface-3` |
| Tooltip / inverse | `--surface-inverse` | #17263C | `bg-surface-inverse` |
| Text primary / secondary / tertiary / quaternary | `--text-*` | #17263C / #40536B / #526680 / #5A6D84 | `text-text-*` |
| Primary action, link, focus | `--brand` | #0B57D0 | `bg-brand`, `text-brand` |
| Primary hover / pressed | `--brand-hover` / `--brand-active` | #0842A0 / #06357A | `hover:bg-brand-hover`, `active:bg-brand-active` |
| Identity accent | `--brand-navy` | #0D3B7A | `bg-brand-navy` |
| Selected / tonal | `--brand-container` (+`-hover`) | #E8F0FE / #D3E3FD | `bg-brand-container` |
| Text on container | `--on-brand-container` | #0842A0 | `text-brand-on-container` |
| Success / warning / danger / info | `--success` … `--info` (+ `-bg`) | #137333/#E8F5ED · #915600/#FFF5E5 · #B3261E/#FCEAE8 · #0B57D0/#E8F0FE | `text-success`, `bg-success-bg` … |
| Divider | `--border-line` | #E0E7F0 | `border-stroke-line` |
| Card / group | `--border-strong` | #C8D4E5 | `border-stroke-strong` |
| Input / control boundary | `--border-control` | #7E90A8 | `border-stroke-control` |
| shadcn HSL (`--primary`, `--ring`, `--background`, …) | | same roles, HSL | `bg-primary`, `ring` |

## UI surfaces touched

Shared: `Button` (+ `tonal`), `Input`/`Textarea`/`Select` (control border, danger ring
on token), `Tabs` (selected = brand), `Sidebar` (selected = container, `aria-current`),
`Modal`, `AppModalShell`. Modules: dashboard builder toolbar (white-alpha → tokens,
selected design mode tonal), editor segmented controls (AddChart, Export PDF/Layout,
Studio preview, chart config, public links, briefing wizard, data model, table grid),
offline bar (status tokens).

## Guards

- `scripts/check-app-theme-contrast.mjs` — 34 real token pairs (alpha-composited where a
  component paints at partial opacity) held to AA.
- `scripts/check-app-theme-contract.mjs` — `.app-chrome` = `:root`; hover/pressed darker;
  report theme never writes `<html>`; builder toolbar + modals carry `.app-chrome`; no
  white-alpha in the builder; focus ring on the token.
- Both run in `npm run qa` (CI preflight).
