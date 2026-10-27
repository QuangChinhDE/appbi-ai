/**
 * Deployment flags that switch whole modules on or off.
 *
 * `NEXT_PUBLIC_*` values are inlined by `next build`, so flipping one needs a
 * frontend rebuild — the same contract as every other flag in this app (see
 * `export-mode.ts`). Keeping them in one tiny module (no React, no imports) is
 * deliberate: `middleware.ts` runs on the Edge runtime and can import from here
 * without dragging in anything Node-specific.
 */

/**
 * The Home module — "Trang chủ" / Overview, served at `/overview`.
 *
 * OFF by default since 2026-08-17, on DA request. The page fanned out five list
 * endpoints on mount (`/datasources`, `/datasets`, `/charts?limit=500`,
 * `/dashboards`, `/workboards`) and then built a lineage graph across all of
 * them, which made the first screen after login the slowest one in the product
 * while showing nothing the user could act on.
 *
 * The module is hidden, not deleted: the page component and its lineage board
 * are untouched. Set `NEXT_PUBLIC_HOME_MODULE_ENABLED=true` and rebuild the
 * frontend to restore the nav entry, the route, and `/` landing on it.
 */
export const HOME_MODULE_ENABLED =
  String(process.env.NEXT_PUBLIC_HOME_MODULE_ENABLED ?? 'false').toLowerCase() === 'true';

/**
 * Where `/` sends an authenticated user, and where the hidden Home route
 * bounces to. Dashboards is the landing module while Home is switched off.
 */
export const DEFAULT_LANDING_PATH = HOME_MODULE_ENABLED ? '/overview' : '/dashboards';
