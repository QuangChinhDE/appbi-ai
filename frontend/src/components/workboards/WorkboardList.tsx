/**
 * WorkboardList — table view of workboards.
 *
 * Mirrors DashboardList so the workboards module reads consistently with the
 * rest of the catalog (dashboards / datasets / charts): same column layout,
 * same FilterTag chips, same selection + bulk-delete model, same EmptyState.
 */
'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardList, Loader2, Share2, Trash2 } from 'lucide-react';

import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/Button';
import { FilterTag, type FilterTagTone } from '@/components/ui/FilterTag';
import { WorkboardPublishToggle } from '@/components/workboards/WorkboardPublishToggle';
import type { Workboard } from '@/lib/api/workboards';
import { useI18n } from '@/providers/LanguageProvider';

type Translate = (key: string, values?: Record<string, string | number>) => string;

interface WorkboardListProps {
  workboards: Workboard[];
  onDelete?: (workboard: Workboard) => void;
  onShare?: (workboard: Workboard) => void;
  deletingId?: number;
  activeFilters?: Record<string, string | undefined>;
  onFilterClick?: (key: string, value: string) => void;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  onToggleSelectAll?: (ids: number[]) => void;
  /** Drop the card's bottom border/rounding so a pagination footer joins it. */
  hasFooter?: boolean;
}

function getAccessMeta(permission: string | null | undefined, t: Translate): {
  label: string;
  tone: FilterTagTone;
  value: string;
} {
  switch (permission) {
    case 'full':
      return { label: t('workboards.filter.fullAccess'), tone: 'brand', value: 'full' };
    case 'edit':
      return { label: t('workboards.filter.editable'), tone: 'info', value: 'edit' };
    case 'view':
      return { label: t('workboards.filter.viewOnly'), tone: 'neutral', value: 'view' };
    default:
      return { label: t('workboards.filter.restricted'), tone: 'neutral', value: 'none' };
  }
}

function getStateMeta(published: boolean, t: Translate): {
  label: string;
  tone: FilterTagTone;
  value: string;
} {
  return published
    ? { label: t('workboards.filter.published'), tone: 'success', value: 'published' }
    : { label: t('workboards.filter.draft'), tone: 'warning', value: 'draft' };
}

export function WorkboardList({
  workboards,
  onDelete,
  onShare,
  deletingId,
  activeFilters,
  onFilterClick,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  hasFooter,
}: WorkboardListProps) {
  const { t, locale } = useI18n();
  const router = useRouter();

  if (workboards.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title={t('workboards.empty.title')}
        description={t('workboards.empty.description')}
      />
    );
  }

  const selectable = Boolean(onToggleSelect);
  const allSelected =
    selectable &&
    workboards.length > 0 &&
    workboards.every((w) => selectedIds?.has(w.id));
  const someSelected =
    selectable && workboards.some((w) => selectedIds?.has(w.id));

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
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={() =>
                      onToggleSelectAll?.(workboards.map((w) => w.id))
                    }
                    className="h-3.5 w-3.5 cursor-pointer rounded accent-[rgb(var(--brand))]"
                  />
                </th>
              )}
              <th className="app-list-header w-[36%]">{t('workboards.list.headerWorkboard')}</th>
              <th className="app-list-header w-[18%]">{t('workboards.list.headerTags')}</th>
              <th className="app-list-header w-[16%]">{t('workboards.list.headerOwner')}</th>
              <th className="app-list-header w-[14%]">{t('workboards.list.headerDataset')}</th>
              <th className="app-list-header w-[12%]">{t('workboards.list.headerUpdated')}</th>
              <th className="app-list-header w-[96px] text-right">{t('workboards.list.headerActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
            {workboards.map((wb) => {
              const perms = getResourcePermissions(wb.user_permission ?? undefined);
              const stateMeta = getStateMeta(!!wb.is_published, t);
              const accessMeta = getAccessMeta(wb.user_permission, t);

              return (
                <tr key={wb.id} className="hover:bg-surface-2">
                  {selectable && (
                    <td className="w-10 px-3 py-4">
                      <input
                        type="checkbox"
                        checked={selectedIds?.has(wb.id) ?? false}
                        onChange={() => onToggleSelect?.(wb.id)}
                        className="h-3.5 w-3.5 cursor-pointer rounded accent-[rgb(var(--brand))]"
                      />
                    </td>
                  )}
                  <td className="app-list-cell">
                    <button
                      type="button"
                      onClick={() => router.push(`/workboards/${wb.id}`)}
                      className="w-full min-w-0 text-left"
                    >
                      <div className="app-list-text-main text-caption font-emphasis text-text-primary transition-colors hover:text-brand">
                        {wb.name}
                      </div>
                      {wb.description && (
                        <div className="app-list-text-sub text-tiny text-text-tertiary">
                          {wb.description}
                        </div>
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
                      email={wb.owner_email ?? null}
                      active={activeFilters?.owner === wb.owner_email}
                      onClick={
                        wb.owner_email
                          ? () => onFilterClick?.('owner', wb.owner_email!)
                          : undefined
                      }
                    />
                  </td>
                  <td className="app-list-cell text-caption text-text-tertiary">
                    {t('workboards.list.datasetFallback', { id: wb.dataset_id })}
                  </td>
                  <td className="app-list-cell text-caption text-text-tertiary">
                    {new Date(wb.updated_at).toLocaleDateString(locale)}
                  </td>
                  <td className="app-list-cell-tight text-right">
                    <div className="flex items-center justify-end gap-1">
                      <WorkboardPublishToggle
                        workboard={wb}
                        variant="icon"
                        canEdit={perms.canEdit}
                      />
                      {onShare && perms.canShare && (
                        <IconButton
                          aria-label={t('workboards.list.shareAria')}
                          variant="ghost"
                          size="xs"
                          onClick={() => onShare(wb)}
                          title={t('common.share')}
                        >
                          <Share2 className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                      {onDelete && perms.canDelete && (
                        <IconButton
                          aria-label={t('workboards.list.deleteAria')}
                          variant="ghost"
                          size="xs"
                          onClick={() => onDelete(wb)}
                          disabled={deletingId === wb.id}
                          title={t('workboards.list.deleteAria')}
                          className="text-text-tertiary hover:text-danger hover:bg-danger/10"
                        >
                          {deletingId === wb.id ? (
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
