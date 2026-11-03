'use client';

import React, { useEffect, useRef, useState } from 'react';

export type Device = 'desktop' | 'tablet' | 'mobile';
export const DEVICE_WIDTH: Record<Device, number> = { desktop: 1440, tablet: 820, mobile: 390 };

/**
 * Renders its child at the device's real CSS width (so the report's own breakpoints
 * apply) and scales it down visually when the canvas is narrower.
 */
export function DevicePreview({ device, children }: { device: Device; children: React.ReactNode }) {
  const canvas = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 1200, h: 800 });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const width = DEVICE_WIDTH[device];
  const pad = device === 'desktop' ? 0 : 24;
  const scale = Math.min(1, (box.w - pad * 2) / width);
  const height = Math.max(320, (box.h - pad * 2) / scale);

  return (
    <div ref={canvas} className="relative h-full w-full overflow-hidden bg-surface-2" data-testid="device-preview" data-device={device}>
      <div
        className={device === 'desktop' ? 'absolute left-0 top-0' : 'absolute left-1/2 top-6 overflow-hidden rounded-[18px] shadow-xl ring-1 ring-black/10'}
        style={{
          width,
          height,
          transform: device === 'desktop' ? `scale(${scale})` : `translateX(-50%) scale(${scale})`,
          transformOrigin: device === 'desktop' ? 'top left' : 'top center',
          background: '#fff',
        }}
      >
        {children}
      </div>
    </div>
  );
}
