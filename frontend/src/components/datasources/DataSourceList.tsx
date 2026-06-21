/**
 * Data Source List Component
 * Displays table of data sources with actions
 */
'use client';

import Link from 'next/link';
import { DataSource } from '@/types/api';
import { Database, Loader2, Trash2, TestTube, Share2 } from 'lucide-react';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { FilterTag, type FilterTagTone } from '@/components/ui/FilterTag';
import { IconButton } from '@/components/ui/Button';

interface DataSourceListProps {
  dataSources: DataSource[];
  onEdit?: (dataSource: DataSource) => void;
  onDelete?: (id: number) => void;
  onTest: (dataSource: DataSource) => void;
  onShare?: (dataSource: DataSource) => void;
  isDeleting?: number | null;
  activeFilters?: Record<string, string | undefined>;
  onFilterClick?: (key: string, value: string) => void;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  onToggleSelectAll?: (ids: number[]) => void;
}

export default function DataSourceList({
  dataSources,
  onEdit,
  onDelete,
  onTest,
  onShare,
  isDeleting,
  activeFilters,
  onFilterClick,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: DataSourceListProps) {
  if (dataSources.length === 0) {
    return (
      <div className="text-center py-12">
        <Database className="w-16 h-16 text-text-quaternary mx-auto mb-4" />
        <p className="text-text-tertiary text-lg mb-2">No data sources yet</p>
        <p className="text-text-quaternary text-sm">Create your first data source to get started</p>
      </div>
    );
  }

  const getTypeMeta = (type: string): { label: string; tone: FilterTagTone } => {
    switch (type) {
      case 'postgresql':
        return { label: 'PostgreSQL', tone: 'brand' };
      case 'mysql':
        return { label: 'MySQL', tone: 'warning' };
      case 'bigquery':
        return { label: 'BigQuery', tone: 'success' };
      case 'google_sheets':
        return { label: 'Google Sheets', tone: 'success' };
      case 'manual':
        return { label: 'Manual Table', tone: 'info' };
      default:
        return { label: type, tone: 'neutral' };
    }
  };

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

  const selectable = Boolean(onToggleSelect);
  const allSelected = selectable && dataSources.length > 0 && dataSources.every((ds) => selectedIds?.has(ds.id));
  const someSelected = selectable && dataSources.some((ds) => selectedIds?.has(ds.id));

  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
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
                  onChange={() => onToggleSelectAll?.(dataSources.map((ds) => ds.id))}
                  className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                />
              </th>
            )}
            <th className="app-list-header w-[32%]">
              Source
            </th>
            <th className="app-list-header w-[22%]">
              Tags
            </th>
            <th className="app-list-header w-[16%]">
              Owner
            </th>
            <th className="app-list-header w-[12%]">
              Updated
            </th>
            <th className="app-list-header w-[12%]">
              Created
            </th>
            <th className="app-list-header w-[120px] text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
          {dataSources.map((ds) => {
            const typeMeta = getTypeMeta(ds.type);
            const accessMeta = getAccessMeta(ds.user_permission);
            const perms = getResourcePermissions(ds.user_permission);

            return (
              <tr key={ds.id} className="hover:bg-surface-2">
                {selectable && (
                  <td className="w-10 px-3 py-3.5">
                    <input
                      type="checkbox"
                      checked={selectedIds?.has(ds.id) ?? false}
                      onChange={() => onToggleSelect?.(ds.id)}
                      className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                    />
                  </td>
                )}
                <td className="app-list-cell">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                      <Database className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/datasources/${ds.id}`}
                        className="app-list-text-main text-caption font-emphasis text-text-primary hover:text-brand"
                      >
                        {ds.name}
                      </Link>
                      <p className="app-list-text-sub mt-0.5 text-tiny text-text-tertiary">
                        {ds.description || 'No description yet'}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="app-list-cell">
                  <div className="flex flex-wrap gap-1.5">
                    <FilterTag
                      tone={typeMeta.tone}
                      active={activeFilters?.type === ds.type}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFilterClick?.('type', ds.type);
                      }}
                    >
                      {typeMeta.label}
                    </FilterTag>
                    {accessMeta.value !== 'full' && (
                      <FilterTag
                        tone={accessMeta.tone}
                        active={activeFilters?.access === accessMeta.value}
                        onClick={(event) => {
                          event.stopPropagation();
                          onFilterClick?.('access', accessMeta.value);
                        }}
                      >
                        {accessMeta.label}
                      </FilterTag>
                    )}
                  </div>
                </td>
                <td className="app-list-cell">
                  {ds.owner_email ? (
                    <OwnerBadge
                      email={ds.owner_email}
                      active={activeFilters?.owner === ds.owner_email}
                      onClick={() => onFilterClick?.('owner', ds.owner_email!)}
                    />
                  ) : (
                    <span className="text-tiny text-text-quaternary">—</span>
                  )}
                </td>
                <td className="app-list-cell text-caption text-text-tertiary">
                  {new Date(ds.updated_at).toLocaleDateString()}
                </td>
                <td className="app-list-cell text-caption text-text-tertiary">
                  {new Date(ds.created_at).toLocaleDateString()}
                </td>
                <td className="app-list-cell-tight text-right text-caption">
                  <div className="flex items-center justify-end gap-1">
                    <IconButton
                      aria-label="Test connection"
                      variant="ghost"
                      size="xs"
                      onClick={() => onTest(ds)}
                      className="text-success hover:bg-success/10"
                      title="Test connection"
                    >
                      <TestTube className="h-3.5 w-3.5" />
                    </IconButton>
                    {onShare && perms.canShare && (
                      <IconButton
                        aria-label="Share data source"
                        variant="ghost"
                        size="xs"
                        onClick={() => onShare(ds)}
                        className="text-brand hover:bg-brand/10"
                        title="Share"
                      >
                        <Share2 className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                    {onDelete && perms.canDelete && (
                      <IconButton
                        aria-label="Delete data source"
                        variant="ghost"
                        size="xs"
                        onClick={() => onDelete(ds.id)}
                        disabled={isDeleting === ds.id}
                        className="text-text-tertiary hover:text-danger hover:bg-danger/10"
                        title="Delete"
                      >
                        {isDeleting === ds.id ? (
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
