/**
 * Report filters that do not apply to a chart — the AUTHOR's diagnostic.
 *
 * The engine reports a filter it could not apply to a chart in
 * `debug.dropped_filters` (backend chart_contracts FILTER_DROP_* and the
 * propagation reasons), and the Builder itself detects a filter whose field the
 * chart's data does not have. This module turns both into what an author can act
 * on: WHICH filter (by its report label, never an id), WHY in product words, and
 * the consequence (the chart's numbers do not follow that filter). The engine's
 * own wording stays available only as an explicit "technical details" note.
 *
 * Viewers (/d, /embed, emb_) and exports never show this (product contract 2026-10).
 */
import { getFilterDisplayLabel, getFriendlyFieldLabel, type BaseFilter } from '@/lib/filters';
import type { DroppedFilterInfo } from '@/types/api';

export type FilterDiagnosticKind = 'no_field' | 'not_linked' | 'operator' | 'no_value' | 'link_only' | 'other';

const KIND_BY_REASON: Record<string, FilterDiagnosticKind> = {
  // the chart's data has no field the filter can use
  no_field: 'no_field',
  unknown_field: 'no_field',
  dataset_mismatch: 'no_field',
  binding_unsupported: 'no_field',
  not_in_model: 'no_field',
  // the field exists, but no relationship reaches the chart's data
  unreachable_view: 'not_linked',
  no_join_path: 'not_linked',
  wrong_direction: 'not_linked',
  ambiguous_path: 'not_linked',
  no_primary_key: 'not_linked',
  multi_role_pick_required: 'not_linked',
  // the condition does not fit the field
  unsupported_operator: 'operator',
  unknown_operator: 'operator',
  // nothing chosen
  empty_value: 'no_value',
  // shared-link policy
  not_in_public_whitelist: 'link_only',
  link_hidden: 'link_only',
};

export function diagnosticKind(reason: string | null | undefined): FilterDiagnosticKind {
  return KIND_BY_REASON[String(reason ?? '').trim()] ?? 'other';
}

export interface FilterDiagnosticItem {
  /** The filter as the author named it on the report. */
  label: string;
  kind: FilterDiagnosticKind;
  /** The engine's own wording — shown only behind "technical details". */
  technical: string;
}

const refsOf = (f: Pick<BaseFilter, 'field' | 'semanticField' | 'fieldKey'>) =>
  [f.semanticField, f.fieldKey, f.field].filter(Boolean).map((r) => String(r));

/** The report filter a dropped entry is about, matched on the field it names. */
function filterFor(entry: DroppedFilterInfo, filters: BaseFilter[]): BaseFilter | null {
  const wanted = [entry.semantic_field, entry.field].filter(Boolean).map((r) => String(r));
  if (!wanted.length) return null;
  const exact = filters.find((f) => refsOf(f).some((r) => wanted.includes(r)));
  if (exact) return exact;
  const tail = (r: string) => r.split('.').pop() ?? r;
  return filters.find((f) => refsOf(f).some((r) => wanted.some((w) => tail(w) === tail(r)))) ?? null;
}

/**
 * One line per filter that does not apply. `skipped` are the report filters the
 * Builder found no field for; `dropped` is what the engine reported; `filters`
 * are the filters applied to the report (for their labels).
 */
export function buildFilterDiagnostics(input: {
  skipped: BaseFilter[];
  dropped: DroppedFilterInfo[];
  filters: BaseFilter[];
  unknownLabel: string;
}): FilterDiagnosticItem[] {
  const out: FilterDiagnosticItem[] = [];
  const seen = new Set<string>();
  const push = (item: FilterDiagnosticItem) => {
    const key = item.label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const f of input.skipped) {
    push({ label: getFilterDisplayLabel(f) || input.unknownLabel, kind: 'no_field', technical: `not_in_model: ${refsOf(f)[0] ?? ''}` });
  }
  for (const d of input.dropped) {
    const match = filterFor(d, input.filters);
    const label = (match ? getFilterDisplayLabel(match) : getFriendlyFieldLabel(d.field || d.semantic_field))
      || input.unknownLabel;
    push({
      label,
      kind: diagnosticKind(d.reason),
      technical: [d.reason, d.semantic_field || d.field, d.detail].filter(Boolean).join(' · '),
    });
  }
  return out;
}
