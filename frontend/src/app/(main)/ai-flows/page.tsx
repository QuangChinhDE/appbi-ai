'use client';

import { Suspense } from 'react';

import { StudioPage } from '@/components/ai-flows/StudioPage';

export default function AiFlowsRoute() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">…</div>}>
      <StudioPage />
    </Suspense>
  );
}
