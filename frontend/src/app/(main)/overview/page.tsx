/**
 * `/overview` — the Home module route.
 *
 * Hidden by default (`HOME_MODULE_ENABLED`, see `lib/feature-flags.ts`), so this
 * is a server component whose only job is the gate: with the module off, the
 * request is redirected before React renders anything, which is what keeps the
 * page's five list queries from ever firing. `middleware.ts` already bounces the
 * same path at the edge; this guard stands on its own so the route can never
 * serve the module by accident (a middleware matcher change, a direct RSC hit).
 *
 * The page itself lives in `components/overview/OverviewHome.tsx`, untouched —
 * flipping the flag brings it back exactly as it was.
 */
import { redirect } from 'next/navigation';

import { OverviewHome } from '@/components/overview/OverviewHome';
import { DEFAULT_LANDING_PATH, HOME_MODULE_ENABLED } from '@/lib/feature-flags';

export default function OverviewPage() {
  if (!HOME_MODULE_ENABLED) redirect(DEFAULT_LANDING_PATH);

  return <OverviewHome />;
}
