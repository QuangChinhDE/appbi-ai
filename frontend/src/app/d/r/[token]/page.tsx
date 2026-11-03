'use client';

import { PublicReportView } from '@/components/report-code/PublicReportView';

// Public link of a published Report-as-Code page (/d/r/<token>). Under /d/, so the
// middleware treats it as public and applies the same framing floor as /d/<token>.
export default function PublicCodeReportPage() {
  return <PublicReportView variant="public" />;
}
