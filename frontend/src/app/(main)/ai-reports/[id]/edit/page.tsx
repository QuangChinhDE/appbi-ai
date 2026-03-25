'use client';

import { useParams } from 'next/navigation';

import { AIReportWizard } from '@/components/ai-reports/AIReportWizard';

export default function EditAIReportPage() {
  const params = useParams();
  const specId = Number(params.id);

  return (
    <AIReportWizard
      mode="page"
      backHref={Number.isFinite(specId) ? `/ai-reports/${specId}` : '/ai-reports'}
      initialSpecId={Number.isFinite(specId) ? specId : null}
    />
  );
}
