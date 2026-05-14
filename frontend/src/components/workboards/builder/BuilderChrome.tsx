'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const BUILDER_INPUT =
  'min-h-9 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-caption text-text-primary placeholder:text-text-quaternary shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-colors focus:border-brand focus:outline-none';

export const BUILDER_PANEL =
  'rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]';

export const BUILDER_SUBPANEL =
  'rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]';

// Container-query–driven grids — break by editor pane width, not viewport.
// Definitions live in `frontend/src/app/globals.css` under "Workboard
// builder — container-query grids". They expand 1 → 2 → 3/4 columns as
// the .wb-editor-pane container grows, so opening the Live Preview
// (which halves the editor) doesn't crush 2-col layouts.
export const BUILDER_GRID_2 = 'wb-grid-2';
export const BUILDER_GRID_3 = 'wb-grid-3';
export const BUILDER_GRID_4 = 'wb-grid-4';

export function BuilderSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx(BUILDER_PANEL, className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-caption font-emphasis text-text-primary">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 max-w-3xl text-caption text-text-tertiary">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function BuilderSubsection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(BUILDER_SUBPANEL, className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-caption font-medium text-text-secondary">{title}</h3>
          {description ? (
            <p className="mt-1 max-w-2xl text-caption text-text-tertiary">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function BuilderTopBar({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3.5 py-2.5',
        className,
      )}
    >
      <span className="shrink-0 text-caption font-emphasis text-text-secondary">
        {title}
      </span>
      {children}
    </div>
  );
}

export function BuilderTopBarItem({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('flex min-w-0 items-center gap-1.5', className)}>
      <span className="shrink-0 text-caption text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}

export function BuilderCollapsibleAdvanced({
  title,
  description,
  defaultOpen,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      className="group rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 open:bg-surface-1"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-caption font-medium text-text-secondary hover:text-text-primary">
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90 text-text-tertiary transition-transform group-open:rotate-0" />
          <span className="min-w-0 truncate">
            {title}
            <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              advanced
            </span>
          </span>
        </span>
      </summary>
      <div className="border-t border-[rgb(var(--border-line))] px-3 py-3">
        {description && <p className="mb-3 text-caption text-text-tertiary">{description}</p>}
        {children}
      </div>
    </details>
  );
}

/**
 * Master-detail container — rail on the left (220px), detail panel on
 * the right. Adopted across every screen-kind editor so the user only
 * learns one layout instead of one per kind.
 *
 * 220px matches the redesign storyboard width and gives the detail
 * inspector room for a comfortable 2-column grid even on a 1280px
 * laptop screen.
 */
export function BuilderObjectEditor({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function BuilderNavigator({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <aside className={cx(BUILDER_PANEL, 'p-3', className)}>
      <div className="mb-3">
        <h2 className="text-caption font-emphasis text-text-primary">{title}</h2>
        {description ? <p className="mt-0.5 text-caption text-text-tertiary">{description}</p> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </aside>
  );
}

export function BuilderNavigatorGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          {title}
        </h3>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

export function BuilderNavigatorItem({
  icon,
  label,
  subtitle,
  badge,
  active,
  onClick,
  action,
}: {
  icon?: React.ReactNode;
  label: string;
  subtitle?: string;
  badge?: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        'group flex min-h-10 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition-colors',
        active
          ? 'border-brand/40 bg-brand/10'
          : 'border-transparent hover:bg-surface-2',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-caption font-medium text-text-primary">{label}</span>
            {badge ? <span className="shrink-0">{badge}</span> : null}
          </span>
          {subtitle ? (
            <span className="block truncate text-caption text-text-tertiary">{subtitle}</span>
          ) : null}
        </span>
      </button>
      {action ? <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">{action}</div> : null}
    </div>
  );
}

export function BuilderInspectorPanel({
  icon,
  title,
  subtitle,
  action,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx(BUILDER_PANEL, 'p-4', className)}>
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-[rgb(var(--border-line))] pb-3">
        <div className="flex min-w-0 items-start gap-2">
          {icon ? <span className="mt-0.5 shrink-0 text-text-tertiary">{icon}</span> : null}
          <div className="min-w-0">
            <h2 className="truncate text-body font-emphasis text-text-primary">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-caption text-text-tertiary">{subtitle}</p> : null}
          </div>
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function BuilderEmptyHint({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-0 px-4 py-5 text-center text-caption text-text-tertiary',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function BuilderActionButton({
  children,
  onClick,
  type = 'button',
  variant = 'default',
  disabled = false,
  className,
}: {
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  type?: 'button' | 'submit';
  variant?: 'default' | 'brand' | 'danger';
  disabled?: boolean;
  className?: string;
}) {
  const variantClass =
    variant === 'brand'
      ? 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/15'
      : variant === 'danger'
      ? 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/15'
      : 'border-[rgb(var(--border-line))] bg-surface-0 text-text-secondary hover:border-brand/30 hover:text-text-primary';

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-caption font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variantClass,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Compact "data source" picker shown at the top of every screen editor.
 *  A 1-line strip — label on the left, dropdown on the right — so users
 *  see immediately which table the screen reads/writes without diving
 *  into a separate data tab. */
export function DataSourcePicker({
  tableId,
  tables,
  onChange,
  disabled,
}: {
  tableId: number | null | undefined;
  tables: { id: number; display_name: string; source_table_name: string }[];
  onChange: (next: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
      <span className="shrink-0 text-caption font-emphasis text-text-secondary">Data source</span>
      <select
        value={tableId ?? ''}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        disabled={disabled}
        className="min-h-9 flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-caption text-text-primary focus:border-brand focus:outline-none"
      >
        <option value="">— pick a table —</option>
        {tables.map((table) => (
          <option key={table.id} value={table.id}>
            {table.display_name} ({table.source_table_name})
          </option>
        ))}
      </select>
    </div>
  );
}

export function BuilderIconButton({
  children,
  onClick,
  title,
  type = 'button',
  variant = 'default',
  disabled = false,
  className,
}: {
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  title?: string;
  type?: 'button' | 'submit';
  variant?: 'default' | 'danger';
  disabled?: boolean;
  className?: string;
}) {
  const variantClass =
    variant === 'danger'
      ? 'border-danger/20 text-danger hover:bg-danger/10'
      : 'border-[rgb(var(--border-line))] text-text-tertiary hover:border-brand/30 hover:bg-surface-2 hover:text-text-primary';

  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cx(
        // h-9 / w-9 — matches the 36px height of INPUT so icon buttons
        // align flush with the inputs they sit beside in row layouts.
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-surface-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variantClass,
        className,
      )}
    >
      {children}
    </button>
  );
}
