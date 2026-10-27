'use client';

import React from 'react';

import ChatWorkspace from '@/components/chat/ChatWorkspace';

/**
 * AI Chat: a new conversation. The first question opens it (/chat/c/{id}).
 *
 * SUSPENSE IS REQUIRED, NOT DECORATION: the page reads `?thread=` (an old
 * Flow-chat link) and `?brain=` (an add-on to start with). `useSearchParams()`
 * cannot be resolved while prerendering, so Next fails the build unless the
 * component that reads it sits behind a boundary.
 */
export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <ChatWorkspace />
    </React.Suspense>
  );
}
