'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Trash2, FileText, Loader2, Database } from 'lucide-react';
import type { ReportTemplate } from '@/types/template';
import { isTemplateDefinition } from '@/types/template';
import { OwnerBadge } from '@/components/common/OwnerBadge';

interface TemplateListProps {
  templates: ReportTemplate[];
  onDelete?: (id: number) => void;
  deletingId?: number;
}

export function TemplateList({ templates, onDelete, deletingId }: TemplateListProps) {
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
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Tên template
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Nguồn dữ liệu
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Owner
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Cập nhật
            </th>
            <th className="px-5 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Thao tác
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {templates.map((tpl) => {
            const def = isTemplateDefinition(tpl.blocks) ? tpl.blocks : null;
            const dsName = def?.dataSource?.datasetName;
            const tableName = def?.dataSource?.tableName;
            const layout = def?.layout;
            const colCount = def?.columns?.length ?? 0;

            return (
              <tr
                key={tpl.id}
                className="cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => router.push(`/templates/${tpl.id}`)}
              >
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-50">
                      <FileText className="h-3.5 w-3.5 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{tpl.name}</p>
                      {tpl.description && (
                        <p className="text-xs text-gray-500 truncate max-w-[220px]">{tpl.description}</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3.5">
                  {dsName ? (
                    <div className="flex items-center gap-1.5">
                      <Database className="h-3 w-3 shrink-0 text-blue-500" />
                      <span className="text-xs text-gray-700 font-medium">{dsName}</span>
                      {tableName && (
                        <span className="text-xs text-gray-400">/ {tableName}</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400 italic">Chưa bind</span>
                  )}
                  {(layout || colCount > 0) && (
                    <div className="mt-0.5 flex gap-1.5">
                      {layout && (
                        <span className="rounded bg-gray-100 px-1.5 py-px text-[10px] text-gray-500 capitalize">
                          {layout}
                        </span>
                      )}
                      {colCount > 0 && (
                        <span className="rounded bg-gray-100 px-1.5 py-px text-[10px] text-gray-500">
                          {colCount} cột
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-5 py-3.5">
                  <OwnerBadge email={tpl.owner_email} />
                </td>
                <td className="whitespace-nowrap px-5 py-3.5 text-xs text-gray-500">
                  {new Date(tpl.updated_at).toLocaleDateString('vi-VN')}
                </td>
                <td className="whitespace-nowrap px-5 py-3.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); router.push(`/templates/${tpl.id}`); }}
                      className="rounded-md p-1.5 text-blue-600 hover:bg-blue-50 transition-colors"
                      title="Mở template"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    {onDelete && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(tpl.id); }}
                        disabled={deletingId === tpl.id}
                        className="rounded-md p-1.5 text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
                        title="Xoá template"
                      >
                        {deletingId === tpl.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
