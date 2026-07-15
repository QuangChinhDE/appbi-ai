'use client';

/**
 * Shared presentational atoms for the Observability tabs. Matches the design
 * tokens used across the module (surface/border/severity colors).
 */
import { cn } from '@/lib/utils';
import type { Pillar, Severity } from '@/lib/observability';
import { useI18n } from '@/providers/LanguageProvider';
import { Clock, Database, BarChart3, LayoutDashboard, GitBranch } from 'lucide-react';

type TFunction = (key: string, values?: Record<string, string | number>) => string;

const SEV_TONE: Record<string, string> = {
  critical: 'bg-danger/10 text-danger', error: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning', info: 'bg-info/10 text-info',
};

export function SeverityBadge({ severity }: { severity: Severity | string }) {
  const { t } = useI18n();
  const s = (severity || 'info').toLowerCase();
  const labelKey = ['info', 'warning', 'critical'].includes(s) ? `observability.severity.${s}` : null;
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-tiny font-emphasis capitalize', SEV_TONE[s] ?? 'bg-surface-2 text-text-tertiary')}>
      {labelKey ? t(labelKey) : severity}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  open: 'bg-danger/10 text-danger',
  acknowledged: 'bg-warning/10 text-warning',
  resolved: 'bg-success/10 text-success',
  ok: 'bg-success/10 text-success',
  breached: 'bg-danger/10 text-danger',
  error: 'bg-warning/10 text-warning',
  unknown: 'bg-surface-2 text-text-tertiary',
};
const STATUS_LABEL_KEY: Record<string, string> = {
  open: 'observability.status.open',
  acknowledged: 'observability.status.acknowledged',
  resolved: 'observability.status.resolved',
  ok: 'observability.status.ok',
  breached: 'observability.status.breached',
  error: 'observability.status.error',
  unknown: 'observability.status.unknown',
};

export function StatusPill({ status }: { status?: string | null }) {
  const { t } = useI18n();
  const s = (status || 'unknown').toLowerCase();
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-tiny font-emphasis', STATUS_TONE[s] ?? 'bg-surface-2 text-text-tertiary')}>
      {STATUS_LABEL_KEY[s] ? t(STATUS_LABEL_KEY[s]) : status}
    </span>
  );
}

const PILLAR_TONE: Record<string, string> = {
  freshness: 'bg-info/10 text-info', volume: 'bg-brand/10 text-brand',
  schema: 'bg-warning/10 text-warning', distribution: 'bg-purple-500/10 text-purple-400',
  quality: 'bg-success/10 text-success',
};

export function PillarBadge({ pillar }: { pillar: Pillar | string }) {
  const { t } = useI18n();
  const p = (pillar || '').toLowerCase();
  const labelKey = ['freshness', 'volume', 'schema', 'distribution', 'quality'].includes(p) ? `observability.pillar.${p}` : null;
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-tiny font-emphasis', PILLAR_TONE[p] ?? 'bg-surface-2 text-text-tertiary')}>
      {labelKey ? t(labelKey) : pillar}
    </span>
  );
}

export function SourceIcon({ type, className }: { type: string; className?: string }) {
  const cls = className ?? 'h-4 w-4';
  if (type === 'source') return <Database className={cls} />;
  if (type === 'table') return <GitBranch className={cls} />;
  if (type === 'chart') return <BarChart3 className={cls} />;
  if (type === 'dashboard') return <LayoutDashboard className={cls} />;
  return <Database className={cls} />;
}

/** Minimal inline SVG sparkline (no external dep). */
export function Sparkline({ values, breached, width = 120, height = 28 }: {
  values: (number | null)[]; breached?: boolean[]; width?: number; height?: number;
}) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <span className="text-tiny text-text-quaternary">—</span>;
  const min = Math.min(...nums), max = Math.max(...nums);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const y = v == null ? height / 2 : height - ((v - min) / span) * (height - 4) - 2;
    return `${(i * stepX).toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.5}
        className="text-brand" strokeLinejoin="round" strokeLinecap="round" />
      {values.map((v, i) => v != null && breached?.[i] ? (
        <circle key={i} cx={(i * stepX).toFixed(1)} cy={(height - ((v - min) / span) * (height - 4) - 2).toFixed(1)} r={2.5} className="fill-danger" />
      ) : null)}
    </svg>
  );
}

export function relativeTime(iso?: string | null, t?: TFunction, locale = 'vi-VN'): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  const fallback = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (mins < 1) return t ? t('observability.time.justNow') : fallback.format(0, 'minute');
  if (mins < 60) return t ? t('observability.time.minutesAgo', { count: mins }) : fallback.format(-mins, 'minute');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t ? t('observability.time.hoursAgo', { count: hrs }) : fallback.format(-hrs, 'hour');
  const days = Math.round(hrs / 24);
  if (days < 30) return t ? t('observability.time.daysAgo', { count: days }) : fallback.format(-days, 'day');
  return new Date(iso).toLocaleDateString(locale);
}

export function fmtNumber(n?: number | null, locale = 'vi-VN'): string {
  if (n == null) return '—';
  return new Intl.NumberFormat(locale).format(n);
}

export function fmtBytes(n?: number | null, locale = 'vi-VN'): string {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

function fmtUnit(value: number, unit: 'minute' | 'hour' | 'day', locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(value);
}

export function fmtDuration(hours?: number | null, t?: TFunction, locale = 'vi-VN'): string {
  if (hours == null) return '—';
  if (hours < 1) {
    const count = Math.round(hours * 60);
    return t ? t('observability.duration.minutes', { count }) : fmtUnit(count, 'minute', locale);
  }
  if (hours < 48) {
    const count = Number(hours.toFixed(1));
    return t ? t('observability.duration.hours', { count }) : fmtUnit(count, 'hour', locale);
  }
  const count = Number((hours / 24).toFixed(1));
  return t ? t('observability.duration.days', { count }) : fmtUnit(count, 'day', locale);
}

export const ClockIcon = Clock;
