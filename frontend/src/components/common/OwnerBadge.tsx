'use client';

import { filterTagBaseClass } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';

interface OwnerBadgeProps {
  email?: string | null;
  className?: string;
  onClick?: () => void;
  active?: boolean;
}

export function OwnerBadge({ email, className = '', onClick, active = false }: OwnerBadgeProps) {
  if (!email) return null;
  const label = email.split('@')[0];

  const badgeClassName = cn(
    filterTagBaseClass,
    'truncate max-w-[120px] transition-colors',
    active
      ? 'border-brand/30 bg-brand/10 text-brand shadow-linear-sm'
      : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-tertiary',
    onClick && !active && 'hover:border-[rgb(var(--border-strong))] hover:bg-surface-3 hover:text-text-secondary',
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn('appearance-none', badgeClassName)}
        title={email}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      className={badgeClassName}
      title={email}
    >
      {label}
    </span>
  );
}
