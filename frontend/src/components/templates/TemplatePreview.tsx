'use client';

import React, { useMemo } from 'react';
import type { TemplateBlock } from '@/types/template';
import { PAGE_SIZES } from '@/types/template';
import { BlockRenderer } from './BlockRenderer';

interface TemplatePreviewProps {
  blocks: TemplateBlock[];
  pageSize?: string;
  orientation?: string;
}

const PAGE_PADDING = 24;

export function TemplatePreview({ blocks, pageSize = 'A4', orientation = 'portrait' }: TemplatePreviewProps) {
  const dims = PAGE_SIZES[pageSize] ?? PAGE_SIZES.A4;
  const isLandscape = orientation === 'landscape';
  const width = isLandscape ? dims.height : dims.width;
  const height = isLandscape ? dims.width : dims.height;

  const contentBounds = useMemo(() => {
    if (!blocks.length) {
      return {
        minX: 0,
        minY: 0,
        width: Math.max(1, width - PAGE_PADDING * 2),
        height: Math.max(1, height - PAGE_PADDING * 2),
      };
    }

    const minX = Math.min(...blocks.map((block) => block.layout.x));
    const minY = Math.min(...blocks.map((block) => block.layout.y));
    const maxX = Math.max(...blocks.map((block) => block.layout.x + block.layout.width));
    const maxY = Math.max(...blocks.map((block) => block.layout.y + block.layout.height));

    return {
      minX,
      minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }, [blocks, height, width]);

  const scale = useMemo(() => {
    const scaleX = (width - PAGE_PADDING * 2) / contentBounds.width;
    const scaleY = (height - PAGE_PADDING * 2) / contentBounds.height;
    return Math.min(scaleX, scaleY, 1);
  }, [contentBounds.height, contentBounds.width, height, width]);

  const offsetX = (width - contentBounds.width * scale) / 2 - contentBounds.minX * scale;
  const offsetY = (height - contentBounds.height * scale) / 2 - contentBounds.minY * scale;

  return (
    <div className="flex justify-center bg-gray-100 p-8 print:bg-white print:p-0">
      <div
        className="relative overflow-hidden bg-white shadow-lg print:shadow-none"
        style={{ width, height }}
      >
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
        >
          {blocks.map((block) => (
            <div
              key={block.id}
              className="absolute overflow-hidden"
              style={{
                left: block.layout.x,
                top: block.layout.y,
                width: block.layout.width,
                height: block.layout.height,
              }}
            >
              <BlockRenderer block={block} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
