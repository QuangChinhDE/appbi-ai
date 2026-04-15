'use client';

import React from 'react';
import type { ReportTemplate } from '@/types/template';

const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  table: { bg: '#e8f5ed', color: '#1a4d2e' },
  card: { bg: '#eeedf8', color: '#4a3f8f' },
  'cross-tab': { bg: '#fef3e2', color: '#92540a' },
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
    <div
      className="flex w-[220px] shrink-0 flex-col overflow-hidden border-r"
      style={{ background: '#fff', borderColor: '#e2dfd8' }}
    >
      <div
        className="px-3 pt-[10px] pb-[6px] text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: '#a09b95' }}
      >
        Templates
      </div>
      <div className="flex-1 overflow-y-auto">
        {templates.map((tpl) => {
          const isActive = tpl.id === currentTemplateId;
          const layout = getLayoutFromBlocks(tpl.blocks);
          const badge = BADGE_STYLES[layout] ?? BADGE_STYLES.table;

          return (
            <div
              key={tpl.id}
              onClick={() => onNavigate(tpl.id)}
              className="cursor-pointer border-b px-3 py-2"
              style={{
                borderColor: '#e2dfd8',
                background: isActive ? '#e8f5ed' : undefined,
                borderLeft: isActive ? '3px solid #1a4d2e' : '3px solid transparent',
              }}
            >
              <div
                className="text-xs leading-tight"
                style={{
                  fontWeight: isActive ? 500 : 400,
                  color: isActive ? '#1a4d2e' : '#18171a',
                }}
              >
                {tpl.name}
              </div>
              <div
                className="mt-0.5 text-[10px]"
                style={{ fontFamily: "'DM Mono', monospace", color: '#a09b95' }}
              >
                {tpl.description || 'template'}
              </div>
              <span
                className="mt-1 inline-block rounded px-[5px] py-px text-[9px] font-medium"
                style={{ background: badge.bg, color: badge.color }}
              >
                {layout}
              </span>
            </div>
          );
        })}
      </div>
      <button
        className="mx-3 my-2 rounded-md border border-dashed py-1.5 text-center text-[11px]"
        style={{ borderColor: '#c9c5bc', color: '#a09b95', background: 'none' }}
        onClick={() => {/* handled by parent */}}
      >
        + Template mới
      </button>
    </div>
  );
}
