'use client';

import { Suspense } from 'react';

import { SemanticsPage } from '@/components/intelligence/SemanticsPage';

export default function SemanticsRoute() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">…</div>}>
      <SemanticsPage />
    </Suspense>
  );
}
