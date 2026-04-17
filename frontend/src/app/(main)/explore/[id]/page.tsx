'use client';

import { useParams } from 'next/navigation';

import { ExploreEditor } from '@/components/explore/ExploreEditor';

export default function ExploreDetailPage() {
  const params = useParams();
  const routeChartId = params.id === 'new' ? null : Number(params.id);

  return <ExploreEditor chartId={routeChartId} />;
}
