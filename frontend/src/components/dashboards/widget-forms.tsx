'use client';

/**
 * The content forms of every native report element — one set, used by the
 * inspector panel and by the edit dialog, so an element is edited the same
 * way wherever it is opened.
 */
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { DashboardWidgetType } from '@/types/api';
import { useI18n } from '@/providers/LanguageProvider';
import { useReportFindings } from '@/lib/report-evidence';
import { renderFindingSentence } from '@/lib/report-findings';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What an element type is called, for toasts, the inspector and the outline. */
export function widgetTypeLabel(t: Translate, type: string | null | undefined): string {
  const key: Record<string, string> = {
    text: 'dashboards.widgetEdit.typeText',
    countdown: 'dashboards.widgetEdit.typeCountdown',
    image: 'dashboards.widgetEdit.typeImage',
    shape: 'dashboards.widgetEdit.typeShape',
    parameter_switcher: 'dashboards.widgetEdit.typeParameterSwitcher',
    section_header: 'dashboards.widgetEdit.typeSectionHeader',
    callout: 'dashboards.widgetEdit.typeCallout',
    hero_strip: 'dashboards.widgetEdit.typeHeroStrip',
    narrative: 'dashboards.addElement.insight',
    html_fragment: 'dashboards.widgetEdit.typeHtml',
    slicer: 'dashboards.addSlicer.menu',
    chart: 'dashboards.addElement.chart',
  };
  return key[String(type ?? 'chart')] ? t(key[String(type ?? 'chart')]) : String(type ?? '');
}

export interface ReportFormContext {
  reportName?: string;
  reportDescription?: string | null;
  /** Charts on this page, for choosing what an insight is about. */
  tileTitle?: (tileId: number) => string;
}

/** The form for one element's content. `set` changes one key; `setConfig` the whole config. */
export function WidgetConfigForm({
  type, config, set, setConfig, context,
}: {
  type: DashboardWidgetType | string;
  config: Record<string, any>;
  set: (key: string, value: any) => void;
  setConfig: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  context?: ReportFormContext;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      {type === 'text' && <TextWidgetForm config={config} set={set} />}
      {type === 'countdown' && <CountdownWidgetForm config={config} set={set} />}
      {type === 'image' && <ImageWidgetForm config={config} set={set} />}
      {type === 'shape' && <ShapeWidgetForm config={config} set={set} />}
      {type === 'parameter_switcher' && <ParameterSwitcherForm config={config} setConfig={setConfig} />}
      {type === 'section_header' && <SectionHeaderForm config={config} set={set} />}
      {type === 'hero_strip' && <ReportHeaderForm config={config} set={set} setConfig={setConfig} context={context} />}
      {type === 'callout' && <CalloutForm config={config} set={set} />}
      {type === 'narrative' && <NarrativeForm config={config} set={set} context={context} />}
      {type === 'html_fragment' && (
        <p className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-[12px] text-text-tertiary">
          {t('dashboards.widgetEdit.htmlReadOnly')}
        </p>
      )}
      {(type === 'text' || type === 'countdown' || type === 'image' || type === 'narrative') && (
        <label className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] pt-3 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            checked={config.transparentBackground === true}
            onChange={(e) => set('transparentBackground', e.target.checked)}
          />
          {t('dashboards.widgetEdit.transparentBackground')}
        </label>
      )}
    </div>
  );
}

/** The report header: title/description default to the report's own; period
 *  and context are computed from the data and the active filters; a headline
 *  is a finding, never a typed number. */
export function ReportHeaderForm({
  config, set, setConfig, context,
}: {
  config: any;
  set: (k: string, v: any) => void;
  setConfig: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  context?: ReportFormContext;
}) {
  const { t } = useI18n();
  const title = config.title ?? config.headline ?? '';
  const description = config.description ?? config.subhead ?? '';
  const variant = config.variant ?? 'banner';
  return (
    <>
      <Field label={t('dashboards.widgetEdit.headerEyebrow')} hint={t('dashboards.widgetEdit.headerEyebrowHint')}>
        <input className={inputClass} value={config.eyebrow ?? ''} onChange={(e) => set('eyebrow', e.target.value)} />
      </Field>
      <Field label={t('dashboards.widgetEdit.headingTitle')} hint={t('dashboards.widgetEdit.headerTitleHint')}>
        <input className={inputClass} value={title} placeholder={context?.reportName ?? ''}
          onChange={(e) => setConfig((p) => { const n: Record<string, any> = { ...p, title: e.target.value }; delete n.headline; return n; })} />
      </Field>
      <Field label={t('dashboards.widgetEdit.headerDescription')} hint={t('dashboards.widgetEdit.headerDescriptionHint')}>
        <textarea className={inputClass} rows={2} value={description} placeholder={context?.reportDescription ?? ''}
          onChange={(e) => setConfig((p) => { const n: Record<string, any> = { ...p, description: e.target.value }; delete n.subhead; return n; })} />
      </Field>
      <Field label={t('dashboards.widgetEdit.headerVariant')}>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup">
          {(['banner', 'split', 'minimal'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={variant === v} data-testid={`header-variant-${v}`}
              onClick={() => set('variant', v)}
              className={`rounded-md border px-2 py-1.5 text-[12px] ${variant === v ? 'border-brand bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'}`}>
              {t(`dashboards.widgetEdit.headerVariant_${v}`)}
            </button>
          ))}
        </div>
      </Field>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <input type="checkbox" checked={config.showPeriod !== false} onChange={(e) => set('showPeriod', e.target.checked)} />
          {t('dashboards.widgetEdit.headerShowPeriod')}
        </label>
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <input type="checkbox" checked={config.showContext !== false} onChange={(e) => set('showContext', e.target.checked)} />
          {t('dashboards.widgetEdit.headerShowContext')}
        </label>
      </div>
      <FindingPicker
        label={t('dashboards.widgetEdit.headerFinding')}
        hint={t('dashboards.widgetEdit.headerFindingHint')}
        selected={config.finding ? [config.finding] : []}
        multiple={false}
        onChange={(keys) => set('finding', keys[0] ?? '')}
        context={context}
      />
      {(config.metric || config.metricLabel) ? (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-text-secondary" data-testid="header-static-metric">
          <div>{t('dashboards.widgetEdit.headerStaticMetric', { value: `${config.metric ?? ''} ${config.metricLabel ?? ''}`.trim() })}</div>
          <button type="button" className="mt-1.5 text-[12px] font-[510] text-brand hover:underline"
            onClick={() => setConfig((p) => { const n = { ...p }; delete n.metric; delete n.metricLabel; return n; })}>
            {t('dashboards.widgetEdit.headerRemoveStatic')}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Findings currently computed on this page, as sentences, grouped by chart. */
function FindingPicker({
  label, hint, selected, onChange, multiple, context,
}: {
  label: string;
  hint?: string;
  selected: string[];
  onChange: (keys: string[]) => void;
  multiple: boolean;
  context?: ReportFormContext;
}) {
  const { t, locale } = useI18n() as { t: Translate; locale?: string };
  const { findings } = useReportFindings();
  const byTile = new Map<number, { key: string; text: string }[]>();
  findings.forEach((f, key) => {
    const list = byTile.get(f.tileId) ?? [];
    list.push({ key, text: renderFindingSentence(f, t, locale) });
    byTile.set(f.tileId, list);
  });
  const missing = selected.filter((k) => !findings.has(k));
  return (
    <Field label={label} hint={hint}>
      <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-[rgb(var(--border-line))] p-2" data-testid="finding-picker">
        {!multiple && (
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            <input type="radio" checked={selected.length === 0} onChange={() => onChange([])} />
            {t('dashboards.widgetEdit.findingNone')}
          </label>
        )}
        {byTile.size === 0 && (
          <p className="text-[12px] text-text-tertiary">{t('dashboards.widgetEdit.findingEmpty')}</p>
        )}
        {[...byTile.entries()].map(([tileId, list]) => (
          <div key={tileId}>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-quaternary">
              {context?.tileTitle?.(tileId) ?? `#${tileId}`}
            </div>
            {list.map((it) => (
              <label key={it.key} className="flex items-start gap-2 py-0.5 text-[12px] leading-snug text-text-secondary">
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  className="mt-0.5"
                  data-finding-option={it.key}
                  checked={selected.includes(it.key)}
                  onChange={(e) => {
                    if (!multiple) { onChange([it.key]); return; }
                    const next = e.target.checked ? [...selected, it.key] : selected.filter((k) => k !== it.key);
                    onChange(next.slice(0, 8));
                  }}
                />
                <span>{it.text}</span>
              </label>
            ))}
          </div>
        ))}
        {missing.length > 0 && (
          <p className="text-[11px] text-text-tertiary">{t('dashboards.widgetEdit.findingNotNow', { count: missing.length })}</p>
        )}
      </div>
    </Field>
  );
}

/** A narrative block: the sentences are findings (live); the author's own
 *  words are optional and shown as static text. */
export function NarrativeForm({ config, set, context }: { config: any; set: (k: string, v: any) => void; context?: ReportFormContext }) {
  const { t } = useI18n();
  const items: { finding: string }[] = Array.isArray(config.items) ? config.items : [];
  return (
    <>
      <Field label={t('dashboards.widgetEdit.narrativeVariant')}>
        <select className={inputClass} value={config.variant ?? 'summary'} onChange={(e) => set('variant', e.target.value)}>
          {(['headline', 'summary', 'takeaway', 'callout', 'chapter'] as const).map((v) => (
            <option key={v} value={v}>{t(`dashboards.widgetEdit.narrative_${v}`)}</option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('dashboards.widgetEdit.eyebrow')}>
          <input className={inputClass} value={config.eyebrow ?? ''} onChange={(e) => set('eyebrow', e.target.value)} />
        </Field>
        <Field label={t('dashboards.widgetEdit.headingTitle')}>
          <input className={inputClass} value={config.title ?? ''} onChange={(e) => set('title', e.target.value)} />
        </Field>
      </div>
      <FindingPicker
        label={t('dashboards.widgetEdit.narrativeFindings')}
        hint={t('dashboards.widgetEdit.narrativeFindingsHint')}
        selected={items.map((i) => i.finding)}
        multiple
        onChange={(keys) => set('items', keys.map((finding) => ({ finding })))}
        context={context}
      />
      <Field label={t('dashboards.widgetEdit.narrativeProse')} hint={t('dashboards.widgetEdit.narrativeProseHint')}>
        <textarea className={inputClass} rows={3} value={config.prose ?? ''} onChange={(e) => set('prose', e.target.value)} />
      </Field>
    </>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-[510] text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1.5 text-[13px] text-text-primary focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand';

export function TextWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.template')} hint={t('dashboards.widgetEdit.templateHint')}>
        <textarea
          value={config.template ?? ''}
          onChange={(e) => set('template', e.target.value)}
          rows={5}
          className={inputClass}
          placeholder="Hello {{today()}}"
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('dashboards.widgetEdit.align')}>
          <select value={config.align ?? 'left'} onChange={(e) => set('align', e.target.value)} className={inputClass}>
            <option value="left">{t('dashboards.widgetEdit.alignLeft')}</option>
            <option value="center">{t('dashboards.widgetEdit.alignCenter')}</option>
            <option value="right">{t('dashboards.widgetEdit.alignRight')}</option>
          </select>
        </Field>
        <Field label={t('dashboards.widgetEdit.fontSize')}>
          <input
            type="number"
            min={10}
            max={72}
            value={config.fontSize ?? 14}
            onChange={(e) => set('fontSize', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.color')}>
          <input
            type="color"
            value={config.color ?? '#000000'}
            onChange={(e) => set('color', e.target.value)}
            className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1"
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-text-secondary">
        <input type="checkbox" checked={!!config.bold} onChange={(e) => set('bold', e.target.checked)} />
        {t('dashboards.widgetEdit.bold')}
      </label>
    </>
  );
}

export function CountdownWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  // Convert ISO ↔ datetime-local for input compatibility
  const targetIso: string = config.target ?? '';
  const localValue = (() => {
    if (!targetIso) return '';
    const d = new Date(targetIso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.label')}>
        <input
          type="text"
          value={config.label ?? ''}
          onChange={(e) => set('label', e.target.value)}
          className={inputClass}
          placeholder={t('dashboards.widgetEdit.countdownLabelPlaceholder')}
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.targetDateTime')}>
        <input
          type="datetime-local"
          value={localValue}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              set('target', '');
              return;
            }
            set('target', new Date(v).toISOString());
          }}
          className={inputClass}
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.accentColor')}>
        <input
          type="color"
          value={config.accent ?? '#facc15'}
          onChange={(e) => set('accent', e.target.value)}
          className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1"
        />
      </Field>
    </>
  );
}

export function ImageWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.imageUrl')} hint={t('dashboards.widgetEdit.imageUrlHint')}>
        <input
          type="url"
          value={config.url ?? ''}
          onChange={(e) => set('url', e.target.value)}
          className={inputClass}
          placeholder="https://…"
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.imageLink')} hint={t('dashboards.widgetEdit.imageLinkHint')}>
        <input
          type="url"
          value={config.link ?? ''}
          onChange={(e) => set('link', e.target.value)}
          className={inputClass}
          placeholder="https://…"
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.altText')}>
        <input
          type="text"
          value={config.alt ?? ''}
          onChange={(e) => set('alt', e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label={t('dashboards.widgetEdit.fit')}>
        <select value={config.fit ?? 'contain'} onChange={(e) => set('fit', e.target.value)} className={inputClass}>
          <option value="contain">{t('dashboards.widgetEdit.fitContain')}</option>
          <option value="cover">{t('dashboards.widgetEdit.fitCover')}</option>
        </select>
      </Field>
      {config.url ? (
        <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={config.url} alt={config.alt ?? ''} className="max-h-48 w-full" style={{ objectFit: config.fit ?? 'contain' }} />
        </div>
      ) : null}
    </>
  );
}

export function ShapeWidgetForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.kind')}>
        <select value={config.kind ?? 'rect'} onChange={(e) => set('kind', e.target.value)} className={inputClass}>
          <option value="rect">{t('dashboards.widgetEdit.kindRectangle')}</option>
          <option value="circle">{t('dashboards.widgetEdit.kindCircle')}</option>
          <option value="line">{t('dashboards.widgetEdit.kindLine')}</option>
          <option value="divider">{t('dashboards.widgetEdit.kindDivider')}</option>
        </select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('dashboards.widgetEdit.color')}>
          <input
            type="color"
            value={config.color ?? '#94a3b8'}
            onChange={(e) => set('color', e.target.value)}
            className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1"
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.radiusPx')}>
          <input
            type="number"
            min={0}
            max={64}
            value={config.radius ?? 8}
            onChange={(e) => set('radius', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.opacity')}>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.opacity ?? 0.85}
            onChange={(e) => set('opacity', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  );
}

export function SectionHeaderForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.eyebrow')} hint={t('dashboards.widgetEdit.eyebrowHint')}>
        <input className={inputClass} value={config.eyebrow ?? ''} onChange={(e) => set('eyebrow', e.target.value)} />
      </Field>
      <Field label={t('dashboards.widgetEdit.headingTitle')}>
        <input className={inputClass} value={config.title ?? ''} onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label={t('dashboards.widgetEdit.subtitle')}>
        <input className={inputClass} value={config.subtitle ?? ''} onChange={(e) => set('subtitle', e.target.value)} />
      </Field>
    </>
  );
}

export function CalloutForm({ config, set }: { config: any; set: (k: string, v: any) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('dashboards.widgetEdit.headingTitle')}>
        <input className={inputClass} value={config.title ?? ''} onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label={t('dashboards.widgetEdit.calloutText')}>
        <textarea className={inputClass} rows={3} value={config.text ?? ''} onChange={(e) => set('text', e.target.value)} />
      </Field>
      <Field label={t('dashboards.widgetEdit.calloutTone')}>
        <select className={inputClass} value={config.tone ?? 'accent'} onChange={(e) => set('tone', e.target.value)}>
          <option value="accent">{t('dashboards.widgetEdit.toneAccent')}</option>
          <option value="good">{t('dashboards.widgetEdit.toneGood')}</option>
          <option value="warn">{t('dashboards.widgetEdit.toneWarn')}</option>
          <option value="bad">{t('dashboards.widgetEdit.toneBad')}</option>
          <option value="neutral">{t('dashboards.widgetEdit.toneNeutral')}</option>
        </select>
      </Field>
    </>
  );
}

export function ParameterSwitcherForm({
  config,
  setConfig,
}: {
  config: any;
  setConfig: React.Dispatch<React.SetStateAction<Record<string, any>>>;
}) {
  const { t } = useI18n();
  const options: Array<{ label: string; value: string }> = Array.isArray(config.options) ? config.options : [];
  const updateOption = (i: number, patch: Partial<{ label: string; value: string }>) => {
    const next = options.map((o, idx) => (idx === i ? { ...o, ...patch } : o));
    setConfig((prev) => ({ ...prev, options: next }));
  };
  const addOption = () => {
    setConfig((prev) => ({
      ...prev,
      options: [...(Array.isArray(prev.options) ? prev.options : []), { label: '', value: '' }],
    }));
  };
  const removeOption = (i: number) => {
    setConfig((prev) => ({
      ...prev,
      options: (Array.isArray(prev.options) ? prev.options : []).filter((_: any, idx: number) => idx !== i),
    }));
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('dashboards.widgetEdit.parameterName')} hint={t('dashboards.widgetEdit.parameterNameHint')}>
          <input
            type="text"
            value={config.paramName ?? ''}
            onChange={(e) => setConfig((p) => ({ ...p, paramName: e.target.value }))}
            className={inputClass}
            placeholder="period"
          />
        </Field>
        <Field label={t('dashboards.widgetEdit.label')}>
          <input
            type="text"
            value={config.label ?? ''}
            onChange={(e) => setConfig((p) => ({ ...p, label: e.target.value }))}
            className={inputClass}
            placeholder={t('dashboards.widgetEdit.parameterLabelPlaceholder')}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('dashboards.widgetEdit.layout')}>
          <select
            value={config.layout ?? 'tabs'}
            onChange={(e) => setConfig((p) => ({ ...p, layout: e.target.value }))}
            className={inputClass}
          >
            <option value="tabs">{t('dashboards.widgetEdit.layoutTabs')}</option>
            <option value="dropdown">{t('dashboards.widgetEdit.layoutDropdown')}</option>
          </select>
        </Field>
        <Field
          label={t('dashboards.widgetEdit.paramFilterColumn')}
          hint={t('dashboards.widgetEdit.paramFilterColumnHint')}
        >
          <input
            type="text"
            value={config.field ?? ''}
            onChange={(e) => setConfig((p) => ({ ...p, field: e.target.value }))}
            className={inputClass}
            placeholder="order_status"
          />
        </Field>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[12px] font-[510] text-text-secondary">{t('dashboards.widgetEdit.options')}</label>
          <button
            type="button"
            onClick={addOption}
            className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[11px] font-[510] text-text-secondary hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" /> {t('dashboards.widgetEdit.addOption')}
          </button>
        </div>
        <div className="space-y-2">
          {options.length === 0 && (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-[12px] text-text-tertiary">
              {t('dashboards.widgetEdit.noOptions')}
            </p>
          )}
          {options.map((opt, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <input
                type="text"
                placeholder={t('dashboards.widgetEdit.optionLabelPlaceholder')}
                value={opt.label ?? ''}
                onChange={(e) => updateOption(i, { label: e.target.value })}
                className={inputClass}
              />
              <input
                type="text"
                placeholder={t('dashboards.widgetEdit.optionValuePlaceholder')}
                value={opt.value ?? ''}
                onChange={(e) => updateOption(i, { value: e.target.value })}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => removeOption(i)}
                className="rounded-md p-1.5 text-text-quaternary hover:bg-danger/10 hover:text-danger"
                title={t('dashboards.widgetEdit.removeOption')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
