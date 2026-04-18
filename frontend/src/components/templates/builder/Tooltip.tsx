'use client';

import React, { useState, useRef, useCallback } from 'react';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom';
}

export function Tooltip({ content, children, position = 'bottom' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), 400);
  }, []);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <span
          className={`absolute z-50 whitespace-normal rounded-md bg-surface-inverse px-2.5 py-1.5 text-[11px] leading-snug text-text-secondary shadow-lg pointer-events-none ${
            position === 'top'
              ? 'bottom-full left-1/2 -translate-x-1/2 mb-1.5'
              : 'top-full left-1/2 -translate-x-1/2 mt-1.5'
          }`}
          style={{ minWidth: 160, maxWidth: 280 }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
