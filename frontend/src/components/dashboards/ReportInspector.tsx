'use client';

/**
 * The Inspector: everything about the selected element in one place — what it
 * says, how it looks, where it sits and in which section, and where its data
 * comes from. With nothing selected it is the report's own panel: its name and
 * description (which the report header states), and the report's structure as
 * a reader meets it, with what a reader would find broken.
 *
 * Every edit is a draft edit through the page's existing paths: geometry goes
 * through the grid's single placement rule (one undo step, like a drag), tile
 * properties through the layout buffer, and a widget's content through the
 * draft widget endpoint (Publish ships it, Discard drops it). Nothing here
 * writes the live report.
 */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, Lock, MoveVertical, Unlock, X } from 'lucide-react';

import type { DashboardChart, DashboardWidgetType } from '@/types/api';
import type { TileFrame } from '@/lib/dashboard-presentation/tile-frame';
import type { Structure, StructTile, StructureIssue } from '@/lib/report-structure';
import { LAYOUT_PATTERNS, type LayoutPattern } from '@/lib/report-patterns';
import { emphasisOf, TILE_EMPHASES, type TileEmphasis } from '@/lib/tile-emphasis';
import { FIT_TO_CONTENT_TYPES } from '@/lib/fit-content';
import { useI18n } from '@/providers/LanguageProvider';
import { Field, inputClass, WidgetConfigForm, widgetTypeLabel } from './widget-forms';

type Rect = { x: number; y: number; w: number; h: number };
/** A tile with the layout the author sees (unsaved edits merged in). */
export type InspectedTile = Omit<DashboardChart, 'layout'> & { layout: Record<string, any> };

export interface ReportInspectorProps {
  onClose: () => void;
  dashboardId: number;
  report: { name: string; description: string | null };
  /** The selected tiles, with the layout the author sees (unsaved edits included). */
  selected: Array<InspectedTile>;
  structure: { tiles: StructTile[]; resolved: Structure; issues: StructureIssue[] };
  titleOf: (id: number) => string;
  onSelect: (id: number) => void;
  onGeometry: (id: number, rect: Rect) => void;
  onPatchLayout: (id: number, patch: Record<string, any>) => void;
  onMoveToSection: (id: number, sectionId: number | null) => void;
  onSaveWidgetConfig: (id: number, config: Record<string, any>) => Promise<void>;
  onSaveReport: (patch: { name: string; description: string | null }) => Promise<void>;
  onPattern: (pattern: LayoutPattern) => void;
  /** Height to what the element says (text-like widgets). */
  onFitToContent: (id: number) => void;
  onFrame: (frame: TileFrame) => void;
  frame: TileFrame | null;
}

const panelClass =
  'flex h-full w-full flex-col overflow-hidden bg-surface-1 text-text-primary';

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="border-b border-[rgb(var(--border-line))] px-4 py-3.5" data-testid={testId}>
      <h3 className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-text-quaternary">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, name }: {
  value: T | null; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; name: string;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="inline-flex w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-testid={`${name}-${o.value}`}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded px-2 py-1 text-[11.5px] font-[510] transition-colors ${value === o.value ? 'bg-surface-1 text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A number cell that commits on Enter / blur — never on every keystroke, so a
 *  half-typed "1" does not move a tile to column 1 on its way to "18". */
function GeometryInput({ label, value, min, max, onCommit, testId }: {
  label: string; value: number; min: number; max?: number; onCommit: (v: number) => void; testId: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) { setDraft(String(value)); return; }
    const v = Math.max(min, max != null ? Math.min(max, n) : n);
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <label className="flex flex-col gap-1 text-[10.5px] font-[510] text-text-tertiary">
      {label}
      <input
        type="number"
        inputMode="numeric"
        data-testid={testId}
        value={draft}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className={`${inputClass} h-8 px-2 tabular-nums`}
      />
    </label>
  );
}

export function ReportInspector(props: ReportInspectorProps) {
  const { t } = useI18n();
  const { selected, onClose } = props;
  const single = selected.length === 1 ? selected[0] : null;
  const heading = single
    ? widgetTypeLabel(t, single.widget_type && single.widget_type !== 'chart' ? single.widget_type : 'chart')
    : selected.length > 1
      ? t('dashboards.inspector.multi', { count: selected.length })
      : t('dashboards.inspector.report');
  return (
    <div className={panelClass} data-testid="report-inspector" role="complementary" aria-label={t('dashboards.inspector.title')}>
      <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-text-quaternary">{t('dashboards.inspector.title')}</div>
          <div className="truncate text-[13.5px] font-semibold" data-testid="inspector-heading">{heading}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          data-testid="inspector-close"
          className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {single ? <ElementPanel {...props} tile={single} key={single.id} />
          : selected.length > 1 ? <SelectionPanel {...props} />
            : <ReportPanel {...props} />}
      </div>
    </div>
  );
}

// ── One element ──────────────────────────────────────────────────────────────

function ElementPanel(props: ReportInspectorProps & { tile: InspectedTile }) {
  const { t } = useI18n();
  const { tile, structure, titleOf } = props;
  const isChart = !tile.widget_type || tile.widget_type === 'chart';
  const layout = tile.layout ?? {};
  const rect: Rect = { x: Number(layout.x) || 0, y: Number(layout.y) || 0, w: Number(layout.w) || 1, h: Number(layout.h) || 1 };
  const locked = Boolean(layout.locked);
  const struct = structure.tiles.find((s) => s.id === tile.id);
  const canJoinSection = struct?.kind === 'content' || struct?.kind === 'narrative';
  const sectionId = structure.resolved.sectionOf.get(tile.id) ?? null;

  return (
    <>
      <Section title={t('dashboards.inspector.content')} testId="inspector-content">
        {isChart
          ? <ChartContent {...props} />
          : <WidgetContent {...props} />}
      </Section>

      {isChart && (
        <Section title={t('dashboards.inspector.style')} testId="inspector-style">
          <Field label={t('dashboards.inspector.emphasis')} hint={t('dashboards.inspector.emphasisHint')}>
            <Segmented<TileEmphasis>
              name="inspector-emphasis"
              value={emphasisOf(layout)}
              options={TILE_EMPHASES.map((e) => ({ value: e, label: t(`dashboards.inspector.emphasis.${e}`) }))}
              onChange={(e) => props.onPatchLayout(tile.id, { emphasis: e === 'normal' ? null : e })}
            />
          </Field>
          <Field label={t('dashboards.inspector.frame')}>
            <Segmented<TileFrame>
              name="inspector-frame"
              value={props.frame}
              options={(['card', 'subtle', 'flush'] as TileFrame[]).map((f) => ({ value: f, label: t(`dashboards.arrange.frame.${f}`) }))}
              onChange={props.onFrame}
            />
          </Field>
          <Field label={t('dashboards.inspector.surface')} hint={t('dashboards.inspector.surfaceHint')}>
            <Segmented<'default' | 'dark' | 'light'>
              name="inspector-surface"
              value={(layout.styleConfigOverride?.chartSurface as 'dark' | 'light' | undefined) ?? 'default'}
              options={(['default', 'dark', 'light'] as const).map((s) => ({ value: s, label: t(`dashboards.inspector.surface.${s}`) }))}
              onChange={(s) => {
                const { chartSurface: _drop, ...rest } = (layout.styleConfigOverride ?? {}) as Record<string, any>;
                props.onPatchLayout(tile.id, { styleConfigOverride: s === 'default' ? rest : { ...rest, chartSurface: s } });
              }}
            />
          </Field>
        </Section>
      )}

      <Section title={t('dashboards.inspector.layout')} testId="inspector-layout">
        <div className="grid grid-cols-4 gap-2">
          <GeometryInput label="X" testId="inspector-x" value={rect.x} min={0} max={36 - rect.w} onCommit={(x) => props.onGeometry(tile.id, { ...rect, x })} />
          <GeometryInput label="Y" testId="inspector-y" value={rect.y} min={0} onCommit={(y) => props.onGeometry(tile.id, { ...rect, y })} />
          <GeometryInput label={t('dashboards.inspector.width')} testId="inspector-w" value={rect.w} min={1} max={36 - rect.x} onCommit={(w) => props.onGeometry(tile.id, { ...rect, w })} />
          <GeometryInput label={t('dashboards.inspector.height')} testId="inspector-h" value={rect.h} min={1} onCommit={(h) => props.onGeometry(tile.id, { ...rect, h })} />
        </div>
        <p className="text-[11px] leading-snug text-text-quaternary">{t('dashboards.inspector.gridHint')}</p>
        {FIT_TO_CONTENT_TYPES.has(String(tile.widget_type)) && (
          <button
            type="button"
            data-testid="inspector-fit"
            onClick={() => props.onFitToContent(tile.id)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] px-2.5 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-surface-2"
          >
            <MoveVertical className="h-3.5 w-3.5" />
            {t('dashboards.inspector.fitHeight')}
          </button>
        )}
        {canJoinSection && (
          <Field label={t('dashboards.inspector.section')} hint={t('dashboards.inspector.sectionHint')}>
            <select
              data-testid="inspector-section"
              value={sectionId ?? ''}
              onChange={(e) => props.onMoveToSection(tile.id, e.target.value === '' ? null : Number(e.target.value))}
              className={inputClass}
            >
              <option value="">{t('dashboards.inspector.noSection')}</option>
              {structure.resolved.sections.map((s) => (
                <option key={s.headerId} value={s.headerId}>{titleOf(s.headerId)}</option>
              ))}
            </select>
          </Field>
        )}
        <button
          type="button"
          data-testid="inspector-lock"
          aria-pressed={locked}
          onClick={() => props.onPatchLayout(tile.id, { locked: !locked })}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-[510] transition-colors ${locked ? 'border-brand/50 bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'}`}
        >
          {locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
          {locked ? t('dashboards.inspector.locked') : t('dashboards.inspector.lock')}
        </button>
      </Section>

      {isChart && (
        <Section title={t('dashboards.inspector.data')} testId="inspector-data">
          <div className="text-[12px] text-text-secondary">
            <span className="text-text-tertiary">{t('dashboards.inspector.chart')}: </span>
            <span className="font-[510] text-text-primary">{tile.chart?.name ?? `#${tile.chart_id}`}</span>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              data-testid="inspector-highlight"
              checked={layout.highlightEnabled !== false}
              onChange={(e) => props.onPatchLayout(tile.id, { highlightEnabled: e.target.checked })}
            />
            {t('dashboards.inspector.respondsToHighlight')}
          </label>
          {tile.chart_id ? (
            <Link
              href={`/explore/${tile.chart_id}?fromReport=${props.dashboardId}&tile=${tile.id}`}
              data-testid="inspector-explore"
              className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-brand hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('dashboards.inspector.openExplore')}
            </Link>
          ) : null}
        </Section>
      )}
    </>
  );
}

function ChartContent({ tile, onPatchLayout }: ReportInspectorProps & { tile: InspectedTile }) {
  const { t } = useI18n();
  const current = String(tile.layout?.custom_title ?? '');
  const [title, setTitle] = useState(current);
  useEffect(() => { setTitle(current); }, [current]);
  const commit = () => {
    const next = title.trim();
    if (next === current.trim()) return;
    onPatchLayout(tile.id, { custom_title: next || null });
  };
  return (
    <Field label={t('dashboards.inspector.tileTitle')} hint={t('dashboards.inspector.tileTitleHint', { name: tile.chart?.name ?? '' })}>
      <input
        data-testid="inspector-title"
        value={title}
        placeholder={tile.chart?.name ?? ''}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className={inputClass}
      />
    </Field>
  );
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

/** A widget's content, saved to the draft as the author types (debounced), so
 *  the canvas shows the edit without a Save step inside the panel. */
function WidgetContent({ tile, report, titleOf, onSaveWidgetConfig }: ReportInspectorProps & { tile: InspectedTile }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<Record<string, any>>(() => ({ ...(tile.widget_config ?? {}) }));
  const [state, setState] = useState<SaveState>('idle');
  const dirty = useRef(false);
  const latest = useRef(config);
  latest.current = config;
  const save = useRef(onSaveWidgetConfig);
  save.current = onSaveWidgetConfig;

  const flush = React.useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setState('saving');
    try {
      await save.current(tile.id, latest.current);
      setState('saved');
    } catch {
      dirty.current = true;
      setState('failed');
    }
  }, [tile.id]);

  useEffect(() => {
    if (!dirty.current) return;
    setState('pending');
    const id = window.setTimeout(() => { void flush(); }, 650);
    return () => window.clearTimeout(id);
  }, [config, flush]);
  // Leaving the element (another selection, closing the panel) never drops an edit.
  useEffect(() => () => { void flush(); }, [flush]);

  const setAll: React.Dispatch<React.SetStateAction<Record<string, any>>> = (next) => {
    dirty.current = true;
    setConfig(next);
  };
  const set = (key: string, value: any) => setAll((prev) => ({ ...prev, [key]: value }));

  return (
    <>
      <WidgetConfigForm
        type={(tile.widget_type ?? 'text') as DashboardWidgetType}
        config={config}
        set={set}
        setConfig={setAll}
        context={{ reportName: report.name, reportDescription: report.description, tileTitle: titleOf }}
      />
      <div className="text-[11px] text-text-quaternary" data-testid="inspector-save-state" data-state={state} aria-live="polite">
        {state === 'saving' || state === 'pending' ? t('dashboards.inspector.saving')
          : state === 'saved' ? t('dashboards.inspector.savedDraft')
            : state === 'failed' ? (
              <button type="button" onClick={() => { dirty.current = true; void flush(); }} className="text-danger underline">
                {t('dashboards.inspector.saveFailed')}
              </button>
            ) : t('dashboards.inspector.draftNote')}
      </div>
    </>
  );
}

// ── Several elements ─────────────────────────────────────────────────────────

function SelectionPanel({ selected, onPattern }: ReportInspectorProps) {
  const { t } = useI18n();
  return (
    <Section title={t('dashboards.inspector.patterns')} testId="inspector-patterns">
      <p className="text-[11.5px] leading-snug text-text-tertiary">{t('dashboards.inspector.patternsHint', { count: selected.length })}</p>
      <div className="grid gap-1.5">
        {LAYOUT_PATTERNS.map((p) => (
          <button
            key={p}
            type="button"
            data-testid={`inspector-pattern-${p}`}
            onClick={() => onPattern(p)}
            className="flex items-center gap-2.5 rounded-lg border border-[rgb(var(--border-line))] px-2.5 py-2 text-left transition-colors hover:border-brand/40 hover:bg-brand/5"
          >
            <PatternGlyph pattern={p} />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-[560] text-text-primary">{t(`dashboards.inspector.pattern.${p}`)}</span>
              <span className="block text-[11px] leading-snug text-text-tertiary">{t(`dashboards.inspector.pattern.${p}.desc`)}</span>
            </span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function PatternGlyph({ pattern }: { pattern: LayoutPattern }) {
  const cell = 'rounded-[2px] bg-brand/35';
  return (
    <span aria-hidden className="flex h-7 w-10 shrink-0 gap-[2px] rounded border border-[rgb(var(--border-line))] p-[3px]">
      {pattern === 'leadSupport' ? (
        <>
          <span className={`${cell} w-2/3`} />
          <span className="flex w-1/3 flex-col gap-[2px]"><span className={`${cell} flex-1`} /><span className={`${cell} flex-1`} /></span>
        </>
      ) : (
        <span className={`flex w-full gap-[2px] ${pattern === 'kpiStrip' ? 'h-1/2 self-center' : ''}`}>
          <span className={`${cell} flex-1`} /><span className={`${cell} flex-1`} /><span className={`${cell} flex-1`} />
        </span>
      )}
    </span>
  );
}

// ── Nothing selected: the report ─────────────────────────────────────────────

function ReportPanel({ report, onSaveReport, structure, titleOf, onSelect }: ReportInspectorProps) {
  const { t } = useI18n();
  const [name, setName] = useState(report.name);
  const [description, setDescription] = useState(report.description ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(report.name); setDescription(report.description ?? ''); }, [report.name, report.description]);
  const dirty = name.trim() !== report.name.trim() || description.trim() !== (report.description ?? '').trim();

  const { resolved, issues, tiles } = structure;
  const inSection = new Set(resolved.sections.flatMap((s) => [s.headerId, ...s.members]));
  const byReading = (a: number, b: number) => {
    const ta = tiles.find((x) => x.id === a)!; const tb = tiles.find((x) => x.id === b)!;
    return ta.y - tb.y || ta.x - tb.x;
  };
  const preamble = tiles.filter((x) => !inSection.has(x.id)).map((x) => x.id).sort(byReading);
  const sections = [...resolved.sections].sort((a, b) => byReading(a.headerId, b.headerId));

  const issueText = (i: StructureIssue) => i.kind === 'empty_section'
    ? t('dashboards.inspector.issue.empty', { title: titleOf(i.headerId) })
    : i.kind === 'member_above_heading'
      ? t('dashboards.inspector.issue.above', { title: titleOf(i.tileId), section: titleOf(i.headerId) })
      : t('dashboards.inspector.issue.detached', { title: titleOf(i.tileId) });
  const issueTarget = (i: StructureIssue) => (i.kind === 'empty_section' ? i.headerId : i.tileId);

  const Item = ({ id, indent = false }: { id: number; indent?: boolean }) => (
    <button
      type="button"
      data-testid="outline-item"
      data-outline-id={id}
      onClick={() => onSelect(id)}
      className={`block w-full truncate rounded px-2 py-1 text-left text-[12px] transition-colors hover:bg-surface-2 ${indent ? 'pl-5 text-text-secondary' : 'font-[560] text-text-primary'}`}
    >
      {titleOf(id)}
    </button>
  );

  return (
    <>
      <Section title={t('dashboards.inspector.aboutReport')} testId="inspector-report">
        <Field label={t('dashboards.inspector.reportName')}>
          <input data-testid="inspector-report-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label={t('dashboards.inspector.reportDescription')} hint={t('dashboards.inspector.reportDescriptionHint')}>
          <textarea
            data-testid="inspector-report-description"
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputClass} h-auto py-2`}
          />
        </Field>
        <button
          type="button"
          data-testid="inspector-report-save"
          disabled={!dirty || busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            try { await onSaveReport({ name: name.trim(), description: description.trim() || null }); } finally { setBusy(false); }
          }}
          className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-[12px] font-[510] text-white shadow-sm transition-colors hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? t('dashboards.inspector.saving') : t('dashboards.inspector.saveReport')}
        </button>
      </Section>

      <Section title={t('dashboards.inspector.structure')} testId="inspector-outline">
        {issues.length > 0 && (
          <ul className="space-y-1.5" data-testid="outline-issues">
            {issues.map((i, n) => (
              <li key={n}>
                <button
                  type="button"
                  data-issue-kind={i.kind}
                  onClick={() => onSelect(issueTarget(i))}
                  className="flex w-full items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-left text-[11.5px] leading-snug text-text-secondary hover:bg-warning/15"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  {issueText(i)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {tiles.length === 0 ? (
          <p className="text-[12px] text-text-tertiary">{t('dashboards.inspector.emptyOutline')}</p>
        ) : (
          <nav aria-label={t('dashboards.inspector.structure')} className="-mx-2">
            {preamble.map((id) => <Item key={id} id={id} />)}
            {sections.map((s) => (
              <div key={s.headerId} data-outline-section={s.headerId}>
                <Item id={s.headerId} />
                {[...s.members].sort(byReading).map((m) => <Item key={m} id={m} indent />)}
              </div>
            ))}
          </nav>
        )}
      </Section>
    </>
  );
}
