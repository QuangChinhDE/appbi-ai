'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Lightweight CSS-only tooltip. Renders above the trigger on hover/focus.
 * Not for complex interactions — use a Radix popover for those cases.
 */
export function Tooltip({
  content,
  side = 'top',
  align = 'center',
  children,
  className,
}: {
  content: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  children: React.ReactNode;
  className?: string;
}) {
  const position = {
    top: 'bottom-full mb-1.5',
    bottom: 'top-full mt-1.5',
    left: 'right-full mr-1.5',
    right: 'left-full ml-1.5',
  }[side];

  const alignX = {
    start: 'left-0',
    center: 'left-1/2 -translate-x-1/2',
    end: 'right-0',
  }[align];

  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-pre rounded-md px-2 py-1',
          'text-tiny font-emphasis text-text-inverse bg-surface-inverse',
          'shadow-linear-lg border border-[rgb(var(--border-subtle)/0.2)]',
          'opacity-0 scale-95 transition-all duration-150',
          'group-hover/tt:opacity-100 group-hover/tt:scale-100',
          'group-focus-within/tt:opacity-100 group-focus-within/tt:scale-100',
          position,
          (side === 'top' || side === 'bottom') && alignX,
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
