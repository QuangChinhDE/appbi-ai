'use client';

import { Info } from 'lucide-react';

/**
 * HelpTooltip — small info icon that shows a tooltip on hover or focus.
 */
export function HelpTooltip({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      role="button"
      aria-label="Show help"
      className="group/help relative ml-1 inline-flex items-center rounded-full align-middle outline-none"
    >
      <Info className="h-3.5 w-3.5 cursor-help text-text-quaternary transition-colors group-hover/help:text-brand group-focus/help:text-brand" />
      <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden w-72 rounded-md bg-surface-inverse px-2.5 py-2 text-tiny font-normal normal-case tracking-normal text-text-inverse shadow-linear-lg group-hover/help:block group-focus/help:block">
        {text}
      </span>
    </span>
  );
}
