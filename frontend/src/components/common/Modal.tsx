'use client';

import React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/ui/Button';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  bodyClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  bodyClassName,
  contentClassName,
  footerClassName,
}: ModalProps) {
  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    '2xl': 'max-w-6xl',
    full: 'max-w-[96rem]',
  };
  const heightClass = size === 'full' ? 'h-[94vh] max-h-[94vh]' : 'max-h-[90vh]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div
        className="absolute inset-0 bg-overlay/84 backdrop-blur-[3px]"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative mx-4 flex w-full flex-col overflow-hidden rounded-xl',
          'bg-surface-1 border border-[rgb(var(--border-strong))] shadow-linear-lg',
          'animate-slide-up',
          sizeClasses[size],
          heightClass,
          contentClassName,
        )}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgb(var(--border-line))]">
          <h3 className="text-small font-strong text-text-primary">{title}</h3>
          <IconButton
            aria-label="Close"
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className={cn('flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>
          {children}
        </div>

        {footer && (
          <div
            className={cn(
              'flex items-center justify-end gap-2 px-5 py-3',
              'border-t border-[rgb(var(--border-line))] bg-surface-2',
              footerClassName,
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
