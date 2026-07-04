'use client';

import React, { useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';

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
  const { t } = useI18n();

  // Track where the press started so we only treat a backdrop click as
  // "close" when both press AND release happened on the backdrop. Without
  // this, dragging the cursor from a native <select> option (or a text
  // selection inside the modal) onto the dim layer dismisses the modal —
  // which users see as "I clicked an option and the dialog disappeared".
  const pressOriginRef = useRef<EventTarget | null>(null);

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
        // No backdrop-filter here: Firefox 150 routes native <select>
        // dropdown popups through a composite layer that gets clipped
        // by any ancestor with `backdrop-filter`, so option clicks land
        // on the backdrop instead of the option. Plain ``bg-overlay/84``
        // already gives a strong dim effect across all themes, and the
        // 3px blur was visually negligible.
        className="absolute inset-0 bg-overlay/84"
        onMouseDown={(e) => {
          pressOriginRef.current = e.target;
        }}
        onMouseUp={(e) => {
          const sameTarget = pressOriginRef.current === e.currentTarget;
          pressOriginRef.current = null;
          if (sameTarget && e.target === e.currentTarget) onClose();
        }}
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
            aria-label={t('common.close')}
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
