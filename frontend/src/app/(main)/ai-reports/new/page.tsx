'use client';

import { AIReportWizard } from '@/components/ai-reports/AIReportWizard';

export default function NewAIReportPage() {
  return (
    <AIReportWizard
      mode="page"
      backHref="/ai-reports"
      initialSpecId={null}
    />
  );
}
