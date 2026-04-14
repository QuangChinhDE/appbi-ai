'use client';

import React from 'react';
import { Type, Table2, PenLine, FileText, Minus, Image } from 'lucide-react';

export interface BlockTypeDef {
  type: string;
  label: string;
  icon: React.ReactNode;
  defaultW: number;   // px
  defaultH: number;   // px
}

export const BLOCK_TYPES: BlockTypeDef[] = [
  { type: 'title', label: 'Title', icon: <Type className="h-4 w-4" />, defaultW: 1100, defaultH: 80 },
  { type: 'table', label: 'Table', icon: <Table2 className="h-4 w-4" />, defaultW: 1100, defaultH: 240 },
  { type: 'signature', label: 'Signature', icon: <PenLine className="h-4 w-4" />, defaultW: 1100, defaultH: 120 },
  { type: 'text', label: 'Text', icon: <FileText className="h-4 w-4" />, defaultW: 1100, defaultH: 60 },
  { type: 'spacer', label: 'Spacer', icon: <Minus className="h-4 w-4" />, defaultW: 1100, defaultH: 32 },
  { type: 'image', label: 'Image', icon: <Image className="h-4 w-4" />, defaultW: 320, defaultH: 220 },
];

interface BlockPaletteProps {
  onAddBlock: (typeDef: BlockTypeDef) => void;
}

export function BlockPalette({ onAddBlock }: BlockPaletteProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
        Add Block
      </h3>
      <div className="space-y-1">
        {BLOCK_TYPES.map((bt) => (
          <button
            key={bt.type}
            onClick={() => onAddBlock(bt)}
            className="flex w-full items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left text-sm text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
          >
            <span className="text-gray-500">{bt.icon}</span>
            <span>{bt.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
