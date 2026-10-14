'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { ExploreEditor } from '@/components/explore/ExploreEditor';

export default function ExploreDetailPage() {
  const params = useParams();
  const routeChartId = params.id === 'new' ? null : Number(params.id);
  // "Edit chart" from a report tile: saving asks whether the edit is for this
  // report only or for the shared chart (see ExploreEditor.reportContext).
  const search = useSearchParams();
  const fromReport = Number(search?.get('fromReport'));
  const tile = Number(search?.get('tile'));
  const reportContext = routeChartId !== null && fromReport > 0 && tile > 0
    ? { dashboardId: fromReport, tileId: tile }
    : null;

  // Explore is chart-only; the Calculated-table tab lives in the Dashboard
  // import/edit flow where it makes sense alongside source transforms.
  return <ExploreEditor chartId={routeChartId} reportContext={reportContext} />;
}
