'use client';

import React from 'react';
import { useParams } from 'next/navigation';

import WorkboardWebhooksTab from '@/components/workboards/builder/WorkboardWebhooksTab';

export default function WorkboardWebhooksPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return <WorkboardWebhooksTab workboardId={id} />;
}
