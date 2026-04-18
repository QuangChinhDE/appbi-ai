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
      <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-12 text-center shadow-linear-sm">
        <FileText className="mx-auto mb-4 h-12 w-12 text-text-quaternary" />
        <h3 className="mb-2 text-lg font-medium text-text-primary">Chưa có template nào</h3>
        <p className="text-text-tertiary">Tạo template đầu tiên để bắt đầu.</p>
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
            className="group relative cursor-pointer rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-sm transition-all hover:border-brand/30 hover:shadow-linear-md"
          >
            {/* Delete button */}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(tpl.id); }}
                disabled={deletingId === tpl.id}
                className="absolute right-3 top-3 rounded-lg p-1.5 text-text-quaternary opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100 disabled:opacity-50"
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
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <span className="text-base">{layoutIcon}</span>
              </div>
              {layout && (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-tertiary capitalize">
                  {layout}
                </span>
              )}
              {colCount > 0 && (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-text-quaternary">
                  {colCount} cột
                </span>
              )}
            </div>

            {/* Name */}
            <h3 className="mb-1 truncate pr-6 text-sm font-semibold text-text-primary">{tpl.name}</h3>
            {tpl.description && (
              <p className="mb-2.5 line-clamp-2 text-xs text-text-tertiary">{tpl.description}</p>
            )}

            {/* Datasource chip */}
            <div className="mb-3">
              {dsName ? (
                <div className="inline-flex items-center gap-1 rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5">
                  <Database className="h-2.5 w-2.5 shrink-0 text-brand" />
                  <span className="text-[10px] font-medium text-brand truncate max-w-[120px]">
                    {dsName}
                  </span>
                  {tableName && (
                    <>
                      <span className="text-[10px] text-brand">/</span>
                      <span className="text-[10px] text-brand truncate max-w-[80px]">{tableName}</span>
                    </>
                  )}
                </div>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[rgb(var(--border-strong))] px-2 py-0.5 text-[10px] text-text-quaternary">
                  <Database className="h-2.5 w-2.5" />
                  Chưa bind dữ liệu
                </span>
              )}
            </div>

            {/* Updated */}
            <p className="text-[10px] text-text-quaternary">
              Cập nhật {new Date(tpl.updated_at).toLocaleDateString('vi-VN')}
            </p>
          </div>
        );
      })}
    </div>
  );
}
