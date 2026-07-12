'use client';

import { Suspense } from 'react';

import { InboxPage } from '@/components/intelligence/InboxPage';

export default function AIInboxRoute() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">…</div>}>
      <InboxPage />
    </Suspense>
  );
}
