'use client';

/**
 * The retired AI Analyst address. Data questions are asked in the one AI Chat
 * (docs/features/unified-ai-chat/contract.md); nothing is answered here.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AnalystRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/chat'); }, [router]);
  return null;
}
