'use client';

/**
 * Shared bits for the Intelligence module group (Sẵn sàng AI / Chỉ số & Thuật
 * ngữ / Hướng dẫn AI / Đề xuất AI). Kept deliberately tiny: everything visual
 * rides on the existing design system (Badge/Button/Tabs/PageListLayout).
 */
import React, { useState } from 'react';
import { Wand2 } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { AiButton } from '@/components/ui/AiButton';
import { Textarea } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import type { IntelStatus } from '@/lib/catalog';

/**
 * Two-layer access for the Intelligence group:
 *   "soạn" (author: create / edit / delete / scope / instructions) → needs
 *   `govern:edit`; "duyệt" (approve / certify) stays open to anyone with
 *   `govern:view`. So a non-tech reviewer sees review surfaces without the
 *   authoring depth, while stewards get the full toolset.
 */
export function useCanAuthor(): boolean {
  const { data } = usePermissions();
  return hasPermission(data?.permissions, 'govern', 'edit');
}

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

/**
 * "✨ AI soạn" panel — the non-tech on-ramp shared by every create modal.
 * User writes a natural-language prompt; onCompose runs the AI draft and the
 * caller fills the form fields for the user to review/edit before saving.
 */
export function AiComposePanel({ placeholder, loading, onCompose }: {
  placeholder: string;
  loading: boolean;
  onCompose: (prompt: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  return (
    <div className="space-y-2 rounded-lg border border-brand/25 bg-brand/[0.05] p-3">
      <div className="flex items-center gap-1.5 text-tiny font-emphasis text-brand">
        <Wand2 className="h-3.5 w-3.5" /> {t('intel.ai.composeTitle')}
      </div>
      <Textarea
        rows={2}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={placeholder}
      />
      <div className="flex flex-wrap items-center gap-2">
        <AiButton size="sm" loading={loading} disabled={!prompt.trim()} onClick={() => onCompose(prompt.trim())}>
          {t('intel.ai.compose')}
        </AiButton>
        <span className="text-tiny text-text-quaternary">{t('intel.ai.reviewHint')}</span>
      </div>
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
