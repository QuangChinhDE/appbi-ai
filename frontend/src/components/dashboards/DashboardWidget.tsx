'use client';

import React, { useEffect, useState } from 'react';
import type { DashboardChart, DashboardWidgetType } from '@/types/api';
import { renderTemplate } from '@/lib/dashboard-expression';

type Props = {
  widget: DashboardChart;
  params?: Record<string, any>;
  onParamChange?: (paramName: string, value: any) => void;
};

/**
 * Renders a non-chart widget. Switches on `widget_type`. Unknown types fall
 * back to a labeled placeholder so a future widget kind never crashes a
 * dashboard rendered by an older client.
 */
export function DashboardWidget({ widget, params = {}, onParamChange }: Props) {
  const type: DashboardWidgetType = (widget.widget_type ?? 'chart') as DashboardWidgetType;
  const cfg = widget.widget_config ?? {};

  switch (type) {
    case 'text':
      return <TextWidget config={cfg} params={params} />;
    case 'countdown':
      return <CountdownWidget config={cfg} />;
    case 'image':
      return <ImageWidget config={cfg} />;
    case 'shape':
      return <ShapeWidget config={cfg} />;
    case 'parameter_switcher':
      return (
        <ParameterSwitcherWidget
          config={cfg}
          value={params[cfg.paramName ?? '']}
          onChange={(v) => onParamChange?.(cfg.paramName ?? '', v)}
        />
      );
    default:
      return (
        <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 text-xs text-text-tertiary">
          Unknown widget: {String(type)}
        </div>
      );
  }
}

function TextWidget({ config, params }: { config: any; params: Record<string, any> }) {
  const rendered = renderTemplate(String(config.template ?? ''), params);
  const align = (config.align ?? 'left') as 'left' | 'center' | 'right';
  const fontSize = Number(config.fontSize ?? 14);
  const color = config.color || undefined;
  const fontWeight = config.bold ? 600 : 400;
  return (
    <div
      className="h-full w-full overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4"
      style={{ textAlign: align, color, fontSize, fontWeight }}
    >
      <div className="whitespace-pre-wrap break-words">{rendered}</div>
    </div>
  );
}

function CountdownWidget({ config }: { config: any }) {
  const target = String(config.target ?? '');
  const label = String(config.label ?? '');
  const accent = config.accent || '#facc15';
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // tick is read so the component re-renders every second
  void tick;
  const t = new Date(target).getTime();
  const now = Date.now();
  const diff = Number.isFinite(t) ? t - now : 0;
  const positive = diff > 0;
  const totalSeconds = Math.max(0, Math.floor(diff / 1000));
  const days = Math.floor(totalSeconds / (60 * 60 * 24));
  const hours = Math.floor((totalSeconds % (60 * 60 * 24)) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <div
      className="flex h-full w-full items-center justify-center rounded-xl border bg-surface-1 p-4"
      style={{ borderColor: accent, borderWidth: 2 }}
    >
      <div className="text-center">
        {label && (
          <div
            className="text-xs font-bold uppercase tracking-[0.24em]"
            style={{ color: accent }}
          >
            {label}
          </div>
        )}
        {!positive ? (
          <div className="mt-2 text-2xl font-semibold text-text-primary">Đã kết thúc</div>
        ) : (
          <div className="mt-2 flex items-baseline justify-center gap-2 text-text-primary">
            <span className="text-3xl font-bold tabular-nums" style={{ color: accent }}>
              {days}
            </span>
            <span className="text-xs uppercase tracking-widest text-text-tertiary">ngày</span>
            <span className="text-3xl font-bold tabular-nums" style={{ color: accent }}>
              {pad(hours)}:{pad(minutes)}:{pad(seconds)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ImageWidget({ config }: { config: any }) {
  const url = String(config.url ?? '');
  const fit = (config.fit ?? 'contain') as 'contain' | 'cover';
  const alt = String(config.alt ?? '');
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 text-xs text-text-tertiary">
        Image URL not set
      </div>
    );
  }
  return (
    <div className="h-full w-full overflow-hidden rounded-xl bg-surface-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className="h-full w-full" style={{ objectFit: fit }} />
    </div>
  );
}

function ShapeWidget({ config }: { config: any }) {
  const kind = (config.kind ?? 'rect') as 'rect' | 'line' | 'divider';
  const color = config.color || '#94a3b8';
  const radius = Number(config.radius ?? 8);
  if (kind === 'line' || kind === 'divider') {
    return (
      <div className="flex h-full w-full items-center">
        <div className="h-px w-full" style={{ background: color }} />
      </div>
    );
  }
  return (
    <div
      className="h-full w-full"
      style={{ background: color, borderRadius: radius, opacity: config.opacity ?? 0.85 }}
    />
  );
}

function ParameterSwitcherWidget({
  config,
  value,
  onChange,
}: {
  config: any;
  value: any;
  onChange?: (v: any) => void;
}) {
  const label = String(config.label ?? '');
  const options: Array<{ label: string; value: string }> = Array.isArray(config.options)
    ? config.options
    : [];
  const layout = (config.layout ?? 'tabs') as 'tabs' | 'dropdown';
  return (
    <div className="flex h-full w-full flex-col gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      {label && (
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-tertiary">
          {label}
        </div>
      )}
      {layout === 'dropdown' ? (
        <select
          value={value ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5 text-sm"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => onChange?.(o.value)}
              className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                value === o.value
                  ? 'bg-brand text-white'
                  : 'border border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:bg-surface-3'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
