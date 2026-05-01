'use client';

import React from 'react';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const BUILDER_INPUT =
  'min-h-9 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-caption text-text-primary placeholder:text-text-quaternary shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-colors focus:border-brand focus:outline-none';

export const BUILDER_PANEL =
  'rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]';

export const BUILDER_SUBPANEL =
  'rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]';

export const BUILDER_GRID_2 = 'grid gap-3 md:grid-cols-2';
export const BUILDER_GRID_3 = 'grid gap-3 md:grid-cols-2 xl:grid-cols-3';
export const BUILDER_GRID_4 = 'grid gap-3 md:grid-cols-2 xl:grid-cols-4';

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
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-3xl text-tiny text-text-tertiary">{description}</p>
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
          <h3 className="text-tiny font-medium text-text-secondary">{title}</h3>
          {description ? (
            <p className="mt-1 max-w-2xl text-tiny text-text-tertiary">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
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
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-tiny font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
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
 *  into a separate "Dữ liệu" tab. */
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
      <span className="shrink-0 text-tiny font-emphasis text-text-secondary">Bảng dữ liệu</span>
      <select
        value={tableId ?? ''}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        disabled={disabled}
        className="min-h-8 flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-caption text-text-primary focus:border-brand focus:outline-none"
      >
        <option value="">— chọn bảng —</option>
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
        'inline-flex h-8 w-8 items-center justify-center rounded-md border bg-surface-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variantClass,
        className,
      )}
    >
      {children}
    </button>
  );
}
