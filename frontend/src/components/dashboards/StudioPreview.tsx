'use client';

/**
 * Studio preview — the whole report, at a device width, before and after an AI
 * design, over everything else (the AI panel included).
 *
 * Each frame is the builder route itself (`?studio=preview`) inside an iframe
 * whose width IS the device width, so breakpoints, the tablet/phone derivation
 * and every renderer are the real ones. The frame is then scaled down only
 * visually (a CSS transform on the iframe element) to fit the screen; the
 * report's coordinates, and the canvas behind this overlay, never change.
 * Nothing is saved from here: Apply/Discard are the same actions as the panel's.
 */
import React from 'react';
import { Columns2, Monitor, Smartphone, Tablet, X } from 'lucide-react';

import { isStudioMessage, type StudioMessage, type StudioPreviewState } from '@/lib/studio/preview-mode';
import { useI18n } from '@/providers/LanguageProvider';

export type StudioDevice = 'desktop' | 'tablet' | 'phone';
export type StudioView = 'after' | 'before' | 'compare';

export const STUDIO_DEVICE_WIDTH: Record<StudioDevice, number> = { desktop: 1440, tablet: 820, phone: 390 };

function PreviewFrame({ dashboardId, frame, state, deviceWidth, maxWidth, label, onSettled }: {
  dashboardId: number;
  frame: string;
  state: StudioPreviewState;
  deviceWidth: number;
  maxWidth: number;
  label: string;
  onSettled?: (frame: string, settled: boolean) => void;
}) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(700);
  const [settled, setSettled] = React.useState(false);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const send = React.useCallback(() => {
    ref.current?.contentWindow?.postMessage(
      { type: 'appbi-studio-state', frame, state: stateRef.current } satisfies StudioMessage,
      window.location.origin,
    );
  }, [frame]);

  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isStudioMessage(e) || e.source !== ref.current?.contentWindow) return;
      const m = e.data as StudioMessage;
      if (m.frame !== frame) return;
      if (m.type === 'appbi-studio-ready') send();
      if (m.type === 'appbi-studio-height') {
        setHeight(Math.max(300, m.height));
        setSettled(m.settled);
        onSettled?.(frame, m.settled);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, send, onSettled]);

  // A new state (another AI turn, a toggled view) goes to the live frame.
  React.useEffect(() => { send(); }, [state, send]);

  const scale = Math.min(1, maxWidth / deviceWidth);
  const src = `/dashboards/${dashboardId}?studio=preview&frame=${encodeURIComponent(frame)}`;
  return (
    <figure className="flex min-w-0 flex-col items-center gap-2" data-studio-frame={frame} data-studio-settled={settled ? 'true' : 'false'}>
      <figcaption className="text-[12px] font-[560] text-text-secondary">
        {label} · {deviceWidth}px{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}
      </figcaption>
      <div
        className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm"
        style={{ width: deviceWidth * scale, height: height * scale }}
      >
        <iframe
          ref={ref}
          src={src}
          title={`${label} ${deviceWidth}px`}
          className="block border-0"
          style={{ width: deviceWidth, height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
        />
      </div>
    </figure>
  );
}

export function StudioPreview({ dashboardId, before, after, hasPending, onApply, onDiscard, onClose }: {
  dashboardId: number;
  before: StudioPreviewState;
  after: StudioPreviewState;
  hasPending: boolean;
  onApply?: () => void;
  onDiscard?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [device, setDevice] = React.useState<StudioDevice>('desktop');
  const [view, setView] = React.useState<StudioView>(hasPending ? 'compare' : 'after');
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = React.useState(1200);

  React.useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyWidth(el.clientWidth));
    ro.observe(el);
    setBodyWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const width = STUDIO_DEVICE_WIDTH[device];
  const frames: Array<{ frame: string; state: StudioPreviewState; label: string }> = view === 'compare'
    ? [{ frame: 'before', state: before, label: t('dashboards.studio.before') },
       { frame: 'after', state: after, label: t('dashboards.studio.after') }]
    : [{ frame: view, state: view === 'before' ? before : after, label: t(`dashboards.studio.${view}`) }];
  const gap = 24;
  const perFrame = Math.max(200, (bodyWidth - gap * (frames.length + 1)) / frames.length);

  const deviceButton = (d: StudioDevice, Icon: typeof Monitor) => (
    <button
      type="button"
      key={d}
      data-testid={`studio-device-${d}`}
      aria-pressed={device === d}
      onClick={() => setDevice(d)}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-[560] transition-colors ${
        device === d ? 'bg-brand text-white' : 'text-text-secondary hover:bg-surface-2'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {t(`dashboards.studio.device.${d}`)}
    </button>
  );
  const viewButton = (v: StudioView) => (
    <button
      type="button"
      key={v}
      data-testid={`studio-view-${v}`}
      aria-pressed={view === v}
      disabled={v !== 'after' && !hasPending}
      onClick={() => setView(v)}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-[560] transition-colors disabled:opacity-40 ${
        view === v ? 'bg-surface-inverse text-white' : 'text-text-secondary hover:bg-surface-2'
      }`}
    >
      {v === 'compare' ? <Columns2 className="h-3.5 w-3.5" /> : null}
      {t(`dashboards.studio.${v}`)}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-surface-0/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t('dashboards.studio.title')} data-testid="studio-preview">
      <div className="flex flex-wrap items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2">
        <span className="mr-2 text-[13px] font-[600] text-text-primary">{t('dashboards.studio.title')}</span>
        <div className="flex items-center gap-1 rounded-lg border border-[rgb(var(--border-line))] p-0.5">
          {deviceButton('desktop', Monitor)}
          {deviceButton('tablet', Tablet)}
          {deviceButton('phone', Smartphone)}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-[rgb(var(--border-line))] p-0.5">
          {viewButton('after')}
          {viewButton('before')}
          {viewButton('compare')}
        </div>
        <span className="text-[12px] text-text-tertiary">
          {hasPending ? t('dashboards.studio.pendingNote') : t('dashboards.studio.noPendingNote')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {hasPending && onDiscard ? (
            <button type="button" data-testid="studio-discard" onClick={onDiscard}
              className="h-8 rounded-md border border-[rgb(var(--border-line))] px-3 text-[12px] font-[560] text-text-secondary hover:bg-surface-2">
              {t('dashboards.studio.discard')}
            </button>
          ) : null}
          {hasPending && onApply ? (
            <button type="button" data-testid="studio-apply" onClick={onApply}
              className="h-8 rounded-md bg-brand px-3 text-[12px] font-[600] text-white hover:bg-brand/90">
              {t('dashboards.studio.apply')}
            </button>
          ) : null}
          <button type="button" data-testid="studio-close" onClick={onClose} aria-label={t('dashboards.studio.close')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-2">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div ref={bodyRef} className="flex-1 overflow-auto">
        <div className="flex items-start justify-center py-6" style={{ gap }}>
          {frames.map((f) => (
            <PreviewFrame
              key={`${f.frame}-${device}`}
              dashboardId={dashboardId}
              frame={f.frame}
              state={f.state}
              deviceWidth={width}
              maxWidth={perFrame}
              label={f.label}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
