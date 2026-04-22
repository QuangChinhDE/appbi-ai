'use client';

import { useParams } from 'next/navigation';

import { ChartEditorWithTabs } from '@/components/explore/ChartEditorWithTabs';

export default function ExploreDetailPage() {
  const params = useParams();
  const routeChartId = params.id === 'new' ? null : Number(params.id);

  return <ChartEditorWithTabs chartId={routeChartId} />;
}
