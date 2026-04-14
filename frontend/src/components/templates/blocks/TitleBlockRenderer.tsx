'use client';

import React from 'react';

interface TitleBlockRendererProps {
  config: Record<string, any>;
}

export function TitleBlockRenderer({ config }: TitleBlockRendererProps) {
  const text = config.text || 'Untitled';
  const subtitle = config.subtitle || '';
  const centered = config.centered !== false;

  return (
    <div className={`flex h-full flex-col justify-center px-4 ${centered ? 'text-center' : 'text-left'}`}>
      <h2 className="text-lg font-bold text-gray-900">{text}</h2>
      {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
    </div>
  );
}
