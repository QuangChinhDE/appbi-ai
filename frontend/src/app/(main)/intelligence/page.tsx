'use client';

import { Suspense } from 'react';

import { IntelligenceOverviewPage } from '@/components/intelligence/OverviewPage';

export default function IntelligencePage() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">…</div>}>
      <IntelligenceOverviewPage />
    </Suspense>
  );
}
