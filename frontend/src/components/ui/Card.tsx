'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

type CardElevation = 'flat' | 'raised' | 'interactive';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  elevation?: CardElevation;
  padded?: boolean;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, elevation = 'flat', padded, children, ...props }, ref) => {
    const elevations: Record<CardElevation, string> = {
      flat: 'bg-surface-1 border border-[rgb(var(--border-strong))]',
      raised: 'bg-surface-1 shadow-linear border border-[rgb(var(--border-line))]',
      interactive:
        'bg-surface-1 border border-[rgb(var(--border-strong))] transition-[background-color,border-color,box-shadow] hover:bg-surface-2 hover:border-[rgb(var(--border-subtle)/0.18)] hover:shadow-linear-sm cursor-pointer',
    };
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg overflow-hidden',
          elevations[elevation],
          padded && 'p-4',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
Card.displayName = 'Card';

export function CardHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 px-4 py-3 border-b border-[rgb(var(--border-line))]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        'text-h3 text-text-primary font-strong',
        className,
      )}
      {...props}
    >
      {children}
    </h3>
  );
}

export function CardDescription({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('text-caption text-text-tertiary', className)}
      {...props}
    >
      {children}
    </p>
  );
}

export function CardBody({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('p-4', className)} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 px-4 py-3 border-t border-[rgb(var(--border-line))] bg-surface-2',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
