'use client';

import { PublicDashboardView } from '@/components/dashboards/PublicDashboardView';

// Standalone public share link (/d/<token>). The full report surface lives in
// the shared PublicDashboardView so this page and the embed page (/embed/<token>)
// can never drift apart — they are the same component, differing only by variant.
export default function PublicDashboardPage() {
  return <PublicDashboardView variant="public" />;
}
