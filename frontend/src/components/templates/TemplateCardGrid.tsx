'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Trash2, Loader2 } from 'lucide-react';
import type { ReportTemplate } from '@/types/template';

interface TemplateCardGridProps {
  templates: ReportTemplate[];
  onDelete?: (id: number) => void;
  deletingId?: number;
}

const BLOCK_TYPE_ICONS: Record<string, string> = {
  title: '📝',
  table: '📊',
  signature: '✍️',
  text: '📄',
  spacer: '📏',
  image: '🖼️',
};

export function TemplateCardGrid({ templates, onDelete, deletingId }: TemplateCardGridProps) {
  const router = useRouter();

  if (templates.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
        <FileText className="mx-auto mb-4 h-12 w-12 text-gray-400" />
        <h3 className="mb-2 text-lg font-medium text-gray-900">No templates yet</h3>
        <p className="text-gray-500">Create your first report template to get started.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {templates.map((tpl) => {
        const blockSummary = (tpl.blocks ?? []).reduce<Record<string, number>>((acc, b) => {
          acc[b.type] = (acc[b.type] || 0) + 1;
          return acc;
        }, {});

        return (
          <div
            key={tpl.id}
            onClick={() => router.push(`/templates/${tpl.id}`)}
            className="group cursor-pointer rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="mb-3 flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <FileText className="h-5 w-5" />
              </div>
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(tpl.id);
                  }}
                  disabled={deletingId === tpl.id}
                  className="rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 disabled:opacity-50"
                  title="Delete"
                >
                  {deletingId === tpl.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>

            <h3 className="mb-1 truncate text-sm font-semibold text-gray-900">{tpl.name}</h3>
            {tpl.description && (
              <p className="mb-3 line-clamp-2 text-xs text-gray-500">{tpl.description}</p>
            )}

            {/* Block summary badges */}
            <div className="mb-3 flex flex-wrap gap-1">
              {Object.entries(blockSummary).map(([type, count]) => (
                <span
                  key={type}
                  className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                >
                  {BLOCK_TYPE_ICONS[type] ?? '?'} {count}
                </span>
              ))}
              {(tpl.blocks ?? []).length === 0 && (
                <span className="text-xs text-gray-400">Empty template</span>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{tpl.page_size} · {tpl.orientation}</span>
              <span>{new Date(tpl.updated_at).toLocaleDateString()}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
