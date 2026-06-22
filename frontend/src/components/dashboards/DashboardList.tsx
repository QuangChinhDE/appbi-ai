'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Share2, LayoutDashboard, Loader2 } from 'lucide-react';
import { Dashboard } from '@/types/api';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/Button';
import { FilterTag, type FilterTagTone } from '@/components/ui/FilterTag';

interface DashboardListProps {
  dashboards: Dashboard[];
  onDelete?: (id: number) => void;
  onShare?: (dashboard: Dashboard) => void;
  deletingId?: number;
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
  onDelete,
  onShare,
  deletingId,
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
  const allSelected = selectable && dashboards.length > 0 && dashboards.every((d) => selectedIds?.has(d.id));
  const someSelected = selectable && dashboards.some((d) => selectedIds?.has(d.id));

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
                  onChange={() => onToggleSelectAll?.(dashboards.map((d) => d.id))}
                  className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                />
              </th>
            )}
            <th className="app-list-header w-[34%]">
              Dashboard
            </th>
            <th className="app-list-header w-[20%]">
              Tags
            </th>
            <th className="app-list-header w-[16%]">
              Owner
            </th>
            <th className="app-list-header w-[12%]">
              Charts
            </th>
            <th className="app-list-header w-[12%]">
              Updated
            </th>
            <th className="app-list-header w-[96px] text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
          {dashboards.map((dashboard) => {
            const perms = getResourcePermissions(dashboard.user_permission);
            const chartCount = dashboard.dashboard_charts?.length || 0;
            const stateMeta = getStateMeta(chartCount);
            const accessMeta = getAccessMeta(dashboard.user_permission);

            return (
              <tr key={dashboard.id} className="hover:bg-surface-2">
                {selectable && (
                  <td className="w-10 px-3 py-4">
                    <input
                      type="checkbox"
                      checked={selectedIds?.has(dashboard.id) ?? false}
                      onChange={() => onToggleSelect?.(dashboard.id)}
                      className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                    />
                  </td>
                )}
                <td className="app-list-cell">
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboards/${dashboard.id}`)}
                    className="text-left min-w-0 w-full"
                  >
                    <div className="app-list-text-main text-caption font-emphasis text-text-primary transition-colors hover:text-brand">
                      {dashboard.name}
                    </div>
                    {dashboard.description && (
                      <div className="app-list-text-sub text-tiny text-text-tertiary">{dashboard.description}</div>
                    )}
                  </button>
                </td>
                <td className="app-list-cell">
                  <div className="flex flex-wrap gap-1.5">
                    <FilterTag
                      tone={stateMeta.tone}
                      active={activeFilters?.state === stateMeta.value}
                      onClick={() => onFilterClick?.('state', stateMeta.value)}
                    >
                      {stateMeta.label}
                    </FilterTag>
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
                  {chartCount} charts
                </td>
                <td className="app-list-cell text-caption text-text-tertiary">
                  {new Date(dashboard.updated_at).toLocaleDateString()}
                </td>
                <td className="app-list-cell-tight text-right">
                  <div className="flex items-center justify-end gap-1">
                    {onShare && perms.canShare && (
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
                    {onDelete && perms.canDelete && (
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
