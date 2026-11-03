/**
 * /dashboards lists both kinds of report: Manual Dashboards and AI Vibe Reports.
 * A Vibe Report is carried through the same list as a Dashboard-shaped row tagged
 * `report_kind: 'vibe'`, so search, sorting, pagination and both views treat them
 * alike; what differs (route, actions, status) is decided from the tag.
 */
import type { ReportSummary } from '@/lib/api/report-code';
import type { Dashboard } from '@/types/api';

export type ReportKind = 'manual' | 'vibe';
export type ReportTypeFilter = 'all' | ReportKind;

export type ReportListItem = Dashboard & { report_kind?: ReportKind; vibe?: ReportSummary };

export const isVibe = (item: ReportListItem): boolean => item.report_kind === 'vibe';

export const rowKey = (item: ReportListItem): string => `${item.report_kind === 'vibe' ? 'vibe' : 'manual'}-${item.id}`;

export const openHref = (item: ReportListItem): string =>
  isVibe(item) ? `/dashboards/code/${item.id}` : `/dashboards/${item.id}`;

export function vibeAsListItem(r: ReportSummary): ReportListItem {
  const level = r.user_permission ?? 'view';
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    owner_email: r.owner_email ?? undefined,
    user_permission: level,
    // What the caller may do with a report (re-checked server-side on every call).
    capabilities: {
      read: true,
      edit: level === 'edit' || level === 'full',
      delete: level === 'full',
      share: false,
      publish: level === 'full',
    },
    created_at: r.updated_at || '',
    updated_at: r.updated_at || '',
    last_published_at: r.last_published_at ?? null,
    dashboard_charts: [],
    report_kind: 'vibe',
    vibe: r,
  } as ReportListItem;
}

/** Draft/Published as one status vocabulary for both kinds. */
export function publishState(item: ReportListItem): { label: 'published' | 'changes' | 'draft'; version?: number | null } {
  if (isVibe(item)) {
    const v = item.vibe!;
    if (!v.published_number) return { label: 'draft', version: v.draft_number };
    return { label: v.has_unpublished_changes ? 'changes' : 'published', version: v.published_number };
  }
  // A manual dashboard is served live; editor changes sit in a draft overlay until published.
  return { label: (item as Dashboard & { has_draft?: boolean }).has_draft ? 'changes' : 'published' };
}
