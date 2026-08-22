/**
 * Which permission module owns which route — the frontend half of the backend's
 * router-level module floor.
 *
 * WHY THIS FILE EXISTS.
 *
 * The sidebar already hid a module the user has no permission for, and the API
 * now refuses it. Neither of those stops the PAGE from rendering: signing in
 * lands on `/dashboards`, and a user holding nothing saw the full Dashboards
 * shell — "No dashboards yet · Create your first dashboard" — inviting them to
 * create something the server would refuse, with a row of 403s in the console
 * behind it. Hidden in the nav is not the same as unreachable, and a URL is
 * typed, bookmarked and shared.
 *
 * One map, used by the shell guard and by the post-login landing choice, so the
 * two can never disagree about who may open what.
 */
import type { ModuleKey } from '@/hooks/use-permissions';

/** Route prefix → the module that grants it. Longest prefix wins. */
export const ROUTE_MODULES: ReadonlyArray<readonly [string, ModuleKey]> = [
  ['/datasources', 'data_sources'],
  ['/datasets', 'datasets'],
  ['/explore', 'explore_charts'],
  ['/dashboards', 'dashboards'],
  ['/observability', 'observability'],
  ['/govern', 'govern'],
  ['/agent-flows', 'agent_flows'],
  ['/workboards', 'workboards'],
  ['/permissions', 'settings'],
] as const;

/**
 * The module a path belongs to, or null when the route is not module-owned
 * (overview, account pages, anything shared).
 *
 * Fails OPEN on purpose: an unmapped route is not guarded here. The server is
 * the boundary; this map exists to explain a refusal rather than to create one,
 * and guessing wrong would lock people out of a page nobody meant to gate.
 */
export function moduleForPath(pathname: string): ModuleKey | null {
  let best: readonly [string, ModuleKey] | null = null;
  for (const entry of ROUTE_MODULES) {
    if (pathname === entry[0] || pathname.startsWith(entry[0] + '/')) {
      if (!best || entry[0].length > best[0].length) best = entry;
    }
  }
  return best ? best[1] : null;
}
