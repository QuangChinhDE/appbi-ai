'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ClipboardPaste, Code2, Crosshair, Database, Download, Filter, ImagePlus, Loader2, Plus, Search, Send, Sparkles, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { downloadContextPack } from '@/components/report-code/contextPack';
import { reportCodeApi, type ReportCatalog, type ReportDetail, type ReportRevision } from '@/lib/api/report-code';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

const KIND_TONE: Record<string, string> = {
  kpi: 'bg-brand-container text-brand-on-container', time: 'bg-sky-50 text-sky-800', category: 'bg-emerald-50 text-emerald-800', table: 'bg-amber-50 text-amber-800',
};

export function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 3 * 1024 * 1024) { reject(new Error('too-large')); return; }
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ── AI ────────────────────────────────────────────────────────────────────────
export function AiPanel({ detail, revisions, busy, region, regionLabel, onClearRegion, onSubmit, selectMode, onToggleSelect }: {
  detail: ReportDetail;
  revisions: ReportRevision[];
  busy: boolean;
  region: string | null;
  regionLabel: string | null;
  onClearRegion: () => void;
  onSubmit: (instruction: string, image?: string, allowData?: boolean) => Promise<boolean>;
  selectMode: boolean;
  onToggleSelect: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [image, setImage] = useState<string | undefined>();
  const [allowData, setAllowData] = useState(false);
  const editable = detail.user_permission === 'edit' || detail.user_permission === 'full';
  const history = useMemo(() => [...revisions].reverse().filter((r) => r.note), [revisions]);
  const suggestions = region
    ? [t('reportCode.ai.sugRegion1'), t('reportCode.ai.sugRegion2'), t('reportCode.ai.sugRegion3')]
    : [t('reportCode.ai.sug1'), t('reportCode.ai.sug2'), t('reportCode.ai.sug3'), t('reportCode.ai.sug4')];

  const send = async () => {
    const value = text.trim();
    if (value.length < 2 || busy) return;
    if (await onSubmit(value, image, allowData)) { setText(''); setImage(undefined); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="ai-history">
        {history.length === 0 && <p className="text-xs text-text-tertiary">{t('reportCode.ai.empty')}</p>}
        {history.map((r) => (
          <div key={r.id} className="space-y-1.5">
            <div className="ml-6 rounded-xl rounded-tr-sm bg-brand/10 px-3 py-2 text-[13px] text-text-primary">{r.note}</div>
            <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
              <Sparkles className="h-3 w-3" />
              <span>{t(`reportCode.source.${r.source}`) || r.source} · v{r.number}</span>
              {r.created_at && <span>· {new Date(r.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>}
            </div>
          </div>
        ))}
      </div>
      {editable && (
        <div className="border-t border-stroke-strong p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => setText(s)} className="rounded-full border border-stroke-strong bg-surface-0 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-2">{s}</button>
            ))}
          </div>
          <div className="mb-2 flex items-center gap-2">
            <button type="button" onClick={onToggleSelect} data-testid="studio-select-region"
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${selectMode ? 'border-brand bg-brand/10 text-brand' : 'border-stroke-strong text-text-secondary hover:bg-surface-2'}`}>
              <Crosshair className="h-3.5 w-3.5" />{selectMode ? t('reportCode.ai.selecting') : t('reportCode.ai.selectRegion')}
            </button>
            {region && (
              <span className="inline-flex items-center gap-1 rounded-md bg-brand/10 px-2 py-1 text-[11px] font-medium text-brand" data-testid="studio-region-chip">
                {t('reportCode.ai.editing')}: {regionLabel || region}
                <button type="button" onClick={onClearRegion} aria-label="clear"><X className="h-3 w-3" /></button>
              </span>
            )}
          </div>
          <div className="rounded-xl border border-stroke-strong bg-surface-0 focus-within:ring-2 focus-within:ring-brand/30">
            <textarea
              data-testid="studio-ai-input"
              value={text}
              rows={3}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
              placeholder={region ? t('reportCode.ai.placeholderRegion') : t('reportCode.ai.placeholder')}
              className="block w-full resize-none rounded-xl bg-transparent px-3 py-2 text-sm outline-none"
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-tertiary hover:bg-surface-2">
                <ImagePlus className="h-3.5 w-3.5" />{image ? t('reportCode.ai.imageAttached') : t('reportCode.ai.attachImage')}
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try { setImage(await readImage(f)); } catch { toast.error(t('reportCode.ai.imageTooLarge')); }
                }} />
              </label>
              <Button size="sm" variant="primary" onClick={send} disabled={busy || text.trim().length < 2} loading={busy}
                leadingIcon={<Send className="h-3.5 w-3.5" />} data-testid="studio-ai-send">
                {region ? t('reportCode.ai.sendRegion') : t('reportCode.ai.send')}
              </Button>
            </div>
          </div>
          <label className="mt-2 flex items-start gap-2 text-[11px] text-text-secondary">
            <input type="checkbox" className="mt-0.5 h-3.5 w-3.5" checked={allowData} onChange={(e) => setAllowData(e.target.checked)} data-testid="studio-ai-allow-data" />
            <span><b>{t('reportCode.ai.allowData')}</b> — {t('reportCode.ai.allowDataHint')}</span>
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-text-quaternary">{region ? t('reportCode.ai.scopeRegion') : t('reportCode.ai.scopePage')} {t('reportCode.ai.governance')}</p>
        </div>
      )}
    </div>
  );
}

// ── Data ──────────────────────────────────────────────────────────────────────
// Commented-out examples are not uses.
const refCount = (html: string, attr: string, id: string) =>
  (html.replace(/<!--[\s\S]*?-->/g, '').match(new RegExp(`${attr}=["']${id}["']`, 'g')) || []).length;

export function snippetFor(kind: string, id: string, title: string): string {
  if (kind === 'filter') return `<div data-rac-filter="${id}"></div>\n`;
  if (kind === 'value') return `<span data-rac-value="${id}"></span>`;
  const viz = kind === 'kpi' ? 'kpi' : kind === 'table' ? 'table' : kind === 'time' ? 'line' : 'bar';
  if (viz === 'kpi') return `<div class="card">\n  <div data-rac-viz="kpi" data-rac-bind="${id}"></div>\n</div>\n`; // the KPI shows its own title
  return `<div class="card">\n  <h3 data-rac-title="${id}">${title.replace(/[<>&"]/g, '')}</h3>\n  <div data-rac-viz="${viz}" data-rac-bind="${id}" style="height:280px"></div>\n</div>\n`;
}

export function DataPanel({ detail, onChanged, html = '', onInsert, onPaste }: { detail: ReportDetail; onChanged: () => void; html?: string; onInsert?: (snippet: string) => void; onPaste?: () => void }) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<ReportCatalog | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const draft = detail.draft;
  const editable = detail.user_permission === 'edit' || detail.user_permission === 'full';

  useEffect(() => {
    if (!adding || catalog) return;
    reportCodeApi.catalog(detail.id).then(setCatalog).catch((e) => toast.error(e?.response?.data?.detail || 'catalog'));
  }, [adding, catalog, detail.id]);

  const run = async (key: string, fn: () => Promise<{ warnings?: string[] }>, ok: string) => {
    setBusyId(key);
    try {
      const out = await fn();
      toast.success(ok);
      (out.warnings || []).slice(0, 2).forEach((w) => toast.warning(w));
      onChanged();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message || 'error');
    } finally {
      setBusyId(null);
    }
  };

  const used = new Set((draft?.filters || []).map((f) => f.label));
  const usage = (draft?.bindings || []).map((b) => refCount(html, 'data-rac-bind', b.id) + refCount(html, 'data-rac-value', b.id));
  const known = new Set((draft?.bindings || []).map((b) => b.id));
  const missing = Array.from(new Set(Array.from(html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/data-rac-(?:bind|value)=["']([^"']+)["']/g)).map((m) => m[1]).filter((id) => !known.has(id))));
  const filtered = (catalog?.candidates || []).filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase())).slice(0, 80);

  return (
    <div className="h-full min-h-0 space-y-5 overflow-y-auto p-4" data-testid="data-panel">
      <div className="rounded-lg border border-brand/15 bg-brand-container px-3 py-2 text-[11px] leading-relaxed text-brand-on-container">
        <Database className="mr-1 inline h-3.5 w-3.5" />{t('reportCode.data.governance')}
      </div>
      {detail.dataset_id && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-stroke-strong px-3 py-2">
          <div className="text-[11px] leading-snug text-text-secondary"><div className="font-semibold text-text-primary">{t('reportCode.pack.title')}</div>{t('reportCode.pack.short')}</div>
          <Button size="xs" variant="secondary" leadingIcon={<Download className="h-3 w-3" />} onClick={() => downloadContextPack(detail.dataset_id as number, t)} data-testid="data-context-pack">{t('reportCode.pack.download')}</Button>
        </div>
      )}
      {onPaste && (
        <button type="button" onClick={onPaste} data-testid="data-paste-open"
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-brand/40 bg-brand-container/40 px-3 py-2 text-left text-[11px] text-brand-on-container hover:bg-brand-container">
          <ClipboardPaste className="h-4 w-4 shrink-0" /><span><b>{t('reportCode.paste.open')}</b><br />{t('reportCode.paste.openHint')}</span>
        </button>
      )}
      {missing.length > 0 && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-700" data-testid="data-missing">{t('reportCode.data.missing', { ids: missing.join(', ') })}</div>
      )}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('reportCode.data.bindings')} ({draft?.bindings?.length || 0})</h4>
          {editable && <Button size="xs" variant="ghost" leadingIcon={<Plus className="h-3 w-3" />} onClick={() => setAdding((v) => !v)} data-testid="data-add-toggle">{t('reportCode.data.add')}</Button>}
        </div>
        {adding && (
          <div className="mb-3 rounded-lg border border-stroke-strong bg-surface-1 p-2">
            <div className="mb-2 flex items-center gap-2 rounded-md border border-stroke-strong bg-surface-0 px-2">
              <Search className="h-3.5 w-3.5 text-text-tertiary" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('reportCode.data.search')} className="w-full bg-transparent py-1.5 text-xs outline-none" />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {!catalog && <div className="p-2 text-xs text-text-tertiary"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />{t('common.loading')}</div>}
              {filtered.map((c) => (
                <button key={c.id} type="button" disabled={!!busyId} data-testid={`data-candidate-${c.id}`}
                  onClick={() => run(c.id, () => reportCodeApi.addBinding(detail.id, { candidate_id: c.id }), t('reportCode.data.added'))}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2 disabled:opacity-50">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${KIND_TONE[c.kind] || ''}`}>{c.kind}</span>
                  <span className="flex-1 truncate">{c.title}</span>
                  {busyId === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 text-text-tertiary" />}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          {(draft?.bindings || []).map((b, bi) => (
            <div key={b.id} className="flex items-center gap-2 rounded-lg border border-stroke-strong bg-surface-0 px-2.5 py-2" data-testid={`binding-${b.id}`}>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${KIND_TONE[b.kind] || ''}`}>{b.kind}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-text-primary">{b.title}</div>
                <div className="text-[10px] text-text-tertiary"><code>{b.id}</code> · <Link className="hover:underline" href={`/explore/${b.chart_id}`} target="_blank">{t('reportCode.data.openChart')} #{b.chart_id}</Link>
                  {' · '}<span className={usage[bi] ? 'text-text-tertiary' : 'font-medium text-amber-700'} data-testid={`binding-${b.id}-uses`}>{usage[bi] ? t('reportCode.data.uses', { n: usage[bi] }) : t('reportCode.data.unused')}</span></div>
              </div>
              {onInsert && editable && (
                <span className="flex shrink-0 gap-0.5">
                  <button type="button" title={t('reportCode.data.insertBlock')} onClick={() => onInsert(snippetFor(b.kind, b.id, b.title))} data-testid={`binding-${b.id}-insert`}
                    className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Code2 className="h-3.5 w-3.5" /></button>
                  <button type="button" title={t('reportCode.data.insertValue')} onClick={() => onInsert(snippetFor('value', b.id, b.title))}
                    className="rounded px-1 text-[10px] font-semibold text-text-tertiary hover:bg-surface-2 hover:text-brand">123</button>
                </span>
              )}
              {editable && (
                <button type="button" disabled={!!busyId} aria-label="remove" className="text-text-quaternary hover:text-red-600"
                  onClick={() => run(b.id, () => reportCodeApi.removeBinding(detail.id, b.id), t('reportCode.data.removed'))}>
                  {busyId === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('reportCode.data.filters')} ({draft?.filters?.length || 0})</h4>
        <div className="space-y-1.5">
          {(draft?.filters || []).map((f) => (
            <div key={f.key} className="flex items-center gap-2 rounded-lg border border-stroke-strong bg-surface-0 px-2.5 py-2" data-testid={`filter-${f.key}`}>
              {f.kind === 'date' ? <CalendarDays className="h-3.5 w-3.5 text-sky-600" /> : <Filter className="h-3.5 w-3.5 text-emerald-600" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{f.label}</div>
                <div className="text-[10px] text-text-tertiary"><code>{f.key}</code> · {refCount(html, 'data-rac-filter', f.key) ? t('reportCode.data.uses', { n: refCount(html, 'data-rac-filter', f.key) }) : <span className="font-medium text-amber-700">{t('reportCode.data.unused')}</span>}</div>
              </div>
              {onInsert && editable && (
                <button type="button" title={t('reportCode.data.insertBlock')} onClick={() => onInsert(snippetFor('filter', f.key, f.label))} data-testid={`filter-${f.key}-insert`}
                  className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Code2 className="h-3.5 w-3.5" /></button>
              )}
              {editable && (
                <button type="button" disabled={!!busyId} aria-label="remove" className="text-text-quaternary hover:text-red-600"
                  onClick={() => run(f.key, () => reportCodeApi.removeFilter(detail.id, f.key), t('reportCode.data.removed'))}><Trash2 className="h-3.5 w-3.5" /></button>
              )}
            </div>
          ))}
        </div>
        {editable && adding && catalog && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {catalog.dimensions.filter((d) => !used.has(d.label)).slice(0, 18).map((d) => (
              <button key={d.id} type="button" disabled={!!busyId} onClick={() => run(d.id, () => reportCodeApi.addFilter(detail.id, d.id), t('reportCode.data.added'))}
                className="rounded-full border border-dashed border-stroke-strong px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-2">+ {d.label}</button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
