'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, FileText, Loader2, Database } from 'lucide-react';
import type { ReportTemplate } from '@/types/template';
import { isTemplateDefinition, isTemplateDocumentDefinition } from '@/types/template';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { FilterTag, type FilterTagTone } from '@/components/ui/FilterTag';
import { IconButton } from '@/components/ui/Button';

function countDocumentBlocks(block: any): number {
  if (!block || typeof block !== 'object') return 0;
  const children: any[] = Array.isArray(block.children) ? block.children : [];
  return 1 + children.reduce((total: number, child: any) => total + countDocumentBlocks(child), 0);
}

interface TemplateListProps {
  templates: ReportTemplate[];
  onDelete?: (id: number) => void;
  deletingId?: number;
  activeFilters?: Record<string, string | undefined>;
  onFilterClick?: (key: string, value: string) => void;
}

export function TemplateList({
  templates,
  onDelete,
  deletingId,
  activeFilters,
  onFilterClick,
}: TemplateListProps) {
  const router = useRouter();

  const getLayoutMeta = (layout?: string): { label: string; tone: FilterTagTone; value: string } => {
    switch (layout) {
      case 'table':
        return { label: 'Table', tone: 'brand', value: 'table' };
      case 'card':
        return { label: 'Card', tone: 'info', value: 'card' };
      case 'cross-tab':
        return { label: 'Cross-tab', tone: 'success', value: 'cross-tab' };
      case 'document':
        return { label: 'Document', tone: 'info', value: 'document' };
      default:
        return { label: 'Custom', tone: 'neutral', value: 'custom' };
    }
  };

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
    <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
      <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
        <thead className="bg-surface-2">
          <tr>
            <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
              Tên template
            </th>
            <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
              Tags
            </th>
            <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
              Owner
            </th>
            <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
              Cập nhật
            </th>
            <th className="px-5 py-3 text-right text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
              Thao tác
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
          {templates.map((tpl) => {
            const def = isTemplateDefinition(tpl.blocks) ? tpl.blocks : null;
            const documentDefinition = isTemplateDocumentDefinition(tpl.blocks) ? tpl.blocks : null;
            const dsName = def?.dataSource?.datasetName ?? documentDefinition?.dataSources[0]?.name;
            const tableName = def?.dataSource?.tableName;
            const layout = def?.layout ?? (documentDefinition ? 'document' : undefined);
            const colCount = def?.columns?.length ?? 0;
            const blockCount = documentDefinition ? countDocumentBlocks(documentDefinition.root) : 0;
            const layoutMeta = getLayoutMeta(layout);
            const bindingValue = dsName ? 'bound' : 'unbound';
            const bindingTone: FilterTagTone = dsName ? 'success' : 'warning';

            return (
              <tr
                key={tpl.id}
                className="cursor-pointer hover:bg-surface-2 transition-colors"
                onClick={() => router.push(`/templates/${tpl.id}`)}
              >
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10">
                      <FileText className="h-3.5 w-3.5 text-brand" />
                    </div>
                    <div>
                      <p className="text-caption font-emphasis text-text-primary">{tpl.name}</p>
                      {tpl.description && (
                        <p className="text-tiny text-text-tertiary truncate max-w-[220px]">{tpl.description}</p>
                      )}
                      {dsName ? (
                        <div className="mt-1 flex items-center gap-1.5 text-tiny text-text-secondary">
                          <Database className="h-3 w-3 shrink-0 text-brand" />
                          <span className="truncate">{dsName}</span>
                          {tableName && (
                            <span className="truncate text-text-quaternary">/ {tableName}</span>
                          )}
                        </div>
                      ) : (
                        <p className="mt-1 text-tiny italic text-text-quaternary">Chưa bind nguồn dữ liệu</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex flex-wrap gap-1.5">
                    <FilterTag
                      tone={layoutMeta.tone}
                      active={activeFilters?.layout === layoutMeta.value}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFilterClick?.('layout', layoutMeta.value);
                      }}
                    >
                      {layoutMeta.label}
                    </FilterTag>
                    <FilterTag
                      tone={bindingTone}
                      active={activeFilters?.binding === bindingValue}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFilterClick?.('binding', bindingValue);
                      }}
                    >
                      {dsName ? 'Bound' : 'Unbound'}
                    </FilterTag>
                    {colCount > 0 && (
                      <FilterTag className="cursor-default" disabled>
                        {colCount} cột
                      </FilterTag>
                    )}
                    {!colCount && blockCount > 0 && (
                      <FilterTag className="cursor-default" disabled>
                        {blockCount} blocks
                      </FilterTag>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-5 py-3.5">
                  <OwnerBadge
                    email={tpl.owner_email}
                    active={activeFilters?.owner === tpl.owner_email}
                    onClick={tpl.owner_email ? () => onFilterClick?.('owner', tpl.owner_email!) : undefined}
                  />
                </td>
                <td className="whitespace-nowrap px-5 py-3.5 text-caption text-text-tertiary">
                  {new Date(tpl.updated_at).toLocaleDateString('vi-VN')}
                </td>
                <td className="whitespace-nowrap px-5 py-3.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {onDelete && (
                      <IconButton
                        aria-label="Delete template"
                        variant="ghost"
                        size="xs"
                        onClick={(e) => { e.stopPropagation(); onDelete(tpl.id); }}
                        disabled={deletingId === tpl.id}
                        className="text-danger hover:bg-danger/10"
                        title="Xoá template"
                      >
                        {deletingId === tpl.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </IconButton>
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
