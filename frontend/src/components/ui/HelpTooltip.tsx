'use client';

import { Info } from 'lucide-react';

/**
 * HelpTooltip — small info icon that shows a tooltip on hover or focus.
 * Replaces inline helper/instructional text to keep the UI clean.
 */
export function HelpTooltip({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      role="button"
      aria-label="Show help"
      className="group/help relative ml-1 inline-flex items-center rounded-full align-middle outline-none"
    >
      <Info className="h-3.5 w-3.5 cursor-help text-gray-400 transition-colors group-hover/help:text-blue-500 group-focus/help:text-blue-500" />
      <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden w-72 rounded-md bg-slate-900 px-2.5 py-2 text-[11px] font-normal normal-case tracking-normal text-white shadow-lg group-hover/help:block group-focus/help:block">
        {text}
      </span>
    </span>
  );
}
