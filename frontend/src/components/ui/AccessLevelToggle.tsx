'use client';

import { cn } from '@/lib/utils';

/**
 * AccessLevelToggle — a color-coded segmented control for a permission level.
 *
 * Renders one pill per allowed level (None / View / Edit / Full). The active pill
 * is tinted by its level so a whole access panel reads at a glance without a
 * legend. `allowed` may be a subset (e.g. Setup only offers None / Full).
 */

export type AccessLevel = 'none' | 'view' | 'edit' | 'full';

const ACTIVE_STYLES: Record<string, string> = {
  none: 'bg-danger/12 text-danger shadow-linear-sm',
  view: 'bg-brand/12 text-brand shadow-linear-sm',
  edit: 'bg-success/12 text-success shadow-linear-sm',
  full: 'bg-info/12 text-info shadow-linear-sm',
};

export interface AccessLevelToggleProps {
  value: string;
  allowed: string[];
  labels: Record<string, string>;
  onChange: (level: string) => void;
  changed?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}

export function AccessLevelToggle({
  value,
  allowed,
  labels,
  onChange,
  changed = false,
  disabled = false,
  size = 'sm',
  className,
  ariaLabel,
}: AccessLevelToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border bg-surface-2 p-0.5',
        changed
          ? 'border-warning/60 ring-1 ring-warning/40'
          : 'border-[rgb(var(--border-line))]',
        disabled && 'opacity-60',
        className,
      )}
    >
      {allowed.map((level) => {
        const active = level === value;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => !disabled && onChange(level)}
            className={cn(
              'rounded-md font-emphasis transition-colors focus-visible:outline-none focus-visible:shadow-focus-brand',
              size === 'sm' ? 'h-6 px-2 text-tiny' : 'h-7 px-2.5 text-label',
              active
                ? ACTIVE_STYLES[level] ?? 'bg-surface-1 text-text-primary shadow-linear-sm'
                : 'text-text-quaternary hover:text-text-secondary',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer',
            )}
          >
            {labels[level] ?? level}
          </button>
        );
      })}
    </div>
  );
}
