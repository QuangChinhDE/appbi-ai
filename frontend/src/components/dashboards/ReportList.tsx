'use client';

/**
 * The report list of /dashboards — one table and one card for every report, whichever
 * way it was built. A row and a card are two renderings of one object: the actions on
 * them never disagree (an author following "attach to a report" must find the same
 * controls in either view). Builder-specific actions appear only where that builder
 * has them; nothing is shown as available that the report cannot do.
 */
import React from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Copy, Database, Download, Eye, Globe, LayoutDashboard, Loader2, Share2, Trash2, Wand2 } from 'lucide-react';

import { OwnerBadge } from '@/components/common/OwnerBadge';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterTag, type FilterTagTone } from '@/components/ui/FilterTag';
import type { ReportKind, ReportRow, ReportStatus } from '@/components/dashboards/reportRows';
import { useI18n } from '@/providers/LanguageProvider';

export interface ReportActions {
  onDelete?: (row: ReportRow) => void;
  onPublicLinks?: (row: ReportRow) => void;
  /** Resource grants, duplicate and HTML export - the same for both build methods. */
  onShare?: (row: ReportRow) => void;
  onDuplicate?: (row: ReportRow) => void;
  onExport?: (row: ReportRow) => void;
  busyKey?: string;
}

/** How the report was built — a small marker, not a product split. */
export function BuildMethodBadge({ kind }: { kind: ReportKind }) {
  const { t } = useI18n();
  return kind === 'vibe' ? (
    <Badge variant="subtle" size="sm" pill data-testid="report-kind-vibe" title={t('reportList.builtWith')}>
      <Wand2 className="h-3 w-3 text-brand" />{t('reportList.kind.vibe')}
    </Badge>
  ) : (
    <Badge variant="subtle" size="sm" pill data-testid="report-kind-manual" title={t('reportList.builtWith')}>
      <LayoutDashboard className="h-3 w-3" />{t('reportList.kind.manual')}
    </Badge>
  );
}

/** Draft / Published, one vocabulary for every report. */
export function ReportStatusChip({ status }: { status: ReportStatus }) {
  const { t } = useI18n();
  const v = status.version ? ` v${status.version}` : '';
  if (status.label === 'draft') return <Badge variant="neutral" size="sm" pill dot data-testid="report-status">{t('reportList.status.draft')}{v}</Badge>;
  if (status.label === 'changes') return <Badge variant="warning" size="sm" pill dot data-testid="report-status">{t('reportList.status.changes')}{v}</Badge>;
  return <Badge variant="success" size="sm" pill dot data-testid="report-status">{t('reportList.status.published')}{v}</Badge>;
}

function ContentLabel({ row }: { row: ReportRow }) {
  const { t } = useI18n();
  return <>{row.content.unit === 'charts' ? t('reportList.content.charts', { n: row.content.count }) : t('reportList.content.data', { n: row.content.count })}</>;
}

const ACCESS: Record<string, { tone: FilterTagTone; key: string }> = {
  edit: { tone: 'info', key: 'reportList.access.edit' },
  view: { tone: 'neutral', key: 'reportList.access.view' },
  none: { tone: 'neutral', key: 'reportList.access.none' },
};

function RowActions({ row, actions }: { row: ReportRow; actions: ReportActions }) {
  const { t } = useI18n();
  const busy = actions.busyKey === row.key;
  return (
    <div className="flex items-center justify-end gap-1">
      {actions.onExport && (
        <IconButton aria-label={t('reportList.action.export')} title={t('reportList.action.export')} variant="ghost" size="xs"
          onClick={() => actions.onExport!(row)} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        </IconButton>
      )}
      {actions.onDuplicate && row.perms.canEdit && (
        <IconButton aria-label={t('reportList.action.duplicate')} title={t('reportList.action.duplicate')} variant="ghost" size="xs"
          onClick={() => actions.onDuplicate!(row)} disabled={busy}>
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {actions.onShare && row.perms.canShare && (
        <IconButton aria-label={t('reportList.action.share')} title={t('reportList.action.share')} variant="ghost" size="xs"
          onClick={() => actions.onShare!(row)}>
          <Share2 className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {actions.onPublicLinks && row.canManagePublic && (
        <IconButton aria-label={t('reportList.action.public')} title={t('reportList.action.public')} variant="ghost" size="xs"
          onClick={() => actions.onPublicLinks!(row)} data-testid={`report-row-${row.key}-public`}>
          <Globe className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {actions.onDelete && row.perms.canDelete && (
        <IconButton aria-label={t('reportList.action.delete')} title={t('reportList.action.delete')} variant="ghost" size="xs"
          onClick={() => actions.onDelete!(row)} className="text-text-tertiary hover:bg-danger/10 hover:text-danger">
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </div>
  );
}

export function ReportTable({ rows, actions, selectedIds, onToggleSelect, onToggleSelectAll, activeFilters, onFilterClick, hasFooter }: {
  rows: ReportRow[];
  actions: ReportActions;
  /** Bulk selection by row KEY (`manual-12`, `vibe-48`): a dashboard and a Vibe Report can share an id. */
  selectedIds?: Set<string>;
  onToggleSelect?: (key: string) => void;
  onToggleSelectAll?: (keys: string[]) => void;
  activeFilters?: Record<string, string | undefined>;
  onFilterClick?: (key: string, value: string) => void;
  hasFooter?: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  if (rows.length === 0) {
    return <EmptyState icon={<LayoutDashboard />} title={t('reportList.empty.title')} description={t('reportList.empty.desc')} />;
  }
  const selectable = Boolean(onToggleSelect);
  // Only what this caller may delete can be selected, whichever way it was built.
  const selectableRows = rows.filter((r) => r.perms.canDelete);
  const allSelected = selectable && selectableRows.length > 0 && selectableRows.every((r) => selectedIds?.has(r.key));
  const someSelected = selectable && selectableRows.some((r) => selectedIds?.has(r.key));
  return (
    <div className={`border border-[rgb(var(--border-line))] bg-surface-1 ${hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl'}`}>
      <div className="app-list-table-wrap">
        <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
          <thead className="bg-surface-2">
            <tr>
              {selectable && (
                <th className="w-10 px-3 py-3">
                  <input type="checkbox" checked={allSelected} aria-label={t('reportList.selectAll')}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={() => onToggleSelectAll?.(selectableRows.map((r) => r.key))} data-testid="report-select-all"
                    className="h-3.5 w-3.5 cursor-pointer rounded accent-[rgb(var(--brand))]" />
                </th>
              )}
              <th className="app-list-header w-[26%]">{t('reportList.col.report')}</th>
              <th className="app-list-header w-[184px]">{t('reportList.col.status')}</th>
              <th className="app-list-header">{t('reportList.col.method')}</th>
              <th className="app-list-header">{t('reportList.col.public')}</th>
              <th className="app-list-header">{t('reportList.col.access')}</th>
              <th className="app-list-header">{t('reportList.col.owner')}</th>
              <th className="app-list-header">{t('reportList.col.content')}</th>
              <th className="app-list-header">{t('reportList.col.updated')}</th>
              <th className="app-list-header w-[170px] text-right">{t('reportList.col.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
            {rows.map((row) => {
              const access = ACCESS[row.perms.level === 'full' ? '' : row.perms.level] || null;
              return (
                <tr key={row.key} className="hover:bg-surface-2" data-testid={`report-row-${row.key}`}>
                  {selectable && (
                    <td className="w-10 px-3 py-4">
                      {row.perms.canDelete && (
                        <input type="checkbox" checked={selectedIds?.has(row.key) ?? false} aria-label={row.name}
                          onChange={() => onToggleSelect?.(row.key)} data-testid={`report-select-${row.key}`}
                          className="h-3.5 w-3.5 cursor-pointer rounded accent-[rgb(var(--brand))]" />
                      )}
                    </td>
                  )}
                  <td className="app-list-cell">
                    <button type="button" onClick={() => router.push(row.href)} className="w-full min-w-0 text-left" data-testid={`report-open-${row.key}`}>
                      <div className="app-list-text-main text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{row.name}</div>
                      {row.description && <div className="app-list-text-sub text-tiny text-text-tertiary">{row.description}</div>}
                    </button>
                  </td>
                  <td className="app-list-cell whitespace-nowrap"><ReportStatusChip status={row.status} /></td>
                  <td className="app-list-cell whitespace-nowrap"><BuildMethodBadge kind={row.kind} /></td>
                  <td className="app-list-cell whitespace-nowrap text-caption text-text-tertiary" data-testid={`report-row-${row.key}-public-count`}>
                    {row.publicLinks ? <span className="inline-flex items-center gap-1 text-text-secondary"><Globe className="h-3.5 w-3.5 text-info" />{row.publicLinks}</span> : '—'}
                  </td>
                  <td className="app-list-cell whitespace-nowrap">
                    {access ? (
                      <FilterTag tone={access.tone} active={activeFilters?.access === row.access}
                        onClick={() => onFilterClick?.('access', row.access)}>{t(access.key)}</FilterTag>
                    ) : <span className="text-caption text-text-tertiary">{t('reportList.access.full')}</span>}
                  </td>
                  <td className="app-list-cell">
                    <OwnerBadge email={row.ownerEmail ?? undefined} active={activeFilters?.owner === row.ownerEmail}
                      onClick={row.ownerEmail ? () => onFilterClick?.('owner', row.ownerEmail!) : undefined} />
                  </td>
                  <td className="app-list-cell min-w-[96px] text-caption text-text-tertiary"><ContentLabel row={row} /></td>
                  <td className="app-list-cell whitespace-nowrap text-caption text-text-tertiary">{row.updatedAt ? new Date(row.updatedAt).toLocaleDateString(locale) : ''}</td>
                  <td className="app-list-cell-tight text-right"><RowActions row={row} actions={actions} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ReportCard({ row, actions, selected, onToggleSelect }: {
  row: ReportRow; actions: ReportActions; selected?: boolean; onToggleSelect?: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <div className="group flex flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-all hover:border-[rgb(var(--border-strong))] hover:shadow-linear"
      data-testid={`report-card-${row.key}`}>
      <div className="flex-1 p-4">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2">
            {onToggleSelect && row.perms.canDelete && (
              <input type="checkbox" aria-label={row.name} checked={!!selected} onChange={() => onToggleSelect(row.key)}
                data-testid={`report-card-select-${row.key}`}
                className="h-3.5 w-3.5 cursor-pointer rounded accent-[rgb(var(--brand))]" />
            )}
            {/* Every report has the same mark: the product is the report, not its builder. */}
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <LayoutDashboard className="h-4 w-4" />
            </div>
          </div>
          <ReportStatusChip status={row.status} />
        </div>
        <button type="button" onClick={() => router.push(row.href)} className="block w-full text-left" data-testid={`report-card-${row.key}-open`}>
          <h3 className="mb-1 truncate text-caption font-strong text-text-primary hover:text-brand">{row.name}</h3>
        </button>
        <OwnerBadge email={row.ownerEmail ?? undefined} />
        {row.description && <p className="mt-1.5 line-clamp-2 text-caption text-text-tertiary">{row.description}</p>}
        <div className="mt-3 flex items-center justify-between gap-2 text-tiny text-text-quaternary">
          <span className="flex items-center gap-1"><Database className="h-3 w-3" /><ContentLabel row={row} /></span>
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{row.updatedAt ? new Date(row.updatedAt).toLocaleDateString(locale) : ''}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 rounded-b-xl border-t border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
        <BuildMethodBadge kind={row.kind} />
        <div className="flex items-center gap-1">
          <RowActions row={row} actions={actions} />
          <button type="button" onClick={() => router.push(row.href)} className="ml-1 flex items-center gap-1 text-tiny font-emphasis text-brand transition-colors hover:text-brand-hover">
            <Eye className="h-3 w-3" />{t('reportList.action.open')}
          </button>
        </div>
      </div>
    </div>
  );
}
