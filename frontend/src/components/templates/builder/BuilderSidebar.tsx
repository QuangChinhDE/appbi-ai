'use client';

import React from 'react';

import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import type { ReportTemplate } from '@/types/template';

const BADGE_STYLES: Record<string, { label: string; variant: 'success' | 'brand' | 'warning' }> = {
  table: { label: 'table', variant: 'success' },
  card: { label: 'card', variant: 'brand' },
  'cross-tab': { label: 'cross-tab', variant: 'warning' },
};

function getLayoutFromBlocks(blocks: any): string {
  if (blocks?.version === 3 && blocks.layout) return blocks.layout;
  return 'table';
}

interface BuilderSidebarProps {
  templates: ReportTemplate[];
  currentTemplateId: number;
  onNavigate: (id: number) => void;
}

export function BuilderSidebar({ templates, currentTemplateId, onNavigate }: BuilderSidebarProps) {
  return (
    <aside className="flex w-[232px] shrink-0 flex-col overflow-hidden border-r border-[rgb(var(--border-line))] bg-surface-1">
      <div className="px-3 pb-2 pt-3 text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
        Templates
      </div>
      <div className="flex-1 overflow-y-auto">
        {templates.map((tpl) => {
          const isActive = tpl.id === currentTemplateId;
          const layout = getLayoutFromBlocks(tpl.blocks);
          const badge = BADGE_STYLES[layout] ?? BADGE_STYLES.table;

          return (
            <button
              key={tpl.id}
              onClick={() => onNavigate(tpl.id)}
              type="button"
              className={cn(
                'w-full border-b border-[rgb(var(--border-line))] px-3 py-2.5 text-left transition-colors',
                isActive
                  ? 'border-l-[3px] border-l-brand bg-brand/10'
                  : 'border-l-[3px] border-l-transparent hover:bg-surface-2',
              )}
            >
              <div className={cn(
                'text-caption leading-tight text-text-primary',
                isActive ? 'font-strong text-brand' : 'font-emphasis',
              )}>
                {tpl.name}
              </div>
              <div className="mt-0.5 truncate text-[10px] font-mono text-text-quaternary">
                {tpl.description || 'template'}
              </div>
              <Badge variant={badge.variant} size="xs" pill={false} className="mt-2 rounded px-1.5 py-0">
                {badge.label}
              </Badge>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="mx-3 my-2 rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-transparent py-2 text-center text-label text-text-tertiary transition-colors hover:bg-surface-2"
        onClick={() => {/* handled by parent */}}
      >
        + Template mới
      </button>
    </aside>
  );
}
