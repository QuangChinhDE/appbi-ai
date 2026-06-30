'use client';

/**
 * Module shell for Catalog modules (Govern / Observability).
 *
 * The big modules live in AppBI's main sidebar (unchanged). The small
 * sub-modules are presented as a horizontal Tabs bar (AppBI's native `Tabs`
 * component) at the top of the content area — NOT a second vertical sidebar.
 */
import React from 'react';
import { cn } from '@/lib/utils';
import { Tabs } from '@/components/ui/Tabs';

export interface SubNavItem {
  key: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
}

export function ModuleShell({
  items,
  active,
  onSelect,
  connected,
  children,
}: {
  title?: string;
  icon?: React.ReactNode;
  /** Optional sub-tabs. Omit for a single-console module (no tab bar). */
  items?: SubNavItem[];
  active?: string;
  onSelect?: (key: string) => void;
  connected?: boolean | null;
  children: React.ReactNode;
}) {
  const showTabs = !!items && items.length > 0;
  return (
    <div className="flex h-full flex-col px-4 pt-5 sm:px-6 xl:px-8">
      {(showTabs || connected === false) && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {showTabs && (
            <Tabs
              items={items!.map((i) => ({ key: i.key, label: i.label, icon: i.icon }))}
              value={active ?? items![0].key}
              onChange={onSelect ?? (() => {})}
              size="sm"
            />
          )}
          {connected === false && (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">Catalog offline</span>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</div>
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-h1 font-emphasis text-text-primary">{title}</h1>
      {description && <p className="mt-1 text-caption text-text-tertiary">{description}</p>}
    </div>
  );
}

const STAT_TONE: Record<string, string> = {
  neutral: 'text-text-primary',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
};

export function StatCard({
  label,
  value,
  pct,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: number | string;
  pct?: number;
  tone?: keyof typeof STAT_TONE;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
      <div>
        <div className={cn('text-title font-strong', STAT_TONE[tone])}>{value}</div>
        <div className="mt-1 flex items-center gap-1.5 text-caption text-text-tertiary">
          {icon && <span className={STAT_TONE[tone]}>{icon}</span>}
          {label}
        </div>
      </div>
      {pct !== undefined && (
        <span className={cn('rounded-full border px-2 py-0.5 text-caption font-emphasis', STAT_TONE[tone], 'border-current/30')}>
          {pct}%
        </span>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: 'bg-success/10 text-success',
    failed: 'bg-danger/10 text-danger',
    aborted: 'bg-warning/10 text-warning',
    approved: 'bg-success/10 text-success',
    draft: 'bg-surface-2 text-text-tertiary',
    deprecated: 'bg-warning/10 text-warning',
  };
  const cls = map[status?.toLowerCase()] ?? 'bg-surface-2 text-text-tertiary';
  return <span className={cn('rounded-full px-2 py-0.5 text-tiny font-emphasis capitalize', cls)}>{status || '—'}</span>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-text-quaternary">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </div>
      <p className="text-small font-emphasis text-text-primary">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-caption text-text-tertiary">{hint}</p>}
    </div>
  );
}

export function DataTable({
  columns,
  rows,
  empty,
  loading,
}: {
  columns: { key: string; label: string; className?: string; render?: (row: Record<string, unknown>) => React.ReactNode }[];
  rows: Record<string, unknown>[];
  empty: React.ReactNode;
  loading?: boolean;
}) {
  if (loading) return <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>;
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="app-list-table-wrap">
        <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
          <thead className="bg-surface-2">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={cn('app-list-header', c.className)}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-surface-2">
                {columns.map((c) => (
                  <td key={c.key} className={cn('app-list-cell text-caption text-text-secondary', c.className)}>
                    {c.render ? c.render(row) : (row[c.key] as React.ReactNode) ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
