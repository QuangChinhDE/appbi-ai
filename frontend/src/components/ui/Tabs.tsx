'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string = string> {
  key: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
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
        'inline-flex items-center gap-1 border-b border-[rgb(var(--border-line))]',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.key)}
            className={cn(
              'inline-flex items-center gap-1.5 relative transition-colors font-emphasis',
              size === 'sm' ? 'h-8 px-2.5 text-label' : 'h-9 px-3 text-caption',
              active
                ? 'text-text-primary'
                : 'text-text-tertiary hover:text-text-primary',
              item.disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {item.icon}
            {item.label}
            {item.badge}
            <span
              className={cn(
                'absolute left-0 right-0 -bottom-px h-0.5 bg-brand transition-opacity',
                active ? 'opacity-100' : 'opacity-0',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
