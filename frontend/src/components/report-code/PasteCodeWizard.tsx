'use client';

/**
 * Paste outside HTML/CSS/JS → connect it to governed data, keeping its design.
 *
 * Step 1: the code (one file or three parts) and the dataset.
 * Step 2: the mapping the server proposes — which printed number / chart / table /
 * select is which governed candidate — reviewed and edited by the author. Only the
 * spans that held data change; everything else in the code stays as pasted.
 */
import React, { useMemo, useState } from 'react';
import { BarChart3, Check, Code2, Download, FileUp, Filter, Hash, Link2, Loader2, Table2, Wand2, Rows3, CalendarDays } from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { downloadContextPack } from '@/components/report-code/contextPack';
import { reportCodeApi, type ImportAnalysis, type ImportSlot } from '@/lib/api/report-code';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

const VIZ = ['bar', 'hbar', 'line', 'area', 'donut', 'table', 'heatmap', 'waterfall', 'progress'];
const KIND_FOR: Record<string, string[]> = { value: ['kpi'], chart: ['time', 'category'], table: ['category'] };
const SLOT_ICON = { value: Hash, chart: BarChart3, table: Table2, filter: Filter, list: Rows3, period: CalendarDays } as const;

export function PasteCodeWizard({ datasets, datasetId: fixedDataset, artifactId, onClose, onDone }: {
  datasets?: { id: number; name: string }[];
  datasetId?: number | null;
  artifactId?: number;
  onClose: () => void;
  onDone: (reportId: number) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'file' | 'parts'>('file');
  const [file, setFile] = useState('');
  const [parts, setParts] = useState({ html: '', css: '', js: '' });
  const [datasetId, setDatasetId] = useState<number | ''>(fixedDataset ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [map, setMap] = useState<Record<string, { candidate?: string | null; viz?: string | null; dimension?: string | null; columns?: Record<string, string | null> }>>({});
  const [extraFilters, setExtraFilters] = useState<string[]>([]);

  const sources = () => (mode === 'file' ? { html: file, css: '', js: '' } : parts);
  const hasCode = mode === 'file' ? file.trim().length > 0 : parts.html.trim().length > 0;

  const analyze = async () => {
    if (datasetId === '' || !hasCode || busy) return;
    setBusy(true);
    try {
      const a = await reportCodeApi.importAnalyze({ dataset_id: datasetId, ...sources() });
      setAnalysis(a);
      setMap(Object.fromEntries(a.slots.map((s) => [s.id, { candidate: s.candidate ?? null, viz: s.viz ?? null, dimension: s.dimension ?? null,
        columns: s.kind === 'list' ? { ...(s.column_fields || {}) } : undefined }])));
      setExtraFilters([]);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!analysis || datasetId === '' || busy) return;
    setBusy(true);
    try {
      const s = await reportCodeApi.importApply({
        dataset_id: datasetId, ...sources(), name: name.trim() || undefined, artifact_id: artifactId,
        mapping: analysis.slots.map((x) => ({ slot: x.id, ...map[x.id] })), filters: extraFilters,
      });
      onDone(s.id);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message);
      setBusy(false);
    }
  };

  // the same measure name can live in two tables: name the table only where it is ambiguous
  const dupTitles = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of analysis?.candidates || []) seen.set(c.title, (seen.get(c.title) || 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  }, [analysis]);
  const mapped = useMemo(() => analysis?.slots.filter((s) => {
    const m = map[s.id];
    if (s.kind === 'filter' || s.kind === 'period') return !!m?.dimension;
    if (s.kind === 'list') return !!m?.dimension && Object.values(m.columns || {}).some((v) => v && v !== 'dim' && v !== 'static' && v !== '#');
    return !!m?.candidate && m.candidate !== 'static';
  }).length ?? 0, [analysis, map]);
  // places that will still show the design's numbers (marked "số mẫu"; publishing asks first)
  const samples = useMemo(() => analysis?.slots.filter((s) => {
    const m = map[s.id];
    if (s.kind === 'value') return !m?.candidate;
    if (s.kind === 'list') return !(m?.dimension && Object.values(m.columns || {}).some((v) => v && !['dim', 'static', '#'].includes(v)));
    return false;
  }).length ?? 0, [analysis, map]);
  const measureOptions = (analysis?.candidates || []).filter((c) => c.kind === 'kpi');
  const label = (c: { title: string; source?: string | null }) => (c.source && dupTitles.has(c.title) ? `${c.title} · ${c.source}` : c.title);

  return (
    <Modal isOpen onClose={busy ? () => undefined : onClose} size="2xl" title={t('reportCode.paste.title')}
      footer={analysis ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => setAnalysis(null)} disabled={busy}>{t('reportCode.paste.back')}</Button>
          <Button variant="primary" size="sm" onClick={apply} loading={busy} disabled={busy || (!analysis.compatible && mapped === 0)}
            leadingIcon={<Link2 className="h-3.5 w-3.5" />} data-testid="paste-apply">
            {artifactId ? t('reportCode.paste.applyExisting') : t('reportCode.paste.apply')}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={analyze} loading={busy} disabled={busy || !hasCode || datasetId === ''}
            leadingIcon={<Wand2 className="h-3.5 w-3.5" />} data-testid="paste-analyze">{t('reportCode.paste.analyze')}</Button>
        </>
      )}>
      {!analysis ? (
        <div className="space-y-4" data-testid="paste-step-source">
          <p className="text-xs leading-relaxed text-text-secondary">{t('reportCode.paste.intro')}</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_260px]">
            <div>
              <div className="mb-2 inline-flex rounded-lg border border-stroke-strong bg-surface-2 p-0.5">
                {(['file', 'parts'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)} data-testid={`paste-mode-${m}`}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${mode === m ? 'bg-surface-1 text-text-primary shadow-sm' : 'text-text-tertiary'}`}>
                    {t(`reportCode.paste.mode.${m}`)}
                  </button>
                ))}
              </div>
              {mode === 'file' ? (
                <textarea data-testid="paste-file" value={file} onChange={(e) => setFile(e.target.value)} rows={16} spellCheck={false}
                  placeholder={'<!doctype html>\n<html>…<style>…</style>…<body>…</body>…<script>…</script></html>'}
                  className="w-full rounded-lg border border-stroke-strong bg-surface-1 p-3 font-mono text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-brand/30" />
              ) : (
                <div className="grid gap-2 lg:grid-cols-3">
                  {(['html', 'css', 'js'] as const).map((k) => (
                    <div key={k}>
                      <div className="mb-1 text-[11px] font-semibold uppercase text-text-tertiary">{k}</div>
                      <textarea data-testid={`paste-part-${k}`} value={parts[k]} onChange={(e) => setParts({ ...parts, [k]: e.target.value })} rows={14} spellCheck={false}
                        className="w-full rounded-lg border border-stroke-strong bg-surface-1 p-2 font-mono text-[12px] outline-none focus:ring-2 focus:ring-brand/30" />
                    </div>
                  ))}
                </div>
              )}
              <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-brand hover:underline">
                <FileUp className="h-3.5 w-3.5" />{t('reportCode.paste.loadFile')}
                <input type="file" accept=".html,.htm,text/html" className="hidden" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 600_000) { toast.error(t('reportCode.home.htmlTooLarge')); return; }
                  setMode('file');
                  setFile(await f.text());
                }} />
              </label>
            </div>
            <div className="space-y-3">
              {!artifactId && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">{t('reportCode.home.dataset')}</span>
                  <select data-testid="paste-dataset" value={datasetId} onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full rounded-lg border border-stroke-strong bg-surface-1 px-3 py-2 text-sm">
                    <option value="">{t('reportCode.home.pickDataset')}</option>
                    {(datasets || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </label>
              )}
              {!artifactId && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">{t('reportCode.home.name')}</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('reportCode.home.nameHint')}
                    className="w-full rounded-lg border border-stroke-strong bg-surface-1 px-3 py-2 text-sm" />
                </label>
              )}
              <div className="rounded-lg border border-brand/20 bg-brand-container p-3 text-[11px] leading-relaxed text-brand-on-container">
                <div className="mb-1 font-semibold">{t('reportCode.pack.title')}</div>
                {t('reportCode.pack.hint')}
                <Button size="xs" variant="secondary" className="mt-2" disabled={datasetId === ''} leadingIcon={<Download className="h-3 w-3" />}
                  onClick={() => datasetId !== '' && downloadContextPack(datasetId, t)} data-testid="paste-context-pack">{t('reportCode.pack.download')}</Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3" data-testid="paste-step-map">
          {analysis.warnings.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">{analysis.warnings.slice(0, 4).map((w) => <div key={w}>• {w}</div>)}</div>
          )}
          {analysis.compatible ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" data-testid="paste-compatible">
              <div className="mb-1 flex items-center gap-2 font-semibold"><Check className="h-4 w-4" />{t('reportCode.paste.compatible')}</div>
              <div className="text-xs">{t('reportCode.paste.compatibleHint', { n: analysis.placeholders.length })}</div>
              <div className="mt-2 flex flex-wrap gap-1">{analysis.placeholders.slice(0, 40).map((p) => <code key={p} className="rounded bg-white/70 px-1.5 text-[11px]">{p}</code>)}</div>
            </div>
          ) : (
            <>
              <p className="text-xs text-text-secondary">{t('reportCode.paste.mapIntro', { n: analysis.slots.length })}</p>
              <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-stroke-strong">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-2 text-left text-[11px] uppercase text-text-tertiary">
                    <tr><th className="px-3 py-2">{t('reportCode.paste.col.where')}</th><th className="px-3 py-2">{t('reportCode.paste.col.data')}</th><th className="px-3 py-2">{t('reportCode.paste.col.viz')}</th><th className="px-3 py-2">{t('reportCode.paste.col.confidence')}</th></tr>
                  </thead>
                  <tbody>
                    {analysis.slots.map((s: ImportSlot) => {
                      const Icon = SLOT_ICON[s.kind];
                      const m = map[s.id] || {};
                      return (
                        <tr key={s.id} className="border-t border-stroke-line align-top" data-testid={`slot-${s.id}`}>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5 font-medium text-text-primary"><Icon className="h-3.5 w-3.5 text-brand" />{t(`reportCode.paste.kind.${s.kind}`)}</div>
                            <div className="mt-0.5 text-text-tertiary">{s.context || '—'}{s.sample ? <> · <code className="text-text-secondary">{s.sample}</code></> : null}</div>
                          </td>
                          <td className="px-3 py-2">
                            {s.kind === 'filter' || s.kind === 'period' ? (
                              <div className="space-y-1">
                                <select data-testid={`slot-${s.id}-dimension`} value={m.dimension || ''} onChange={(e) => setMap({ ...map, [s.id]: { ...m, dimension: e.target.value || null } })}
                                  className="w-full max-w-[280px] rounded-md border border-stroke-strong bg-surface-1 px-2 py-1">
                                  <option value="">{t('reportCode.paste.keep')}</option>
                                  {analysis.dimensions.filter((d) => s.kind !== 'period' || d.kind === 'date').map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                                </select>
                                {(s.kind === 'period' || s.period) && m.dimension ? (
                                  <div className="text-[10px] text-emerald-700" data-testid={`slot-${s.id}-period-note`}>{t(s.kind === 'period' ? 'reportCode.paste.periodText' : 'reportCode.paste.periodFilter')}</div>
                                ) : null}
                              </div>
                            ) : s.kind === 'list' ? (
                              <div className="space-y-1.5" data-testid={`slot-${s.id}-list`}>
                                <select data-testid={`slot-${s.id}-dimension`} value={m.dimension || ''} onChange={(e) => setMap({ ...map, [s.id]: { ...m, dimension: e.target.value || null } })}
                                  className="w-full max-w-[320px] rounded-md border border-stroke-strong bg-surface-1 px-2 py-1">
                                  <option value="">{t('reportCode.paste.listRowsKeep')}</option>
                                  {analysis.dimensions.filter((d) => d.kind !== 'date').map((d) => <option key={d.id} value={d.id}>{t('reportCode.paste.listRowsBy', { dim: d.label })}</option>)}
                                </select>
                                {m.dimension ? (
                                  <div className="grid gap-1">
                                    {(s.columns || []).map((c) => (
                                      <label key={c.index} className="flex items-center gap-1.5">
                                        <code className="w-28 truncate text-[10px] text-text-tertiary" title={c.sample}>{c.sample}</code>
                                        <select data-testid={`slot-${s.id}-col-${c.index}`} value={m.columns?.[String(c.index)] || ''}
                                          onChange={(e) => setMap({ ...map, [s.id]: { ...m, columns: { ...(m.columns || {}), [String(c.index)]: e.target.value || null } } })}
                                          className="min-w-0 flex-1 rounded-md border border-stroke-strong bg-surface-1 px-1.5 py-0.5 text-[11px]">
                                          <option value="">{t('reportCode.paste.colKeep')}</option>
                                          <option value="dim">{t('reportCode.paste.colDim')}</option>
                                          <option value="#">{t('reportCode.paste.colRank')}</option>
                                          {measureOptions.map((c2) => <option key={c2.id} value={c2.id}>{label(c2)}</option>)}
                                        </select>
                                      </label>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <select data-testid={`slot-${s.id}-candidate`} value={m.candidate || ''} onChange={(e) => setMap({ ...map, [s.id]: { ...m, candidate: e.target.value || null } })}
                                className="w-full max-w-[320px] rounded-md border border-stroke-strong bg-surface-1 px-2 py-1">
                                <option value="">{t('reportCode.paste.keepSample')}</option>
                                {s.kind === 'value' ? <option value="static">{t('reportCode.paste.static')}</option> : null}
                                {analysis.candidates.filter((c) => (KIND_FOR[s.kind] || []).includes(c.kind)).map((c) => (
                                  <option key={c.id} value={c.id}>{label(c)}</option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {s.kind === 'chart' || s.kind === 'table' ? (
                              <select value={m.viz || ''} onChange={(e) => setMap({ ...map, [s.id]: { ...m, viz: e.target.value || null } })}
                                className="rounded-md border border-stroke-strong bg-surface-1 px-2 py-1">
                                {VIZ.map((v) => <option key={v} value={v}>{v}</option>)}
                              </select>
                            ) : <span className="text-text-quaternary">—</span>}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.confidence >= 0.7 ? 'bg-emerald-50 text-emerald-700' : s.confidence >= 0.3 ? 'bg-amber-50 text-amber-700' : 'bg-surface-2 text-text-tertiary'}`}>
                              {s.source === 'model' ? 'AI' : t('reportCode.paste.rules')} · {Math.round(s.confidence * 100)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-text-tertiary">{t('reportCode.paste.extraFilters')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {analysis.dimensions.slice(0, 20).map((d) => {
                    const on = extraFilters.includes(d.id);
                    return (
                      <button key={d.id} type="button" onClick={() => setExtraFilters(on ? extraFilters.filter((x) => x !== d.id) : [...extraFilters, d.id])}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] ${on ? 'border-brand bg-brand-container text-brand-on-container' : 'border-stroke-strong text-text-secondary hover:bg-surface-2'}`}>{d.label}</button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          {!analysis.compatible && samples > 0 ? (
            <p className="rounded-md bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800" data-testid="paste-samples">{t('reportCode.paste.samplesLeft', { n: samples })}</p>
          ) : null}
          <p className="flex items-center gap-1.5 text-[11px] text-text-quaternary"><Code2 className="h-3.5 w-3.5" />{t('reportCode.paste.preserve')}</p>
          {busy && <div className="flex items-center gap-2 text-xs text-text-tertiary"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('reportCode.paste.working')}</div>}
        </div>
      )}
    </Modal>
  );
}
