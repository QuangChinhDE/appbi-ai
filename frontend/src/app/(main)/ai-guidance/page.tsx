'use client';

import { Suspense } from 'react';

import { GuidancePage } from '@/components/intelligence/GuidancePage';

export default function AIGuidanceRoute() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">…</div>}>
      <GuidancePage />
    </Suspense>
  );
}
