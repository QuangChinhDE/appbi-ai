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
 * BFS over all model joins starting from `baseViewName`.
 * Returns the set of semantic node ids reachable through declared joins,
 * including the base view itself. When a join has an alias, that alias is the
 * node id used in field refs.
 */
export function computeReachableViews(
  model: DatasetModelResponse | null | undefined,
  baseViewName: string | null | undefined,
): Set<string> {
  const reachable = new Set<string>();
  if (!model || !baseViewName) return reachable;

  reachable.add(baseViewName);

  // Build adjacency from every explore so multi-hop chains can cross the
  // explore that originally owns each relationship.
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!a || !b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const explore of model.explores ?? []) {
    for (const join of explore.joins ?? []) {
      const from = join.from_view ?? explore.base_view_name;
      const to = join.alias || join.view;
      addEdge(from, to);
      addEdge(to, from);
    }
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
 * PowerBI-parity (2026-06) STRICT reachability — mirrors the backend's
 * single-direction resolver (`SemanticJoinResolver`, bidirectional=false).
 *
 * `computeReachableViews` walks joins BOTH ways, so it reports a sibling fact's
 * dimension (e.g. `dim_customer` reachable from `fact_targets` via the bridge
 * `targets→region→sales→customer`) as reachable. The backend's default
 * single-direction relationships do NOT propagate a filter that way, so such a
 * filter is silently ignored at query time. This helper reproduces that rule on
 * the FE — traverse a join `from→to` always, but `to→from` ONLY when the join
 * declares `cross_filter: 'both'` — so the Explore filter UI can WARN that a
 * field which is pickable (bidirectionally reachable) won't actually apply.
 *
 * Used for warnings only; the column picker stays on the permissive set so a
 * legitimately bidirectional (`cross_filter:'both'`) model still works.
 */
export function computeStrictReachableViews(
  model: DatasetModelResponse | null | undefined,
  baseViewName: string | null | undefined,
): Set<string> {
  const reachable = new Set<string>();
  if (!model || !baseViewName) return reachable;
  reachable.add(baseViewName);

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!a || !b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const explore of model.explores ?? []) {
    for (const join of explore.joins ?? []) {
      const from = join.from_view ?? explore.base_view_name;
      const to = join.alias || join.view;
      addEdge(from, to);
      // Reverse edge only when the relationship is explicitly bidirectional —
      // matches the backend's `cross_filter === 'both'` synthetic-reverse rule.
      const crossFilter = String((join as any).cross_filter ?? 'single').toLowerCase();
      if (crossFilter === 'both') addEdge(to, from);
    }
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
  const viewsByName = new Map(model.views.map((view) => [view.name, view]));
  const nodeToViewName = new Map<string, string>(
    model.views.map((view) => [view.name, view.name]),
  );

  for (const explore of model.explores ?? []) {
    for (const join of explore.joins ?? []) {
      const viewName = join.view;
      const nodeName = join.alias || join.view;
      if (viewName && nodeName) {
        nodeToViewName.set(nodeName, viewName);
      }
    }
  }

  const out: DatasetModelView[] = [];
  const seen = new Set<string>();
  for (const nodeName of reachable) {
    if (seen.has(nodeName)) continue;
    const viewName = nodeToViewName.get(nodeName) ?? nodeName;
    const view = viewsByName.get(viewName);
    if (!view) continue;
    seen.add(nodeName);
    out.push(
      nodeName === view.name
        ? view
        : {
            ...view,
            name: nodeName,
            table_display_name: view.table_display_name
              ? `${view.table_display_name} (${nodeName})`
              : `${view.name} (${nodeName})`,
          },
    );
  }
  return out;
}
