'use client';

import { PublicReportView } from '@/components/report-code/PublicReportView';

// Embeddable Report-as-Code page (/embed/r/<token>): the same public surface without
// the attribution bar, under /embed/ so the embed framing policy applies.
export default function EmbedCodeReportPage() {
  return <PublicReportView variant="embed" />;
}
