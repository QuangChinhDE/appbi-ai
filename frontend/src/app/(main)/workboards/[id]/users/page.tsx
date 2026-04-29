'use client';

import React from 'react';
import { useParams } from 'next/navigation';

import { useWorkboard } from '@/hooks/use-workboards';
import WorkboardAppUsersTab from '@/components/workboards/builder/WorkboardAppUsersTab';

export default function WorkboardUsersPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: workboard } = useWorkboard(id);
  if (!workboard) return null;
  return <WorkboardAppUsersTab workboard={workboard} />;
}
