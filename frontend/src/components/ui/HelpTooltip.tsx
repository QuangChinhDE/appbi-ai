'use client';

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

/**
 * usePortalTooltip — anchored tooltip rendered into document.body so it
 * escapes ancestor `overflow:hidden` containers (table headers, panel bars).
 * Updates position on hover/focus and on scroll/resize.
 */
function usePortalTooltip(side: 'left' | 'right') {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; align: 'left' | 'right' } | null>(null);

  const recompute = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setCoords({
      top: rect.bottom + 6,
      left: side === 'right' ? rect.right : rect.left,
      align: side,
    });
  }, [side]);

  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    const onMove = () => recompute();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, recompute]);

  const bind = {
    ref: triggerRef,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
  };

  return { open, coords, bind };
}

/**
 * HelpTooltip — small info icon that shows a plain-text tooltip on hover or focus.
 */
export function HelpTooltip({ text }: { text: string }) {
  const { open, coords, bind } = usePortalTooltip('left');
  return (
    <>
      <span
        {...bind}
        tabIndex={0}
        role="button"
        aria-label="Show help"
        className="group/help ml-1 inline-flex items-center rounded-full align-middle outline-none"
      >
        <Info className="h-3.5 w-3.5 cursor-help text-text-quaternary transition-colors group-hover/help:text-brand group-focus/help:text-brand" />
      </span>
      {open && coords && typeof document !== 'undefined' && createPortal(
        <span
          style={{ position: 'fixed', top: coords.top, left: coords.left, zIndex: 9999 }}
          className="pointer-events-none w-72 rounded-md bg-surface-inverse px-2.5 py-2 text-tiny font-normal normal-case tracking-normal text-text-inverse shadow-linear-lg"
        >
          {text}
        </span>,
        document.body,
      )}
    </>
  );
}

/**
 * HelpTooltipRich — info icon with rich (JSX) tooltip content.
 * Use when the tooltip needs formatting: bold labels, bullet lists, etc.
 *
 * Rendered via React Portal so the tooltip is not clipped by an ancestor
 * with `overflow:hidden` (a frequent issue inside scrollable panels).
 */
export function HelpTooltipRich({
  children,
  side = 'left',
}: {
  children: React.ReactNode;
  side?: 'left' | 'right';
}) {
  const { open, coords, bind } = usePortalTooltip(side);
  return (
    <>
      <span
        {...bind}
        tabIndex={0}
        role="button"
        aria-label="Show help"
        className="group/help ml-1 inline-flex items-center rounded-full align-middle outline-none"
      >
        <Info className="h-3.5 w-3.5 cursor-help text-text-quaternary transition-colors group-hover/help:text-text-secondary group-focus/help:text-brand" />
      </span>
      {open && coords && typeof document !== 'undefined' && createPortal(
        <span
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.align === 'left' ? coords.left : undefined,
            right: coords.align === 'right' ? window.innerWidth - coords.left : undefined,
            zIndex: 9999,
          }}
          className="pointer-events-none w-80 rounded-md border border-[rgb(var(--border-strong))] bg-surface-inverse px-3 py-2.5 text-tiny font-normal normal-case tracking-normal text-text-inverse shadow-linear-lg"
        >
          {children}
        </span>,
        document.body,
      )}
    </>
  );
}
