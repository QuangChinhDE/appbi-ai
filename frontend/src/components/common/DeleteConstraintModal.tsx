'use client';

import React from 'react';
import { AlertTriangle, Trash2, Loader2 } from 'lucide-react';

export interface DeleteConstraint {
  type: string;
  id?: number;
  name?: string;
  table_name?: string;
  column?: string;
}

interface DeleteConstraintModalProps {
  /** Name of the item being deleted — shown in confirmation and constraint messages */
  itemName: string;
  /** Vietnamese label for the item type, e.g. "dataset", "data source", "biểu đồ" */
  itemTypeLabel: string;
  /** When non-null, shows the constraint error view instead of confirmation */
  constraints: DeleteConstraint[] | null;
  isDeleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

const TYPE_LABELS: Record<string, { label: string; cls: string }> = {
  chart:     { label: 'Biểu đồ',   cls: 'bg-blue-100 text-blue-700' },
  dashboard: { label: 'Dashboard', cls: 'bg-purple-100 text-purple-700' },
  dataset: { label: 'Dataset', cls: 'bg-orange-100 text-orange-700' },
  lookup:    { label: 'LOOKUP',    cls: 'bg-amber-100 text-amber-700' },
};

function ConstraintBadge({ type }: { type: string }) {
  const meta = TYPE_LABELS[type.toLowerCase()] ?? { label: type.toUpperCase(), cls: 'bg-gray-100 text-gray-700' };
  return (
    <span className={`text-xs font-semibold uppercase rounded px-1.5 py-0.5 ${meta.cls}`}>
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
    <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
        {constraints ? (
          /* ── Constraint error view ── */
          <>
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Không thể xóa {itemTypeLabel}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  <span className="font-medium">&ldquo;{itemName}&rdquo;</span> đang được sử dụng bởi:
                </p>
              </div>
            </div>

            <ul className="mb-6 space-y-2">
              {constraints.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm bg-red-50 rounded-lg px-3 py-2">
                  <ConstraintBadge type={c.type} />
                  {c.type === 'lookup' ? (
                    <span className="text-gray-800">
                      Bảng <strong>{c.table_name}</strong>, cột <strong>{c.column}</strong>
                    </span>
                  ) : (
                    <span className="text-gray-800">{c.name}</span>
                  )}
                </li>
              ))}
            </ul>

            <p className="text-xs text-gray-500 mb-4">
              Hãy xóa hoặc cập nhật các ràng buộc trên trước khi xóa {itemTypeLabel} này.
            </p>

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium"
              >
                Đóng
              </button>
            </div>
          </>
        ) : (
          /* ── Confirmation view ── */
          <>
            <div className="flex items-start gap-3 mb-4">
              <Trash2 className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Xóa {itemTypeLabel}?
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  Bạn có chắc muốn xóa{' '}
                  <span className="font-medium">&ldquo;{itemName}&rdquo;</span>?{' '}
                  Hành động này không thể hoàn tác.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                disabled={isDeleting}
                className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                onClick={onConfirm}
                disabled={isDeleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-2"
              >
                {isDeleting && <Loader2 className="w-4 h-4 animate-spin" />}
                Xóa {itemTypeLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
