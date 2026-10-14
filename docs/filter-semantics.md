# Filter semantics

The cross-module contract for how a filter is stored, merged and applied, in the
Builder and on public surfaces (`/d`, `/embed`, integration `emb_`). Source code
across the backend and frontend cites this file by section (`§2.3`, `§3`, …); the
section numbers are stable on purpose.

**Source of truth.** This file describes the code. Where they disagree, the code and
its tests win and this file is a bug. The public data-authority invariants (A–F) live
in [`features/dashboard-public-final-closure/spec.md` §3](features/dashboard-public-final-closure/spec.md#3-data-authority-contract);
they are referenced here, not repeated.

| Concern | Code |
|---|---|
| Entry shapes | `backend/app/schemas/filter_entry.py` |
| Layer merge, scope bounds, disclosure | `backend/app/services/filter_layered_merge.py` |
| Normalisation, operators, presets, drop reasons | `backend/app/services/chart_contracts.py` |
| Public merge (single, batch, distinct values, AI) | `backend/app/api/public.py` `_build_public_chart_filters` |
| WHERE / HAVING, relative-date guard | `backend/app/services/semantic_query_engine.py` |
| Builder merge | `frontend/src/lib/filters.ts` `resolveEffectiveFilterSet` |
| Parameters | `backend/app/services/dashboard_parameters.py` |

## 1. Taxonomy

| Kind | Stored in | Who sets it | Viewer can change it? |
|---|---|---|---|
| Chart base filter | `chart.config` | chart author | no — always ANDed (§3) |
| Dashboard filter, `publicMode: visible` | `dashboard.filters_config` | report author | yes (a default) |
| Dashboard filter, `publicMode: locked` (🔒) | same | report author | no — enforced, shown read-only |
| Dashboard filter, `publicMode: hidden` (🚫) | same | report author | no — enforced, never named |
| Dashboard / page slicer | `slicers_config`, `pages_config[p].slicers` | report author | yes — always visible (slicers have no `publicMode`) |
| Page filter (page scope) | `pages_config[p].filters` | report author | no — hard bound (§3.2) |
| Link lock (🔒) | `DashboardPublicLink.filters_config` entry | link author | no |
| Link hide (🚫) | link entry with `hidden: true` | link author | no |
| Link limit (🎯) | link entry with `limit: true` | link author | only *inside* the allow-list |
| Viewer selection | request | viewer | — |
| Parameter switcher selection | request (`param-…` filter id) | viewer | only to one of the switcher's options |
| Tile instance parameters | `dashboard_charts.parameters` | report author | no |

`publicMode` also carries `allowOverride` and `showBanner` (`filter_entry.py`). Legacy
`public_mode` is still read.

## 2. Entries

### 2.1 Shape

A filter entry names its field by `field` and, when bound to the semantic model, by
`semanticField` (`view.column`) plus `datasetId`. Its operator is a canonical key (§7)
and its `value` is a scalar, a list (`in`/`not_in`) or a pair (`between`). A date
entry may instead carry a `datePreset` token (§7.2).

### 2.2 Visible filters and the viewer

A `visible` dashboard filter is a default. A viewer may override it through a slicer or
the filter mini-pane; the override wins on the same field whatever the operator (§3.1
dedupe key). A viewer may filter only fields the served report exposes
(`available_filter_fields`: slicers plus visible filter-pane entries; 🔒/🚫 entries are
excluded) — see invariant E in the spec. A viewer filter on any other field is dropped
and logged (`viewer_field_not_exposed`); a crafted name or case variant is not an
exposed name.

### 2.3 Public link entries: lock, hide, limit

One row per field in the Public Links dialog (*Data* tab); `buildLinkFiltersPayload`
writes at most one entry per field.

- **Lock** — `{field, operator, value}`. Enforced; shown to the viewer read-only.
- **Hide** — `{field, …, hidden: true}`.
  - With a value: enforced exactly like a lock, but never named to the viewer, never
    served in the page structure and never handed to the AI.
  - Without a value: a *kill marker* that removes the field from the viewer's
    controls. It never removes a 🔒/🚫 dashboard or page filter on that field
    (author bounds, §3.2).
- **Limit** — `{field, operator: 'in', value: [...], limit: true}`. An allow-list: the
  viewer still sees an interactive control but can only pick inside it (§3.2).

Entry states (`link_entry_state`), decided by the engine's own normalisation:
`enforced`; `empty` (no value, no preset — a no-op, except the hidden kill marker);
`malformed` (a value the engine cannot apply, e.g. `between 5`, an unknown preset).
A malformed link entry cannot be saved, and a stored one makes the public request fail
closed with **409** — it is never silently widened.

Disclosure: `public_link_locked_filters` carries only 🔒 entries that enforce a value
(display fields only). `public_link_hidden_filters` is always `[]`.

## 3. Precedence and merge

### 3.1 Layers

`_LAYER_ORDER` in `filter_layered_merge.py`; a later layer replaces an earlier one on
the same field:

```
chart_base < dashboard_filter (visible) < dashboard_slicer
  < viewer_slicer < viewer_filter
  ── author-enforced: a viewer cannot relax anything below this line ──
  < dashboard_filter_locked (🔒/🚫) < link_locked
then link_hidden removes fields
```

- **Dedupe key**: `(semanticField or fieldKey, field, datasetId)`, lower-cased. The
  operator is not part of the key, so a cross-operator override never double-applies.
- **Chart base filters are ANDed**, never replaced, even on the same field.
- Authoritative layers (`AUTHORITATIVE_LAYERS`: `dashboard_filter_locked`,
  `link_locked`, `page_scope`, `link_scope`) are applied **or the request is refused**.
  An empty authoritative entry refuses rather than normalising away.

### 3.2 Hard bounds, after the merge

Applied in this order on the public path:

1. **Link limit** (`apply_link_scope_bounds`). A pick inside the allow-list narrows
   to the intersection; a pick outside it, or no pick, falls back to the whole
   allow-list; a non-`in` pick is replaced by `in allow`. On a field that already has
   an authoritative entry, the scope is ANDed, never intersected with fallback.
2. **Page scope** (`apply_page_scope_bounds`), resolved on the server from the stored
   `pages_config` — never from the request. `in` against an `in` viewer pick
   intersects with fallback to the scope; anything else ANDs; a lock on the same field
   is never intersected. A page filter is skipped for a chart only when it provably
   belongs to another dataset; otherwise it is kept (fails closed).
3. **Author bounds** (`enforce_author_bounds`). Any 🔒/🚫 dashboard filter that a link
   lock replaced or a kill marker removed is ANDed back.
4. **Dataset scoping** (`scope_filters_to_dataset`).

### 3.3 Then parameters

Tile instance parameter filters are ANDed after everything above (`a..b` → `between`,
a list → `in`, otherwise `eq`). Parameter switcher selections are accepted only as
exactly what the switcher can produce — its resolved field, `in`, one of its options —
and join the `viewer_slicer` layer; anything else is **400**. What-if overrides are
accepted only for a bound role and one of the bound switcher's options.

### 3.4 Public pipeline

`_build_public_chart_filters` is the one merge for public chart data (single and
batch), distinct values and the AI bot: split and validate switcher filters → drop
unexposed viewer fields → re-attach stored date presets → canonicalise link entries and
peel off limits → split lock/hide (a valued hide becomes an undisclosed lock) → split
dashboard filters by `publicMode` → layer merge (§3.1) → hard bounds (§3.2).

## 4. WHERE vs HAVING

A filter on a measure is applied in `HAVING`; every other filter in `WHERE`
(`semantic_query_engine.py`). `top_n`/`bottom_n` never reach `WHERE`: they compile to
`ORDER BY … LIMIT`.

## 5. Empty and malformed filters

`normalize_filter_conditions` drops, with a diagnostic, entries with no field
(`no_field`) and entries with no usable value (`empty_value`); `is_null`/`is_not_null`
always count as active. An empty slicer never clobbers a valued default.

Drop reasons (`chart_contracts.py`) are either:

- **hard** — `unknown_field`, `dataset_mismatch`, `binding_unsupported`,
  `unsupported_operator`: the request fails with **400**;
- **soft** — `no_field`, `empty_value`, `not_in_public_whitelist`, `link_hidden`,
  `unreachable_view`: dropped, reported, never raised.

Authoritative entries are the exception: they are applied or refused (§3.1), and a
public refusal names no field and no value.

## 6. Builder and public consistency

The Builder resolves its filter set in the browser (`resolveEffectiveFilterSet`):
selections (visible defaults → page-scoped global slicers → page slicers, same dedupe
key as §3.1) → scope bound against non-authoritative page filters → authoritative
(🔒/🚫) filters last. It mirrors `_LAYER_ORDER`; the backend then folds in the chart
base filters. Kept in step by:

- the same dedupe key and the same intersection rule on both sides;
- mirrored date-preset functions (`computeDatePresetRange` ↔ `compute_date_preset_range`);
- distinct-value dropdowns using the same resolver as the charts;
- tile instance parameters run on identical vectors in Python and TypeScript
  (`backend/tests/fixtures/instance_parameter_vectors.json`);
- browser parity on all four surfaces: `e2e/tests/public-closure-*.spec.ts`.

## 7. Operators and relative dates

### 7.1 Canonical operators

`_OPERATOR_MAP` (`chart_contracts.py`):

| Group | Keys |
|---|---|
| comparison | `eq` `neq` `gt` `gte` `lt` `lte` |
| text | `like` `contains` `not_contains` `starts_with` `ends_with` `matches_regex` |
| list / range | `in` `not_in` `between` `not_between` |
| null | `is_null` `is_not_null` |
| date | `date_eq` `date_between` `date_in_last` `date_this` `date_to_date` |
| ranking | `top_n` `bottom_n` |

Aliases (`=`, `==`, `!=`, `<>`, `ne`, `not in`, …) map onto these keys. The default is
`eq`. `in`/`not_in` accept comma-separated text; `between` accepts `a..b` or `a,b`. An
unknown operator is dropped as `unsupported_operator` (hard, §5). Every literal is
quoted dialect-aware (spec invariant F).

### 7.2 Relative dates

A `datePreset` is resolved to `[start, end]` **by the server at request time**; the
stored token is authoritative and any frozen `value` beside it is ignored. The frontend
must not pre-resolve it. Presets: `today` `yesterday` `this_week` `last_week` (weeks
start Monday) `this_month` `last_month` `this_quarter` `last_quarter` `this_year`
`last_year` `last_7_days` `last_30_days` `last_90_days`; `custom` or an unknown token
resolves to nothing. "Today" is the app timezone's report date. On public requests the
server re-attaches the stored tokens, so a viewer cannot substitute a range. An
unresolved `date_in_last`/`date_this`/`date_to_date` reaching the SQL builder is an
error, never a silent no-op.

## 8. Security boundary

A viewer's filter is a request, not an authority. A viewer cannot remove or widen a
locked, hidden, page-scope or link-limit constraint, cannot claim or shed a server
marker, and is never told the field or value of a hidden one — invariants A–E in the
spec. Locked by `backend/tests/test_public_filter_authority.py`,
`test_public_authoritative_bounds.py` (+ `_pg`), `test_public_link_filter_disclosure.py`
and `test_filter_layered_merge.py`.

Presentation flags (`show_page_tabs`, `allow_viewer_filters`, `allow_data_export`)
choose which controls a viewer sees; they are not data controls.

## 9. What a public viewer sees and edits

- Slicers and `visible` filter-pane entries, editable (subject to §3.2 bounds).
- 🔒 entries that enforce a value, read-only, display fields only.
- Nothing about 🚫 entries — not in the structure, the picker, errors or the AI context.
- Parameter switchers, interactive, limited to their options.
