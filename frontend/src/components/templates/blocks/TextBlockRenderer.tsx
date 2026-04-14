'use client';

import React from 'react';
import { Database } from 'lucide-react';
import type { CellValue } from '@/types/template';
import { isDataField, isFormula } from '@/types/template';

interface TextBlockRendererProps {
  config: Record<string, any>;
}

export function TextBlockRenderer({ config }: TextBlockRendererProps) {
  const content = config.content;

  // Support rich content (array of CellValue segments)
  if (Array.isArray(content)) {
    return (
      <div className="h-full overflow-auto px-4 py-2 text-sm text-gray-700 whitespace-pre-wrap">
        {content.map((seg: CellValue, i: number) => {
          if (typeof seg === 'string') return <span key={i}>{seg}</span>;
          if (isDataField(seg)) {
            return (
              <span key={i} className="inline-flex items-center gap-0.5 rounded bg-blue-100 px-1 py-0.5 text-[10px] font-medium text-blue-700 mx-0.5">
                <Database className="h-2.5 w-2.5" />
                {seg.label ?? seg.column}
              </span>
            );
          }
          if (isFormula(seg)) {
            return <span key={i} className="rounded bg-green-100 px-1 py-0.5 text-[10px] font-medium text-green-700 mx-0.5">ƒ {seg.expression}</span>;
          }
          return null;
        })}
      </div>
    );
  }

  // Plain string content (backward compat)
  if (!content) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">
        Text block — configure in settings
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-4 py-2 text-sm text-gray-700 whitespace-pre-wrap">
      {content}
    </div>
  );
}
