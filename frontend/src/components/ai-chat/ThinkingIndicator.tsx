'use client';

/**
 * Animated "AI is thinking..." indicator.
 */
import React from 'react';

interface ThinkingIndicatorProps {
  content?: string;
}

export function ThinkingIndicator({ content }: ThinkingIndicatorProps) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-gray-500">
      <span className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
      </span>
      {content && <span className="italic">{content}</span>}
    </div>
  );
}
