/**
 * Helpers for traversing the join graph of a Dataset Semantic Model.
 *
 * The Explore module uses these to know which views are reachable (via JOIN)
 * from a base view, so the chart builder can correctly scope its schema to
 * "base view + all joined views" instead of just the single selected table.
 */
import type { DatasetModelResponse, DatasetModelExplore, DatasetModelView } from '@/hooks/use-dataset-model';

/**
 * Find the explore that uses the given view as its base.
 */
export function findExploreForBaseView(
  model: DatasetModelResponse | null | undefined,
  baseViewName: string | null | undefined,
): DatasetModelExplore | null {
  if (!model || !baseViewName) return null;
  return model.explores.find((e) => e.base_view_name === baseViewName) ?? null;
}

/**
 * BFS over `explore.joins` starting from `baseViewName`.
 * Returns the set of view names reachable through declared joins, including
 * the base view itself. Each join contributes both `from_view` (anchor) and
 * `view` (target) so multi-hop chains naturally propagate.
 */
export function computeReachableViews(
  model: DatasetModelResponse | null | undefined,
  baseViewName: string | null | undefined,
): Set<string> {
  const reachable = new Set<string>();
  if (!model || !baseViewName) return reachable;

  const explore = findExploreForBaseView(model, baseViewName);
  reachable.add(baseViewName);
  if (!explore) return reachable;

  // Build adjacency from joins: from_view -> view (and view -> from_view, since
  // user can pivot in either direction in the chart builder).
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!a || !b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const join of explore.joins ?? []) {
    const from = join.from_view ?? explore.base_view_name;
    const to = join.view;
    addEdge(from, to);
    addEdge(to, from);
  }

  const queue: string[] = [baseViewName];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbours = adjacency.get(current);
    if (!neighbours) continue;
    for (const next of neighbours) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  return reachable;
}

/**
 * Filter the model's views to those reachable from the base view, preserving
 * the order from `model.views`. Always includes the base view if present.
 */
export function getReachableViews(
  model: DatasetModelResponse | null | undefined,
  baseViewName: string | null | undefined,
): DatasetModelView[] {
  if (!model) return [];
  const reachable = computeReachableViews(model, baseViewName);
  return model.views.filter((v) => reachable.has(v.name));
}
