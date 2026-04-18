'use client';

import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ui/Button';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'info';
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  const iconTone = {
    danger: 'text-danger bg-danger/10',
    warning: 'text-warning bg-warning/10',
    info: 'text-info bg-info/10',
  }[variant];

  const confirmVariant = variant === 'danger' ? 'danger' : 'primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-[3px] animate-fade-in">
      <div className="relative mx-4 w-full max-w-md rounded-xl bg-surface-1 border border-[rgb(var(--border-strong))] shadow-linear-lg animate-slide-up">
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="flex items-start gap-3">
            <div className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg', iconTone)}>
              <AlertTriangle className="h-4 w-4" />
            </div>
            <h3 className="text-small font-strong text-text-primary pt-1">
              {title}
            </h3>
          </div>
          <IconButton aria-label="Close" variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="px-5 pb-5 pl-16">
          <p className="text-caption text-text-secondary">{description}</p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[rgb(var(--border-line))] bg-surface-2 rounded-b-xl">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} size="sm" onClick={handleConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
