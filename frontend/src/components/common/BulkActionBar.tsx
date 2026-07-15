'use client';

import React from 'react';
import { Trash2, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';

interface BulkActionBarProps {
  selectedCount: number;
  onDelete: () => void;
  onClear: () => void;
  isDeleting?: boolean;
}

export function BulkActionBar({ selectedCount, onDelete, onClear, isDeleting }: BulkActionBarProps) {
  const { t } = useI18n();

  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-200">
      <div className="flex items-center gap-3 rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2.5 shadow-lg">
        <span className="text-caption font-emphasis text-text-primary">
          {t('common.selectedCount', { count: selectedCount })}
        </span>
        <div className="h-4 w-px bg-[rgb(var(--border-line))]" />
        <Button
          variant="danger"
          size="sm"
          leadingIcon={isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          onClick={onDelete}
          disabled={isDeleting}
        >
          {isDeleting ? t('common.deleting') : t('common.delete')}
        </Button>
        <button
          type="button"
          onClick={onClear}
          disabled={isDeleting}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
          title={t('common.clearSelection')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
