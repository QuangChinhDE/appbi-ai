'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

export type FilterTagTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

export const filterTagBaseClass =
  'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-tiny font-emphasis leading-none whitespace-nowrap';

const toneStyles: Record<FilterTagTone, string> = {
  neutral:
    'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-3',
  brand: 'border-brand/20 bg-brand/10 text-brand hover:border-brand/35 hover:bg-brand/15',
  success: 'border-success/20 bg-success/10 text-success hover:border-success/35 hover:bg-success/15',
  warning: 'border-warning/20 bg-warning/10 text-warning hover:border-warning/35 hover:bg-warning/15',
  danger: 'border-danger/20 bg-danger/10 text-danger hover:border-danger/35 hover:bg-danger/15',
  info: 'border-info/20 bg-info/10 text-info hover:border-info/35 hover:bg-info/15',
};

const activeToneStyles: Record<FilterTagTone, string> = {
  neutral: 'border-brand/30 bg-brand/10 text-brand shadow-linear-sm',
  brand: 'border-brand/35 bg-brand/15 text-brand shadow-linear-sm',
  success: 'border-success/35 bg-success/15 text-success shadow-linear-sm',
  warning: 'border-warning/35 bg-warning/15 text-warning shadow-linear-sm',
  danger: 'border-danger/35 bg-danger/15 text-danger shadow-linear-sm',
  info: 'border-info/35 bg-info/15 text-info shadow-linear-sm',
};

export interface FilterTagProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: FilterTagTone;
  active?: boolean;
}

export const FilterTag = React.forwardRef<HTMLButtonElement, FilterTagProps>(
  ({ className, tone = 'neutral', active = false, type = 'button', children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={active}
      className={cn(
        filterTagBaseClass,
        'appearance-none transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50',
        active ? activeToneStyles[tone] : toneStyles[tone],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
);

FilterTag.displayName = 'FilterTag';