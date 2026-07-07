'use client';

/**
 * Govern — ONE surface built on the standard module layout, exactly like
 * Observability / Datasets: a searchable LIST of business documents
 * (PageListLayout + ModuleOverview), and opening a document drills into a
 * DetailShell with pill Tabs (Nội dung / Chỉ số / Liên kết / Lịch sử).
 *
 * A business document is long-form markdown carrying {{metric:…}} and
 * {{dashboard|dataset|term:…}} tokens the backend resolves into cards +
 * cross-links. Metrics (KPIs) are authored INSIDE documents (SSOT); master
 * vocabulary lives in the "Từ điển & Nhãn" modal (owned by the parent page).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type ChangeEvent } from 'react';
import Link from 'next/link';
import {
  BookOpen, Compass, Boxes, Workflow, HelpCircle, FileText, Sigma, LayoutDashboard, Database,
  Tag as TagIcon, History, Plus, Pencil, Trash2, Save, X, Pin, ChevronLeft, ChevronRight,
  ExternalLink, AlertTriangle, Loader2, Library, Search, Upload, Sparkles,
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code, Link2, Table, Eye,
  GitBranch, ShieldCheck, ArrowRight, Clock3, BookCheck, MessageCircleQuestion,
} from 'lucide-react';

import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { FilterTag } from '@/components/ui/FilterTag';
import { Button } from '@/components/ui/Button';
import { AiButton } from '@/components/ui/AiButton';
import { Input, Textarea, Label, Select } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { useUrlNav } from '@/hooks/use-url-nav';
import { useI18n } from '@/providers/LanguageProvider';
import {
  listKnowledge, getKnowledgeDoc, upsertKnowledgeDoc, deleteKnowledgeDoc, listManagedMetrics,
  listDocVersions, getDocVersion, aiDraftKnowledge, listDatasetsLite, governSearch, regenAiSummary, verifyDoc,
  type KnowledgeDoc, type KnowledgeSpace, type KnowledgeDocWrite, type KnowledgeAsset, type ManagedMetric,
  type KnowledgeDocVersion, type DatasetLite, type GovernSearchResult, type RelatedDoc,
} from '@/lib/catalog';
import { AppModalShell } from '@/components/common/AppModalShell';
import { Markdown, DOC_TYPES, STATUS_TONE, docTypeLabel, managedTargetLabel, statusLabel } from './knowledge-markdown';
import { docTemplate } from './doc-templates';
import { MetricFormModal } from './MetricForm';

function errDetail(e: unknown): string | undefined {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}

/** Rough HTML → readable text/markdown for imported .html files (no deps). */
function htmlToText(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, t) => `\n${'#'.repeat(Number(lvl))} ${t}\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${t}\n`);
  s = s.replace(/<\/(p|div|tr|br|table|ul|ol)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

function newDoc(space = 'Chung'): KnowledgeDocWrite {
  return { title: '', space, doc_type: 'article', status: 'Draft', pinned: false, tags: [], related_metrics: [], related_terms: [] };
}

/** Rebuild a write payload from a fetched doc so a partial update doesn't blank fields. */
function docToWrite(d: KnowledgeDoc, patch: Partial<KnowledgeDocWrite> = {}): KnowledgeDocWrite {
  return {
    id: d.id, title: d.title, space: d.space, parent_id: d.parent_id ?? null, doc_type: d.doc_type,
    summary: d.summary ?? '', body: d.body ?? '', status: d.status, pinned: d.pinned, owner: d.owner ?? '',
    tags: d.tags ?? [], related_terms: d.related_terms ?? [], related_metrics: d.related_metrics ?? [],
    related_dashboard_ids: d.related_dashboard_ids ?? [], related_dataset_ids: d.related_dataset_ids ?? [],
    business_domain: d.business_domain ?? '', process_ref: d.process_ref ?? '',
    review_date: d.review_date ?? null, importance: d.importance ?? 'normal',
    ...patch,
  };
}

const DOC_TYPE_ICON: Record<string, ReactNode> = {
  overview: <Compass className="h-4 w-4" />, guide: <BookOpen className="h-4 w-4" />,
  domain: <Boxes className="h-4 w-4" />, process: <Workflow className="h-4 w-4" />,
  sop: <BookCheck className="h-4 w-4" />, report: <LayoutDashboard className="h-4 w-4" />,
  ai_knowhow: <MessageCircleQuestion className="h-4 w-4" />,
  faq: <HelpCircle className="h-4 w-4" />, article: <FileText className="h-4 w-4" />,
};

// ── AI-readiness helpers (shared by list + detail) ───────────────────────────
function readyTone(score: number): string {
  return score >= 80 ? 'bg-success/10 text-success' : score >= 50 ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger';
}
const READY_HINT_KEY: Record<string, string> = {
  summary: 'govern.ready.summary', tags: 'govern.ready.tags', owner: 'govern.ready.owner',
  headings: 'govern.ready.headings', links: 'govern.ready.links', context: 'govern.ready.context',
  review: 'govern.ready.review', embedded: 'govern.ready.embedded',
};
/** ~200 wpm reading time from a markdown body. */
function readingMinutes(body: string | undefined | null): number {
  const words = (body || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
function relTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  // Backend timestamps are naive UTC — anchor them so local offsets don't shift.
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const dt = new Date(normalized).getTime();
  const mins = Math.floor((Date.now() - dt) / 60000);
  if (mins < 1) return locale === 'vi' ? 'vừa xong' : 'just now';
  if (mins < 60) return locale === 'vi' ? `${mins} phút trước` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return locale === 'vi' ? `${hrs} giờ trước` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return locale === 'vi' ? `${days} ngày trước` : `${days}d ago`;
  return new Date(normalized).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US');
}
/** Compose the human "why related" line from the shared-signal buckets. */
function relatedReason(r: RelatedDoc, t: (k: string) => string): string {
  const parts: string[] = [];
  if (r.shared_metrics?.length) parts.push(`${t('govern.related.sharedMetrics')}: ${r.shared_metrics.join(', ')}`);
  if (r.shared_dashboards?.length) parts.push(`${t('govern.related.sharedDashboards')}: ${r.shared_dashboards.join(', ')}`);
  if (r.shared_datasets?.length) parts.push(`${t('govern.related.sharedDatasets')}: ${r.shared_datasets.join(', ')}`);
  if (r.shared_tags?.length) parts.push(`${t('govern.related.sharedTags')}: ${r.shared_tags.join(', ')}`);
  return parts.join(' · ');
}
const docIcon = (t: string) => DOC_TYPE_ICON[t] ?? <FileText className="h-4 w-4" />;

const ASSET_ICON: Record<KnowledgeAsset['type'], ReactNode> = {
  dashboard: <LayoutDashboard className="h-4 w-4" />, dataset: <Database className="h-4 w-4" />, term: <TagIcon className="h-4 w-4" />,
};

type MetricModalState = { machineName: string | null; homeDocId: number | null; onCreated?: (mn: string) => void };

// ═══════════════════════════════════ Root ═══════════════════════════════════
export function KnowledgeTab({ nav, onOpenVocab }: { nav: ReturnType<typeof useUrlNav>; onOpenVocab?: () => void }) {
  const { t } = useI18n();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [managed, setManaged] = useState<ManagedMetric[]>([]);
  const [metricModal, setMetricModal] = useState<MetricModalState | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [seed, setSeed] = useState<KnowledgeDocWrite | null>(null);  // AI-draft prefill for a new doc

  const docParam = nav.get('doc');
  const selId = docParam ? Number(docParam) : null;
  const mode = nav.get('m'); // 'new' | 'edit' | null

  const loadList = useCallback(async () => {
    setLoading(true);
    try { const { docs: d, spaces: s } = await listKnowledge(); setDocs(d); setSpaces(s); }
    catch { toast.error(t('govern.detail.listLoadFailed')); }
    finally { setLoading(false); }
  }, [t]);
  const loadManaged = useCallback(() => { listManagedMetrics().then(setManaged).catch(() => {}); }, []);
  useEffect(() => { void loadList(); loadManaged(); }, [loadList, loadManaged]);

  const openDoc = (id: number) => { setSeed(null); nav.set({ doc: String(id), m: null, dt: null }); };
  const openList = () => { setSeed(null); nav.set({ doc: null, m: null, dt: null }); };
  const startNew = () => { setSeed(null); nav.set({ doc: null, m: 'new' }); };
  const startEdit = () => nav.set({ m: 'edit' });

  const openMetric = (s: MetricModalState) => setMetricModal(s);
  const afterMetricChange = async () => { loadManaged(); };

  // AI-drafted doc → open the editor pre-filled (as a new Draft) for review.
  const onAiDrafted = (draft: KnowledgeDocWrite) => { setSeed({ ...draft, status: 'Draft' }); setAiOpen(false); nav.set({ doc: null, m: 'new' }); };

  let screen: ReactNode;
  if (mode === 'new' || (selId && mode === 'edit')) {
    screen = (
      <EditorScreen
        docId={mode === 'edit' ? selId : null} seed={mode === 'new' ? seed : null} managed={managed}
        onCancel={() => (selId ? openDoc(selId) : openList())}
        onSaved={(id) => { void loadList(); openDoc(id); }}
        onOpenMetric={openMetric}
      />
    );
  } else if (selId) {
    screen = (
      <DetailScreen
        docId={selId} nav={nav} managed={managed}
        onBack={openList} onEdit={startEdit}
        onDeleted={() => { void loadList(); openList(); }}
        onOpenMetric={openMetric} onListChanged={loadList} onOpenDoc={openDoc}
      />
    );
  } else {
    screen = (
      <ListScreen docs={docs} spaces={spaces} loading={loading} managed={managed}
        onOpen={openDoc} onNew={startNew} onOpenVocab={onOpenVocab} onAiWrite={() => setAiOpen(true)}
        onOpenMetric={(mn) => openMetric({ machineName: mn, homeDocId: null })} />
    );
  }

  return (
    <>
      {screen}
      {aiOpen && <AiWriteModal onClose={() => setAiOpen(false)} onDrafted={onAiDrafted} />}
      {metricModal && (
        <MetricFormModal
          machineName={metricModal.machineName}
          defaultHomeDocId={metricModal.homeDocId}
          onClose={() => setMetricModal(null)}
          onChanged={afterMetricChange}
          onCreated={(mn) => metricModal.onCreated?.(mn)}
          onOpenDoc={(id) => { setMetricModal(null); openDoc(id); }}
        />
      )}
    </>
  );
}

// ═════════════════════════════════ List ═════════════════════════════════════
type HealthKey = 'noOwner' | 'noSummary' | 'staleReview' | 'notEmbedded' | 'mostViewed' | 'mostRetrieved';

function ListScreen({ docs, spaces, loading, managed, onOpen, onNew, onOpenVocab, onAiWrite, onOpenMetric }: {
  docs: KnowledgeDoc[]; spaces: KnowledgeSpace[]; loading: boolean; managed: ManagedMetric[];
  onOpen: (id: number) => void; onNew: () => void; onOpenVocab?: () => void; onAiWrite: () => void;
  onOpenMetric: (machineName: string) => void;
}) {
  const { t, language } = useI18n();
  const [space, setSpace] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthKey | null>(null);
  const [q, setQ] = useState('');
  const [searchRes, setSearchRes] = useState<GovernSearchResult | null>(null);

  // Search-everything: debounce → grouped results panel above the table.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) { setSearchRes(null); return; }
    const h = setTimeout(() => {
      governSearch(needle).then(setSearchRes).catch(() => setSearchRes(null));
    }, 300);
    return () => clearTimeout(h);
  }, [q]);

  // Knowledge-health sets — computed from the list payload (ai_ready + counters).
  const healthSets = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const ids = (pred: (d: KnowledgeDoc) => boolean) => new Set(docs.filter(pred).map((d) => d.id));
    const top = (key: 'view_count' | 'retrieval_count') => new Set(
      [...docs].filter((d) => (d[key] ?? 0) > 0).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, 8).map((d) => d.id),
    );
    return {
      noOwner: ids((d) => !(d.owner || '').trim()),
      noSummary: ids((d) => !((d.summary || '').trim() || (d.ai_summary || '').trim())),
      staleReview: ids((d) => !!d.review_date && d.review_date < today),
      notEmbedded: ids((d) => (d.ai_ready?.missing ?? []).includes('embedded')),
      mostViewed: top('view_count'),
      mostRetrieved: top('retrieval_count'),
    } as Record<HealthKey, Set<number>>;
  }, [docs]);

  const avgReady = useMemo(() => {
    const scores = docs.map((d) => d.ai_ready?.score ?? 0);
    return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  }, [docs]);
  const needsReview = useMemo(() => {
    const s = new Set<number>([...healthSets.noOwner, ...healthSets.noSummary, ...healthSets.staleReview]);
    return s.size;
  }, [healthSets]);

  const HEALTH_CHIPS: { key: HealthKey; label: string }[] = [
    { key: 'noOwner', label: t('govern.insight.noOwner') },
    { key: 'noSummary', label: t('govern.insight.noSummary') },
    { key: 'staleReview', label: t('govern.insight.staleReview') },
    { key: 'notEmbedded', label: t('govern.insight.notEmbedded') },
    { key: 'mostViewed', label: t('govern.insight.mostViewed') },
    { key: 'mostRetrieved', label: t('govern.insight.mostRetrieved') },
  ];

  return (
    <PageListLayout
      title={t('govern.page.title')}
      description={t('govern.page.description')}
      overview={(
        <ModuleOverview
          stats={[
            { label: t('govern.stats.documents'), value: docs.length, helper: t('govern.stats.documentsHelper') },
            { label: t('govern.stats.metrics'), value: managed.length, helper: t('govern.stats.metricsHelper') },
            { label: t('govern.stats.aiReady'), value: `${avgReady}%`, helper: t('govern.stats.aiReadyHelper') },
            { label: t('govern.stats.needsReview'), value: needsReview, helper: t('govern.stats.needsReviewHelper') },
            { label: t('govern.stats.spaces'), value: spaces.length, helper: t('govern.stats.spacesHelper') },
          ]}
        />
      )}
      action={(
        <div className="flex items-center gap-2">
          {onOpenVocab && <Button variant="secondary" leadingIcon={<Library className="h-4 w-4" />} onClick={onOpenVocab}>{t('govern.action.vocab')}</Button>}
          <AiButton size="md" onClick={onAiWrite}>{t('govern.action.aiWrite')}</AiButton>
          <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={onNew}>{t('govern.action.createDocument')}</Button>
        </div>
      )}
      isLoading={loading}
      loadingText={t('govern.loading')}
      searchPlaceholder={t('govern.search.placeholder')}
      searchValue={q}
      onSearchValueChange={setQ}
      viewToggle={false}
      toolbarExtra={(
        <div className="flex items-center gap-1.5">
          <FilterTag tone="brand" active={space === null && health === null} onClick={() => { setSpace(null); setHealth(null); }}>{t('govern.filter.all')}</FilterTag>
          {spaces.map((s) => (
            <FilterTag key={s.space} tone="brand" active={space === s.space} onClick={() => setSpace(space === s.space ? null : s.space)}>
              {s.space} ({s.count})
            </FilterTag>
          ))}
          <div className="mx-1 h-4 w-px bg-surface-3" />
          {HEALTH_CHIPS.map((c) => (
            <FilterTag key={c.key} tone="warning" active={health === c.key} onClick={() => setHealth(health === c.key ? null : c.key)}>
              {c.label} ({healthSets[c.key].size})
            </FilterTag>
          ))}
        </div>
      )}
    >
      {({ filterText }) => {
        const needle = filterText.trim().toLowerCase();
        const rows = docs
          .filter((d) =>
            (space === null || d.space === space)
            && (health === null || healthSets[health].has(d.id))
            && (!needle || `${d.title} ${d.summary ?? ''} ${d.ai_summary ?? ''} ${d.space} ${(d.tags ?? []).join(' ')} ${(d.ai_keywords ?? []).join(' ')}`.toLowerCase().includes(needle)))
          .sort((a, b) => {
            if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
            return (b.updated_at || '').localeCompare(a.updated_at || '');
          });

        const searchPanel = q.trim().length >= 2 && searchRes ? (
          <HubSearchPanel res={searchRes} q={q.trim()} onOpenDoc={onOpen} onOpenMetric={onOpenMetric} onOpenVocab={onOpenVocab} />
        ) : null;

        if (docs.length === 0) {
          return (
            <div className="py-16 text-center">
              <BookOpen className="mx-auto mb-4 h-14 w-14 text-text-quaternary" />
              <h2 className="mb-2 text-small font-strong text-text-primary">{t('govern.empty.title')}</h2>
              <p className="mb-4 text-caption text-text-tertiary">{t('govern.empty.body')}</p>
              <Button variant="primary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={onNew}>{t('govern.action.createDocument')}</Button>
            </div>
          );
        }
        if (rows.length === 0) {
          return (
            <div className="space-y-3">
              {searchPanel}
              <div className="flex h-48 flex-col items-center justify-center text-center">
                <Search className="mb-2 h-8 w-8 text-text-quaternary" />
                <p className="text-caption text-text-tertiary">{t('govern.empty.noMatches')}</p>
              </div>
            </div>
          );
        }
        return (
          <div className="space-y-3">
          {searchPanel}
          <PaginatedCollection items={rows} viewMode="list" resetKey={`${filterText}|${space ?? ''}|${health ?? ''}`}>
            {({ pageItems, pagination, hasFooter }) => (
              <div>
                <div className={cn('border border-[rgb(var(--border-line))] bg-surface-1', hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl')}>
                  <div className="app-list-table-wrap">
                    <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                      <thead className="bg-surface-2"><tr>
                        <th className="app-list-header w-[32%]">{t('govern.list.header.document')}</th>
                        <th className="app-list-header w-[12%]">{t('govern.list.header.space')}</th>
                        <th className="app-list-header w-[10%]">{t('govern.list.header.type')}</th>
                        <th className="app-list-header w-[8%]">{t('govern.list.header.metrics')}</th>
                        <th className="app-list-header w-[8%]">{t('govern.list.header.links')}</th>
                        <th className="app-list-header w-[9%]">{t('govern.list.header.aiReady')}</th>
                        <th className="app-list-header w-[11%]">{t('govern.list.header.status')}</th>
                        <th className="app-list-header w-[10%]">{t('govern.list.header.updated')}</th>
                        <th className="app-list-header w-[40px] text-right" />
                      </tr></thead>
                      <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                        {pageItems.map((d) => {
                          const links = (d.related_dashboard_ids?.length ?? 0) + (d.related_dataset_ids?.length ?? 0);
                          const score = d.ai_ready?.score ?? 0;
                          return (
                            <tr key={d.id} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen(d.id)}>
                              <td className="app-list-cell">
                                <span className="flex w-full items-start gap-3 text-left">
                                  <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                                    {d.pinned ? <Pin className="h-4 w-4" /> : docIcon(d.doc_type)}
                                  </span>
                                  <span className="min-w-0">
                                    <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{d.title}</span>
                                    {(d.summary || d.ai_summary) && <span className="app-list-text-sub mt-0.5 block text-tiny text-text-quaternary line-clamp-1">{d.summary || d.ai_summary}</span>}
                                  </span>
                                </span>
                              </td>
                              <td className="app-list-cell"><span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{d.space}</span></td>
                              <td className="app-list-cell text-caption text-text-tertiary">{docTypeLabel(d.doc_type, t)}</td>
                              <td className="app-list-cell">
                                {d.related_metrics?.length
                                  ? <span className="inline-flex items-center gap-1 text-caption text-text-secondary"><Sigma className="h-3.5 w-3.5 text-text-quaternary" />{d.related_metrics.length}</span>
                                  : <span className="text-tiny text-text-quaternary">—</span>}
                              </td>
                              <td className="app-list-cell">
                                {links
                                  ? <span className="inline-flex items-center gap-1 text-caption text-text-secondary"><LayoutDashboard className="h-3.5 w-3.5 text-text-quaternary" />{links}</span>
                                  : <span className="text-tiny text-text-quaternary">—</span>}
                              </td>
                              <td className="app-list-cell">
                                <span className={cn('rounded-full px-2 py-0.5 text-tiny font-emphasis', readyTone(score))} title={(d.ai_ready?.missing ?? []).map((k) => t(READY_HINT_KEY[k] || k)).join(' · ')}>
                                  {score}%
                                </span>
                              </td>
                              <td className="app-list-cell">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className={cn('rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[d.status] || 'bg-surface-2 text-text-tertiary')}>{statusLabel(d.status, t)}</span>
                                  <span className="text-tiny text-text-quaternary">v{d.version}</span>
                                </span>
                              </td>
                              <td className="app-list-cell text-tiny text-text-quaternary"><Clock3 className="mr-1 inline h-3 w-3" />{relTime(d.updated_at, language)}</td>
                              <td className="app-list-cell-tight text-right"><ChevronRight className="inline h-4 w-4 text-text-quaternary" /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
                {pagination}
              </div>
            )}
          </PaginatedCollection>
          </div>
        );
      }}
    </PageListLayout>
  );
}

// ── Search-everything results panel (documents · KPIs · terms · dashboards · datasets) ──
function HubSearchPanel({ res, q, onOpenDoc, onOpenMetric, onOpenVocab }: {
  res: GovernSearchResult; q: string;
  onOpenDoc: (id: number) => void; onOpenMetric: (machineName: string) => void; onOpenVocab?: () => void;
}) {
  const { t } = useI18n();
  const total = res.documents.length + res.metrics.length + res.terms.length + res.dashboards.length + res.datasets.length;
  const groups: { key: string; label: string; icon: ReactNode; items: { id: string | number; name: string; subtitle?: string; open_path?: string }[]; onPick?: (id: string | number, path?: string) => void }[] = [
    { key: 'documents', label: t('govern.search.gDocuments'), icon: <FileText className="h-3.5 w-3.5" />, items: res.documents, onPick: (id) => onOpenDoc(Number(id)) },
    { key: 'metrics', label: t('govern.search.gMetrics'), icon: <Sigma className="h-3.5 w-3.5" />, items: res.metrics, onPick: (id) => onOpenMetric(String(id)) },
    { key: 'terms', label: t('govern.search.gTerms'), icon: <TagIcon className="h-3.5 w-3.5" />, items: res.terms, onPick: () => onOpenVocab?.() },
    { key: 'dashboards', label: t('govern.search.gDashboards'), icon: <LayoutDashboard className="h-3.5 w-3.5" />, items: res.dashboards },
    { key: 'datasets', label: t('govern.search.gDatasets'), icon: <Database className="h-3.5 w-3.5" />, items: res.datasets },
  ];
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      {total === 0 ? (
        <p className="px-1 py-2 text-caption text-text-tertiary">{t('govern.search.empty', { q })}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {groups.filter((g) => g.items.length > 0).map((g) => (
            <div key={g.key} className="min-w-0">
              <p className="mb-1.5 flex items-center gap-1.5 px-1 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">{g.icon}{g.label}</p>
              <ul className="space-y-0.5">
                {g.items.map((it) => {
                  const inner = (
                    <>
                      <span className="block truncate text-caption text-text-secondary">{it.name}</span>
                      {it.subtitle && <span className="block truncate text-tiny text-text-quaternary">{it.subtitle}</span>}
                    </>
                  );
                  return (
                    <li key={`${g.key}:${it.id}`}>
                      {it.open_path ? (
                        <Link href={it.open_path} className="block rounded-md px-1.5 py-1 hover:bg-surface-2">{inner}</Link>
                      ) : (
                        <button type="button" onClick={() => g.onPick?.(it.id, it.open_path)} className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2">{inner}</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Same outer chrome (padding + scroll) as PageListLayout, for full-pane detail/editor. */
function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col px-4 pt-6 sm:px-6 xl:px-8">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</div>
    </div>
  );
}

// ═══════════════════════════════ Detail ═════════════════════════════════════
const DETAIL_TABS = [
  { key: 'noidung', labelKey: 'govern.detail.tab.content', icon: <FileText className="h-4 w-4" /> },
  { key: 'chiso', labelKey: 'govern.detail.tab.metrics', icon: <Sigma className="h-4 w-4" /> },
  { key: 'lienket', labelKey: 'govern.detail.tab.links', icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: 'dothi', labelKey: 'govern.detail.tab.graph', icon: <GitBranch className="h-4 w-4" /> },
  { key: 'lichsu', labelKey: 'govern.detail.tab.history', icon: <History className="h-4 w-4" /> },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['key'];

function DetailScreen({ docId, nav, onBack, onEdit, onDeleted, onOpenMetric, onListChanged, onOpenDoc }: {
  docId: number; nav: ReturnType<typeof useUrlNav>; managed: ManagedMetric[];
  onBack: () => void; onEdit: () => void; onDeleted: () => void;
  onOpenMetric: (s: MetricModalState) => void; onListChanged: () => Promise<void> | void;
  onOpenDoc: (id: number) => void;
}) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<KnowledgeDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const articleRef = useRef<HTMLDivElement>(null);
  const tab = (nav.get('dt') as DetailTab) || 'noidung';
  const setTab = (t: string) => nav.set({ dt: t });

  useEffect(() => {
    let on = true;
    setLoading(true);
    getKnowledgeDoc(docId)
      .then((d) => { if (on) setDoc(d); })
      .catch(() => { if (on) { setDoc(null); toast.error(t('govern.detail.openFailed')); } })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [docId, refresh, t]);

  const remove = async () => {
    if (!doc || !window.confirm(t('govern.detail.deleteConfirm', { name: doc.title }))) return;
    try { await deleteKnowledgeDoc(doc.id); toast.success(t('govern.action.deleted')); onDeleted(); }
    catch { toast.error(t('govern.action.deleteFailed')); }
  };

  // Define a NEW metric homed to this doc → append its token to the body & save.
  const defineMetric = () => {
    if (!doc) return;
    onOpenMetric({
      machineName: null, homeDocId: doc.id,
      onCreated: async (mn) => {
        try {
          const body = `${doc.body ?? ''}${(doc.body ?? '').trim() ? '\n\n' : ''}{{metric:${mn}}}`;
          await upsertKnowledgeDoc(docToWrite(doc, { body, change_note: t('govern.detail.metricChangeNote', { name: mn }) }));
          await onListChanged(); setRefresh((v) => v + 1);
        } catch (e) { toast.error(errDetail(e) || t('govern.detail.attachMetricFailed')); }
      },
    });
  };
  const editMetric = (machineName: string) => onOpenMetric({
    machineName, homeDocId: null, onCreated: undefined,
  });

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div>;
  if (!doc) return (
    <div className="flex h-full flex-col px-4 pt-6 sm:px-6 xl:px-8">
      <button onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary"><ChevronLeft className="h-3.5 w-3.5" /> {t('govern.detail.back')}</button>
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center">
        <p className="text-small font-emphasis text-text-primary">{t('govern.detail.loadFailed')}</p>
      </div>
    </div>
  );

  const metrics = doc.metrics_on_page ?? [];
  const assets = doc.assets_on_page ?? [];
  const related = doc.related_docs ?? [];
  const items = DETAIL_TABS.map((tabItem) => ({
    key: tabItem.key, icon: tabItem.icon,
    label: tabItem.key === 'chiso' && metrics.length ? `${t('govern.detail.tab.metrics')} · ${metrics.length}`
      : tabItem.key === 'lienket' && assets.length ? `${t('govern.detail.tab.links')} · ${assets.length}` : t(tabItem.labelKey),
  }));

  // On-this-page outline (## / ### headings) → wayfinding in the context rail.
  const toc = (doc.body || '').split('\n').reduce<{ level: number; text: string }[]>((acc, raw) => {
    const m = raw.match(/^(#{1,3})\s+(.*)$/);
    if (m) acc.push({ level: m[1].length, text: m[2].replace(/\{\{[^}]+\}\}/g, '').replace(/[*`]/g, '').trim() });
    return acc;
  }, []);
  const jumpTo = (text: string) => {
    const el = articleRef.current; if (!el) return;
    const h = Array.from(el.querySelectorAll('h1,h2,h3')).find((n) => (n.textContent || '').trim() === text);
    h?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Standard detail header bar — SAME chrome as Dataset/Explore detail:
             h-11 strip, border-b, bg-surface-1: breadcrumb / tabs / actions ── */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-text-tertiary transition-colors hover:text-text-primary">
          <ChevronLeft className="h-4 w-4" />
          {t('govern.detail.back')}
        </button>
        <span className="text-text-quaternary">/</span>
        <span className="max-w-[220px] truncate text-sm font-medium text-text-primary xl:max-w-[360px]">{doc.title}</span>
        <div className="mx-1 h-5 w-px bg-surface-3" />
        <Tabs<DetailTab> size="sm" value={tab} onChange={setTab} items={items} />
        <div className="flex-1" />
        <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>{t('govern.action.edit')}</Button>
        <Button size="sm" variant="ghost" leadingIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>{t('govern.action.delete')}</Button>
      </div>

      {/* content — reading surface: readable column + right context rail (fills
          the width with document context, not stretched prose). Data tabs go full-width. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-6 sm:px-6 xl:px-8 [scrollbar-gutter:stable]">
        {tab === 'noidung' ? (
          <div className="flex gap-8 xl:gap-12">
            <article ref={articleRef} className="min-w-0 flex-1">
              <div className="max-w-[46rem]">
                <DocHeader doc={doc} />
                <ContentTab doc={doc} />
              </div>
            </article>
            <DetailRail doc={doc} toc={toc} related={related} metrics={metrics} assets={assets} onTab={setTab} onOpenDoc={onOpenDoc} onJump={jumpTo} onRefresh={() => setRefresh((v) => v + 1)} />
          </div>
        ) : (
          <div className="w-full">
            <DocHeader doc={doc} />
            {tab === 'chiso' && <MetricsTab doc={doc} onDefine={defineMetric} onEdit={editMetric} />}
            {tab === 'lienket' && <LinksTab doc={doc} />}
            {tab === 'dothi' && <GraphTab doc={doc} onOpenDoc={onOpenDoc} onEditMetric={editMetric} />}
            {tab === 'lichsu' && <HistoryTab docId={doc.id} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Knowledge-graph neighborhood (LineageTab-style: columns + arrows, no deps) ──
function GraphNode({ icon, title, sub, tone, onClick, href }: {
  icon: ReactNode; title: string; sub?: string; tone?: string; onClick?: () => void; href?: string;
}) {
  const inner = (
    <span className="flex min-w-0 items-start gap-2">
      <span className={cn('mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md', tone || 'bg-brand/10 text-brand')}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-caption font-emphasis text-text-primary">{title}</span>
        {sub && <span className="block truncate text-tiny text-text-quaternary">{sub}</span>}
      </span>
    </span>
  );
  const cls = 'block w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-2 text-left transition-colors hover:border-brand/40 hover:bg-surface-2';
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
  return <div className={cls.replace(' hover:border-brand/40 hover:bg-surface-2', '')}>{inner}</div>;
}

function GraphTab({ doc, onOpenDoc, onEditMetric }: {
  doc: KnowledgeDoc; onOpenDoc: (id: number) => void; onEditMetric: (machineName: string) => void;
}) {
  const { t } = useI18n();
  const metrics = doc.metrics_on_page ?? [];
  const assets = doc.assets_on_page ?? [];
  const related = doc.related_docs ?? [];
  if (metrics.length === 0 && assets.length === 0 && related.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center">
        <GitBranch className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
        <p className="text-caption text-text-tertiary">{t('govern.graph.empty')}</p>
      </div>
    );
  }
  const col = 'flex-1 min-w-[220px] space-y-2';
  const head = 'mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary';
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className={col}>
          <p className={head}><FileText className="h-3.5 w-3.5" />{t('govern.graph.thisDoc')}</p>
          <GraphNode icon={docIcon(doc.doc_type)} title={doc.title} sub={doc.space} />
        </div>
        {metrics.length > 0 && (
          <>
            <ArrowRight className="mt-9 h-4 w-4 flex-shrink-0 text-text-quaternary" />
            <div className={col}>
              <p className={head}><Sigma className="h-3.5 w-3.5" />{t('govern.graph.kpis')}</p>
              {metrics.map((m) => (
                <GraphNode key={m.machine_name} icon={<Sigma className="h-3.5 w-3.5" />} title={m.name}
                  sub={m.is_source ? t('govern.metrics.sourceRole') : t('govern.metrics.reusedRole')}
                  onClick={() => onEditMetric(m.machine_name)} />
              ))}
            </div>
          </>
        )}
        {assets.length > 0 && (
          <>
            <ArrowRight className="mt-9 h-4 w-4 flex-shrink-0 text-text-quaternary" />
            <div className={col}>
              <p className={head}><LayoutDashboard className="h-3.5 w-3.5" />{t('govern.graph.assets')}</p>
              {assets.map((a) => (
                <GraphNode key={`${a.type}:${a.ref}`}
                  icon={a.type === 'dashboard' ? <LayoutDashboard className="h-3.5 w-3.5" /> : a.type === 'dataset' ? <Database className="h-3.5 w-3.5" /> : <TagIcon className="h-3.5 w-3.5" />}
                  title={a.name || a.ref} sub={t(`govern.asset.${a.type}`)}
                  href={a.exists && a.open_path ? a.open_path : undefined} />
              ))}
            </div>
          </>
        )}
      </div>
      {related.length > 0 && (
        <div>
          <p className={head}><BookOpen className="h-3.5 w-3.5" />{t('govern.graph.related')}</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {related.map((r) => (
              <GraphNode key={r.id} icon={<FileText className="h-3.5 w-3.5" />} title={r.title}
                sub={relatedReason(r, t)} onClick={() => onOpenDoc(r.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// AI writes a business doc from a dataset — pick a dataset; the backend reads
// its real model + a data sample + metrics and drafts a doc; the user reviews
// and edits before saving.
function AiWriteModal({ onClose, onDrafted }: { onClose: () => void; onDrafted: (draft: KnowledgeDocWrite) => void }) {
  const { t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetLite[]>([]);
  const [dsId, setDsId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { listDatasetsLite().then(setDatasets).catch(() => toast.error(t('govern.ai.loadDatasetsFailed'))); }, [t]);

  const run = async () => {
    if (!dsId) { toast.error(t('govern.ai.chooseDataset')); return; }
    setBusy(true);
    try {
      const d = await aiDraftKnowledge(Number(dsId));
      onDrafted({
        title: d.title, summary: d.summary, body: d.body, space: d.space,
        tags: d.tags ?? [], status: 'Draft', doc_type: 'domain', pinned: false,
        related_dataset_ids: d.related_dataset_ids ?? [], related_dashboard_ids: d.related_dashboard_ids ?? [],
        related_metrics: [], related_terms: [],
      });
    } catch (e) { toast.error(errDetail(e) || t('govern.ai.failed')); }
    finally { setBusy(false); }
  };

  return (
    <AppModalShell
      onClose={onClose} title={t('govern.ai.title')} icon={<Sparkles className="h-4 w-4" />} maxWidthClass="max-w-lg"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('govern.action.cancel')}</Button>
          {/* Stable size: label never changes while busy (spinner replaces the wand). */}
          <AiButton size="md" onClick={run} loading={busy} disabled={!dsId}>
            {t('govern.ai.submit')}
          </AiButton>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="text-caption text-text-secondary">{t('govern.ai.description')}</p>
        <div className="space-y-1.5">
          <Label required>{t('govern.ai.dataset')}</Label>
          <Select value={dsId} onChange={(e) => setDsId(e.target.value)} disabled={busy}>
            <option value="">{t('govern.ai.datasetPlaceholder')}</option>
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </div>
        {busy && <p className="text-tiny text-text-quaternary">{t('govern.ai.busyHint')}</p>}
      </div>
    </AppModalShell>
  );
}

/** Replace {{…}} tokens INLINE with readable links/chips so prose reads naturally. */
function resolveBody(doc: KnowledgeDoc): string {
  let body = doc.body ?? '';
  for (const m of doc.metrics_on_page ?? []) body = body.split(`{{metric:${m.machine_name}}}`).join(`**📈 ${m.name}**`);
  for (const a of doc.assets_on_page ?? []) {
    const icon = a.type === 'dashboard' ? '📊' : a.type === 'dataset' ? '🗄' : '📖';
    const label = a.name || a.ref;
    const rep = a.exists && a.open_path ? `[${icon} ${label}](${a.open_path})` : `**${icon} ${label}**`;
    body = body.split(`{{${a.type}:${a.ref}}}`).join(rep);
  }
  return body;
}

// ── Document header (eyebrow → title → lead summary) — clear entry hierarchy ──
function DocHeader({ doc }: { doc: KnowledgeDoc }) {
  const { t } = useI18n();
  return (
    <header className="mb-7 border-b border-[rgb(var(--border-line))] pb-5">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-tiny">
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-text-tertiary">{doc.space}</span>
        <span className="text-text-quaternary">{docTypeLabel(doc.doc_type, t)}</span>
        <span className={cn('rounded-full px-2 py-0.5', STATUS_TONE[doc.status] || 'bg-surface-2 text-text-tertiary')}>{statusLabel(doc.status, t)}</span>
        <span className="text-text-quaternary">v{doc.version}</span>
        {doc.owner && <span className="text-text-quaternary">· {doc.owner}</span>}
      </div>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">{doc.pinned ? <Pin className="h-4 w-4" /> : docIcon(doc.doc_type)}</span>
        <h1 className="text-h2 font-emphasis leading-tight text-text-primary">{doc.title}</h1>
      </div>
      {doc.summary && <p className="mt-2.5 max-w-2xl text-small leading-relaxed text-text-tertiary">{doc.summary}</p>}
    </header>
  );
}

// ── Right context rail — properties, on-this-page outline, quick links, related.
// DOCUMENT CONTEXT (not the doc list), using the horizontal space so prose keeps
// a readable measure. ──
function RailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-tiny text-text-quaternary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-caption text-text-secondary">{value}</dd>
    </div>
  );
}
function RailCard({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
      <p className="mb-3 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">{icon}{title}</p>
      {children}
    </div>
  );
}
// AI-context card — readiness score + what's missing + AI summary/keywords.
function AiContextCard({ doc, onRefresh }: { doc: KnowledgeDoc; onRefresh: () => void }) {
  const { t } = useI18n();
  const [regenBusy, setRegenBusy] = useState(false);
  const ready = doc.ai_ready ?? { score: 0, missing: [] };
  const regen = async () => {
    setRegenBusy(true);
    try { await regenAiSummary(doc.id); toast.success(t('govern.aiCard.regenOk')); onRefresh(); }
    catch (e) { toast.error(errDetail(e) || t('govern.aiCard.regenFailed')); }
    finally { setRegenBusy(false); }
  };
  return (
    <RailCard title={t('govern.aiCard.title')} icon={<Sparkles className="h-3.5 w-3.5" />}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className={cn('rounded-full px-2.5 py-0.5 text-caption font-emphasis', readyTone(ready.score))}>{ready.score}%</span>
        <span className="text-tiny text-text-quaternary">{t('govern.aiCard.readingTime', { min: readingMinutes(doc.body) })}</span>
      </div>
      {ready.missing.length > 0 && (
        <div className="mb-2.5 rounded-lg bg-surface-2 px-2.5 py-2">
          <p className="mb-1 text-tiny font-emphasis text-text-tertiary">{t('govern.aiCard.missingTitle')}</p>
          <ul className="space-y-0.5">
            {ready.missing.map((k) => (
              <li key={k} className="flex items-start gap-1.5 text-tiny text-text-secondary">
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-warning" />{t(READY_HINT_KEY[k] || k)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">{t('govern.aiCard.summary')}</p>
        <AiButton size="xs" loading={regenBusy} onClick={regen}>{t('govern.aiCard.regen')}</AiButton>
      </div>
      {doc.ai_summary
        ? <p className="text-tiny leading-relaxed text-text-secondary">{doc.ai_summary}</p>
        : <p className="text-tiny text-text-quaternary">{t('govern.aiCard.noSummary')}</p>}
      {(doc.ai_keywords ?? []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(doc.ai_keywords ?? []).map((k) => (
            <span key={k} className="rounded bg-brand/10 px-1.5 py-0.5 text-tiny text-brand">{k}</span>
          ))}
        </div>
      )}
    </RailCard>
  );
}

function DetailRail({ doc, toc, related, metrics, assets, onTab, onOpenDoc, onJump, onRefresh }: {
  doc: KnowledgeDoc;
  toc: { level: number; text: string }[];
  related: NonNullable<KnowledgeDoc['related_docs']>;
  metrics: NonNullable<KnowledgeDoc['metrics_on_page']>;
  assets: NonNullable<KnowledgeDoc['assets_on_page']>;
  onTab: (tab: string) => void; onOpenDoc: (id: number) => void; onJump: (text: string) => void;
  onRefresh: () => void;
}) {
  const { t, language } = useI18n();
  const [verifyBusy, setVerifyBusy] = useState(false);
  const doVerify = async () => {
    setVerifyBusy(true);
    try { await verifyDoc(doc.id); toast.success(t('govern.detail.verifyOk')); onRefresh(); }
    catch (e) { toast.error(errDetail(e) || t('govern.detail.verifyFailed')); }
    finally { setVerifyBusy(false); }
  };
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 lg:flex xl:w-80">
      <AiContextCard doc={doc} onRefresh={onRefresh} />

      <RailCard title="Thông tin">
        <dl className="space-y-2.5">
          <RailRow label="Không gian" value={doc.space} />
          <RailRow label="Loại" value={docTypeLabel(doc.doc_type, t)} />
          <RailRow label="Trạng thái" value={<span className={cn('rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[doc.status] || 'bg-surface-2 text-text-tertiary')}>{statusLabel(doc.status, t)}</span>} />
          <RailRow label="Phiên bản" value={`v${doc.version}`} />
          <RailRow label="Chủ sở hữu" value={doc.owner || '—'} />
          {doc.business_domain && <RailRow label={t('govern.detail.businessDomain')} value={doc.business_domain} />}
          {doc.process_ref && <RailRow label={t('govern.detail.processRef')} value={doc.process_ref} />}
          <RailRow label={t('govern.detail.importance')} value={t(`govern.importance.${doc.importance || 'normal'}`)} />
          {doc.review_date && <RailRow label={t('govern.detail.reviewDate')} value={doc.review_date} />}
          <RailRow label={t('govern.detail.lastVerified')} value={doc.last_verified_at ? relTime(doc.last_verified_at, language) : '—'} />
          <RailRow label={t('govern.detail.views')} value={doc.view_count ?? 0} />
          <RailRow label={t('govern.detail.aiRetrievals')} value={doc.retrieval_count ?? 0} />
          {doc.updated_at && <RailRow label="Cập nhật" value={new Date(doc.updated_at).toLocaleDateString('vi-VN')} />}
        </dl>
        <Button size="sm" variant="secondary" className="mt-3 w-full" leadingIcon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verifyBusy} onClick={doVerify}>
          {t('govern.detail.verify')}
        </Button>
      </RailCard>

      {toc.length > 1 && (
        <RailCard title="Mục trên trang">
          <nav className="space-y-0.5">
            {toc.map((h, i) => (
              <button key={i} onClick={() => onJump(h.text)}
                className={cn('block w-full truncate rounded px-2 py-1 text-left text-caption text-text-secondary transition-colors hover:bg-surface-2 hover:text-brand', h.level === 3 && 'pl-4 text-tiny')}>
                {h.text}
              </button>
            ))}
          </nav>
        </RailCard>
      )}

      {(metrics.length > 0 || assets.length > 0) && (
        <div className="space-y-1 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-2">
          <button onClick={() => onTab('chiso')} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-caption text-text-secondary hover:bg-surface-2">
            <span className="flex items-center gap-2"><Sigma className="h-4 w-4 text-text-quaternary" />{t('govern.detail.tab.metrics')}</span>
            <span className="font-emphasis text-text-primary">{metrics.length}</span>
          </button>
          <button onClick={() => onTab('lienket')} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-caption text-text-secondary hover:bg-surface-2">
            <span className="flex items-center gap-2"><LayoutDashboard className="h-4 w-4 text-text-quaternary" />{t('govern.detail.tab.links')}</span>
            <span className="font-emphasis text-text-primary">{assets.length}</span>
          </button>
        </div>
      )}

      {related.length > 0 && (
        <RailCard title={t('govern.detail.relatedDocs')} icon={<BookOpen className="h-3.5 w-3.5" />}>
          <div className="space-y-1">
            {related.map((r) => (
              <button key={r.id} onClick={() => onOpenDoc(r.id)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-2" title={relatedReason(r, t)}>
                <span className="block truncate text-caption font-emphasis text-text-secondary">{r.title}</span>
                <span className="block truncate text-tiny text-text-quaternary">{relatedReason(r, t)}</span>
              </button>
            ))}
          </div>
        </RailCard>
      )}
    </aside>
  );
}

function ContentTab({ doc }: { doc: KnowledgeDoc }) {
  const { t } = useI18n();
  const missing = doc.missing_metric_tokens ?? [];
  return (
    <div className="min-w-0">
      {doc.body
        ? <Markdown source={resolveBody(doc)} />
        : <p className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center text-caption text-text-tertiary">{t('govern.content.empty')}</p>}

      {missing.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{t('govern.content.missingMetrics', { count: missing.length })} {missing.map((token) => <code key={token} className="mx-0.5 font-mono">{token}</code>)} — {t('govern.content.defineInMetricsTab')}</span>
        </div>
      )}
    </div>
  );
}

function MetricsTab({ doc, onDefine, onEdit }: { doc: KnowledgeDoc; onDefine: () => void; onEdit: (mn: string) => void }) {
  const { t } = useI18n();
  const metrics = doc.metrics_on_page ?? [];
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-text-tertiary">{t('govern.metrics.intro')}</p>
        <Button size="sm" variant="primary" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={onDefine}>{t('govern.action.defineMetric')}</Button>
      </div>
      {metrics.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center">
          <Sigma className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
          <p className="text-caption text-text-tertiary">{t('govern.metrics.empty')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="app-list-table-wrap">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2"><tr>
                <th className="app-list-header w-[46%]">{t('govern.metrics.header.metric')}</th>
                <th className="app-list-header w-[20%]">{t('govern.metrics.header.role')}</th>
                <th className="app-list-header w-[12%]">{t('govern.metrics.header.unit')}</th>
                <th className="app-list-header w-[16%]">{t('govern.metrics.header.target')}</th>
                <th className="app-list-header w-[48px] text-right" />
              </tr></thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {metrics.map((m) => (
                  <tr key={m.machine_name} className="cursor-pointer hover:bg-surface-2" onClick={() => onEdit(m.machine_name)}>
                    <td className="app-list-cell">
                      <span className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand"><Sigma className="h-3.5 w-3.5" /></span>
                        <span className="min-w-0">
                          <span className="block text-caption font-emphasis text-text-primary">{m.name}</span>
                          {m.definition && <span className="mt-0.5 block text-tiny text-text-quaternary line-clamp-1">{m.definition}</span>}
                        </span>
                      </span>
                    </td>
                    <td className="app-list-cell">
                      {m.is_source
                        ? <span className="rounded-full bg-brand/10 px-2 py-0.5 text-tiny text-brand">{t('govern.metrics.sourceRole')}</span>
                        : <span className="rounded-full bg-surface-3 px-2 py-0.5 text-tiny text-text-tertiary" title={m.home_doc_title || undefined}>↩ {t('govern.metrics.reusedRole')}</span>}
                    </td>
                    <td className="app-list-cell text-caption text-text-tertiary">{m.unit || '—'}</td>
                    <td className="app-list-cell text-caption text-text-tertiary">{managedTargetLabel(m)}</td>
                    <td className="app-list-cell-tight text-right"><Pencil className="inline h-3.5 w-3.5 text-text-quaternary" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function LinksTab({ doc }: { doc: KnowledgeDoc }) {
  const { t } = useI18n();
  const assets = doc.assets_on_page ?? [];
  if (assets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center">
        <LayoutDashboard className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
        <p className="text-caption text-text-tertiary">{t('govern.links.empty')}</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="app-list-table-wrap">
        <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
          <thead className="bg-surface-2"><tr>
            <th className="app-list-header w-[58%]">{t('govern.links.header.resource')}</th>
            <th className="app-list-header w-[22%]">{t('govern.links.header.type')}</th>
            <th className="app-list-header w-[20%] text-right">{t('govern.links.header.open')}</th>
          </tr></thead>
          <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
            {assets.map((a) => (
              <tr key={`${a.type}:${a.ref}`} className="hover:bg-surface-2">
                <td className="app-list-cell">
                  <span className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">{ASSET_ICON[a.type]}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-caption font-emphasis text-text-primary">{a.name || a.ref}</span>
                      {a.type === 'term' && a.definition
                        ? <span className="mt-0.5 block truncate text-tiny text-text-quaternary">{a.definition}</span>
                        : !a.exists ? <span className="mt-0.5 block text-tiny text-danger">{t('govern.links.missing')}</span> : null}
                    </span>
                  </span>
                </td>
                <td className="app-list-cell"><span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{t(`govern.asset.${a.type}`)}</span></td>
                <td className="app-list-cell-tight text-right">
                  {a.exists && a.open_path
                    ? <Link href={a.open_path} className="inline-flex items-center gap-1 text-tiny text-brand hover:underline"><ExternalLink className="h-3 w-3" />{t('govern.action.open')}</Link>
                    : <span className="text-tiny text-text-quaternary">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HistoryTab({ docId }: { docId: number }) {
  const { t, locale } = useI18n();
  const [versions, setVersions] = useState<KnowledgeDocVersion[] | null>(null);
  const [viewV, setViewV] = useState<KnowledgeDocVersion | null>(null);
  useEffect(() => { let on = true; listDocVersions(docId).then((v) => { if (on) setVersions(v); }).catch(() => { if (on) setVersions([]); }); return () => { on = false; }; }, [docId]);
  const viewVersion = async (n: number) => { try { setViewV(await getDocVersion(docId, n)); } catch { toast.error(t('govern.history.loadVersionFailed')); } };

  return (
    <div className="min-w-0">
      <p className="mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary"><History className="h-3.5 w-3.5" /> {t('govern.history.title')}</p>
      {versions === null ? (
        <p className="py-6 text-center text-caption text-text-tertiary">{t('govern.loading')}</p>
      ) : versions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-8 text-center text-caption text-text-tertiary">{t('govern.history.empty')}</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 divide-y divide-[rgb(var(--border-line))]">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-surface-2">
              <div className="min-w-0">
                <span className="font-strong text-text-primary">v{v.version}</span>
                {v.change_note && <span className="ml-2 text-caption text-text-secondary">{v.change_note}</span>}
                <span className="ml-2 text-tiny text-text-quaternary">{v.changed_by || t('govern.history.system')} · {v.created_at ? new Date(v.created_at).toLocaleString(locale) : ''}</span>
              </div>
              <button onClick={() => viewVersion(v.version)} className="flex-shrink-0 text-caption text-brand hover:underline">{t('govern.action.view')}</button>
            </li>
          ))}
        </ul>
      )}
      {viewV && (
        <div className="mt-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-caption font-strong text-text-primary">{t('govern.history.readonlyTitle', { version: viewV.version })}</span>
            <button onClick={() => setViewV(null)} className="text-text-quaternary hover:text-text-secondary"><X className="h-3.5 w-3.5" /></button>
          </div>
          {viewV.body ? <Markdown source={viewV.body} /> : <p className="text-caption text-text-tertiary">{t('govern.history.emptyBody')}</p>}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════ Editor ═════════════════════════════════════
// Word-like formatting toolbar over the markdown editor (bold/italic/heading/
// list/quote/code/link/table) — inserts markdown at the cursor.
function FmtBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary">
      {children}
    </button>
  );
}
function MarkdownToolbar({ wrap, prefix, block }: {
  wrap: (b: string, a: string, ph: string) => void; prefix: (p: string) => void; block: (b: string) => void;
}) {
  const { t } = useI18n();
  const Div = () => <div className="mx-1 h-5 w-px bg-surface-3" />;
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-1">
      <FmtBtn title={t('govern.toolbar.bold')} onClick={() => wrap('**', '**', t('govern.toolbar.sample.bold'))}><Bold className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.italic')} onClick={() => wrap('*', '*', t('govern.toolbar.sample.italic'))}><Italic className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.strike')} onClick={() => wrap('~~', '~~', t('govern.toolbar.sample.strike'))}><Strikethrough className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.code')} onClick={() => wrap('`', '`', 'code')}><Code className="h-3.5 w-3.5" /></FmtBtn>
      <Div />
      <FmtBtn title={t('govern.toolbar.h1')} onClick={() => prefix('# ')}><Heading1 className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.h2')} onClick={() => prefix('## ')}><Heading2 className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.h3')} onClick={() => prefix('### ')}><Heading3 className="h-3.5 w-3.5" /></FmtBtn>
      <Div />
      <FmtBtn title={t('govern.toolbar.list')} onClick={() => prefix('- ')}><List className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.orderedList')} onClick={() => prefix('1. ')}><ListOrdered className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.quote')} onClick={() => prefix('> ')}><Quote className="h-3.5 w-3.5" /></FmtBtn>
      <Div />
      <FmtBtn title={t('govern.toolbar.link')} onClick={() => wrap('[', '](https://)', t('govern.toolbar.sample.link'))}><Link2 className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.table')} onClick={() => block(t('govern.toolbar.tableBlock'))}><Table className="h-3.5 w-3.5" /></FmtBtn>
    </div>
  );
}

function EditorScreen({ docId, seed, managed, onCancel, onSaved, onOpenMetric }: {
  docId: number | null; seed?: KnowledgeDocWrite | null; managed: ManagedMetric[];
  onCancel: () => void; onSaved: (id: number) => void; onOpenMetric: (s: MetricModalState) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<KnowledgeDocWrite | null>(docId ? null : (seed ?? newDoc()));
  const [tagsText, setTagsText] = useState((seed?.tags ?? []).join(', '));
  const [changeNote, setChangeNote] = useState('');
  const [loading, setLoading] = useState(!!docId);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const raw = await f.text();
      const text = /\.html?$/i.test(f.name) ? htmlToText(raw) : raw;
      setEditing((p) => (p ? { ...p, body: `${(p.body || '').trim() ? p.body!.trimEnd() + '\n\n' : ''}${text.trim()}` } : p));
      toast.success(t('govern.editor.fileImported', { name: f.name }));
    } catch { toast.error(t('govern.editor.fileReadFailed')); }
  };

  useEffect(() => {
    if (!docId) return;
    let on = true; setLoading(true);
    getKnowledgeDoc(docId)
      .then((d) => { if (!on) return; setEditing(docToWrite(d)); setTagsText((d.tags ?? []).join(', ')); })
      .catch(() => { if (on) toast.error(t('govern.detail.openFailed')); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [docId, t]);

  const upd = (patch: Partial<KnowledgeDocWrite>) => setEditing((p) => (p ? { ...p, ...patch } : p));

  // Changing the doc TYPE on an empty document inserts that type's markdown
  // skeleton (KPI/domain, SOP, report, AI know-how) — structure without forms.
  const changeType = (type: string) => setEditing((p) => {
    if (!p) return p;
    const empty = !(p.body || '').trim();
    const tpl = docTemplate(type);
    return { ...p, doc_type: type, body: empty && tpl ? tpl : p.body };
  });

  const insertToken = (token: string) => {
    const el = bodyRef.current;
    setEditing((p) => {
      if (!p) return p;
      const cur = p.body ?? '';
      if (!el) return { ...p, body: `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${token}` };
      const start = el.selectionStart ?? cur.length; const end = el.selectionEnd ?? cur.length;
      const next = cur.slice(0, start) + token + cur.slice(end);
      requestAnimationFrame(() => { el.focus(); const pos = start + token.length; el.setSelectionRange(pos, pos); });
      return { ...p, body: next };
    });
  };

  const [preview, setPreview] = useState(false);
  // Word-like formatting — acts on the textarea selection; keeps markdown storage.
  const editBody = (fn: (t: string, s: number, e: number) => { text: string; a: number; b: number }) => {
    const el = bodyRef.current;
    setEditing((p) => {
      if (!p) return p;
      const cur = p.body ?? '';
      const s = el?.selectionStart ?? cur.length; const e = el?.selectionEnd ?? cur.length;
      const r = fn(cur, s, e);
      requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(r.a, r.b); } });
      return { ...p, body: r.text };
    });
  };
  const wrapFmt = (b: string, a: string, ph: string) => editBody((t, s, e) => {
    const sel = t.slice(s, e) || ph;
    return { text: t.slice(0, s) + b + sel + a + t.slice(e), a: s + b.length, b: s + b.length + sel.length };
  });
  const prefixFmt = (pfx: string) => editBody((t, s, e) => {
    const ls = t.lastIndexOf('\n', s - 1) + 1;
    return { text: t.slice(0, ls) + pfx + t.slice(ls), a: s + pfx.length, b: e + pfx.length };
  });
  const blockFmt = (blk: string) => editBody((t, s) => {
    const pre = s > 0 && t[s - 1] !== '\n' ? '\n' : '';
    const pos = s + pre.length + blk.length;
    return { text: t.slice(0, s) + pre + blk + t.slice(s), a: pos, b: pos };
  });

  const defineMetric = () => {
    if (!editing?.id) { toast.error(t('govern.editor.saveBeforeMetric')); return; }
    onOpenMetric({ machineName: null, homeDocId: editing.id, onCreated: (mn) => insertToken(`{{metric:${mn}}}`) });
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.title.trim()) { toast.error(t('govern.editor.titleRequired')); return; }
    setSaving(true);
    try {
      const body: KnowledgeDocWrite = {
        ...editing, tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
        change_note: changeNote.trim() || undefined,
      };
      const r = await upsertKnowledgeDoc(body);
      toast.success(editing.id ? t('govern.editor.updated', { version: r.version }) : t('govern.editor.created'));
      onSaved(r.id);
    } catch (e) { toast.error(errDetail(e) || t('govern.editor.saveFailed')); }
    finally { setSaving(false); }
  };

  if (loading || !editing) return <DetailShell><div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div></DetailShell>;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Standard detail header bar (same chrome as Dataset/Explore) ── */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button onClick={onCancel} className="flex items-center gap-1 text-sm text-text-tertiary transition-colors hover:text-text-primary">
          <ChevronLeft className="h-4 w-4" />
          {t('govern.detail.back')}
        </button>
        <span className="text-text-quaternary">/</span>
        <span className="max-w-[320px] truncate text-sm font-medium text-text-primary">{editing.id ? t('govern.editor.titleEdit') : t('govern.editor.titleNew')}</span>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" leadingIcon={<X className="h-3.5 w-3.5" />} onClick={onCancel} disabled={saving}>{t('govern.action.cancel')}</Button>
        <Button size="sm" variant="primary" leadingIcon={<Save className="h-3.5 w-3.5" />} onClick={save} loading={saving} disabled={saving}>{editing.id ? t('govern.action.saveChanges') : t('govern.action.saveDocument')}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-6 sm:px-6 xl:px-8 [scrollbar-gutter:stable]">
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.html,.htm,text/plain,text/markdown,text/html" className="hidden" onChange={onImportFile} />

        {/* full-width 2-column: editor (left) + properties (right) */}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-3">
            <div className="space-y-1.5"><Label required>{t('govern.editor.title')}</Label><Input value={editing.title} onChange={(e) => upd({ title: e.target.value })} placeholder={t('govern.editor.titlePlaceholder')} /></div>
            <div className="space-y-1.5"><Label>{t('govern.editor.summary')}</Label><Input value={editing.summary ?? ''} onChange={(e) => upd({ summary: e.target.value })} placeholder={t('govern.editor.summaryPlaceholder')} /></div>

            {/* insert-token + import toolbar */}
            <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">{t('govern.editor.insertIntoContent')}</p>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="xs" leadingIcon={<Upload className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()}>{t('govern.action.importFile')}</Button>
                  <Button variant="primary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={defineMetric}>{t('govern.action.defineMetric')}</Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <TokenInserter managed={managed} insertToken={insertToken} />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t('govern.editor.content')}</Label>
                <button type="button" onClick={() => setPreview((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-tiny text-text-tertiary hover:bg-surface-3 hover:text-text-primary">
                  {preview ? <><Pencil className="h-3.5 w-3.5" />{t('govern.editor.compose')}</> : <><Eye className="h-3.5 w-3.5" />{t('govern.editor.preview')}</>}
                </button>
              </div>
              {preview ? (
                <div className="min-h-[420px] rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                  {editing.body?.trim() ? <Markdown source={editing.body} /> : <p className="text-caption text-text-quaternary">{t('govern.editor.previewEmpty')}</p>}
                </div>
              ) : (
                <>
                  <MarkdownToolbar wrap={wrapFmt} prefix={prefixFmt} block={blockFmt} />
                  <Textarea ref={bodyRef} rows={24} className="font-mono text-[13px]" value={editing.body ?? ''} onChange={(e) => upd({ body: e.target.value })}
                    placeholder={t('govern.editor.bodyPlaceholder')} />
                </>
              )}
            </div>
          </div>

          {/* properties rail */}
          <aside className="space-y-4 lg:sticky lg:top-0 lg:self-start">
            <div className="space-y-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
              <p className="text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">{t('govern.editor.properties')}</p>
              <div className="space-y-1.5"><Label>{t('govern.editor.space')}</Label><Input value={editing.space ?? ''} onChange={(e) => upd({ space: e.target.value })} placeholder={t('govern.editor.spacePlaceholder')} /></div>
              <div className="space-y-1.5"><Label>{t('govern.editor.type')}</Label>
                <Select value={editing.doc_type ?? 'article'} onChange={(e) => changeType(e.target.value)}>{DOC_TYPES.map((type) => <option key={type} value={type}>{docTypeLabel(type, t)}</option>)}</Select>
              </div>
              <div className="space-y-1.5"><Label>{t('govern.editor.status')}</Label>
                <Select value={editing.status ?? 'Draft'} onChange={(e) => upd({ status: e.target.value as KnowledgeDoc['status'] })}>{['Draft', 'Published', 'Archived'].map((s) => <option key={s} value={s}>{statusLabel(s, t)}</option>)}</Select>
              </div>
              <div className="space-y-1.5"><Label>{t('govern.editor.owner')}</Label><Input value={editing.owner ?? ''} onChange={(e) => upd({ owner: e.target.value })} placeholder={t('govern.editor.ownerPlaceholder')} /></div>
              <div className="space-y-1.5"><Label>{t('govern.editor.businessDomain')}</Label><Input value={editing.business_domain ?? ''} onChange={(e) => upd({ business_domain: e.target.value })} placeholder={t('govern.editor.businessDomainPlaceholder')} /></div>
              <div className="space-y-1.5"><Label>{t('govern.editor.processRef')}</Label><Input value={editing.process_ref ?? ''} onChange={(e) => upd({ process_ref: e.target.value })} placeholder={t('govern.editor.processRefPlaceholder')} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5"><Label>{t('govern.editor.reviewDate')}</Label><Input type="date" value={editing.review_date ?? ''} onChange={(e) => upd({ review_date: e.target.value || null })} /></div>
                <div className="space-y-1.5"><Label>{t('govern.editor.importance')}</Label>
                  <Select value={editing.importance ?? 'normal'} onChange={(e) => upd({ importance: e.target.value })}>
                    {['low', 'normal', 'high'].map((v) => <option key={v} value={v}>{t(`govern.importance.${v}`)}</option>)}
                  </Select>
                </div>
              </div>
              <label className="flex items-center gap-2 text-caption text-text-secondary"><input type="checkbox" checked={!!editing.pinned} onChange={(e) => upd({ pinned: e.target.checked })} className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" /> {t('govern.editor.pinned')}</label>
              <div className="space-y-1.5"><Label>{t('govern.editor.tags')}</Label><Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder={t('govern.editor.tagsPlaceholder')} /></div>
              <div className="space-y-1.5"><Label>{t('govern.editor.changeNote')}</Label><Input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder={t('govern.editor.changeNotePlaceholder')} /></div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function TokenInserter({ managed, insertToken }: { managed: ManagedMetric[]; insertToken: (t: string) => void }) {
  const { t } = useI18n();
  const [pickMetric, setPickMetric] = useState('');
  const [dashId, setDashId] = useState('');
  const [dsId, setDsId] = useState('');
  const [termFqn, setTermFqn] = useState('');
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Select size="sm" className="w-48" value={pickMetric} onChange={(e) => setPickMetric(e.target.value)} aria-label={t('govern.editor.metricSelectAria')}>
          <option value="">{t('govern.editor.selectMetricPlaceholder')}</option>
          {managed.map((m) => <option key={m.machine_name} value={m.machine_name}>{m.name}</option>)}
        </Select>
        <Button variant="secondary" size="sm" leadingIcon={<Sigma className="h-3.5 w-3.5" />} disabled={!pickMetric} onClick={() => insertToken(`{{metric:${pickMetric}}}`)}>{t('govern.editor.existingMetric')}</Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Input size="sm" className="w-24" value={dashId} onChange={(e) => setDashId(e.target.value)} placeholder={t('govern.editor.dashboardIdPlaceholder')} />
        <Button variant="secondary" size="sm" leadingIcon={<LayoutDashboard className="h-3.5 w-3.5" />} disabled={!dashId.trim()} onClick={() => { insertToken(`{{dashboard:${dashId.trim()}}}`); setDashId(''); }}>{t('govern.editor.dashboard')}</Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Input size="sm" className="w-24" value={dsId} onChange={(e) => setDsId(e.target.value)} placeholder={t('govern.editor.datasetIdPlaceholder')} />
        <Button variant="secondary" size="sm" leadingIcon={<Database className="h-3.5 w-3.5" />} disabled={!dsId.trim()} onClick={() => { insertToken(`{{dataset:${dsId.trim()}}}`); setDsId(''); }}>{t('govern.editor.dataset')}</Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Input size="sm" className="w-40" value={termFqn} onChange={(e) => setTermFqn(e.target.value)} placeholder="glossary.term" />
        <Button variant="secondary" size="sm" leadingIcon={<TagIcon className="h-3.5 w-3.5" />} disabled={!termFqn.trim()} onClick={() => { insertToken(`{{term:${termFqn.trim()}}}`); setTermFqn(''); }}>{t('govern.editor.term')}</Button>
      </div>
    </>
  );
}
