'use client';

import React from 'react';

interface SignatureBlockRendererProps {
  config: Record<string, any>;
}

export function SignatureBlockRenderer({ config }: SignatureBlockRendererProps) {
  const columns: { title: string; subtitle?: string }[] = config.columns ?? [];

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">
        Signature block — configure in settings
      </div>
    );
  }

  return (
    <div className="flex h-full items-end justify-around px-4 pb-2">
      {columns.map((col, idx) => (
        <div key={idx} className="text-center">
          <p className="text-xs font-semibold text-gray-700">{col.title}</p>
          {col.subtitle && <p className="mt-0.5 text-[10px] text-gray-400">{col.subtitle}</p>}
          <div className="mx-auto mt-4 h-px w-24 bg-gray-300" />
        </div>
      ))}
    </div>
  );
}
