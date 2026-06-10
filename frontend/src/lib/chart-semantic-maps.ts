/**
 * Shared builders for the chart label/number-format maps derived from a
 * dataset's semantic model. SINGLE source of truth so the Explore editor and
 * every Dashboard surface (tile, detail modal, readonly tile) format and label
 * a chart IDENTICALLY.
 *
 * The recurring "chart shows 36.2% in Explore but 0.4 on the dashboard" bug was
 * caused by the dashboard surfaces NOT passing these maps to <ExploreChart>:
 * the KPI/format precedence then fell through to 'compact' and dropped the
 * measure's declared percent/currency format (and the friendly label). Building
 * the maps here, from the same `datasetModel`, keeps both paths in lock-step.
 */
import type { NumberFormat } from '@/components/explore/ExploreChartConfig';
import type { DatasetModelView } from '@/hooks/use-dataset-model';

/** {qualified-or-bare field → display label} for legends/tooltips/axes. */
export function buildSemanticLabelMap(
  views: DatasetModelView[] | undefined | null,
): Map<string, string> | undefined {
  if (!views) return undefined;
  const map = new Map<string, string>();
  for (const view of views) {
    for (const dim of view.dimensions ?? []) {
      const label = (dim.label || '').trim();
      if (!label) continue;
      map.set(`${view.name}.${dim.name}`, label);
      if (!map.has(dim.name)) map.set(dim.name, label);
    }
    for (const measure of view.measures ?? []) {
      const label = (measure.label || '').trim();
      if (!label) continue;
      map.set(`${view.name}.${measure.name}`, label);
      if (!map.has(measure.name)) map.set(measure.name, label);
    }
  }
  return map;
}

/**
 * {qualified-or-bare field → NumberFormat} from the measure's declared
 * `format.kind`. percent / currency / number map through; duration / custom
 * are skipped (no NumberFormat equivalent). Style-level overrides still win;
 * this is only the default when nothing else is set.
 */
export function buildSemanticFormatMap(
  views: DatasetModelView[] | undefined | null,
): Map<string, NumberFormat> | undefined {
  if (!views) return undefined;
  const map = new Map<string, NumberFormat>();
  const mapKind = (kind: string | undefined): NumberFormat | undefined =>
    kind === 'percent' || kind === 'currency' || kind === 'number' ? kind : undefined;
  for (const view of views) {
    for (const measure of view.measures ?? []) {
      const fmt = mapKind(measure.format?.kind);
      if (!fmt) continue;
      map.set(`${view.name}.${measure.name}`, fmt);
      if (!map.has(measure.name)) map.set(measure.name, fmt);
    }
  }
  return map.size > 0 ? map : undefined;
}
