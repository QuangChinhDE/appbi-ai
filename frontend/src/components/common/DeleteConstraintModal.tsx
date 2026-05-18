'use client';

import React from 'react';
import { AlertTriangle, Trash2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

export interface DeleteConstraint {
  type: string;
  id?: number;
  name?: string;
  table_name?: string;
  column?: string;
}

interface DeleteConstraintModalProps {
  itemName: string;
  itemTypeLabel: string;
  constraints: DeleteConstraint[] | null;
  isDeleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

const TYPE_LABELS: Record<string, { label: string; cls: string }> = {
  chart: { label: 'Chart', cls: 'bg-info/12 text-info' },
  dashboard: { label: 'Dashboard', cls: 'bg-brand/12 text-brand' },
  dataset: { label: 'Dataset', cls: 'bg-warning/12 text-warning' },
  lookup: { label: 'LOOKUP', cls: 'bg-warning/12 text-warning' },
};

function ConstraintBadge({ type }: { type: string }) {
  const meta = TYPE_LABELS[type.toLowerCase()] ?? {
    label: type.toUpperCase(),
    cls: 'bg-surface-2 text-text-tertiary',
  };
  return (
    <span className={cn('text-tiny font-strong uppercase rounded px-1.5 py-0.5', meta.cls)}>
      {meta.label}
    </span>
  );
}

export function DeleteConstraintModal({
  itemName,
  itemTypeLabel,
  constraints,
  isDeleting,
  onConfirm,
  onClose,
}: DeleteConstraintModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-[3px] p-4 animate-fade-in">
      <div className="w-full max-w-md rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg animate-slide-up">
        {constraints ? (
          <div className="p-5">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-small font-strong text-text-primary">
                  Cannot delete {itemTypeLabel}
                </h2>
                <p className="text-caption text-text-secondary mt-0.5">
                  <span className="font-emphasis text-text-primary">&ldquo;{itemName}&rdquo;</span>{' '}
                  is used by {constraints.length} item{constraints.length === 1 ? '' : 's'}:
                </p>
              </div>
            </div>

            <ul className="mb-5 space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
              {constraints.map((c, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 text-caption bg-danger/6 border border-danger/15 rounded-md px-3 py-2"
                >
                  <ConstraintBadge type={c.type} />
                  {c.type === 'lookup' ? (
                    <span className="text-text-primary">
                      Table <strong>{c.table_name}</strong>, column <strong>{c.column}</strong>
                    </span>
                  ) : (
                    <span className="text-text-primary">{c.name}</span>
                  )}
                </li>
              ))}
            </ul>

            <p className="text-tiny text-text-tertiary mb-4">
              Remove or update these dependencies before deleting this {itemTypeLabel}.
            </p>

            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-5">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
                <Trash2 className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-small font-strong text-text-primary">
                  Delete {itemTypeLabel}?
                </h2>
                <p className="text-caption text-text-secondary mt-0.5">
                  Are you sure you want to delete{' '}
                  <span className="font-emphasis text-text-primary">&ldquo;{itemName}&rdquo;</span>?{' '}
                  This action cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={isDeleting}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={onConfirm}
                disabled={isDeleting}
                leadingIcon={isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
              >
                Delete {itemTypeLabel}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
