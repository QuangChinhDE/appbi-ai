'use client';

import React from 'react';
import { ImageOff } from 'lucide-react';

interface ImageBlockRendererProps {
  config: Record<string, any>;
}

export function ImageBlockRenderer({ config }: ImageBlockRendererProps) {
  const url = config.url || '';
  const alt = config.alt || 'Image';

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">
        <ImageOff className="mr-2 h-4 w-4" />
        Image block — set URL in settings
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}
