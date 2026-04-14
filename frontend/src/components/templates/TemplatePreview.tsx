'use client';

import React, { useMemo } from 'react';
import type { TemplateBlock } from '@/types/template';
import { PAGE_SIZES, PAGE_MARGIN } from '@/types/template';
import { BlockRenderer } from './BlockRenderer';

interface TemplatePreviewProps {
  blocks: TemplateBlock[];
  pageSize?: string;
  orientation?: string;
}

/**
 * Flow-based preview renderer.
 *
 * Blocks are sorted top-to-bottom by their Y position and rendered in
 * document flow. Table blocks get auto height so they can grow based on
 * actual data (10 rows or 1000 rows). Non-table blocks keep their 
 * designed height.
 *
 * For print:  the wrapper uses CSS @page rules from globals.css.
 * Tables use `break-inside: avoid` on rows so page breaks don't cut rows.
 */
export function TemplatePreview({ blocks, pageSize = 'A4', orientation = 'portrait' }: TemplatePreviewProps) {
  const dims = PAGE_SIZES[pageSize] ?? PAGE_SIZES.A4;
  const isLandscape = orientation === 'landscape';
  const pageWidth = isLandscape ? dims.height : dims.width;
  const pageMinHeight = isLandscape ? dims.width : dims.height;

  // Sort blocks by Y position for natural document flow
  const sortedBlocks = useMemo(
    () => [...blocks].sort((a, b) => a.layout.y - b.layout.y),
    [blocks],
  );

  return (
    <div className="template-print-root flex justify-center bg-gray-100 p-8 print:bg-white print:p-0">
      <div
        className="template-print-page bg-white shadow-lg print:shadow-none"
        style={{
          width: pageWidth,
          minHeight: pageMinHeight,
          padding: PAGE_MARGIN,
          boxSizing: 'border-box',
        }}
      >
        {sortedBlocks.map((block) => {
          const isTable = block.type === 'table';

          return (
            <div
              key={block.id}
              className={isTable ? 'template-print-table-block' : ''}
              style={{
                width: Math.min(block.layout.width, pageWidth - PAGE_MARGIN * 2),
                // Tables get auto height; other blocks keep their designed height
                ...(isTable ? {} : { height: block.layout.height, overflow: 'hidden' }),
                // Approximate horizontal position: offset from left margin
                marginLeft: Math.max(0, block.layout.x - PAGE_MARGIN),
                marginBottom: 4,
              }}
            >
              <BlockRenderer block={block} printMode={isTable} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
