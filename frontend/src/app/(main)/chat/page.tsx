'use client';

import React from 'react';

import { ChatModule } from '@/components/chat/ChatModule';

/**
 * SUSPENSE IS REQUIRED, NOT DECORATION.
 *
 * The page reads `?brain=` and `?thread=` so a conversation is addressable.
 * `useSearchParams()` cannot be resolved while prerendering — the query string only
 * exists in the browser — so Next fails the export unless the component that reads
 * it sits behind a boundary.
 */
export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <ChatModule />
    </React.Suspense>
  );
}
