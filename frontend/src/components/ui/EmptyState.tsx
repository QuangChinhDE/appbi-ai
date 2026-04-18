'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        'rounded-lg border border-dashed border-[rgb(var(--border-strong))]',
        'bg-surface-1 px-6 py-12',
        className,
      )}
    >
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-text-tertiary [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <h3 className="text-small font-strong text-text-primary">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-caption text-text-tertiary">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
