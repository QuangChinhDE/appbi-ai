'use client';

import React from 'react';
import { Info } from 'lucide-react';

/**
 * HelpTooltip — small info icon that shows a plain-text tooltip on hover or focus.
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

/**
 * HelpTooltipRich — info icon with rich (JSX) tooltip content.
 * Use when the tooltip needs formatting: bold labels, bullet lists, etc.
 *
 * @param side  - Which side of the trigger the panel appears ('left' | 'right')
 *               Defaults to 'left' (panel aligns to the left edge of the icon).
 */
export function HelpTooltipRich({
  children,
  side = 'left',
}: {
  children: React.ReactNode;
  side?: 'left' | 'right';
}) {
  const alignClass = side === 'right' ? 'right-0' : 'left-0';
  return (
    <span
      tabIndex={0}
      role="button"
      aria-label="Show help"
      className="group/help relative ml-1 inline-flex items-center rounded-full align-middle outline-none"
    >
      <Info className="h-3.5 w-3.5 cursor-help text-text-quaternary transition-colors group-hover/help:text-text-secondary group-focus/help:text-brand" />
      <span
        className={`pointer-events-none absolute ${alignClass} top-full z-50 mt-1.5 hidden w-80 rounded-md border border-[rgba(255,255,255,0.08)] bg-surface-inverse px-3 py-2.5 text-tiny font-normal normal-case tracking-normal text-text-inverse shadow-linear-lg group-hover/help:block group-focus/help:block`}
      >
        {children}
      </span>
    </span>
  );
}
