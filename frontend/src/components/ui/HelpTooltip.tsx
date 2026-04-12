'use client';

import { Info } from 'lucide-react';

/**
 * HelpTooltip — small info icon that shows a tooltip on hover.
 * Replaces inline helper/instructional text to keep the UI clean.
 */
export function HelpTooltip({ text }: { text: string }) {
  return (
    <span className="group/help relative inline-flex items-center ml-1 align-middle">
      <Info className="h-3.5 w-3.5 text-gray-400 transition-colors group-hover/help:text-blue-500 cursor-help" />
      <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden w-64 rounded-md bg-slate-900 px-2.5 py-2 text-[11px] font-normal normal-case tracking-normal text-white shadow-lg group-hover/help:block">
        {text}
      </span>
    </span>
  );
}
