'use client';

/**
 * An old /analyst/s/{id} link. The session was imported into AI Chat (alembic
 * 20261027_0001); the server resolves it to that conversation only for someone who
 * may read it, and nothing is ever answered on the retired engine.
 */
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { chatApi } from '@/lib/api/chat';

export default function AnalystSessionRedirect() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  useEffect(() => {
    const id = Number(params?.id);
    if (!Number.isInteger(id) || id <= 0) {
      router.replace('/chat');
      return;
    }
    chatApi.resolveLegacy('analyst_session', id)
      .then((cid) => router.replace(`/chat/c/${cid}`))
      .catch(() => router.replace('/chat/c/-1'));
  }, [params, router]);
  return null;
}
