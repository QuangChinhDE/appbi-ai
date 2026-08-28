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
    case 'section_header':
      return <SectionHeaderWidget config={cfg} />;
    case 'callout':
      return <CalloutWidget config={cfg} />;
    case 'hero_strip':
      return <HeroStripWidget config={cfg} />;
    case 'html_fragment':
      return <HtmlFragmentWidget config={cfg} />;
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
  //
  // Vertical placement: a one-line heading should sit centered in the band, but a
  // longer note must show ALL of its text and scroll — never get clipped. The old
  // `items-center` did the opposite: once the text was taller than the band it
  // centered the block so the TOP overflowed out of the scroll area and couldn't
  // be reached (the "chữ bị cắt / không thấy hết" report). The scroll-safe pattern
  // is a flex COLUMN with the content using `my-auto`: auto margins center it when
  // it fits, and collapse to 0 (content pinned to top, fully scrollable) when it
  // overflows. `break-words` (in renderMarkdown) already wraps long lines.
  return (
    <div
      // Theme hook — text widgets follow the report's body type scale.
      className="dashboard-widget-text flex h-full w-full flex-col overflow-auto px-4 py-2.5"
      style={{ textAlign: align, color, fontSize, fontWeight }}
    >
      <div className="my-auto w-full min-h-0">{renderMarkdown(rendered)}</div>
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

// ── Report "element" widgets (decorative inserts, Modern/SaaS skin) ──────────
// These are frameless (they draw their own styling) and pull the report accent
// from the theme CSS var so they match whichever skin/preset is active.
const ACCENT = 'var(--dashboard-accent, #5b5bd6)';

/**
 * A block of the imported source that AppBI has no native visual for, kept as
 * inert markup so the report does not lose it.
 *
 * The markup is sanitized on the server, at the point it is STORED, so what
 * arrives here is already an allow-listed subset with no scripts, no handlers
 * and no external references. This component does not re-sanitize -- doing so
 * in the browser would imply the server's pass was optional, and a client-side
 * filter is not a security boundary anyway.
 *
 * It renders scaled-to-fit rather than clipped: the fragment was captured at
 * the source page's width, and a tile is usually narrower. Clipping would show
 * the left third of a card and read as a rendering bug.
 */
function HtmlFragmentWidget({ config }: { config: any }) {
  const { t } = useI18n();
  const html = String(config.html ?? '');
  const degraded: string[] = Array.isArray(config.degraded) ? config.degraded.map(String) : [];
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [showNotes, setShowNotes] = useState(false);

  // Measure after paint and on every resize: the fragment carries its own
  // pixel widths, so the only way to know the scale is to lay it out and look.
  useEffect(() => {
    const host = hostRef.current;
    const inner = innerRef.current;
    if (!host || !inner) return;
    const measure = () => {
      const available = host.clientWidth;
      const natural = inner.scrollWidth;
      if (!available || !natural) return;
      // Only ever shrink. Blowing a small fragment up to tile width would
      // magnify its pixel grid and look worse than leaving it alone.
      setScale(natural > available ? Math.max(0.35, available / natural) : 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [html]);

  if (!html) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 text-xs text-text-tertiary">
        {t('dashboards.widget.fragmentEmpty')}
      </div>
    );
  }

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden">
      <div
        ref={innerRef}
        // `w-max` only while the fragment is being shrunk: it is what lets the
        // element keep its natural width so the scale factor means something.
        // Applied at scale 1 it makes a fragment that already fits report a
        // shrink-to-fit width instead of filling the tile, and the rounding
        // leaves a scrollbar along the bottom of every card.
        className={`dashboard-html-fragment ${scale === 1 ? 'w-full' : 'w-max'}`}
        style={{ transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: 'top left' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {degraded.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowNotes((v) => !v)}
            className="absolute right-1 top-1 rounded-md bg-surface-2/90 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary ring-1 ring-[rgb(var(--border-strong))] hover:text-text-primary"
            title={t('dashboards.widget.fragmentDegradedTitle')}
          >
            {t('dashboards.widget.fragmentDegradedBadge')}
          </button>
          {showNotes && (
            <div className="absolute right-1 top-7 z-10 max-w-[min(20rem,90%)] rounded-lg bg-surface-1 p-2.5 text-[11px] leading-relaxed text-text-secondary shadow-lg ring-1 ring-[rgb(var(--border-strong))]">
              <ul className="list-disc space-y-1 pl-3.5">
                {degraded.map((note, i) => <li key={i}>{note}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SectionHeaderWidget({ config }: { config: any }) {
  const eyebrow = String(config.eyebrow ?? '');
  const title = String(config.title ?? '');
  const subtitle = String(config.subtitle ?? '');
  // `dashboard-section` is the theme hook for the section surface token: the
  // header renders as a BAND that introduces the tiles under it, rather than as
  // one more loose card among them. That band is the missing depth level
  // between the page and the cards — with only one surface depth a report reads
  // as scattered tiles no matter how well each tile is styled.
  return (
    <div className="dashboard-section flex h-full w-full flex-col justify-center gap-1 px-1">
      <div className="flex items-center gap-2.5">
        <span className="h-4 w-1 shrink-0 rounded-full" style={{ background: ACCENT }} />
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: ACCENT }}>
              {eyebrow}
            </div>
          )}
          {title && <div className="dashboard-section-title truncate text-[15px] font-semibold leading-tight text-text-primary">{title}</div>}
        </div>
      </div>
      {subtitle && <div className="dashboard-chart-subtitle ml-3.5 truncate text-xs text-text-tertiary">{subtitle}</div>}
    </div>
  );
}

function HeroStripWidget({ config }: { config: any }) {
  // `headline`/`subhead` is what the server normalizes a hero strip to; the
  // older `title`/`subtitle` shape is still in stored dashboards. Reading only
  // the second rendered an imported hero as an empty gradient box with its text
  // sitting unused in the row -- the same key mismatch that made section
  // headers and callouts come up blank.
  const title = String(config.headline ?? config.title ?? '');
  const subtitle = String(config.subhead ?? config.subtitle ?? '');
  const metric = String(config.metric ?? '');
  const metricLabel = String(config.metricLabel ?? '');
  return (
    <div
      className="relative flex h-full w-full items-center justify-between gap-4 overflow-hidden rounded-2xl px-5 py-4"
      style={{
        background: `linear-gradient(120deg, color-mix(in srgb, ${ACCENT} 14%, transparent), transparent 70%)`,
        border: `1px solid color-mix(in srgb, ${ACCENT} 18%, transparent)`,
      }}
    >
      <span className="absolute left-0 top-0 h-full w-1" style={{ background: ACCENT }} />
      <div className="min-w-0">
        {title && <div className="truncate text-lg font-bold text-text-primary">{title}</div>}
        {subtitle && <div className="mt-0.5 truncate text-xs text-text-secondary">{subtitle}</div>}
      </div>
      {metric && (
        <div className="shrink-0 text-right">
          <div className="text-2xl font-bold tabular-nums" style={{ color: ACCENT }}>{metric}</div>
          {metricLabel && <div className="text-[10px] uppercase tracking-wide text-text-tertiary">{metricLabel}</div>}
        </div>
      )}
    </div>
  );
}

function CalloutWidget({ config }: { config: any }) {
  const title = String(config.title ?? '');
  const text = String(config.text ?? '');
  const tone = String(config.tone ?? 'accent') as 'accent' | 'good' | 'warn' | 'bad';
  const color =
    tone === 'good' ? 'var(--dashboard-good, #12b886)'
    : tone === 'warn' ? 'var(--dashboard-warn, #c77d12)'
    : tone === 'bad' ? 'var(--dashboard-bad, #e5604d)'
    : ACCENT;
  return (
    <div
      className="flex h-full w-full gap-3 overflow-auto rounded-xl px-4 py-3"
      style={{
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
      }}
    >
      <span className="w-1 shrink-0 rounded-full" style={{ background: color }} />
      <div className="min-w-0">
        {title && <div className="text-[13px] font-semibold text-text-primary">{title}</div>}
        {text && <div className="mt-0.5 text-xs leading-relaxed text-text-secondary">{text}</div>}
      </div>
    </div>
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
