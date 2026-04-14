'use client';

import React from 'react';
import type { TemplateBlock } from '@/types/template';
import { TitleBlockRenderer } from './blocks/TitleBlockRenderer';
import { TableBlockRenderer } from './blocks/TableBlockRenderer';
import { SignatureBlockRenderer } from './blocks/SignatureBlockRenderer';
import { TextBlockRenderer } from './blocks/TextBlockRenderer';
import { SpacerBlockRenderer } from './blocks/SpacerBlockRenderer';
import { ImageBlockRenderer } from './blocks/ImageBlockRenderer';

interface BlockRendererProps {
  block: TemplateBlock;
}

export function BlockRenderer({ block }: BlockRendererProps) {
  switch (block.type) {
    case 'title':
      return <TitleBlockRenderer config={block.config} />;
    case 'table':
      return <TableBlockRenderer config={block.config} />;
    case 'signature':
      return <SignatureBlockRenderer config={block.config} />;
    case 'text':
      return <TextBlockRenderer config={block.config} />;
    case 'spacer':
      return <SpacerBlockRenderer />;
    case 'image':
      return <ImageBlockRenderer config={block.config} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-gray-400">
          Unknown block type: {block.type}
        </div>
      );
  }
}
