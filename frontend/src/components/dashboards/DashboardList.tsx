'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Share2, Globe, LayoutDashboard, Loader2, Copy, Download, Wand2 } from 'lucide-react';
import { Dashboard } from '@/types/api';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/Button';
import { FilterTag, type FilterTagTone } from '@/components/ui/FilterTag';
import { ReportKindBadge, ReportStatusChip } from '@/components/dashboards/ReportKindBadge';
import { isVibe, openHref, rowKey, type ReportListItem } from '@/components/dashboards/reportListItems';

interface DashboardListProps {
  /** Manual dashboards and AI Vibe Reports (tagged `report_kind: 'vibe'`) in one list. */
  dashboards: ReportListItem[];
  /** Actions on a Vibe Report row (a different resource than a dashboard). */
  onVibeDelete?: (item: ReportListItem) => void;
  onVibePublicLinks?: (item: ReportListItem) => void;
  onDelete?: (id: number) => void;
  onShare?: (dashboard: Dashboard) => void;
  /** Open the dashboard's public links.
   *
   *  THE VIEW DECIDED WHETHER THE ACTION EXISTED. The card view offered
   *  `Public links`; this table did not, so an author who had just published an
   *  assistant, followed its "Gắn vào báo cáo" call to action and happened to be
   *  in list view arrived at a page with no way to do the thing they had been
   *  sent to do — and nothing said the control was one view-toggle away. A row
   *  and a card are two renderings of one object; the actions on them cannot
   *  disagree about what may be done to it. */
  onPublicLinks?: (dashboard: Dashboard) => void;
  onDuplicate?: (dashboard: Dashboard) => void;
  onExport?: (dashboard: Dashboard) => void;
  deletingId?: number;
  duplicatingId?: number;
  exportingId?: number;
  activeFilters?: Record<string, string | undefined>;
  onFilterClick?: (key: string, value: string) => void;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  onToggleSelectAll?: (ids: number[]) => void;
  /** Drop the card's bottom border/rounding so a pagination footer joins it. */
  hasFooter?: boolean;
}

export function DashboardList({
  dashboards,
  onVibeDelete,
  onVibePublicLinks,
  onDelete,
  onShare,
  onPublicLinks,
  onDuplicate,
  onExport,
  deletingId,
  duplicatingId,
  exportingId,
  activeFilters,
  onFilterClick,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  hasFooter,
}: DashboardListProps) {
  const router = useRouter();

  const getAccessMeta = (permission?: string): { label: string; tone: FilterTagTone; value: string } => {
    switch (permission) {
      case 'full':
        return { label: 'Full access', tone: 'brand', value: 'full' };
      case 'edit':
        return { label: 'Editable', tone: 'info', value: 'edit' };
      case 'view':
        return { label: 'View only', tone: 'neutral', value: 'view' };
      default:
        return { label: 'Restricted', tone: 'neutral', value: 'none' };
    }
  };

  const getStateMeta = (chartCount: number): { label: string; tone: FilterTagTone; value: string } => {
    if (chartCount > 0) {
      return { label: 'Linked', tone: 'success', value: 'linked' };
    }
    return { label: 'Empty', tone: 'warning', value: 'empty' };
  };

  if (dashboards.length === 0) {
    return (
      <EmptyState
        icon={<LayoutDashboard />}
        title="No dashboards yet"
        description="Create your first dashboard to organize your charts."
      />
    );
  }

  const selectable = Boolean(onToggleSelect);
  const selectableRows = dashboards.filter((d) => !isVibe(d));
  const allSelected = selectable && selectableRows.length > 0 && selectableRows.every((d) => selectedIds?.has(d.id));
  const someSelected = selectable && selectableRows.some((d) => selectedIds?.has(d.id));

  return (
    <div className={`border border-[rgb(var(--border-line))] bg-surface-1 ${hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl'}`}>
      <div className="app-list-table-wrap">
      <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
        <thead className="bg-surface-2">
          <tr>
            {selectable && (
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={() => onToggleSelectAll?.(selectableRows.map((d) => d.id))}
                  className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                />
              </th>
            )}
            <th className="app-list-header w-[34%]">
              Report
            </th>
            <th className="app-list-header w-[20%]">
              Tags
            </th>
            <th className="app-list-header w-[16%]">
              Owner
            </th>
            <th className="app-list-header w-[12%]">
              Content
            </th>
            <th className="app-list-header w-[12%]">
              Updated
            </th>
            <th className="app-list-header w-[160px] text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
          {dashboards.map((dashboard) => {
            const perms = getResourcePermissions(dashboard.user_permission, dashboard.capabilities);
            const vibe = isVibe(dashboard);
            const chartCount = dashboard.dashboard_charts?.length || 0;
            const stateMeta = getStateMeta(chartCount);
            const accessMeta = getAccessMeta(dashboard.user_permission);

            return (
              <tr key={rowKey(dashboard)} className="hover:bg-surface-2" data-testid={`report-row-${rowKey(dashboard)}`}>
                {selectable && (
                  <td className="w-10 px-3 py-4">
                    {!vibe && <input
                      type="checkbox"
                      checked={selectedIds?.has(dashboard.id) ?? false}
                      onChange={() => onToggleSelect?.(dashboard.id)}
                      className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                    />}
                  </td>
                )}
                <td className="app-list-cell">
                  <button
                    type="button"
                    onClick={() => router.push(openHref(dashboard))}
                    className="text-left min-w-0 w-full"
                  >
                    <div className="app-list-text-main flex items-center gap-1.5 text-caption font-emphasis text-text-primary transition-colors hover:text-brand">
                      {vibe ? <Wand2 className="h-3.5 w-3.5 shrink-0 text-brand" /> : <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />}
                      <span className="truncate">{dashboard.name}</span>
                    </div>
                    {dashboard.description && (
                      <div className="app-list-text-sub text-tiny text-text-tertiary">{dashboard.description}</div>
                    )}
                  </button>
                </td>
                <td className="app-list-cell">
                  <div className="flex flex-wrap gap-1.5">
                    <ReportKindBadge kind={vibe ? 'vibe' : 'manual'} />
                    <ReportStatusChip item={dashboard} />
                    {!vibe && <FilterTag
                      tone={stateMeta.tone}
                      active={activeFilters?.state === stateMeta.value}
                      onClick={() => onFilterClick?.('state', stateMeta.value)}
                    >
                      {stateMeta.label}
                    </FilterTag>}
                    {accessMeta.value !== 'full' && (
                      <FilterTag
                        tone={accessMeta.tone}
                        active={activeFilters?.access === accessMeta.value}
                        onClick={() => onFilterClick?.('access', accessMeta.value)}
                      >
                        {accessMeta.label}
                      </FilterTag>
                    )}
                  </div>
                </td>
                <td className="app-list-cell">
                  <OwnerBadge
                    email={dashboard.owner_email}
                    active={activeFilters?.owner === dashboard.owner_email}
                    onClick={dashboard.owner_email ? () => onFilterClick?.('owner', dashboard.owner_email!) : undefined}
                  />
                </td>
                <td className="app-list-cell text-caption text-text-tertiary">
                  {vibe ? (dashboard.vibe?.public_enabled ? `${dashboard.vibe.public_link_count ?? 1} public link` : '—') : `${chartCount} charts`}
                </td>
                <td className="app-list-cell text-caption text-text-tertiary">
                  {new Date(dashboard.updated_at).toLocaleDateString()}
                </td>
                <td className="app-list-cell-tight text-right">
                  <div className="flex items-center justify-end gap-1">
                    {vibe && onVibePublicLinks && perms.canPublish && (
                      <IconButton aria-label="Public links" variant="ghost" size="xs" onClick={() => onVibePublicLinks(dashboard)}
                        title="Public links" data-testid={`report-row-${rowKey(dashboard)}-public`}>
                        <Globe className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                    {vibe && onVibeDelete && perms.canDelete && (
                      <IconButton aria-label="Delete report" variant="ghost" size="xs" onClick={() => onVibeDelete(dashboard)}
                        title="Delete report" className="text-text-tertiary hover:text-danger hover:bg-danger/10">
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                    {!vibe && onExport && (
                      <IconButton
                        aria-label="Export dashboard to HTML"
                        variant="ghost"
                        size="xs"
                        onClick={() => onExport(dashboard)}
                        disabled={exportingId === dashboard.id}
                        title="Export to HTML"
                      >
                        {exportingId === dashboard.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </IconButton>
                    )}
                    {!vibe && onDuplicate && perms.canEdit && (
                      <IconButton
                        aria-label="Duplicate dashboard"
                        variant="ghost"
                        size="xs"
                        onClick={() => onDuplicate(dashboard)}
                        disabled={duplicatingId === dashboard.id}
                        title="Duplicate"
                      >
                        {duplicatingId === dashboard.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </IconButton>
                    )}
                    {!vibe && onShare && perms.canShare && (
                      <IconButton
                        aria-label="Share dashboard"
                        variant="ghost"
                        size="xs"
                        onClick={() => onShare(dashboard)}
                        title="Share"
                      >
                        <Share2 className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                    {!vibe && onPublicLinks && perms.canEdit && (
                      <IconButton
                        aria-label="Public links"
                        variant="ghost"
                        size="xs"
                        onClick={() => onPublicLinks(dashboard)}
                        title="Public links"
                      >
                        <Globe className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                    {!vibe && onDelete && perms.canDelete && (
                      <IconButton
                        aria-label="Delete dashboard"
                        variant="ghost"
                        size="xs"
                        onClick={() => onDelete(dashboard.id)}
                        disabled={deletingId === dashboard.id}
                        title="Delete dashboard"
                        className="text-text-tertiary hover:text-danger hover:bg-danger/10"
                      >
                        {deletingId === dashboard.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </IconButton>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
