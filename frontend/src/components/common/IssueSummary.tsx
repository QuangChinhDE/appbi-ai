'use client';

import * as React from 'react';
import { AlertOctagon, AlertTriangle, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface DetailIssue {
  id: string;
  severity: IssueSeverity;
  title: React.ReactNode;
  detail?: React.ReactNode;
  /** Optional call to action rendered with the issue. */
  action?: React.ReactNode;
  testId?: string;
  /**
   * Keep a non-critical issue in the strip instead of the counter. For the one
   * lifecycle notice that carries the page's own next step (e.g. "unpublished
   * changes · Sync & Publish"). Critical issues are always pinned.
   */
  persistent?: boolean;
  /** Spinner instead of the severity icon (work in progress). */
  busy?: boolean;
}

const isPinned = (i: DetailIssue) => i.severity === 'critical' || !!i.persistent;

const STRIP_TONE: Record<IssueSeverity, string> = {
  critical: 'border-danger/25 bg-danger/5 text-danger',
  warning: 'border-warning/30 bg-warning/8 text-warning',
  info: 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary',
};

const ICON: Record<IssueSeverity, React.ComponentType<{ className?: string }>> = {
  critical: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
};

/**
 * Pinned issues: a strip under the header. Critical ones are never collapsed —
 * they mean "this cannot run / publish / is unsafe" and must not hide behind a
 * count. Rendered by DetailHeader below its row.
 */
export function PinnedIssues({ issues }: { issues: DetailIssue[] }) {
  const pinned = issues.filter(isPinned);
  if (pinned.length === 0) return null;
  const hasCritical = pinned.some((i) => i.severity === 'critical');
  return (
    <div role={hasCritical ? 'alert' : 'status'} data-testid="detail-pinned-issues" className="shrink-0">
      {pinned.map((issue) => {
        const Icon = issue.busy ? Loader2 : ICON[issue.severity];
        return (
          <div
            key={issue.id}
            data-testid={issue.testId}
            data-severity={issue.severity}
            className={cn('flex items-center gap-2.5 border-b px-4 py-2 text-xs', STRIP_TONE[issue.severity])}
          >
            <Icon className={cn('h-4 w-4 shrink-0', issue.busy && 'animate-spin')} aria-hidden />
            <div className="min-w-0 flex-1 break-words">
              <span className="font-emphasis">{issue.title}</span>
              {issue.detail && <> <span className="opacity-80">{issue.detail}</span></>}
            </div>
            {issue.action && <div className="shrink-0">{issue.action}</div>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Warnings and info: one counter chip in the header that opens a list.
 * Keyboard: Enter/Space opens, Esc closes and returns focus.
 */
export function IssueCounter({ issues }: { issues: DetailIssue[] }) {
  const { t } = useI18n();
  const soft = issues.filter((i) => !isPinned(i));
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (soft.length === 0) return null;
  const warnings = soft.filter((i) => i.severity === 'warning').length;
  const tone = warnings > 0 ? 'warning' : 'info';
  const label = t('common.detailHeader.issuesCount', { count: soft.length });

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        data-testid="detail-issue-counter"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
          tone === 'warning'
            ? 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/15'
            : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:text-text-primary',
        )}
      >
        {tone === 'warning' ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <Info className="h-3.5 w-3.5" aria-hidden />}
        {soft.length}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              btnRef.current?.focus();
            }
          }}
          className="absolute right-0 top-full z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-1 shadow-linear-md"
        >
          <ul className="max-h-[60vh] overflow-y-auto">
            {soft.map((issue) => {
              const Icon = ICON[issue.severity];
              return (
                <li key={issue.id} data-testid={issue.testId} className="flex items-start gap-2 rounded-md px-2.5 py-2 text-xs">
                  <Icon
                    className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', issue.severity === 'warning' ? 'text-warning' : 'text-text-tertiary')}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-text-primary">{issue.title}</p>
                    {issue.detail && <div className="mt-0.5 break-words text-text-secondary">{issue.detail}</div>}
                    {issue.action && <div className="mt-1.5">{issue.action}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
