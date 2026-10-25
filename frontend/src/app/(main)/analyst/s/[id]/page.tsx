'use client';

/** AI Analyst: one saved (or shared) analysis session. Access is decided by the server. */
import { useParams } from 'next/navigation';

import AnalystWorkspace from '@/components/analyst/AnalystWorkspace';

export default function AnalystSessionPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  // the key remounts the workspace when another session is opened from the list
  return <AnalystWorkspace key={id} sessionId={Number.isInteger(id) && id > 0 ? id : -1} />;
}
