'use client';

import React from 'react';

import { AgentFlowsPage } from '@/components/agent-flows/AgentFlowsPage';

/**
 * SUSPENSE IS REQUIRED, NOT DECORATION.
 *
 * The page reads `?flow=` and `?tab=` so a flow and its Runs tab are
 * addressable. `useSearchParams()` cannot be resolved while prerendering — the
 * query string only exists in the browser — so Next fails the export unless the
 * component that reads it sits behind a boundary. Without this the build
 * printed "Compiled successfully" and then errored during export, producing no
 * standalone output at all.
 */
export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <AgentFlowsPage />
    </React.Suspense>
  );
}
