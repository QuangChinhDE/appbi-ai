'use client';

import React, { useEffect, useState } from 'react';
import type { DashboardChart, DashboardWidgetType } from '@/types/api';
import { renderTemplate } from '@/lib/dashboard-expression';
import { renderMarkdown } from '@/lib/dashboard-markdown';
import { useI18n } from '@/providers/LanguageProvider';

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
  const { t } = useI18n();
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
          {t('dashboards.widget.unknownType')}: {String(type)}
        </div>
      );
  }
}

function TextWidget({ config, params }: { config: any; params: Record<string, any> }) {
  const source = String(config.template ?? config.markdown ?? config.text ?? '');
  const rendered = renderTemplate(source, params);
  const align = (config.align ?? 'left') as 'left' | 'center' | 'right';
  const fontSize = Number(config.fontSize ?? 14);
  const color = config.color || undefined;
  const fontWeight = config.bold ? 600 : 400;
  // Border + bg + radius come from the outer tile wrapper (DashboardGrid /
  // DashboardCanvas) so widgets and charts share the same card chrome.
  // Only the inner padding + typography lives here.
  return (
    <div
      className="h-full w-full overflow-auto p-4"
      style={{ textAlign: align, color, fontSize, fontWeight }}
    >
      {renderMarkdown(rendered)}
    </div>
  );
}

function CountdownWidget({ config }: { config: any }) {
  const { t: translate } = useI18n();
  const target = String(config.target ?? config.target_date ?? config.targetDate ?? '');
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
  // Outer tile (DashboardGrid) provides border+bg+radius. Countdown keeps
  // its accent border as an INNER ring so the colored signal stays clear
  // without doubling the chrome.
  return (
    <div
      className="flex h-full w-full items-center justify-center p-4"
      style={{ boxShadow: `inset 0 0 0 2px ${accent}`, borderRadius: 'inherit' }}
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
          <div className="mt-2 text-2xl font-semibold text-text-primary">{translate('dashboards.countdown.ended')}</div>
        ) : (
          <div className="mt-2 flex items-baseline justify-center gap-2 text-text-primary">
            <span className="text-3xl font-bold tabular-nums" style={{ color: accent }}>
              {days}
            </span>
            <span className="text-xs uppercase tracking-widest text-text-tertiary">{translate('dashboards.countdown.days')}</span>
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
  const { t } = useI18n();
  const url = String(config.url ?? '');
  const fit = (config.fit ?? 'contain') as 'contain' | 'cover';
  const alt = String(config.alt ?? '');
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-2 text-xs text-text-tertiary">
        {t('dashboards.image.urlNotSet')}
      </div>
    );
  }
  // Outer tile handles border + radius. Image just fills the canvas.
  return (
    <div className="h-full w-full overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className="h-full w-full" style={{ objectFit: fit }} />
    </div>
  );
}

function ShapeWidget({ config }: { config: any }) {
  const rawKind = String(config.kind ?? config.shape ?? 'rect').toLowerCase();
  const kind = (rawKind === 'rectangle' ? 'rect' : rawKind) as 'rect' | 'circle' | 'line' | 'divider';
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
      className="dashboard-tile h-full w-full"
      style={{ background: color, borderRadius: kind === 'circle' ? '9999px' : radius, opacity: config.opacity ?? 0.85 }}
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
    <div className="dashboard-tile flex h-full w-full flex-col gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
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
