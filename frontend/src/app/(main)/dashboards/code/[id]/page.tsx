'use client';

import { useParams } from 'next/navigation';

import { ReportStudio } from '@/components/report-code/ReportStudio';
import { ReportStudioHome } from '@/components/report-code/ReportStudioHome';

// AI Report Studio (Report-as-Code). `/dashboards/code/new` is its home: create a
// report and list existing ones; `/dashboards/code/<id>` is the studio. Under
// /dashboards so the module access mapping is the dashboards module's.
export default function CodeReportPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || '');
  if (id === 'new' || !/^\d+$/.test(id)) return <ReportStudioHome />;
  return <ReportStudio reportId={Number(id)} />;
}
