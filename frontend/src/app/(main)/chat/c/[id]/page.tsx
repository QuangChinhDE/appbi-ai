'use client';

/** AI Chat: one saved (or shared) conversation. Access is decided by the server. */
import React from 'react';
import { useParams } from 'next/navigation';

import ChatWorkspace from '@/components/chat/ChatWorkspace';

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  // the key remounts the workspace when another conversation is opened from the list
  return (
    <React.Suspense fallback={null}>
      <ChatWorkspace key={id} conversationId={Number.isInteger(id) && id > 0 ? id : -1} />
    </React.Suspense>
  );
}
