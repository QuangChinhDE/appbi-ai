'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Trash2, FileText, Loader2 } from 'lucide-react';
import type { ReportTemplate } from '@/types/template';
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
        <h3 className="mb-2 text-lg font-medium text-gray-900">No templates yet</h3>
        <p className="text-gray-500">Create your first report template to get started.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Owner
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Page
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Blocks
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Updated
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {templates.map((tpl) => (
            <tr key={tpl.id} className="hover:bg-gray-50">
              <td className="px-6 py-4">
                <div className="text-sm font-medium text-gray-900">{tpl.name}</div>
                {tpl.description && (
                  <div className="text-sm text-gray-500">{tpl.description}</div>
                )}
              </td>
              <td className="whitespace-nowrap px-6 py-4">
                <OwnerBadge email={tpl.owner_email} />
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                {tpl.page_size} · {tpl.orientation}
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                {Array.isArray(tpl.blocks) ? tpl.blocks.length : 1} blocks
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                {new Date(tpl.updated_at).toLocaleDateString()}
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-medium">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => router.push(`/templates/${tpl.id}`)}
                    className="rounded p-1 text-blue-600 hover:bg-blue-50 hover:text-blue-900"
                    title="Open template"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  {onDelete && (
                    <button
                      onClick={() => onDelete(tpl.id)}
                      disabled={deletingId === tpl.id}
                      className="rounded p-1 text-red-600 hover:bg-red-50 hover:text-red-900 disabled:opacity-50"
                      title="Delete template"
                    >
                      {deletingId === tpl.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
