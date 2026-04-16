'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Trash2, Loader2, Database, Table2 } from 'lucide-react';
import type { ReportTemplate } from '@/types/template';
import { isTemplateDefinition } from '@/types/template';

interface TemplateCardGridProps {
  templates: ReportTemplate[];
  onDelete?: (id: number) => void;
  deletingId?: number;
}

const LAYOUT_ICON: Record<string, string> = {
  table: '⊞',
  card: '⊟',
  'cross-tab': '╪',
};

export function TemplateCardGrid({ templates, onDelete, deletingId }: TemplateCardGridProps) {
  const router = useRouter();

  if (templates.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
        <FileText className="mx-auto mb-4 h-12 w-12 text-gray-400" />
        <h3 className="mb-2 text-lg font-medium text-gray-900">Chưa có template nào</h3>
        <p className="text-gray-500">Tạo template đầu tiên để bắt đầu.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {templates.map((tpl) => {
        const def = isTemplateDefinition(tpl.blocks) ? tpl.blocks : null;
        const dsName = def?.dataSource?.datasetName;
        const tableName = def?.dataSource?.tableName;
        const layout = def?.layout;
        const colCount = def?.columns?.length ?? 0;
        const layoutIcon = layout ? (LAYOUT_ICON[layout] ?? '⊞') : '⊞';

        return (
          <div
            key={tpl.id}
            onClick={() => router.push(`/templates/${tpl.id}`)}
            className="group relative cursor-pointer rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-all hover:shadow-md hover:border-blue-200"
          >
            {/* Delete button */}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(tpl.id); }}
                disabled={deletingId === tpl.id}
                className="absolute right-3 top-3 rounded-lg p-1.5 text-gray-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 disabled:opacity-50"
                title="Xoá"
              >
                {deletingId === tpl.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}

            {/* Icon + Layout */}
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <span className="text-base">{layoutIcon}</span>
              </div>
              {layout && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 capitalize">
                  {layout}
                </span>
              )}
              {colCount > 0 && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400">
                  {colCount} cột
                </span>
              )}
            </div>

            {/* Name */}
            <h3 className="mb-1 truncate pr-6 text-sm font-semibold text-gray-900">{tpl.name}</h3>
            {tpl.description && (
              <p className="mb-2.5 line-clamp-2 text-xs text-gray-500">{tpl.description}</p>
            )}

            {/* Datasource chip */}
            <div className="mb-3">
              {dsName ? (
                <div className="inline-flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5">
                  <Database className="h-2.5 w-2.5 shrink-0 text-blue-500" />
                  <span className="text-[10px] font-medium text-blue-700 truncate max-w-[120px]">
                    {dsName}
                  </span>
                  {tableName && (
                    <>
                      <span className="text-[10px] text-blue-400">/</span>
                      <span className="text-[10px] text-blue-600 truncate max-w-[80px]">{tableName}</span>
                    </>
                  )}
                </div>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[10px] text-gray-400">
                  <Database className="h-2.5 w-2.5" />
                  Chưa bind dữ liệu
                </span>
              )}
            </div>

            {/* Updated */}
            <p className="text-[10px] text-gray-400">
              Cập nhật {new Date(tpl.updated_at).toLocaleDateString('vi-VN')}
            </p>
          </div>
        );
      })}
    </div>
  );
}
