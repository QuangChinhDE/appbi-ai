'use client';

/**
 * Shared bits for the Intelligence module group (Sẵn sàng AI / Chỉ số & Thuật
 * ngữ / Hướng dẫn AI / Đề xuất AI). Kept deliberately tiny: everything visual
 * rides on the existing design system (Badge/Button/Tabs/PageListLayout).
 */
import React from 'react';

import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/providers/LanguageProvider';
import type { IntelStatus } from '@/lib/catalog';

/** Lifecycle badge — one vocabulary for every knowledge type. */
export function StatusBadge({ status }: { status: IntelStatus | string }) {
  const { t } = useI18n();
  if (status === 'Approved') return <Badge variant="success">✓ {t('intel.status.approved')}</Badge>;
  if (status === 'Deprecated') return <Badge variant="danger">✕ {t('intel.status.deprecated')}</Badge>;
  return <Badge variant="subtle">◐ {t('intel.status.draft')}</Badge>;
}

/** Standard panel card used across the cockpit + guidance screens. */
export function Panel({ title, sub, action, children, className }: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 ${className ?? ''}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-caption font-strong text-text-primary">{title}</h3>
          {sub && <p className="mt-0.5 text-tiny text-text-tertiary">{sub}</p>}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-0 px-4 py-6 text-center text-caption text-text-tertiary">
      {children}
    </div>
  );
}

/** Thin progress bar for coverage rows. */
export function CoverageBar({ approved, total }: { approved: number; total: number }) {
  const pct = total > 0 ? Math.round((approved / total) * 100) : 0;
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
      <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Relative "x ago" that tolerates null. */
export function timeAgo(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 60) return locale === 'vi' ? `${mins} phút trước` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return locale === 'vi' ? `${hours} giờ trước` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return locale === 'vi' ? `${days} ngày trước` : `${days}d ago`;
}
