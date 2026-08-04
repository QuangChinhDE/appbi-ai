'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string = string> {
  key: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  /** A non-selectable heading that separates the tabs after it.
   *
   *  Rendered as a label, never as a tab: a "group" that could be clicked would
   *  read as a tab with no panel, which is worse than no grouping at all. */
  group?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange: (key: T) => void;
  variant?: 'underline' | 'pill';
  className?: string;
  size?: 'sm' | 'md';
}

export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  variant = 'underline',
  size = 'md',
  className,
}: TabsProps<T>) {
  if (variant === 'pill') {
    return (
      <div
        role="tablist"
        className={cn(
          'inline-flex items-center gap-1 p-1 rounded-lg bg-surface-2 border border-[rgb(var(--border-line))]',
          className,
        )}
      >
        {items.map((item) => {
          if (item.group) {
            return (
              <span
                key={item.key}
                aria-hidden
                className="select-none pl-2 pr-1 text-[10px] font-strong uppercase tracking-[0.12em] text-text-quaternary first:pl-1"
              >
                {item.label}
              </span>
            );
          }
          const active = item.key === value;
          return (
            <button
              key={item.key}
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              onClick={() => onChange(item.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md transition-colors',
                size === 'sm' ? 'h-7 px-2.5 text-label' : 'h-8 px-3 text-caption',
                'font-emphasis',
                active
                  ? 'bg-surface-1 text-text-primary shadow-linear-sm'
                  : 'text-text-tertiary hover:text-text-primary',
                item.disabled && 'opacity-50 cursor-not-allowed',
              )}
            >
              {item.icon}
              {item.label}
              {item.badge}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5',
        className,
      )}
    >
      {items.map((item) => {
        if (item.group) {
          return (
            <span
              key={item.key}
              aria-hidden
              className="select-none self-center pl-3 pr-1 text-[10px] font-strong uppercase tracking-[0.12em] text-text-quaternary first:pl-0"
            >
              {item.label}
            </span>
          );
        }
        const active = item.key === value;
        return (
          <button
            key={item.key}
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.key)}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-md transition-colors font-emphasis',
              size === 'sm' ? 'h-7 px-2.5 text-label' : 'h-8 px-3 text-caption',
              active
                ? 'bg-surface-1 text-brand shadow-linear-sm'
                : 'text-text-tertiary hover:bg-surface-1 hover:text-text-primary',
              item.disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {item.icon}
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
