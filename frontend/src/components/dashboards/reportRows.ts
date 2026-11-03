/**
 * One report list, two ways to build a report.
 *
 * /dashboards manages REPORTS. A report is built with Build Manual (a Dashboard) or
 * with AI Vibe Report (a ReportArtifact); the list, its cards, search, status, access
 * and actions treat both as the same product. `ReportRow` is the one shape the list
 * renders: what every report has, read from its own record — nothing pretends a Vibe
 * Report is a Dashboard. The builder-specific record stays attached for the actions
 * only that builder has (share grants, duplicate, HTML export of a dashboard).
 */
import { accessTier, getResourcePermissions, type ResourcePermissions } from '@/hooks/use-resource-permission';
import type { ReportSummary } from '@/lib/api/report-code';
import type { Dashboard } from '@/types/api';

export type ReportKind = 'manual' | 'vibe';
export type ReportTypeFilter = 'all' | ReportKind;
export type ReportStatus = { label: 'published' | 'changes' | 'draft'; version?: number | null };

interface RowBase {
  key: string;
  id: number;
  name: string;
  description?: string | null;
  ownerEmail?: string | null;
  updatedAt: string;
  perms: ResourcePermissions;
  access: ReturnType<typeof accessTier>;
  status: ReportStatus;
  /** What the report holds: tiles of a dashboard, data sources of a Vibe Report. */
  content: { count: number; unit: 'charts' | 'data' };
  publicLinks: number | null;
  datasetIds: number[];
  href: string;
  /** May this caller manage the report's public links (dashboards: edit, reports: full). */
  canManagePublic: boolean;
}

export type ReportRow =
  | (RowBase & { kind: 'manual'; dashboard: Dashboard })
  | (RowBase & { kind: 'vibe'; vibe: ReportSummary });

export function manualRow(d: Dashboard & { has_draft?: boolean }): ReportRow {
  const perms = getResourcePermissions(d.user_permission, d.capabilities);
  return {
    kind: 'manual', dashboard: d, key: `manual-${d.id}`, id: d.id, name: d.name, description: d.description,
    ownerEmail: d.owner_email, updatedAt: d.updated_at, perms, access: accessTier(d.user_permission, d.capabilities),
    // A manual dashboard is served live; editor changes sit in a draft overlay until published.
    status: { label: d.has_draft ? 'changes' : 'published' },
    content: { count: d.dashboard_charts?.length || 0, unit: 'charts' },
    publicLinks: null, datasetIds: [], href: `/dashboards/${d.id}`, canManagePublic: perms.canEdit,
  };
}

export function vibeRow(r: ReportSummary): ReportRow {
  const level = r.user_permission ?? 'view';
  const perms = getResourcePermissions(level, {
    read: true, edit: level === 'edit' || level === 'full', delete: level === 'full', share: false,
    publish: level === 'full',
  });
  return {
    kind: 'vibe', vibe: r, key: `vibe-${r.id}`, id: r.id, name: r.name, description: r.description,
    ownerEmail: r.owner_email, updatedAt: r.updated_at || '', perms, access: accessTier(level, null),
    status: !r.published_number
      ? { label: 'draft', version: r.draft_number }
      : { label: r.has_unpublished_changes ? 'changes' : 'published', version: r.published_number },
    content: { count: r.binding_count ?? 0, unit: 'data' },
    publicLinks: r.public_link_count ?? (r.public_enabled ? 1 : 0),
    datasetIds: r.dataset_id ? [r.dataset_id] : [], href: `/dashboards/code/${r.id}`,
    canManagePublic: level === 'full',
  };
}
