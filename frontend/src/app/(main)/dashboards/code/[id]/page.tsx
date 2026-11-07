'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { ReportStudio } from '@/components/report-code/ReportStudio';
import { ReportStudioHome } from '@/components/report-code/ReportStudioHome';

// AI Report Studio (Report-as-Code). `/dashboards/code/new` is its home: create a
// report and list existing ones; `/dashboards/code/<id>` is the studio. Under
// /dashboards so the module access mapping is the dashboards module's.
export default function CodeReportPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = String(params?.id || '');
  if (id === 'new' || !/^\d+$/.test(id)) return <ReportStudioHome />;
  // `?revision=N` opens the studio on that saved revision (a link from a review, e.g. an
  // MCP approval page): the same renderer and data path as picking it under Versions.
  const rev = Number(search?.get('revision') || '');
  return <ReportStudio reportId={Number(id)} initialRevision={Number.isInteger(rev) && rev > 0 ? rev : null}
    proposalId={(search?.get('proposal') || '').replace(/[^a-f0-9]/g, '') || null} />;
}
