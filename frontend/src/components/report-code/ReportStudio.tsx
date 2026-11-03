'use client';

/**
 * AI Report Studio — Report-as-Code builder.
 *
 * A full-page HTML/CSS/JS report the author writes with AI (prompt, region edits,
 * reference image) or by hand (source editor), previewed live at real device
 * widths, bound to governed data, with append-only versions, publish and rollback.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, Code2, Database, History, Loader2, Monitor, RefreshCw, Rocket, Share2,
  ShieldCheck, Smartphone, Sparkles, Tablet, Wand2, X,
} from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { DevicePreview, type Device } from '@/components/report-code/DevicePreview';
import { ReportFrame, type RuntimeIssue } from '@/components/report-code/ReportFrame';
import { AiPanel, DataPanel } from '@/components/report-code/StudioPanels';
import { CodeWorkspace, type CodeWorkspaceHandle } from '@/components/report-code/CodeWorkspace';
import { PasteCodeWizard } from '@/components/report-code/PasteCodeWizard';
import { PublicLinksManager } from '@/components/common/PublicLinksManager';
import { reportLinkTarget } from '@/components/report-code/reportLinkTarget';
import { reportCodeApi, type ReportDetail, type ReportJob, type ReportRevision } from '@/lib/api/report-code';
import type { FilterState } from '@/lib/report-code/protocol';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

type Tab = 'code' | 'data' | 'ai';

const WIDTH_KEY = 'rac.studio.panelWidth';
const readWidth = () => { try { const v = Number(window.localStorage.getItem(WIDTH_KEY)); return v >= 300 && v <= 1400 ? v : null; } catch { return null; } };

export function ReportStudio({ reportId }: { reportId: number }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<ReportRevision[]>([]);
  const [job, setJob] = useState<ReportJob | null>(null);
  const [tab, setTab] = useState<Tab>('code');
  const [device, setDevice] = useState<Device>('desktop');
  const [selectMode, setSelectMode] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [previewNumber, setPreviewNumber] = useState<number | null>(null);
  const [issues, setIssues] = useState<RuntimeIssue[]>([]);
  const [showIssues, setShowIssues] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [source, setSource] = useState({ html: '', css: '', js: '' });
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const lastJobId = useRef<string | null>(null);
  const workspace = useRef<CodeWorkspaceHandle | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [wide, setWide] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [live, setLive] = useState(true);
  // What the preview shows: the saved draft, or (once edited) a debounced / run copy of the editor.
  const [previewSource, setPreviewSource] = useState<{ html: string; css: string; js: string } | null>(null);
  useEffect(() => {
    setPanelWidth(readWidth());
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const load = useCallback(async () => {
    try {
      const [d, revs] = await Promise.all([reportCodeApi.get(reportId), reportCodeApi.revisions(reportId)]);
      setDetail(d);
      setName(d.name);
      setRevisions(revs);
      setJob(d.job);
      if (d.draft) setSource({ html: d.draft.html || '', css: d.draft.css || '', js: d.draft.js || '' });
      setPreviewSource(null);
      setIssues([]);
    } catch (e: any) {
      setLoadError(e?.response?.data?.detail || e?.message || 'error');
    }
  }, [reportId]);

  useEffect(() => { void load(); }, [load]);

  // Poll the AI job while it runs; any API worker can answer (state is in the DB).
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    lastJobId.current = job.id;
    const timer = setInterval(async () => {
      try {
        const { job: j } = await reportCodeApi.job(reportId);
        setJob(j);
        if (j && j.state !== 'running') {
          clearInterval(timer);
          if (j.state === 'done') {
            toast.success(j.summary || t('reportCode.job.done'));
            (j.notes || []).slice(0, 3).forEach((n) => toast.info(n));
            setRegion(null);
            setPreviewNumber(null);
          } else {
            toast.error(j.error || t('reportCode.job.failed'));
          }
          void load();
        }
      } catch { /* transient — the next tick retries */ }
    }, 1500);
    return () => clearInterval(timer);
  }, [job, reportId, load, t]);

  const draft = detail?.draft || null;
  const editable = detail?.user_permission === 'edit' || detail?.user_permission === 'full';
  const canPublish = detail?.user_permission === 'full';
  const running = job?.state === 'running';
  const shownNumber = previewNumber ?? draft?.number ?? null;
  const dirty = !!draft && (source.html !== draft.html || source.css !== draft.css || source.js !== draft.js);
  const savedSource = useMemo(() => (draft ? { html: draft.html || '', css: draft.css || '', js: draft.js || '' } : null), [draft]);

  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => setPreviewSource(dirty ? source : null), 700);
    return () => clearTimeout(timer);
  }, [live, source, dirty]);
  const runPreview = useCallback(() => { setPreviewSource(dirty ? { ...source } : null); }, [dirty, source]);

  // Leaving with unsaved code asks first (reload / close tab).
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // Bindings/filters of the revision being previewed (an old version may differ).
  const [previewMeta, setPreviewMeta] = useState<{ bindings: { id: string; title: string; kind: string }[]; filters: { key: string; label: string; kind: 'category' | 'date' }[] } | null>(null);
  useEffect(() => {
    setPreviewMeta(null);
    if (!previewNumber) return;
    let alive = true;
    reportCodeApi.revision(reportId, previewNumber).then((r) => {
      if (alive) setPreviewMeta({ bindings: r.bindings || [], filters: r.filters || [] });
    }).catch((e) => toast.error(e?.response?.data?.detail || e?.message));
    return () => { alive = false; };
  }, [previewNumber, reportId]);
  const bindings = useMemo(() => (previewMeta?.bindings || draft?.bindings || []).map((b) => ({ id: b.id, title: b.title, kind: b.kind })), [previewMeta, draft]);
  const filters = useMemo(() => (previewMeta?.filters || draft?.filters || []).map((f) => ({ key: f.key, label: f.label, kind: f.kind })), [previewMeta, draft]);

  const fetchData = useCallback((binding: string, state: FilterState) => reportCodeApi.data(reportId, binding, state, previewNumber), [reportId, previewNumber]);
  const fetchValues = useCallback((key: string, search: string, state: FilterState) => reportCodeApi.values(reportId, key, search, state, previewNumber), [reportId, previewNumber]);
  // An old version is shown only once its own bindings are known, never with the draft's.
  const [doc, setDoc] = useState<{ url: string; isolated: boolean; n: number } | null>(null);
  const [guardState, setGuardState] = useState<{ guard: boolean; authorScript?: 'ran' | 'refused' } | null>(null);
  const wantDoc = shownNumber && (!previewNumber || previewMeta) ? shownNumber : null;
  useEffect(() => {
    setGuardState(null);
    if (!wantDoc) { setDoc(null); return; }
    let alive = true;
    reportCodeApi.documentTicket(reportId, wantDoc)
      .then((t) => { if (alive) setDoc({ url: t.url, isolated: t.isolated, n: wantDoc }); })
      .catch((e) => toast.error(e?.response?.data?.detail || e?.message));
    return () => { alive = false; };
  }, [reportId, wantDoc]);
  const docUrl = doc && doc.n === wantDoc ? doc.url : null;
  // Unsaved code is POSTed to the ticket's /preview (rendered, never stored).
  const postFields = useMemo(
    () => (previewSource && !previewNumber && docUrl ? { html: previewSource.html, css: previewSource.css, js: previewSource.js } : undefined),
    [previewSource, previewNumber, docUrl],
  );
  useEffect(() => { setIssues([]); }, [postFields]);

  const startDrag = (e: React.PointerEvent) => {
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    let last = 0;
    const move = (ev: PointerEvent) => { last = Math.round(Math.max(300, Math.min(box.width - 340, ev.clientX - box.left))); setPanelWidth(last); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { if (last) window.localStorage.setItem(WIDTH_KEY, String(last)); } catch { /* storage off */ }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const linkTarget = useMemo(() => (detail ? reportLinkTarget(detail) : null), [detail]);
  const regionLabel = useMemo(() => draft?.regions?.find((r) => r.id === region)?.label || null, [draft, region]);

  const onIssue = useCallback((issue: RuntimeIssue) => {
    setIssues((prev) => (prev.some((p) => p.message === issue.message) ? prev : [...prev.slice(-19), issue]));
    if (issue.kind === 'security') toast.error(issue.message);
  }, []);

  const submitAi = async (instruction: string, image?: string, allowData = false): Promise<boolean> => {
    // Unsaved code becomes its own version first: the AI edits what the author sees, and it can be undone.
    if (dirty && !(await save())) return false;
    try {
      const { job: j } = await reportCodeApi.aiEdit(reportId, { instruction, region, reference_image: image, allow_data: allowData });
      setJob(j);
      setSelectMode(false);
      return true;
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message);
      return false;
    }
  };

  const fixIssues = () => {
    const text = issues.filter((i) => i.kind !== 'blocked').map((i) => `- ${i.message}`).join('\n');
    if (!text) return;
    void submitAi(`${t('reportCode.issues.fixPrompt')}\n${text}`);
    setShowIssues(false);
    setTab('ai');
  };

  const save = async (): Promise<boolean> => {
    if (!draft || !dirty || saving) return !dirty;
    setSaving(true);
    try {
      const out = await reportCodeApi.saveSource(reportId, { ...source, base_number: draft.number });
      toast.success(t('reportCode.code.saved', { n: out.revision.number }));
      out.warnings.slice(0, 3).forEach((w) => toast.warning(w));
      await load();
      return true;
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const publish = async (revisionId?: number) => {
    if (!detail) return;
    setPublishing(true);
    try {
      const s = await reportCodeApi.publish(reportId, revisionId);
      toast.success(t('reportCode.publish.done', { n: s.published_number ?? '' }));
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || e?.message);
    } finally {
      setPublishing(false);
    }
  };

  const rename = async () => {
    if (!detail || !name.trim() || name.trim() === detail.name) return;
    try { await reportCodeApi.rename(reportId, name.trim()); await load(); } catch (e: any) { toast.error(e?.response?.data?.detail || e?.message); }
  };

  if (loadError) {
    return <div className="p-8 text-sm text-red-600">{loadError}</div>;
  }
  if (!detail) {
    return <div className="flex h-full items-center justify-center text-sm text-text-tertiary"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t('common.loading')}</div>;
  }

  const realIssues = issues.filter((i) => i.kind !== 'blocked' || i.message.includes('removed') || i.message.includes('cancelled'));
  const statusTone = detail.published_number
    ? (detail.has_unpublished_changes ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200')
    : 'bg-surface-2 text-text-tertiary ring-stroke-strong';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2" data-testid="report-studio">
      {/* Header — the same floating bar the Dashboard Builder uses */}
      <div className="app-chrome px-4 pb-2 pt-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-stroke-strong bg-surface-1 px-3 py-2 shadow-linear-sm">
          <Link href="/dashboards/code/new" onClick={(e) => { if (dirty && !window.confirm(t('reportCode.code.leaveUnsaved'))) e.preventDefault(); }} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" aria-label="back" title={t('reportCode.home.title')}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-container text-brand"><Wand2 className="h-4 w-4" /></span>
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} disabled={!editable} data-testid="studio-name"
              className="min-w-[160px] max-w-[380px] rounded-md bg-transparent px-1.5 py-1 text-sm font-semibold text-text-primary outline-none hover:bg-surface-2 focus:bg-surface-2" />
          </div>
          <div className="hidden items-center gap-1.5 md:flex">
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-secondary ring-1 ring-inset ring-stroke-strong" data-testid="studio-draft-badge">
              {t('reportCode.badge.draft')} v{draft?.number ?? '—'}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${statusTone}`} data-testid="studio-published-badge">
              {detail.published_number ? `${t('reportCode.badge.published')} v${detail.published_number}` : t('reportCode.badge.unpublished')}
            </span>
            {detail.has_unpublished_changes && detail.published_number && <span className="text-[11px] text-amber-700">{t('reportCode.badge.changes')}</span>}
            {detail.dataset_name && <span className="ml-1 hidden items-center gap-1 text-[11px] text-text-tertiary xl:inline-flex"><Database className="h-3 w-3" />{detail.dataset_name}</span>}
          </div>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <div className="flex rounded-lg border border-stroke-strong bg-surface-2 p-0.5" role="group" aria-label="device">
              {([['desktop', Monitor], ['tablet', Tablet], ['mobile', Smartphone]] as const).map(([d, Icon]) => (
                <button key={d} type="button" onClick={() => setDevice(d)} data-testid={`device-${d}`} title={t(`reportCode.device.${d}`)}
                  className={`rounded-md px-2 py-1 transition ${device === d ? 'bg-surface-1 text-brand shadow-sm' : 'text-text-tertiary hover:text-text-primary'}`}><Icon className="h-4 w-4" /></button>
              ))}
            </div>
            <Button size="sm" variant="ghost" leadingIcon={<History className="h-3.5 w-3.5" />} onClick={() => setShowVersions(true)} data-testid="studio-versions">{t('reportCode.versions.title')}</Button>
            <Button size="sm" variant="secondary" leadingIcon={<Share2 className="h-3.5 w-3.5" />} onClick={() => setShowShare(true)} data-testid="studio-share">{t('reportCode.share.title')}</Button>
            {canPublish && (
              <Button size="sm" variant="primary" leadingIcon={<Rocket className="h-3.5 w-3.5" />} onClick={() => publish()} data-testid="studio-publish"
                loading={publishing} disabled={!draft || running || dirty || (!detail.has_unpublished_changes && !!detail.published_number)}>
                {t('reportCode.publish.action')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 sm:px-5 lg:flex-row lg:gap-0 lg:overflow-hidden">
        {/* Work panel — resizable on wide screens */}
        <div className={`flex h-[560px] shrink-0 flex-col overflow-hidden rounded-xl border border-stroke-strong bg-surface-1 shadow-linear-sm lg:h-auto lg:min-h-0 ${maximized ? 'lg:flex-1 lg:shrink' : ''}`}
          style={wide && !maximized ? { width: panelWidth ?? (tab === 'code' ? 'min(620px, 50%)' : 400), maxWidth: 'calc(100% - 352px)' } : undefined} data-testid="studio-work-panel">
          <div className="p-2">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1" role="tablist" aria-label="studio">
              {([['code', Code2], ['data', Database], ['ai', Sparkles]] as const).map(([k, Icon]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`studio-tab-${k}`}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${tab === k ? 'bg-surface-1 text-brand shadow-sm' : 'text-text-tertiary hover:text-text-primary'}`}>
                  <Icon className="h-3.5 w-3.5" />{t(`reportCode.tab.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 border-t border-stroke-line">
            <div className={tab === 'code' ? 'h-full' : 'hidden'}>
              <CodeWorkspace ref={workspace} source={source} saved={savedSource} onChange={setSource} onSave={() => { void save(); }}
                onRevert={() => savedSource && setSource(savedSource)} onRun={runPreview} saving={saving} editable={editable}
                live={live} onToggleLive={() => setLive((v) => !v)} maximized={maximized} onToggleMaximize={() => setMaximized((v) => !v)}
                runtimeIssues={issues} warnings={detail.warnings} onPaste={editable ? () => setShowPaste(true) : undefined}
                onAskAiFix={editable ? fixIssues : undefined} />
            </div>
            {tab === 'ai' && (
              <AiPanel detail={detail} revisions={revisions} busy={running} region={region} regionLabel={regionLabel}
                onClearRegion={() => setRegion(null)} onSubmit={submitAi} selectMode={selectMode} onToggleSelect={() => setSelectMode((v) => !v)} />
            )}
            {tab === 'data' && (
              <DataPanel detail={detail} onChanged={load} html={source.html} onPaste={editable ? () => setShowPaste(true) : undefined}
                onInsert={(snippet) => { setTab('code'); workspace.current?.insertHtml(snippet); toast.success(t('reportCode.data.inserted')); }} />
            )}
          </div>
        </div>

        {!maximized && (
          <div role="separator" aria-orientation="vertical" aria-label={t('reportCode.code.resize')} title={t('reportCode.code.resize')} onPointerDown={startDrag}
            onDoubleClick={() => { setPanelWidth(null); try { window.localStorage.removeItem(WIDTH_KEY); } catch { /* storage off */ } }}
            className="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center lg:flex" data-testid="studio-splitter">
            <span className="h-10 w-1 rounded-full bg-stroke-strong transition group-hover:bg-brand" />
          </div>
        )}

        {/* Preview */}
        <div className={`relative h-[640px] min-w-0 shrink-0 overflow-hidden rounded-xl border border-stroke-strong bg-surface-1 shadow-linear-sm lg:h-auto lg:flex-1 lg:shrink ${maximized ? 'hidden' : ''}`} data-testid="studio-preview">
          <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex flex-col items-start gap-1.5">
            {guardState && (
              <span data-testid="studio-guard" title={guardState.guard ? t('reportCode.guard.onHint') : t('reportCode.guard.offHint')}
                className={`pointer-events-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium shadow-sm ring-1 ring-inset ${guardState.guard ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-amber-50 text-amber-800 ring-amber-200'}`}>
                <ShieldCheck className="h-3.5 w-3.5" />{guardState.guard ? t('reportCode.guard.on') : t('reportCode.guard.off')}
              </span>
            )}
          </div>
          {postFields && (
            <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 shadow-sm ring-1 ring-inset ring-amber-200" data-testid="studio-preview-unsaved">
              {t('reportCode.code.previewUnsavedBadge')}
            </div>
          )}
          {previewNumber && (
            <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-900 shadow" data-testid="studio-preview-old">
              {t('reportCode.versions.viewing', { n: previewNumber })}
              <button type="button" onClick={() => setPreviewNumber(null)} className="font-semibold underline">{t('reportCode.versions.backToDraft')}</button>
            </div>
          )}
          {selectMode && (
            <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-brand px-3 py-1 text-xs text-white shadow">{t('reportCode.ai.selectHint')}</div>
          )}
          {docUrl ? (
            <DevicePreview device={device}>
              <ReportFrame
                key={`${docUrl}|${bindings.length}|${filters.length}`}
                src={postFields ? `${docUrl}/preview` : docUrl}
                post={postFields}
                isolated={doc?.isolated}
                onGuard={setGuardState}
                bindings={bindings}
                filters={filters}
                fetchData={fetchData}
                fetchValues={fetchValues}
                mode="studio"
                selectMode={selectMode}
                selectedRegion={region}
                onRegionSelected={(r) => { setRegion(r); setSelectMode(false); setTab('ai'); }}
                onIssue={onIssue}
                title={detail.name}
              />
            </DevicePreview>
          ) : (
            <div className="flex h-full items-center justify-center bg-surface-2 text-sm text-text-tertiary">
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t('reportCode.preview.empty')}
            </div>
          )}

          {running && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-surface-1/70 backdrop-blur-[2px]" data-testid="studio-job">
              <div className="w-[380px] rounded-xl border border-stroke-strong bg-surface-1 p-5 shadow-popover">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-container text-brand"><Sparkles className="h-4 w-4" /></span>
                  {t(`reportCode.job.kind.${job?.kind}`)}
                </div>
                <ol className="space-y-1.5">
                  {(job?.steps || []).map((s, i, arr) => (
                    <li key={`${s}-${i}`} className="flex items-center gap-2 text-xs">
                      {i === arr.length - 1 ? <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" /> : <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-brand text-[9px] text-white">✓</span>}
                      <span className={i === arr.length - 1 ? 'text-text-primary' : 'text-text-tertiary'}>{s}</span>
                    </li>
                  ))}
                  {!job?.steps?.length && <li className="flex items-center gap-2 text-xs"><Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />{job?.step}</li>}
                </ol>
              </div>
            </div>
          )}

          {realIssues.length > 0 && tab !== 'code' && (
            <div className="absolute bottom-3 right-3 z-20 w-[400px] max-w-[calc(100%-24px)]" data-testid="studio-issues">
              {showIssues && (
                <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-stroke-strong bg-surface-1 p-3 text-[11px] shadow-popover">
                  {realIssues.map((i, n) => (
                    <div key={n} className="mb-1.5 flex gap-2">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${i.kind === 'semantic' || i.kind === 'provenance' ? 'bg-amber-50 text-amber-800' : i.kind === 'layout' ? 'bg-brand-container text-brand-on-container' : 'bg-red-50 text-red-700'}`}>{t(`reportCode.issues.kind.${i.kind}`) || i.kind}</span>
                      <span className="text-text-secondary">{i.message}</span>
                    </div>
                  ))}
                  {editable && <Button size="xs" variant="primary" className="mt-2" leadingIcon={<Wand2 className="h-3 w-3" />} onClick={fixIssues} data-testid="studio-fix-issues">{t('reportCode.issues.fix')}</Button>}
                </div>
              )}
              <button type="button" onClick={() => setShowIssues((v) => !v)} className="ml-auto flex items-center gap-1.5 rounded-full bg-text-primary px-3 py-1.5 text-xs font-medium text-white shadow-popover">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />{t('reportCode.issues.count', { n: realIssues.length })}
              </button>
            </div>
          )}
        </div>
      </div>

      {showVersions && (
        <VersionsDrawer reportId={reportId} detail={detail} revisions={revisions} canPublish={canPublish} editable={editable}
          onClose={() => setShowVersions(false)} onPreview={(n) => { setPreviewNumber(n); setShowVersions(false); }}
          onChanged={load} onPublish={publish} />
      )}
      {showShare && (
        <PublicLinksManager dashboardId={detail.id} dashboardName={detail.name} target={linkTarget ?? undefined}
          onClose={() => { setShowShare(false); void load(); }} />
      )}
      {showPaste && (
        <PasteCodeWizard datasetId={detail.dataset_id} artifactId={reportId} onClose={() => setShowPaste(false)}
          onDone={() => { setShowPaste(false); void load(); }} />
      )}
    </div>
  );
}

function VersionsDrawer({ reportId, detail, revisions, canPublish, editable, onClose, onPreview, onChanged, onPublish }: {
  reportId: number; detail: ReportDetail; revisions: ReportRevision[]; canPublish: boolean; editable: boolean;
  onClose: () => void; onPreview: (n: number) => void; onChanged: () => void; onPublish: (revisionId?: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<number | null>(null);
  const restore = async (n: number) => {
    setBusy(n);
    try { await reportCodeApi.restore(reportId, n); toast.success(t('reportCode.versions.restored', { n })); onChanged(); } catch (e: any) { toast.error(e?.response?.data?.detail || e?.message); } finally { setBusy(null); }
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose}>
      <div className="flex h-full w-[420px] flex-col bg-surface-0 shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="versions-drawer">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4" />{t('reportCode.versions.title')}</div>
          <button type="button" onClick={onClose} aria-label="close"><X className="h-4 w-4" /></button>
        </div>
        <p className="border-b border-border px-4 py-2 text-[11px] text-text-tertiary">{t('reportCode.versions.hint')}</p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {revisions.map((r) => (
            <div key={r.id} className="border-b border-border px-4 py-3" data-testid={`version-${r.number}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">v{r.number}</span>
                <span className="text-[11px] text-text-tertiary">{t(`reportCode.source.${r.source}`)}</span>
                {r.is_draft && <span className="rounded bg-surface-3 px-1.5 text-[10px]">{t('reportCode.badge.draft')}</span>}
                {r.is_published && <span className="rounded bg-emerald-100 px-1.5 text-[10px] text-emerald-800">{t('reportCode.badge.published')}</span>}
                <span className="ml-auto text-[10px] text-text-quaternary">{r.created_at ? new Date(r.created_at).toLocaleString('vi-VN') : ''}</span>
              </div>
              {r.note && <div className="mt-1 line-clamp-2 text-xs text-text-secondary">{r.note}</div>}
              <div className="mt-2 flex gap-1.5">
                <Button size="xs" variant="ghost" onClick={() => onPreview(r.number)} data-testid={`version-${r.number}-preview`}>{t('reportCode.versions.preview')}</Button>
                {editable && !r.is_draft && <Button size="xs" variant="ghost" leadingIcon={<RefreshCw className="h-3 w-3" />} loading={busy === r.number} onClick={() => restore(r.number)} data-testid={`version-${r.number}-restore`}>{t('reportCode.versions.restore')}</Button>}
                {canPublish && !r.is_published && (
                  <Button size="xs" variant="secondary" leadingIcon={<Rocket className="h-3 w-3" />} onClick={() => onPublish(r.id)} data-testid={`version-${r.number}-publish`}>
                    {r.is_draft ? t('reportCode.publish.action') : t('reportCode.versions.rollback')}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {!revisions.length && <div className="p-4 text-xs text-text-tertiary">{t('reportCode.versions.empty')}</div>}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] text-text-tertiary">{detail.last_published_at ? t('reportCode.versions.lastPublished', { at: new Date(detail.last_published_at).toLocaleString('vi-VN') }) : ''}</div>
      </div>
    </div>
  );
}
