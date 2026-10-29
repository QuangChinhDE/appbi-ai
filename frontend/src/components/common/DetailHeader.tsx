'use client';

import * as React from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMinWidth, type Breakpoint } from '@/hooks/use-media-query';
import { OverflowMenu, type OverflowMenuItem } from '@/components/common/OverflowMenu';
import { PinnedIssues, IssueCounter, type DetailIssue } from '@/components/common/IssueSummary';

export interface DetailSecondaryAction extends OverflowMenuItem {
  /**
   * Smallest breakpoint at which the action sits inline in the header; below
   * it the action moves into the overflow menu. 'never' = always in the menu.
   * Exactly one copy is mounted at a time, so a testId stays unique.
   */
  inlineFrom?: Breakpoint | 'never';
  /** Custom inline rendering (a toggle, a split button). Defaults to a ghost button. */
  renderInline?: () => React.ReactNode;
}

export interface DetailHeaderProps {
  back?: { label: string; onClick: () => void; testId?: string; showLabelFrom?: Breakpoint };
  /** Object name. Rendered truncating; pass a node for rename-in-place. */
  title: React.ReactNode;
  /** Short context after the title (shown from lg up). */
  meta?: React.ReactNode;
  /** At most one primary state badge (server state). */
  status?: React.ReactNode;
  /** Tabs/segmented navigation. Inline from `tabsInlineFrom` (md); below it, its own scrollable row. */
  tabs?: React.ReactNode;
  /** A crowded header moves its tabs to their own row earlier instead of letting them scroll out of view. */
  tabsInlineFrom?: Breakpoint;
  /** Free slot between tabs and the actions (filters toggle, chips). Never collapsed. */
  center?: React.ReactNode;
  issues?: DetailIssue[];
  secondaryActions?: DetailSecondaryAction[];
  /** Overflow-only items appended after the collapsed secondaries. */
  menuItems?: OverflowMenuItem[];
  overflowTestId?: string;
  /** Primary actions — always visible, never collapsed. */
  actions?: React.ReactNode;
  /** Rendered under the row, inside the header (e.g. an inline editor). */
  below?: React.ReactNode;
  sticky?: boolean;
  className?: string;
  testId?: string;
}

/** Arrow-key roving between role="tab" children, for hand-rolled tab groups too. */
function onTabsKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'));
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
  tabs[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function useInlineSet() {
  const sm = useMinWidth('sm');
  const md = useMinWidth('md');
  const lg = useMinWidth('lg');
  const xl = useMinWidth('xl');
  const xxl = useMinWidth('2xl');
  return (bp: DetailSecondaryAction['inlineFrom'] = 'lg') =>
    bp === 'never' ? false : { sm, md, lg, xl, '2xl': xxl }[bp];
}

/**
 * One compact header row (48px on desktop) for detail/editor screens:
 *   back · title · status | tabs | center … issues · secondaries · ··· · primary actions
 * Back, title, critical issues and primary actions are never collapsed; the row
 * never wraps — secondaries move into the overflow menu instead.
 */
export const DetailHeader = React.forwardRef<HTMLDivElement, DetailHeaderProps>(function DetailHeader(
  {
    back,
    title,
    meta,
    status,
    tabs,
    tabsInlineFrom = 'md',
    center,
    issues = [],
    secondaryActions = [],
    menuItems = [],
    overflowTestId,
    actions,
    below,
    sticky,
    className,
    testId,
  },
  ref,
) {
  const isInline = useInlineSet();
  const tabsInline = useMinWidth(tabsInlineFrom);
  const showBackLabel = useMinWidth(back?.showLabelFrom ?? 'lg');
  const inline = secondaryActions.filter((a) => isInline(a.inlineFrom));
  const collapsed = secondaryActions.filter((a) => !isInline(a.inlineFrom));
  const overflow: OverflowMenuItem[] = [
    ...collapsed,
    ...menuItems.map((m, idx) => (idx === 0 && collapsed.length ? { ...m, separatorBefore: true } : m)),
  ];

  const tabsNode = tabs ? (
    <div onKeyDown={onTabsKeyDown} className="flex min-w-0 items-center">
      {tabs}
    </div>
  ) : null;

  return (
    <header
      ref={ref}
      data-testid={testId}
      className={cn(
        'shrink-0 border-b border-[rgb(var(--border-line))] bg-surface-1',
        sticky && 'sticky top-0 z-20',
        className,
      )}
    >
      <div data-testid="detail-header-row" className="flex h-12 min-w-0 items-center gap-2 px-3 sm:gap-3 sm:px-4">
        {back && (
          <button
            type="button"
            data-testid={back.testId}
            onClick={back.onClick}
            aria-label={back.label}
            title={back.label}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {showBackLabel && <span>{back.label}</span>}
          </button>
        )}
        {/* `contents`: title, status and meta are row items themselves. A
            truncating title then shrinks down to its own 4rem minimum, while a
            wrapper would count the full title text in its min-content and push
            the primary actions off-screen (or, with min-w-0, let the status
            paint over the name). */}
        <div className="contents">
          <div className="min-w-[4rem] shrink truncate text-sm font-medium text-text-primary">{title}</div>
          {status && <div className="flex shrink-0 items-center">{status}</div>}
          {meta && <div className="hidden min-w-0 shrink-[4] truncate text-xs text-text-tertiary lg:block">{meta}</div>}
        </div>
        {tabsNode && tabsInline && (
          <>
            <div className="h-5 w-px shrink-0 bg-surface-3" aria-hidden />
            <div className="shrink-0">{tabsNode}</div>
          </>
        )}
        <div className="min-w-0 flex-1" />
        {center && <div className="flex min-w-0 shrink-0 items-center gap-2">{center}</div>}
        <div className="flex shrink-0 items-center gap-1.5">
          <IssueCounter issues={issues} />
          {inline.map((a) =>
            a.renderInline ? (
              <React.Fragment key={a.id}>{a.renderInline()}</React.Fragment>
            ) : (
              <button
                key={a.id}
                type="button"
                data-testid={a.testId}
                disabled={a.disabled}
                title={a.disabled ? a.disabledReason : typeof a.label === 'string' ? a.label : undefined}
                onClick={a.onSelect}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50',
                  a.danger ? 'text-danger hover:bg-danger/10' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                )}
              >
                {a.icon && <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{a.icon}</span>}
                {a.label}
                {a.trailing}
              </button>
            ),
          )}
          <OverflowMenu items={overflow} triggerTestId={overflowTestId} />
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      </div>
      {tabsNode && !tabsInline && (
        <div className="overflow-x-auto border-t border-[rgb(var(--border-line))] px-3 py-1.5 [scrollbar-width:none]">
          {tabsNode}
        </div>
      )}
      {below}
      <PinnedIssues issues={issues} />
    </header>
  );
});
