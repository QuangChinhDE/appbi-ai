/**
 * Model-aware base-table selection for Explore.
 *
 * The chart's "base" (left) table is the FROM root of the semantic join tree.
 * Historically the FE defaulted it to `tables[0]` (arbitrary — first table
 * added) or the first-picked field's view, neither of which reads the data
 * model. On a star / galaxy schema the sensible default is the CENTRAL FACT:
 * the measure-bearing table that reaches the most other tables through
 * many-to-one (N:1) relationships — i.e. the hub every dimension hangs off.
 *
 * These helpers mirror the backend `SemanticQueryEngine._m1_reachable_views`
 * exactly (forward BFS over the model's joins, following ONLY explicit
 * many_to_one / one_to_one edges, skipping inactive joins) so the FE
 * recommendation matches the grain the engine actually renders.
 *
 * NB: this only drives the RECOMMENDATION + the DA-overridable base picker.
 * The auto-derive-from-first-field default is intentionally kept (see
 * ExploreEditor Phase-15.10) so the common "measure by dim" chart still anchors
 * on the dimension and preserves every dim member (PowerBI parity) — the engine
 * is base-invariant for measures, so we must NOT silently re-root to a fact.
 */
import type { DatasetModelResponse } from '@/hooks/use-dataset-model';

const M1_CARDINALITIES = new Set(['many_to_one', 'one_to_one']);

function normalizeCardinality(raw?: string | null): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/ /g, '_');
}

/**
 * View names reachable from `baseViewName` by following the model's join graph
 * FORWARD along non-fanning (many_to_one / one_to_one) edges — every hop maps
 * one base row to a single target row, so grouping/joining stays fan-out-free.
 * Includes the base itself. Mirrors the backend `_m1_reachable_views`.
 */
export function reachableM1Views(
  model: DatasetModelResponse | null | undefined,
  baseViewName: string,
): Set<string> {
  const seen = new Set<string>();
  if (!model || !baseViewName) return seen;
  const joinsByBase = new Map<string, DatasetModelResponse['explores'][number]['joins']>();
  for (const explore of model.explores || []) {
    if (explore?.base_view_name) joinsByBase.set(explore.base_view_name, explore.joins || []);
  }
  seen.add(baseViewName);
  const stack = [baseViewName];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const join of joinsByBase.get(cur) || []) {
      if (!join || join.is_active === false) continue;
      // CARDINALITY (relationship) first — the canonical field; `type` is only
      // a legacy fallback and is the SQL join-type (always 'left' now), not the
      // cardinality, so it must never be read as one.
      const card = normalizeCardinality(join.relationship);
      if (!M1_CARDINALITIES.has(card)) continue;
      const target = String(join.view || '').trim();
      if (target && !seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  return seen;
}

/**
 * The recommended base table id for a dataset model = the CENTRAL FACT: among
 * measure-bearing views, the one whose N:1 reach covers the most other views
 * (tie-break: more measures, then more direct joins, then stable order). Falls
 * back to the widest-reaching view when no view declares a measure, and finally
 * to null (caller keeps its existing default). Only considers views bound to a
 * real dataset table (a base must have a `dataset_table_id`).
 */
export function pickRecommendedBaseTableId(
  model: DatasetModelResponse | null | undefined,
): number | null {
  const views = (model?.views || []).filter((v) => v.dataset_table_id != null);
  if (!views.length) return null;
  const joinCount = new Map<string, number>();
  for (const explore of model?.explores || []) {
    if (explore?.base_view_name) joinCount.set(explore.base_view_name, (explore.joins || []).length);
  }
  const factViews = views.filter((v) => (v.measures?.length ?? 0) > 0);
  const pool = factViews.length ? factViews : views;
  let best: (typeof pool)[number] | null = null;
  let bestScore = -1;
  for (const v of pool) {
    const reach = reachableM1Views(model, v.name).size;
    // reach dominates; measures then direct-join-count break ties.
    const score = reach * 1_000_000 + (v.measures?.length ?? 0) * 1000 + (joinCount.get(v.name) ?? 0);
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best?.dataset_table_id ?? null;
}
