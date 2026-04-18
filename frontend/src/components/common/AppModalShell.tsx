'use client';

import React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/ui/Button';

interface AppModalShellProps {
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidthClass?: string;
  panelClassName?: string;
  bodyClassName?: string;
  closeDisabled?: boolean;
  variant?: 'modal' | 'page';
}

export function AppModalShell({
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  maxWidthClass = 'max-w-2xl',
  panelClassName = '',
  bodyClassName = 'p-5',
  closeDisabled = false,
  variant = 'modal',
}: AppModalShellProps) {
  const headerInner = (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h2 className="text-small font-strong text-text-primary">{title}</h2>
          {description && (
            <div className="mt-0.5 text-caption text-text-tertiary">{description}</div>
          )}
        </div>
      </div>
      <IconButton
        aria-label="Close"
        variant="ghost"
        size="sm"
        onClick={onClose}
        disabled={closeDisabled}
      >
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  );

  if (variant === 'page') {
    return (
      <div className="flex min-h-screen w-full min-w-0 flex-col bg-surface-0">
        <div className="sticky top-0 z-10 border-b border-[rgb(var(--border-line))] bg-surface-1 px-5 py-3.5 lg:px-8 2xl:px-10">
          {headerInner}
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>
          {children}
        </div>
        {footer && (
          <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] bg-surface-1 px-5 py-3 lg:px-8 2xl:px-10">
            {footer}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-[3px] p-4 animate-fade-in"
      onClick={() => {
        if (!closeDisabled) onClose();
      }}
    >
      <div
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-xl',
          'bg-surface-1 border border-[rgb(var(--border-strong))] shadow-linear-lg',
          'animate-slide-up',
          maxWidthClass,
          panelClassName,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[rgb(var(--border-line))] px-5 py-3.5">
          {headerInner}
        </div>
        <div className={cn('flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] bg-surface-2 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
