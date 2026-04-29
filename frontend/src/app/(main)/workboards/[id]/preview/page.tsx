'use client';

import React from 'react';
import { useParams } from 'next/navigation';

import { useWorkboard } from '@/hooks/use-workboards';
import WorkboardPreview from '@/components/workboards/builder/WorkboardPreview';

export default function WorkboardPreviewPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: workboard } = useWorkboard(id);
  if (!workboard) return null;
  return <WorkboardPreview workboard={workboard} />;
}
