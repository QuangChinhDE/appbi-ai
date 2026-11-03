'use client';

import { LayoutDashboard, Wand2 } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { publishState, type ReportKind, type ReportListItem } from '@/components/dashboards/reportListItems';
import { useI18n } from '@/providers/LanguageProvider';

/** Which builder made the report: Build Manual or AI Vibe Report. */
export function ReportKindBadge({ kind }: { kind: ReportKind }) {
  const { t } = useI18n();
  return kind === 'vibe' ? (
    <Badge variant="brand" size="sm" pill data-testid="report-kind-vibe">
      <Wand2 className="h-3 w-3" />{t('reportList.kind.vibe')}
    </Badge>
  ) : (
    <Badge variant="neutral" size="sm" pill data-testid="report-kind-manual">
      <LayoutDashboard className="h-3 w-3" />{t('reportList.kind.manual')}
    </Badge>
  );
}

/** Draft / Published, one vocabulary for both kinds. */
export function ReportStatusChip({ item }: { item: ReportListItem }) {
  const { t } = useI18n();
  const s = publishState(item);
  const v = s.version ? ` v${s.version}` : '';
  if (s.label === 'draft') return <Badge variant="subtle" size="sm" pill dot>{t('reportList.status.draft')}{v}</Badge>;
  if (s.label === 'changes') return <Badge variant="warning" size="sm" pill dot>{t('reportList.status.changes')}{v}</Badge>;
  return <Badge variant="success" size="sm" pill dot>{t('reportList.status.published')}{v}</Badge>;
}
