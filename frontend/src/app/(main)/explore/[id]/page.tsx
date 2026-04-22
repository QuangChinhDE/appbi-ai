'use client';

import { useParams } from 'next/navigation';

import { ExploreEditor } from '@/components/explore/ExploreEditor';

export default function ExploreDetailPage() {
  const params = useParams();
  const routeChartId = params.id === 'new' ? null : Number(params.id);

  // Explore is chart-only; the Calculated-table tab lives in the Dashboard
  // import/edit flow where it makes sense alongside source transforms.
  return <ExploreEditor chartId={routeChartId} />;
}
