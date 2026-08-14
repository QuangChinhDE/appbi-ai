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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type ChangeEvent } from 'react';
import Link from 'next/link';
import {
  BookOpen, Compass, Boxes, Workflow, HelpCircle, FileText, Sigma, LayoutDashboard, Database,
  Tag as TagIcon, History, Plus, Pencil, Trash2, Save, X, Pin, ChevronLeft, ChevronRight, ChevronDown,
  ExternalLink, AlertTriangle, Check, Loader2, Library, Search, Upload, Sparkles, RefreshCw,
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code, Link2, Table, Eye,
  GitBranch, ShieldCheck, Clock3, BookCheck, MessageCircleQuestion, Share2, Info, Network,
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
  publishVersion, aiChangeNote, governGraph,
  getDocSource, putDocSource, uploadDocSourceFile, syncDocSource, listGoogleDocsSources,
  getEmbeddingConfig, previewChunks, reembedDoc,
  getDocHistory, getDocUsage, getDocVectors, queryDocVectors, getDocSnapshot, isSourceOwned,
  type DocSourceKind, type DocSnapshot, type GoogleDocsSource,
  type KnowledgeDoc, type KnowledgeSpace, type KnowledgeDocWrite, type KnowledgeAsset, type ManagedMetric,
  type KnowledgeDocVersion, type DatasetLite, type GovernSearchResult, type RelatedDoc, type KnowledgeGraph, type GraphNode,
  type DocSourceInfo, type DocSyncSchedule, type EmbeddingConfig, type ChunkPreviewResult, type DocHistory, type DocUsage, type DocVector, type VectorMatch,
} from '@/lib/catalog';
import { AppModalShell } from '@/components/common/AppModalShell';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { ShareDialog } from '@/components/common/ShareDialog';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
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
  review: 'govern.ready.review', embedded: 'govern.ready.embedded', source_connected: 'govern.ready.sourceConnected',
};
/** ~200 wpm reading time from a markdown body. */
function readingMinutes(body: string | undefined | null): number {
  const words = (body || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
function relTime(iso: string | null | undefined, locale: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (!iso) return '-';
  // Backend timestamps are naive UTC — anchor them so local offsets don't shift.
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const dt = new Date(normalized).getTime();
  const mins = Math.floor((Date.now() - dt) / 60000);
  if (mins < 1) return t('govern.time.justNow');
  if (mins < 60) return t('govern.time.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('govern.time.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 30) return t('govern.time.daysAgo', { count: days });
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [seed, setSeed] = useState<KnowledgeDocWrite | null>(null);  // AI-draft prefill for a new doc
  const [shareTarget, setShareTarget] = useState<{ id: number; title: string } | null>(null);
  const onShare = (id: number, title: string) => setShareTarget({ id, title });

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
  // "New document" now starts with the source picker (hand-typed / Google Doc /
  // uploaded file / web page); only the hand-typed path opens the blank editor.
  const startNew = () => { setSeed(null); setWizardOpen(true); };
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
        allDocs={docs.map((d) => ({ id: d.id, title: d.title }))}
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
        onOpenMetric={openMetric} onListChanged={loadList} onOpenDoc={openDoc} onShare={onShare}
      />
    );
  } else {
    screen = (
      <ListScreen docs={docs} spaces={spaces} loading={loading} managed={managed}
        onOpen={openDoc} onNew={startNew} onOpenVocab={onOpenVocab} onAiWrite={() => setAiOpen(true)}
        onOpenMetric={(mn) => openMetric({ machineName: mn, homeDocId: null })} onShare={onShare} />
    );
  }

  return (
    <>
      {screen}
      {shareTarget && (
        <ShareDialog resourceType="knowledge_doc" resourceId={shareTarget.id} resourceName={shareTarget.title} onClose={() => setShareTarget(null)} />
      )}
      {aiOpen && <AiWriteModal onClose={() => setAiOpen(false)} onDrafted={onAiDrafted} />}
      {wizardOpen && (
        <CreateDocWizard
          spaces={spaces}
          onClose={() => setWizardOpen(false)}
          onManual={(sp, docTitle) => { setWizardOpen(false); setSeed({ ...newDoc(sp), title: docTitle }); nav.set({ doc: null, m: 'new' }); }}
          onCreated={(id) => { setWizardOpen(false); void loadList(); openDoc(id); }}
        />
      )}
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

// ── Obsidian-style whole-hub knowledge graph (force-directed, pure SVG) ──────
// Exported: also rendered by the Intelligence cockpit (Sẵn sàng AI → Đồ thị).
export function GlobalGraph({ onOpen }: { onOpen: (id: number) => void }) {
  const { t } = useI18n();
  const [g, setG] = useState<KnowledgeGraph | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { governGraph().then(setG).catch(() => setG({ nodes: [], edges: [] })); }, []);

  const layout = useMemo(() => {
    const W = 1000, H = 680;
    type Placed = GraphNode & { x: number; y: number; deg: number };
    if (!g || g.nodes.length === 0) return { W, H, nodes: [] as Placed[], edges: [] as { from: number; to: number; type: string }[] };
    const N = g.nodes.length;
    const p = g.nodes.map((n, i) => ({ x: W / 2 + Math.cos((2 * Math.PI * i) / N) * 240, y: H / 2 + Math.sin((2 * Math.PI * i) / N) * 240, vx: 0, vy: 0 }));
    const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
    const E = g.edges.map((e) => [idx.get(e.from), idx.get(e.to)] as [number | undefined, number | undefined]).filter((e): e is [number, number] => e[0] != null && e[1] != null);
    const deg = new Array(N).fill(0); E.forEach(([a, b]) => { deg[a]++; deg[b]++; });
    for (let it = 0; it < 260; it++) {
      const cool = Math.max(0.05, 1 - it / 300);
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const dx = p[i].x - p[j].x, dy = p[i].y - p[j].y; const d2 = dx * dx + dy * dy || 0.01; const d = Math.sqrt(d2);
        const rep = 11000 / d2; const fx = (dx / d) * rep, fy = (dy / d) * rep;
        p[i].vx += fx; p[i].vy += fy; p[j].vx -= fx; p[j].vy -= fy;
      }
      for (const [a, b] of E) {
        const dx = p[b].x - p[a].x, dy = p[b].y - p[a].y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 160) * 0.02; const fx = (dx / d) * f, fy = (dy / d) * f;
        p[a].vx += fx; p[a].vy += fy; p[b].vx -= fx; p[b].vy -= fy;
      }
      for (let i = 0; i < N; i++) {
        p[i].vx += (W / 2 - p[i].x) * 0.003; p[i].vy += (H / 2 - p[i].y) * 0.003;
        p[i].x += p[i].vx * cool * 0.4; p[i].y += p[i].vy * cool * 0.4;
        p[i].vx *= 0.85; p[i].vy *= 0.85;
      }
    }
    return { W, H, nodes: g.nodes.map((n, i) => ({ ...n, x: p[i].x, y: p[i].y, deg: deg[i] })), edges: g.edges };
  }, [g]);

  const posById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const connected = (id: number) => hover == null || hover === id || layout.edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id));

  if (!g) return <div className="py-16 text-center text-caption text-text-tertiary">{t('govern.loading')}</div>;
  if (g.nodes.length === 0) return (
    <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-16 text-center">
      <Network className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
      <p className="text-caption text-text-tertiary">{t('govern.graph.emptyGlobal')}</p>
    </div>
  );
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-2">
      <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="h-[72vh] w-full" preserveAspectRatio="xMidYMid meet">
        {layout.edges.map((e, i) => {
          const a = posById.get(e.from), b = posById.get(e.to); if (!a || !b) return null;
          const dim = hover != null && !(e.from === hover || e.to === hover);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={e.type === 'link' ? 'rgb(var(--brand))' : 'rgb(var(--border-strong))'}
            strokeWidth={e.type === 'link' ? 1.6 : 1} strokeDasharray={e.type === 'metric' ? '4 4' : undefined}
            opacity={dim ? 0.12 : (e.type === 'link' ? 0.55 : 0.35)} />;
        })}
        {layout.nodes.map((n) => {
          const r = Math.min(16, 6 + n.deg * 1.6); const on = connected(n.id);
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`} className="cursor-pointer" opacity={on ? 1 : 0.25}
              onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => onOpen(n.id)}>
              <circle r={r} fill="rgb(var(--brand))" fillOpacity={0.85} stroke="rgb(var(--surface-1))" strokeWidth={2} />
              <text y={r + 12} textAnchor="middle" className="pointer-events-none fill-[rgb(var(--text-secondary))] text-[11px]"
                style={{ fontWeight: hover === n.id ? 600 : 400 }}>{n.title.length > 26 ? n.title.slice(0, 25) + '…' : n.title}</text>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-4 px-2 py-1 text-tiny text-text-quaternary">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-brand" />{t('govern.graph.edgeLink')}</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 border-t border-dashed border-[rgb(var(--border-strong))]" />{t('govern.graph.edgeMetric')}</span>
        <span className="ml-auto">{t('govern.graph.hint')}</span>
      </div>
    </div>
  );
}

// ═════════════════════════════════ List ═════════════════════════════════════
type HealthKey = 'noOwner' | 'noSummary' | 'staleReview' | 'notEmbedded' | 'mostViewed' | 'mostRetrieved';

function ListScreen({ docs, spaces, loading, managed, onOpen, onNew, onOpenVocab, onAiWrite, onOpenMetric, onShare }: {
  docs: KnowledgeDoc[]; spaces: KnowledgeSpace[]; loading: boolean; managed: ManagedMetric[];
  onOpen: (id: number) => void; onNew: () => void; onOpenVocab?: () => void; onAiWrite: () => void;
  onOpenMetric: (machineName: string) => void; onShare: (id: number, title: string) => void;
}) {
  const { t, language } = useI18n();
  // Module-level authoring gate: creating / AI-writing a doc is a WRITE (now
  // govern:edit at the backend). Per-doc edit/share stay resource-gated below.
  const { data: permData } = usePermissions();
  const canAuthor = hasPermission(permData?.permissions, 'govern', 'edit');
  const [space, setSpace] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthKey | null>(null);
  const [q, setQ] = useState('');
  const [searchRes, setSearchRes] = useState<GovernSearchResult | null>(null);
  const [view, setView] = useState<'list' | 'graph'>('list');

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
          {canAuthor && <AiButton size="md" onClick={onAiWrite}>{t('govern.action.aiWrite')}</AiButton>}
          {canAuthor && <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={onNew}>{t('govern.action.createDocument')}</Button>}
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
          <Tabs<'list' | 'graph'> size="sm" value={view} onChange={setView} items={[
            { key: 'list', icon: <List className="h-3.5 w-3.5" />, label: t('govern.view.list') },
            { key: 'graph', icon: <Network className="h-3.5 w-3.5" />, label: t('govern.view.graph') },
          ]} />
          <div className="mx-1 h-4 w-px bg-surface-3" />
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
        if (view === 'graph') return <GlobalGraph onOpen={onOpen} />;
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
              {canAuthor && <Button variant="primary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={onNew}>{t('govern.action.createDocument')}</Button>}
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
                        <th className="app-list-header w-[26%]">{t('govern.list.header.document')}</th>
                        <th className="app-list-header w-[10%]">{t('govern.list.header.space')}</th>
                        <th className="app-list-header w-[8%]">{t('govern.list.header.type')}</th>
                        <th className="app-list-header w-[6%]">{t('govern.list.header.metrics')}</th>
                        <th className="app-list-header w-[6%]">{t('govern.list.header.links')}</th>
                        <th className="app-list-header w-[8%]">{t('govern.list.header.aiReady')}</th>
                        <th className="app-list-header w-[10%]">{t('govern.list.header.status')}</th>
                        {/* WHO OWNS THIS. The list showed the free-text `owner`
                            label in a filter chip and nothing else, so an admin
                            could not tell which account a document belonged to —
                            the two fields share a name but only `owner_email` is
                            the account the permission system uses. */}
                        <th className="app-list-header w-[11%]">{t('govern.list.header.owner')}</th>
                        <th className="app-list-header w-[8%]">{t('govern.list.header.updated')}</th>
                        <th className="app-list-header w-[7%] text-right" />
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
                              <td className="app-list-cell"><OwnerBadge email={d.owner_email} /></td>
                              <td className="app-list-cell text-tiny text-text-quaternary"><Clock3 className="mr-1 inline h-3 w-3" />{relTime(d.updated_at, language, t)}</td>
                              <td className="app-list-cell-tight">
                                <span className="flex items-center justify-end gap-0.5 whitespace-nowrap">
                                  {getResourcePermissions(d.user_permission ?? undefined).canShare && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); onShare(d.id, d.title); }}
                                      className="flex-shrink-0 rounded p-1 text-text-quaternary transition-colors hover:bg-surface-2 hover:text-brand"
                                      title={t('shared.share.shareButton')} aria-label={t('shared.share.shareButton')}
                                    >
                                      <Share2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-text-quaternary" />
                                </span>
                              </td>
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
// The document IS the page — there is no tab bar. Everything else is a utility
// surface opened on demand: two drawers (Liên kết / Lịch sử) and three rail
// flyouts (AI readiness / Information / Linked mentions). Configuration that
// used to own a whole tab (source settings, embedding settings) lives behind
// the ••• menu, so nothing was removed — only demoted out of the reading path.
type DetailPanel = null | 'relations' | 'history';
type DetailModal = null | 'source' | 'embedding' | 'graph';

/** Right-hand drawer (Liên kết / Lịch sử) floating over the reading surface. */
function DetailDrawer({ title, icon, width = 'w-[26rem]', onClose, children }: {
  title: string; icon?: ReactNode; width?: string; onClose: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={cn(
      'absolute right-0 top-0 z-40 max-h-full overflow-y-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg',
      width,
    )}>
      <div className="sticky top-0 z-10 flex h-11 items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-3">
        <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary">{icon}{title}</span>
        <div className="flex-1" />
        <button onClick={onClose} aria-label={t('common.close')} className="text-text-quaternary transition-colors hover:text-text-primary">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}

function DrawerSection({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-[rgb(var(--border-line))] px-3 py-3 first-of-type:border-t-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-tiny font-emphasis uppercase tracking-[0.11em] text-text-quaternary">{title}</span>
        {count != null && <span className="text-tiny text-text-tertiary">{count}</span>}
      </div>
      {children}
    </div>
  );
}

/** One clickable connection row (KPI / dashboard / dataset / doc). */
function ConnectionItem({ icon, name, sub, side, onClick }: {
  icon: ReactNode; name: string; sub?: string; side?: string; onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { onClick, type: 'button' as const } : {})}
      className={cn('flex w-full items-start gap-2.5 rounded-lg px-1.5 py-2 text-left', onClick && 'hover:bg-surface-2')}
    >
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-caption font-emphasis text-text-primary">{name}</span>
        {sub && <span className="mt-0.5 block truncate text-tiny text-text-quaternary">{sub}</span>}
      </span>
      {side && <span className="mt-0.5 whitespace-nowrap text-tiny text-text-tertiary">{side}</span>}
    </Tag>
  );
}

/** ⌁ Liên kết — what this doc USES, where it IS USED, and what relates to it.
 *  Replaces the old Chỉ số / Liên kết / Đồ thị tabs with one contextual view. */
function RelationsDrawer({ doc, metrics, assets, related, usage, onClose, onOpenDoc, onEditMetric, onOpenGraph }: {
  doc: KnowledgeDoc;
  metrics: NonNullable<KnowledgeDoc['metrics_on_page']>;
  assets: NonNullable<KnowledgeDoc['assets_on_page']>;
  related: NonNullable<KnowledgeDoc['related_docs']>;
  usage: DocUsage | null;
  onClose: () => void; onOpenDoc: (id: number) => void; onEditMetric: (mn: string) => void; onOpenGraph: () => void;
}) {
  const { t } = useI18n();
  const uses = metrics.length + assets.length;
  const dashboards = usage?.dashboards ?? [];
  return (
    <DetailDrawer title={t('govern.relations.title')} icon={<Network className="h-3.5 w-3.5" />} onClose={onClose}>
      <p className="border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-tiny text-text-tertiary">
        {t('govern.relations.summary', { count: uses + dashboards.length + related.length })}
      </p>

      <DrawerSection title={t('govern.relations.uses')} count={uses}>
        {uses === 0 ? (
          <p className="px-1.5 text-tiny text-text-quaternary">{t('govern.relations.usesEmpty')}</p>
        ) : (
          <>
            {metrics.map((m) => (
              <ConnectionItem key={m.machine_name} icon={<Sigma className="h-3.5 w-3.5" />} name={m.name}
                sub={m.is_source ? t('govern.metrics.sourceRole') : t('govern.metrics.reusedRole')}
                side={t('govern.detail.tab.metrics')} onClick={() => onEditMetric(m.machine_name)} />
            ))}
            {assets.map((a) => (
              <ConnectionItem key={`${a.type}:${a.ref}`} icon={ASSET_ICON[a.type]} name={a.name || a.ref}
                sub={a.exists ? undefined : t('govern.links.missing')} side={t(`govern.asset.${a.type}`)}
                onClick={a.exists && a.open_path ? () => window.open(a.open_path!, '_blank', 'noopener,noreferrer') : undefined} />
            ))}
          </>
        )}
      </DrawerSection>

      <DrawerSection title={t('govern.relations.usedIn')} count={t('govern.relations.dashboardCount', { count: dashboards.length })}>
        {dashboards.length === 0 ? (
          <p className="px-1.5 text-tiny text-text-quaternary">{t('govern.relations.usedInEmpty')}</p>
        ) : dashboards.map((d) => (
          <ConnectionItem key={d.id} icon={<LayoutDashboard className="h-3.5 w-3.5" />} name={d.name}
            sub={t('govern.relations.readsThisDoc')}
            onClick={() => window.open(`/dashboards/${d.id}`, '_blank', 'noopener,noreferrer')} />
        ))}
        <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2 text-tiny text-text-secondary">
          <span><b className="font-emphasis text-text-primary">{dashboards.length}</b> {t('govern.relations.dashboardsWord')}</span>
          <span><b className="font-emphasis text-text-primary">{usage?.retrieval_count ?? doc.retrieval_count ?? 0}</b> {t('govern.relations.aiUses')}</span>
        </div>
      </DrawerSection>

      <DrawerSection title={t('govern.detail.relatedDocs')} count={related.length}>
        {related.length === 0 ? (
          <p className="px-1.5 text-tiny text-text-quaternary">{t('govern.relations.relatedEmpty')}</p>
        ) : related.map((r) => (
          <ConnectionItem key={r.id} icon={<BookOpen className="h-3.5 w-3.5" />} name={r.title}
            sub={relatedReason(r, t)} onClick={() => onOpenDoc(r.id)} />
        ))}
        <button onClick={onOpenGraph} className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-1.5 py-2 text-left text-caption font-emphasis text-brand hover:bg-surface-2">
          <GitBranch className="h-3.5 w-3.5" />{t('govern.relations.openGraph')}
        </button>
      </DrawerSection>
    </DetailDrawer>
  );
}

/** ◷ Lịch sử — one timeline of versions + source syncs + embedding runs. */
function HistoryDrawer({ doc, onClose, onViewVersion }: {
  doc: KnowledgeDoc; onClose: () => void; onViewVersion: (v: number) => void;
}) {
  const { t, language } = useI18n();
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<DocHistory | null>(null);

  useEffect(() => {
    let on = true;
    setLoading(true);
    getDocHistory(doc.id)
      .then((h) => { if (on) setHistory(h); })
      .catch(() => toast.error(t('govern.history.loadFailed')))
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [doc.id, t]);

  type Row = { key: string; kind: 'sync' | 'embed' | 'version'; at: string; title: string; detail?: string | null; status?: string; version?: number };
  const rows: Row[] = [
    ...(history?.runs ?? []).map((r): Row => ({
      key: `run-${r.id}`, kind: r.run_type, at: r.started_at,
      title: r.run_type === 'sync' ? t('govern.history.syncRun') : t('govern.history.embedRun'),
      detail: r.detail, status: r.status,
    })),
    ...(history?.versions ?? []).map((v): Row => ({
      key: `v-${v.version}`, kind: 'version', at: v.created_at || '', version: v.version,
      title: t('govern.history.versionRow', { n: v.version }), detail: v.change_note,
      status: v.is_published ? 'published' : undefined,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <DetailDrawer title={t('govern.history.drawerTitle')} icon={<Clock3 className="h-3.5 w-3.5" />} onClose={onClose}>
      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-brand" /></div>
      ) : rows.length === 0 ? (
        <p className="px-3 py-8 text-center text-caption text-text-tertiary">{t('govern.history.tabEmpty')}</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.key} className="flex gap-3 border-t border-[rgb(var(--border-line))] px-3 py-3 first:border-t-0">
              <span className={cn(
                'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-tiny font-emphasis',
                r.kind === 'version' ? 'bg-brand/10 text-brand' : 'bg-surface-2 text-text-tertiary',
              )}>
                {r.kind === 'version' ? `v${r.version}` : r.kind === 'sync' ? <RefreshCw className="h-3.5 w-3.5" /> : <Boxes className="h-3.5 w-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-caption font-emphasis text-text-primary">{r.title}</span>
                  <span className="whitespace-nowrap text-tiny text-text-quaternary">{relTime(r.at, language, t)}</span>
                </div>
                {r.detail && <p className="mt-0.5 text-tiny leading-relaxed text-text-tertiary">{r.detail}</p>}
                <div className="mt-1.5 flex items-center gap-1.5">
                  {r.status && (
                    <span className={cn('rounded-full px-2 py-0.5 text-tiny',
                      r.status === 'error' ? 'bg-danger/10 text-danger'
                      : r.status === 'published' ? 'bg-success/10 text-success' : 'bg-surface-2 text-text-tertiary')}>
                      {r.status}
                    </span>
                  )}
                  {r.kind === 'version' && r.version != null && (
                    <button onClick={() => onViewVersion(r.version!)} className="text-tiny font-emphasis text-brand hover:underline">
                      {t('govern.action.view')}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </DetailDrawer>
  );
}

function DetailScreen({ docId, nav, onBack, onEdit, onDeleted, onOpenMetric, onListChanged, onOpenDoc, onShare }: {
  docId: number; nav: ReturnType<typeof useUrlNav>; managed: ManagedMetric[];
  onBack: () => void; onEdit: () => void; onDeleted: () => void;
  onOpenMetric: (s: MetricModalState) => void; onListChanged: () => Promise<void> | void;
  onOpenDoc: (id: number) => void; onShare: (id: number, title: string) => void;
}) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<KnowledgeDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const articleRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeHeading, setActiveHeading] = useState<string>('');
  const [viewingVersion, setViewingVersion] = useState<KnowledgeDocVersion | null>(null);
  // URL-backed so a drawer survives a refresh / can be linked to.
  const panel = (nav.get('dp') as DetailPanel) || null;
  const setPanel = (p: DetailPanel) => nav.set({ dp: p || undefined });
  const [modal, setModal] = useState<DetailModal>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [embedTab, setEmbedTab] = useState<'config' | 'vectors'>('config');
  const [usage, setUsage] = useState<DocUsage | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Usage feeds the header's connection count, the relations drawer and the
  // info flyout — fetched once per doc instead of per surface.
  useEffect(() => {
    let on = true;
    getDocUsage(docId).then((u) => { if (on) setUsage(u); }).catch(() => {});
    return () => { on = false; };
  }, [docId, refresh]);

  useEffect(() => {
    let on = true;
    setLoading(true);
    getKnowledgeDoc(docId)
      .then((d) => { if (on) setDoc(d); })
      .catch(() => { if (on) { setDoc(null); toast.error(t('govern.detail.openFailed')); } })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [docId, refresh, t]);

  // Scroll-spy: highlight the section currently being read in the on-this-page
  // outline. Observes the article's headings against the scroll container.
  useEffect(() => {
    const scroller = scrollRef.current;
    const article = articleRef.current;
    if (!scroller || !article) return;
    const heads = Array.from(article.querySelectorAll('h1,h2,h3')) as HTMLElement[];
    if (heads.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActiveHeading((vis[0].target.textContent || '').trim());
      },
      { root: scroller, rootMargin: '0px 0px -68% 0px', threshold: 0 },
    );
    heads.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [doc?.id, doc?.body]);

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

  // Sync straight from the header: a synced doc's most common action.
  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await syncDocSource(docId);
      toast.success(res.detail || t('govern.source.syncOk'));
      setRefresh((v) => v + 1);
    } catch (e) { toast.error(errDetail(e) || t('govern.source.syncFailed')); }
    finally { setSyncing(false); }
  };

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
  const perms = getResourcePermissions(doc.user_permission ?? undefined);
  const connectionCount = metrics.length + assets.length + (usage?.dashboards.length ?? 0) + related.length;

  // On-this-page outline (## / ### headings) → wayfinding in the left rail.
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
      {/* Header — the document IS the page, so the bar carries identity on the
          left and utilities on the right; no tab strip competes with it. */}
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button onClick={onBack} className="flex items-center gap-1 whitespace-nowrap text-sm text-text-tertiary transition-colors hover:text-text-primary">
          <ChevronLeft className="h-4 w-4" />
          {t('govern.detail.back')}
        </button>
        <span className="text-text-quaternary">/</span>
        <span className="max-w-[180px] truncate text-sm font-medium text-text-primary xl:max-w-[300px]">{doc.title}</span>
        {doc.source_type && (
          <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-tiny font-emphasis',
            doc.source_type === 'google_doc' ? 'border-info/20 bg-info/10 text-info'
            : doc.source_type === 'web' ? 'border-success/20 bg-success/10 text-success'
            : 'border-warning/20 bg-warning/10 text-warning')}>
            {doc.source_type ? t(`govern.source.typeShort.${doc.source_type}`) : t('govern.source.typeManual')}
          </span>
        )}
        <span className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[doc.status] || 'bg-surface-2 text-text-tertiary')}>
          {statusLabel(doc.status, t)}
        </span>
        <span className="hidden whitespace-nowrap text-tiny text-text-quaternary lg:inline">v{doc.version} · {doc.space}</span>

        <div className="flex-1" />

        <Button size="sm" variant={panel === 'relations' ? 'primary' : 'secondary'}
          leadingIcon={<Network className="h-3.5 w-3.5" />}
          onClick={() => setPanel(panel === 'relations' ? null : 'relations')}>
          {t('govern.relations.title')}
          {connectionCount > 0 && <span className="ml-1 rounded-full bg-brand/15 px-1.5 text-tiny text-brand">{connectionCount}</span>}
        </Button>
        <Button size="sm" variant={panel === 'history' ? 'primary' : 'secondary'}
          leadingIcon={<Clock3 className="h-3.5 w-3.5" />}
          onClick={() => setPanel(panel === 'history' ? null : 'history')}>
          {t('govern.detail.tab.history')}
        </Button>
        {/* Source-backed docs sync/open right here — the two actions a reader of
            a synced doc actually needs, without opening settings. */}
        {isSourceOwned(doc.source_type) && (
          <Button size="sm" variant="secondary" leadingIcon={<RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />}
            disabled={syncing} onClick={syncNow}>
            {t('govern.source.syncNow')}
          </Button>
        )}
        {doc.source_url && (
          <Button size="sm" variant="secondary" leadingIcon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => window.open(doc.source_url!, '_blank', 'noopener,noreferrer')}>
            {t(doc.source_type === 'google_doc' ? 'govern.detail.openInGoogleDocs' : 'govern.detail.openOriginalPage')}
          </Button>
        )}
        {perms.canEdit && (
          <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>
            {isSourceOwned(doc.source_type) ? t('govern.detail.editMetadata') : t('govern.action.edit')}
          </Button>
        )}

        {/* ••• — what used to be a tab but is configuration, not reading. */}
        <div className="relative">
          <Button size="sm" variant="ghost" onClick={() => setMoreOpen((o) => !o)} aria-label={t('govern.detail.more')}>•••</Button>
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
              <div className="absolute right-0 top-9 z-50 w-56 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-1 shadow-linear-lg">
                <MenuItem icon={<Database className="h-3.5 w-3.5" />} label={t('govern.menu.sourceSettings')}
                  onClick={() => { setMoreOpen(false); setModal('source'); }} />
                <MenuItem icon={<Boxes className="h-3.5 w-3.5" />} label={t('govern.menu.aiIndexSettings')}
                  onClick={() => { setMoreOpen(false); setModal('embedding'); }} />
                <MenuItem icon={<GitBranch className="h-3.5 w-3.5" />} label={t('govern.relations.openGraph')}
                  onClick={() => { setMoreOpen(false); setModal('graph'); }} />
                {perms.canShare && <MenuItem icon={<Share2 className="h-3.5 w-3.5" />} label={t('shared.share.shareButton')}
                  onClick={() => { setMoreOpen(false); onShare(doc.id, doc.title); }} />}
                {perms.canDelete && <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label={t('govern.action.delete')} danger
                  onClick={() => { setMoreOpen(false); remove(); }} />}
              </div>
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-6 sm:px-6 xl:px-8 [scrollbar-gutter:stable]">
        {/* `relative` anchors both the rail flyouts and the drawers, which float
            OVER the document so the reading surface keeps the full width. */}
        <div className="relative flex items-start gap-3">
          <OnPageOutline toc={toc} activeHeading={activeHeading} onJump={jumpTo} />
          <article ref={articleRef} className="min-w-0 flex-1">
            <div className="w-full rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-6 py-7 shadow-linear sm:px-10 sm:py-9">
              {viewingVersion
                ? <><DocHeader doc={doc} /><VersionViewer version={viewingVersion} onClose={() => setViewingVersion(null)} /></>
                : <ContentTab doc={doc} onDocLink={onOpenDoc} />}
            </div>
          </article>
          <DetailRail doc={doc} usage={usage} onOpenDoc={onOpenDoc}
            onRefresh={() => setRefresh((v) => v + 1)} onOpenEmbedding={() => setModal('embedding')}
            onOpenSource={() => setModal('source')} onSyncNow={syncNow} syncing={syncing} />

          {panel === 'relations' && (
            <RelationsDrawer doc={doc} metrics={metrics} assets={assets} related={related} usage={usage}
              onClose={() => setPanel(null)} onOpenDoc={onOpenDoc} onEditMetric={editMetric}
              onOpenGraph={() => { setPanel(null); setModal('graph'); }} />
          )}
          {panel === 'history' && (
            <HistoryDrawer doc={doc} onClose={() => setPanel(null)}
              onViewVersion={async (n) => {
                try { setViewingVersion(await getDocVersion(doc.id, n)); setPanel(null); scrollRef.current?.scrollTo({ top: 0 }); }
                catch { toast.error(t('govern.history.loadVersionFailed')); }
              }} />
          )}
        </div>
      </div>

      {/* Configuration surfaces — the full former tabs, opened on demand. */}
      {modal === 'source' && (
        <AppModalShell title={t('govern.menu.sourceSettings')} onClose={() => setModal(null)} maxWidthClass="max-w-5xl">
          <SourceTab doc={doc} onRefresh={() => setRefresh((v) => v + 1)} />
        </AppModalShell>
      )}
      {modal === 'embedding' && (
        <AppModalShell title={t('govern.menu.aiIndexSettings')} onClose={() => setModal(null)} maxWidthClass="max-w-5xl">
          <Tabs<'config' | 'vectors'> size="sm" value={embedTab} onChange={(v) => setEmbedTab(v)} items={[
            { key: 'config', label: t('govern.aiHealth.settings'), icon: <Boxes className="h-4 w-4" /> },
            { key: 'vectors', label: t('govern.vectors.title'), icon: <Database className="h-4 w-4" /> },
          ]} />
          <div className="mt-3">
            {embedTab === 'config'
              ? <EmbeddingTab doc={doc} onRefresh={() => setRefresh((v) => v + 1)} />
              : <VectorBrowser doc={doc} />}
          </div>
        </AppModalShell>
      )}
      {modal === 'graph' && (
        <AppModalShell title={t('govern.detail.tab.graph')} onClose={() => setModal(null)} maxWidthClass="max-w-5xl">
          <GraphTab doc={doc} onOpenDoc={(id) => { setModal(null); onOpenDoc(id); }} onEditMetric={editMetric} />
        </AppModalShell>
      )}
    </div>
  );
}

function MenuItem({ icon, label, danger, onClick }: { icon: ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-caption hover:bg-surface-2',
        danger ? 'text-danger' : 'text-text-secondary')}>
      {icon}{label}
    </button>
  );
}

// ── Knowledge-graph neighborhood — a hero doc node + a left-spine tree of
// clustered branches (KPIs / dashboards & data / related docs). Node cards are
// styled like the Dataset "Data Model" canvas nodes for a consistent graph feel;
// pure CSS connectors, zero dependencies. ──
type GraphTone = 'brand' | 'info' | 'neutral';
const TONE_MAP: Record<GraphTone, { dot: string; icon: string; grad: string }> = {
  brand: { dot: 'bg-brand', icon: 'bg-brand/10 text-brand', grad: 'from-brand/[0.07]' },
  info: { dot: 'bg-info', icon: 'bg-info/10 text-info', grad: 'from-info/[0.07]' },
  neutral: { dot: 'bg-text-quaternary', icon: 'bg-surface-2 text-text-tertiary', grad: 'from-surface-2' },
};

function GraphRow({ icon, title, sub, tone, onClick, href }: {
  icon: ReactNode; title: string; sub?: string; tone: GraphTone; onClick?: () => void; href?: string;
}) {
  const inner = (
    <span className="flex min-w-0 items-start gap-2">
      <span className={cn('mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md', TONE_MAP[tone].icon)}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-caption font-emphasis text-text-primary">{title}</span>
        {sub && <span className="block truncate text-tiny text-text-quaternary">{sub}</span>}
      </span>
    </span>
  );
  const cls = 'block w-full px-3 py-2 text-left transition-colors hover:bg-surface-2';
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
  return <div className="block w-full px-3 py-2 text-left">{inner}</div>;
}

// A canvas-style cluster card (gradient header + colored dot + count), hung off
// the spine with a dot + elbow connector.
function GraphCluster({ tone, icon, label, count, children }: {
  tone: GraphTone; icon: ReactNode; label: string; count: number; children: ReactNode;
}) {
  return (
    <div className="relative">
      {/* connector to the spine: node dot + horizontal elbow */}
      <span className={cn('absolute -left-[34px] top-[15px] hidden h-2.5 w-2.5 rounded-full border-2 border-surface-1 md:block', TONE_MAP[tone].dot)} />
      <span className="absolute -left-[25px] top-5 hidden h-px w-[25px] bg-[rgb(var(--border-line))] md:block" />
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        <div className={cn('flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-gradient-to-r to-transparent px-3 py-2', TONE_MAP[tone].grad)}>
          <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary">
            <span className={cn('flex h-4 w-4 items-center justify-center rounded', TONE_MAP[tone].icon)}>{icon}</span>{label}
          </span>
          <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">{count}</span>
        </div>
        <div className="divide-y divide-[rgb(var(--border-line))]">{children}</div>
      </div>
    </div>
  );
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
  return (
    <div className="max-w-3xl">
      {/* Hero: this document */}
      <div className="inline-flex items-center gap-3 rounded-xl border border-brand/30 bg-brand/[0.06] px-4 py-3 shadow-linear-sm">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand">{docIcon(doc.doc_type)}</span>
        <span className="min-w-0">
          <span className="block truncate text-small font-strong text-text-primary">{doc.title}</span>
          <span className="block truncate text-tiny text-text-quaternary">{t('govern.graph.thisDoc')} · {doc.space}</span>
        </span>
      </div>
      {/* trunk */}
      <div className="ml-5 h-4 w-px bg-[rgb(var(--border-line))]" />
      {/* spine + branches */}
      <div className="relative ml-5 space-y-4 border-l-2 border-[rgb(var(--border-line))] pl-8">
        {metrics.length > 0 && (
          <GraphCluster tone="brand" icon={<Sigma className="h-3 w-3" />} label={t('govern.graph.kpis')} count={metrics.length}>
            {metrics.map((m) => (
              <GraphRow key={m.machine_name} tone="brand" icon={<Sigma className="h-3.5 w-3.5" />} title={m.name}
                sub={m.is_source ? t('govern.metrics.sourceRole') : t('govern.metrics.reusedRole')}
                onClick={() => onEditMetric(m.machine_name)} />
            ))}
          </GraphCluster>
        )}
        {assets.length > 0 && (
          <GraphCluster tone="info" icon={<LayoutDashboard className="h-3 w-3" />} label={t('govern.graph.assets')} count={assets.length}>
            {assets.map((a) => (
              <GraphRow key={`${a.type}:${a.ref}`} tone="info"
                icon={a.type === 'dashboard' ? <LayoutDashboard className="h-3.5 w-3.5" /> : a.type === 'dataset' ? <Database className="h-3.5 w-3.5" /> : <TagIcon className="h-3.5 w-3.5" />}
                title={a.name || a.ref} sub={t(`govern.asset.${a.type}`)}
                href={a.exists && a.open_path ? a.open_path : undefined} />
            ))}
          </GraphCluster>
        )}
        {related.length > 0 && (
          <GraphCluster tone="neutral" icon={<BookOpen className="h-3 w-3" />} label={t('govern.graph.related')} count={related.length}>
            {related.map((r) => (
              <GraphRow key={r.id} tone="neutral" icon={<FileText className="h-3.5 w-3.5" />} title={r.title}
                sub={relatedReason(r, t)} onClick={() => onOpenDoc(r.id)} />
            ))}
          </GraphCluster>
        )}
      </div>
    </div>
  );
}

// AI writes a business doc from ONE OR MORE datasets — a knowledge doc usually
// spans several data sources, so this is a multi-select + an optional focus that
// steers what the document should be about. The backend reads each source's real
// model + sample + metrics and drafts a doc the user reviews before saving.
// ── Google Docs source picker ────────────────────────────────────────────────
// A document reads Google through a "Google Docs" DATA SOURCE (created in the
// Data Sources module, where each source connects its own Google account). The
// document just picks which connection to read through — the same shape as
// pointing a chart at a BigQuery source.
function GoogleDocsSourcePicker({ sources, value, onChange }: {
  sources: GoogleDocsSource[]; value: string; onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  const picked = sources.find((x) => String(x.id) === String(value));
  return (
    <>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('govern.gdocs.pickSource')}</option>
        {sources.map((x) => (
          <option key={x.id} value={x.id}>{x.name}{x.email ? ` — ${x.email}` : ''}</option>
        ))}
      </Select>
      {sources.length === 0 ? (
        <p className="mt-1 text-tiny text-warning">{t('govern.gdocs.noSources')}</p>
      ) : picked && !picked.can_read_docs ? (
        // Connected, but that account never approved Docs — say so here rather
        // than letting the sync fail later.
        <p className="mt-1 text-tiny text-warning">{t('govern.gdocs.sourceNeedsReconnect', { name: picked.name })}</p>
      ) : picked ? (
        <p className="mt-1 text-tiny text-text-quaternary">{t('govern.gdocs.readsAs', { email: picked.email || '—' })}</p>
      ) : null}
    </>
  );
}

// ── Create wizard — a document can come from four places. They differ ONLY in
// how content gets in; once inside, all four follow the same concept (body →
// versions → embedding → RAG). Google Doc / Web are owned by their source and
// stay read-only here; hand-typed and uploaded files are edited normally. ────
const SOURCE_KINDS: { kind: DocSourceKind; icon: ReactNode; tone: string }[] = [
  { kind: 'manual', icon: <Pencil className="h-5 w-5" />, tone: 'bg-surface-2 text-text-secondary' },
  { kind: 'google_doc', icon: <FileText className="h-5 w-5" />, tone: 'bg-info/10 text-info' },
  { kind: 'file', icon: <Upload className="h-5 w-5" />, tone: 'bg-success/10 text-success' },
  { kind: 'web', icon: <Network className="h-5 w-5" />, tone: 'bg-brand/10 text-brand' },
];

function CreateDocWizard({ spaces, onClose, onManual, onCreated }: {
  spaces: KnowledgeSpace[];
  onClose: () => void;
  onManual: (space: string, title: string) => void;
  onCreated: (docId: number) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<DocSourceKind>('manual');
  const [title, setTitle] = useState('');
  const [space, setSpace] = useState(spaces[0]?.space || 'Chung');
  const [gsources, setGsources] = useState<GoogleDocsSource[]>([]);
  const [datasourceId, setDatasourceId] = useState('');
  const [googleDocRef, setGoogleDocRef] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [schedule, setSchedule] = useState<DocSyncSchedule>({ mode: 'manual' });
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (kind === 'google_doc') listGoogleDocsSources().then(setGsources).catch(() => {}); }, [kind]);

  const canSubmit = (() => {
    if (!title.trim()) return false;
    if (kind === 'google_doc') return !!datasourceId && !!googleDocRef.trim();
    if (kind === 'web') return /^https?:\/\//.test(webUrl.trim());
    if (kind === 'file') return !!file;
    return true;
  })();

  const submit = async () => {
    // Carry the title across — retyping it in the editor is pure friction.
    if (kind === 'manual') { onManual(space, title.trim()); return; }
    setBusy(true);
    try {
      // 1. Create the shell document, 2. attach its source, 3. pull content once.
      // Same three steps for every connected kind — only the payload differs.
      const created = await upsertKnowledgeDoc({
        title: title.trim(), space, doc_type: 'article', status: 'Draft',
        tags: [], related_metrics: [], related_terms: [],
      });
      if (kind === 'file') {
        await uploadDocSourceFile(created.id, file!);
      } else {
        const source_config = kind === 'google_doc'
          ? { datasource_id: Number(datasourceId), google_doc_id: googleDocRef.trim() }
          : { url: webUrl.trim() };
        await putDocSource(created.id, { source_type: kind, source_config, sync_schedule: schedule });
        await syncDocSource(created.id);
      }
      toast.success(t('govern.create.created'));
      onCreated(created.id);
    } catch (e) {
      toast.error(errDetail(e) || t('govern.create.failed'));
    } finally { setBusy(false); }
  };

  return (
    <AppModalShell
      onClose={onClose} title={t('govern.create.title')} icon={<Plus className="h-4 w-4" />} maxWidthClass="max-w-2xl"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('govern.action.cancel')}</Button>
          {step === 2 && <Button variant="secondary" onClick={() => setStep(1)} disabled={busy}>{t('govern.create.back')}</Button>}
          {step === 1
            ? <Button variant="primary" onClick={() => setStep(2)}>{t('govern.create.continue')}</Button>
            : <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
                {kind === 'manual' ? t('govern.create.startWriting') : t('govern.create.submit')}
              </Button>}
        </>
      )}
    >
      {step === 1 ? (
        <div className="space-y-3">
          <p className="text-caption text-text-secondary">{t('govern.create.chooseSource')}</p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {SOURCE_KINDS.map((s) => (
              <button key={s.kind} onClick={() => setKind(s.kind)}
                className={cn(
                  'rounded-xl border p-3.5 text-left transition-colors',
                  kind === s.kind
                    ? 'border-brand bg-brand/[0.06] ring-1 ring-brand'
                    : 'border-[rgb(var(--border-line))] hover:bg-surface-2',
                )}>
                <span className={cn('mb-2 flex h-9 w-9 items-center justify-center rounded-lg', s.tone)}>{s.icon}</span>
                <span className="block text-caption font-emphasis text-text-primary">{t(`govern.create.kind.${s.kind}`)}</span>
                <span className="mt-0.5 block text-tiny leading-relaxed text-text-tertiary">{t(`govern.create.kindDesc.${s.kind}`)}</span>
                <span className="mt-1.5 inline-block rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">
                  {t(`govern.create.kindTag.${s.kind}`)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label required>{t('govern.editor.title')}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('govern.create.titlePlaceholder')} />
            </div>
            <div>
              <Label>{t('govern.editor.space')}</Label>
              <Input value={space} onChange={(e) => setSpace(e.target.value)} list="wizard-spaces" />
              <datalist id="wizard-spaces">{spaces.map((s) => <option key={s.space} value={s.space} />)}</datalist>
            </div>
          </div>

          {kind === 'google_doc' && (
            <>
              <div>
                <Label required>{t('govern.gdocs.source')}</Label>
                <GoogleDocsSourcePicker sources={gsources} value={datasourceId} onChange={setDatasourceId} />
              </div>
              <div>
                <Label required>{t('govern.source.googleDocUrl')}</Label>
                <Input value={googleDocRef} onChange={(e) => setGoogleDocRef(e.target.value)} placeholder="https://docs.google.com/document/d/..." />
              </div>
            </>
          )}

          {kind === 'web' && (
            <div>
              <Label required>{t('govern.source.webUrl')}</Label>
              <Input value={webUrl} onChange={(e) => setWebUrl(e.target.value)} placeholder="https://example.com/article" />
            </div>
          )}

          {kind === 'file' && (
            <div>
              <Label required>{t('govern.source.uploadFile')}</Label>
              <input ref={fileRef} type="file" accept=".pdf,.docx,.xlsx" className="hidden"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" leadingIcon={<Upload className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()}>
                  {t('govern.create.chooseFile')}
                </Button>
                <span className="min-w-0 truncate text-tiny text-text-tertiary">{file ? file.name : t('govern.create.noFile')}</span>
              </div>
            </div>
          )}

          {(kind === 'google_doc' || kind === 'web') && (
            <div>
              <Label>{t('govern.source.schedule')}</Label>
              <Select value={schedule.mode} onChange={(e) => setSchedule({ ...schedule, mode: e.target.value as DocSyncSchedule['mode'] })}>
                <option value="manual">{t('govern.source.scheduleManual')}</option>
                <option value="hourly">{t('govern.source.scheduleHourly')}</option>
                <option value="daily">{t('govern.source.scheduleDaily')}</option>
              </Select>
            </div>
          )}

          <div className="rounded-lg bg-surface-2 px-3 py-2.5">
            <p className="text-tiny leading-relaxed text-text-tertiary">{t(`govern.create.note.${kind}`)}</p>
          </div>
        </div>
      )}
    </AppModalShell>
  );
}

function AiWriteModal({ onClose, onDrafted }: { onClose: () => void; onDrafted: (draft: KnowledgeDocWrite) => void }) {
  const { t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetLite[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { listDatasetsLite().then(setDatasets).catch(() => toast.error(t('govern.ai.loadDatasetsFailed'))); }, [t]);

  const toggle = (id: number) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const filtered = datasets.filter((d) => !q.trim() || d.name.toLowerCase().includes(q.trim().toLowerCase()));

  const run = async () => {
    if (selected.size === 0) { toast.error(t('govern.ai.chooseDataset')); return; }
    setBusy(true);
    try {
      const d = await aiDraftKnowledge({ dataset_ids: [...selected], focus: focus.trim() || undefined });
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
          <AiButton size="md" onClick={run} loading={busy} disabled={selected.size === 0}>
            {t('govern.ai.submit')}
          </AiButton>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="text-caption text-text-secondary">{t('govern.ai.description')}</p>
        <div className="space-y-1.5">
          <Label required>{t('govern.ai.datasets')}</Label>
          <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('govern.ai.searchDatasets')} disabled={busy} />
          <div className="max-h-56 divide-y divide-[rgb(var(--border-line))] overflow-y-auto rounded-lg border border-[rgb(var(--border-line))]">
            {filtered.length === 0
              ? <p className="px-3 py-4 text-center text-tiny text-text-quaternary">{t('govern.ai.noDatasets')}</p>
              : filtered.map((d) => (
                <label key={d.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-surface-2">
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} disabled={busy}
                    className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" />
                  <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">{d.name}</span>
                  {selected.has(d.id) && <span className="text-tiny text-brand">✓</span>}
                </label>
              ))}
          </div>
          {selected.size > 0 && <p className="text-tiny text-text-quaternary">{t('govern.ai.selectedCount', { count: selected.size })}</p>}
        </div>
        <div className="space-y-1.5">
          <Label>{t('govern.ai.focus')}</Label>
          <Textarea rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder={t('govern.ai.focusPlaceholder')} disabled={busy} />
        </div>
        {busy && <p className="text-tiny text-text-quaternary">{t('govern.ai.busyHint')}</p>}
      </div>
    </AppModalShell>
  );
}

/** Replace {{…}} tokens + [[wikilinks]] INLINE with readable links/chips so prose
 * reads naturally. Wikilinks use the "govern:doc:<id>" href scheme the Markdown
 * renderer turns into in-app navigation (or a muted chip when unresolved). */
function resolveBody(doc: KnowledgeDoc): string {
  let body = doc.body ?? '';
  for (const m of doc.metrics_on_page ?? []) body = body.split(`{{metric:${m.machine_name}}}`).join(`**📈 ${m.name}**`);
  for (const a of doc.assets_on_page ?? []) {
    const icon = a.type === 'dashboard' ? '📊' : a.type === 'dataset' ? '🗄' : '📖';
    const label = a.name || a.ref;
    const rep = a.exists && a.open_path ? `[${icon} ${label}](${a.open_path})` : `**${icon} ${label}**`;
    body = body.split(`{{${a.type}:${a.ref}}}`).join(rep);
  }
  for (const w of doc.wikilinks_on_page ?? []) {
    const literal = w.alias ? `[[${w.target}|${w.alias}]]` : `[[${w.target}]]`;
    const label = (w.alias || w.title || w.target).replace(/[[\]]/g, '');
    const rep = w.exists && w.doc_id != null ? `[${label}](govern:doc:${w.doc_id})` : `[${label}](govern:miss)`;
    body = body.split(literal).join(rep);
  }
  return body;
}

// ── Document header (title → lead summary). Metadata chips removed — that
// context (space/type/status/version/owner) lives in the right rail. ──
function DocHeader({ doc }: { doc: KnowledgeDoc }) {
  return (
    <header className="mb-7 border-b border-[rgb(var(--border-line))] pb-5">
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
// Rail card styled like a Dataset "Data Model" canvas node: a divider'd header
// bar (icon + label) over a padded body. Optionally COLLAPSIBLE so secondary
// panels can tuck away and only expand on demand (keeps the rail uncluttered).
function RailCard({ title, icon, children, collapsible = false, defaultOpen = true }: {
  title: string; icon?: ReactNode; children: ReactNode; collapsible?: boolean; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const headerBase = 'flex w-full items-center gap-1.5 bg-surface-2/50 px-3.5 py-2 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary';
  if (!collapsible) {
    return (
      <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
        <p className={cn(headerBase, 'border-b border-[rgb(var(--border-line))]')}>{icon}{title}</p>
        <div className="p-3.5">{children}</div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <button onClick={() => setOpen((o) => !o)} className={cn(headerBase, 'justify-between transition-colors hover:bg-surface-2', open && 'border-b border-[rgb(var(--border-line))]')}>
        <span className="flex items-center gap-1.5">{icon}{title}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <div className="p-3.5">{children}</div>}
    </div>
  );
}
// 4-step readiness strip (Source → Content → Embedded → Available to AI) — a
// compressed, visual grouping of the machine ai_ready checks. No shared
// stepper component exists elsewhere in the codebase to reuse, so this is a
// small bespoke flex row of segments.
function ReadinessStrip({ doc, missing }: { doc: KnowledgeDoc; missing: string[] }) {
  const { t } = useI18n();
  const steps: { key: string; label: string; done: boolean }[] = [
    { key: 'source', label: t('govern.ready.step.source'), done: !missing.includes('source_connected') },
    { key: 'content', label: t('govern.ready.step.content'), done: (doc.body || '').trim().length > 0 },
    { key: 'embedded', label: t('govern.ready.step.embedded'), done: !missing.includes('embedded') },
    { key: 'available', label: t('govern.ready.step.available'), done: doc.status === 'Published' && !missing.includes('embedded') },
  ];
  return (
    <div className="mb-2.5 flex items-center gap-1">
      {steps.map((s, i) => (
        <div key={s.key} className="flex flex-1 items-center gap-1" title={s.label}>
          <span className={cn('h-1.5 flex-1 rounded-full', s.done ? 'bg-success' : 'bg-surface-3')} />
          {i < steps.length - 1 && <ChevronRight className="h-3 w-3 flex-shrink-0 text-text-quaternary" />}
        </div>
      ))}
    </div>
  );
}

// AI-context card — readiness score + what's missing + AI summary/keywords.
function AiContextCard({ doc, onRefresh, bare = false }: { doc: KnowledgeDoc; onRefresh: () => void; bare?: boolean }) {
  const { t } = useI18n();
  const [regenBusy, setRegenBusy] = useState(false);
  const ready = doc.ai_ready ?? { score: 0, missing: [] };
  const regen = async () => {
    setRegenBusy(true);
    try { await regenAiSummary(doc.id); toast.success(t('govern.aiCard.regenOk')); onRefresh(); }
    catch (e) { toast.error(errDetail(e) || t('govern.aiCard.regenFailed')); }
    finally { setRegenBusy(false); }
  };
  // `bare` drops the card chrome when the caller already provides it (rail flyout).
  const Shell = bare
    ? ({ children }: { children: ReactNode }) => <>{children}</>
    : ({ children }: { children: ReactNode }) => (
        <RailCard title={t('govern.aiCard.title')} icon={<Sparkles className="h-3.5 w-3.5" />}>{children}</RailCard>
      );
  return (
    <Shell>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className={cn('rounded-full px-2.5 py-0.5 text-caption font-emphasis', readyTone(ready.score))}>{ready.score}%</span>
        <span className="text-tiny text-text-quaternary">{t('govern.aiCard.readingTime', { min: readingMinutes(doc.body) })}</span>
      </div>
      <ReadinessStrip doc={doc} missing={ready.missing} />
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
    </Shell>
  );
}

// Left rail — on-page outline (TOC) with scroll-spy. Docs-site style: a thin
// vertical rule with the section you're reading highlighted. Its own column so
// it never competes with the right context rail for vertical space.
// ── Icon rails ───────────────────────────────────────────────────────────────
// The reading surface gets the whole width; the outline and the context panels
// collapse to slim icon strips and open as flyouts ON TOP of the content, so
// nothing permanently competes with the document for horizontal space.
function RailIcon({ icon, label, active, badge, onClick }: {
  icon: ReactNode; label: string; active?: boolean; badge?: ReactNode; onClick: () => void;
}) {
  return (
    <button onClick={onClick} title={label} aria-label={label} aria-pressed={active}
      className={cn(
        'relative flex h-9 w-9 items-center justify-center rounded-lg border transition-colors',
        active
          ? 'border-brand/40 bg-brand/10 text-brand'
          : 'border-[rgb(var(--border-line))] text-text-tertiary hover:bg-surface-2 hover:text-text-primary',
      )}>
      {icon}
      {badge != null && (
        <span className="absolute -right-1 -top-1 min-w-[1rem] rounded-full bg-surface-3 px-1 text-[10px] font-emphasis leading-4 text-text-secondary">
          {badge}
        </span>
      )}
    </button>
  );
}

/** Flyout panel anchored to a rail; floats over the document. */
function RailFlyout({ side, title, icon, onClose, children }: {
  side: 'left' | 'right'; title: string; icon?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={cn(
      'absolute top-0 z-30 w-[min(20rem,calc(100vw-6.5rem))] overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg xl:w-[22rem]',
      side === 'left' ? 'left-11' : 'right-11',
    )}>
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2/50 px-3 py-2">
        <p className="flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">
          {icon}{title}
        </p>
        <button onClick={onClose} aria-label={t('common.close')} className="text-text-quaternary transition-colors hover:text-text-primary">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-[calc(100vh-9rem)] overflow-y-auto p-3">{children}</div>
    </div>
  );
}

function OnPageOutline({ toc, activeHeading, onJump }: {
  toc: { level: number; text: string }[]; activeHeading: string; onJump: (text: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (toc.length <= 1) return null;
  return (
    <div className="sticky top-0 z-30 hidden shrink-0 self-start pt-0.5 sm:block">
      <RailIcon icon={<List className="h-4 w-4" />} label={t('govern.rail.outline')} active={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <RailFlyout side="left" title={t('govern.rail.outline')} icon={<List className="h-3.5 w-3.5" />} onClose={() => setOpen(false)}>
          <nav className="border-l border-[rgb(var(--border-line))]">
            {toc.map((h, i) => {
              const active = !!activeHeading && h.text === activeHeading;
              return (
                <button key={i} onClick={() => { onJump(h.text); setOpen(false); }} aria-current={active ? 'true' : undefined}
                  className={cn(
                    '-ml-px block w-full truncate border-l-2 px-2.5 py-1 text-left text-caption transition-colors',
                    active ? 'border-brand font-emphasis text-brand' : 'border-transparent text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:text-text-primary',
                    h.level === 3 && 'pl-5 text-tiny',
                  )}>
                  {h.text}
                </button>
              );
            })}
          </nav>
        </RailFlyout>
      )}
    </div>
  );
}

function DetailRail({ doc, usage, onOpenDoc, onRefresh, onOpenEmbedding, onOpenSource, onSyncNow, syncing }: {
  doc: KnowledgeDoc;
  usage: DocUsage | null;
  onOpenDoc: (id: number) => void; onRefresh: () => void;
  onOpenEmbedding: () => void; onOpenSource: () => void; onSyncNow: () => void; syncing: boolean;
}) {
  const { t, language } = useI18n();
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [reindexBusy, setReindexBusy] = useState(false);
  const [embed, setEmbed] = useState<EmbeddingConfig | null>(null);
  // Three utilities, mirroring the mockup: AI readiness · Information ·
  // Linked mentions. Everything heavier is a drawer or a settings modal.
  const [panel, setPanel] = useState<null | 'ai' | 'info' | 'backlinks'>(null);
  const toggle = (p: NonNullable<typeof panel>) => setPanel((cur) => (cur === p ? null : p));
  const backlinks = doc.backlinks ?? [];
  const ready = doc.ai_ready ?? { score: 0, missing: [] };
  const missing = new Set(ready.missing);

  useEffect(() => {
    let on = true;
    getEmbeddingConfig(doc.id).then((c) => { if (on) setEmbed(c); }).catch(() => {});
    return () => { on = false; };
  }, [doc.id]);

  const doVerify = async () => {
    setVerifyBusy(true);
    try { await verifyDoc(doc.id); toast.success(t('govern.detail.verifyOk')); onRefresh(); }
    catch (e) { toast.error(errDetail(e) || t('govern.detail.verifyFailed')); }
    finally { setVerifyBusy(false); }
  };
  const doReindex = async () => {
    setReindexBusy(true);
    try {
      const res = await reembedDoc(doc.id);
      toast.success(t('govern.embedding.reembedOk', { chunks: res.chunks }));
      // Truncation is a correctness problem, not a detail: part of the document
      // is simply not in the index. Warn separately so it is not read as noise
      // attached to the success line.
      if (res.truncated) toast.error(t('govern.embedding.truncatedToast', { chars: (res.dropped_chars ?? 0).toLocaleString() }));
      setEmbed(await getEmbeddingConfig(doc.id).catch(() => embed!));
      onRefresh();
    } catch (e) { toast.error(errDetail(e) || t('govern.embedding.reembedFailed')); }
    finally { setReindexBusy(false); }
  };

  const Health = ({ label, ok, value }: { label: string; ok?: boolean; value?: ReactNode }) => (
    <div className="flex items-center justify-between gap-2 py-1 text-tiny text-text-secondary">
      <span>{label}</span>
      {value != null ? <span className="text-text-tertiary">{value}</span>
        : ok ? <Check className="h-3.5 w-3.5 text-success" /> : <AlertTriangle className="h-3.5 w-3.5 text-warning" />}
    </div>
  );
  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="border-t border-[rgb(var(--border-line))] py-2.5 first-of-type:border-t-0 first-of-type:pt-0">
      <p className="mb-1.5 text-tiny font-emphasis uppercase tracking-[0.11em] text-text-quaternary">{title}</p>
      {children}
    </div>
  );

  return (
    <div className="sticky top-0 z-30 hidden shrink-0 self-start pt-0.5 sm:block">
      <div className="flex flex-col gap-1.5">
        <RailIcon icon={<Sparkles className="h-4 w-4" />} label={t('govern.aiCard.title')} active={panel === 'ai'} onClick={() => toggle('ai')} />
        <RailIcon icon={<Info className="h-4 w-4" />} label={t('govern.rail.info')} active={panel === 'info'} onClick={() => toggle('info')} />
        {backlinks.length > 0 && (
          <RailIcon icon={<Link2 className="h-4 w-4" />} label={t('govern.backlinks.title')} badge={backlinks.length}
            active={panel === 'backlinks'} onClick={() => toggle('backlinks')} />
        )}
      </div>

      {panel === 'ai' && (
        <RailFlyout side="right" title={t('govern.aiCard.title')} icon={<Sparkles className="h-3.5 w-3.5" />} onClose={() => setPanel(null)}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className={cn('rounded-full px-2.5 py-0.5 text-caption font-emphasis', readyTone(ready.score))}>{ready.score}%</span>
            <span className="text-tiny text-text-quaternary">{t('govern.aiCard.readingTime', { min: readingMinutes(doc.body) })}</span>
          </div>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <span className="block h-full rounded-full bg-success" style={{ width: `${ready.score}%` }} />
          </div>

          {/* Reachability first: a 100% quality score means nothing if the bot
              can never see the document. This is the one thing on the panel
              that says "the AI will not use this at all". */}
          {doc.ai_retrievable && !doc.ai_retrievable.ok && (
            <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-2.5">
              <p className="flex items-center gap-1.5 text-tiny font-emphasis text-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />{t('govern.aiReach.title')}
              </p>
              <ul className="mt-1 space-y-0.5 pl-5 text-tiny text-text-secondary">
                {doc.ai_retrievable.reasons.map((r) => (
                  <li key={r} className="list-disc">{t(`govern.aiReach.${r}`)}</li>
                ))}
              </ul>
            </div>
          )}

          <Section title={t('govern.aiHealth.content')}>
            <Health label={t('govern.aiHealth.hasSummary')} ok={!missing.has('summary')} />
            <Health label={t('govern.aiHealth.hasOwner')} ok={!missing.has('owner')} />
            <Health label={t('govern.aiHealth.hasHeadings')} ok={!missing.has('headings')} />
            <Health label={t('govern.aiHealth.hasContext')} ok={!missing.has('context')} />
          </Section>

          <Section title={t('govern.aiHealth.index')}>
            <Health label={t('govern.aiHealth.indexed')} value={
              embed ? t('govern.embedding.currentChunks', { count: embed.chunk_count }) : '—'} />
            <Health label={t('govern.aiHealth.strategy')} value={
              embed ? t(`govern.embedding.strategy${embed.chunk_strategy === 'heading' ? 'Heading' : embed.chunk_strategy === 'fixed' ? 'Fixed' : 'Paragraph'}`) : '—'} />
            {embed?.index_stale && (
              <p className="mt-1 flex items-start gap-1.5 rounded-md bg-warning/10 p-1.5 text-tiny text-warning">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {t('govern.embedding.staleHint')}
              </p>
            )}
            {embed?.truncated && (
              <p className="mt-1 flex items-start gap-1.5 rounded-md bg-warning/10 p-1.5 text-tiny text-warning">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {t('govern.embedding.truncatedHint', {
                  chunks: embed.dropped_chunks ?? 0,
                  chars: (embed.dropped_chars ?? 0).toLocaleString(),
                  max: embed.max_chunks ?? 0,
                })}
              </p>
            )}
            <div className="mt-1.5 flex gap-1.5">
              <Button size="xs" variant="secondary" loading={reindexBusy} leadingIcon={<RefreshCw className="h-3 w-3" />} onClick={doReindex}>
                {t('govern.aiHealth.reindex')}
              </Button>
              <Button size="xs" variant="ghost" onClick={onOpenEmbedding}>{t('govern.aiHealth.settings')}</Button>
            </div>
          </Section>

          <Section title={t('govern.aiHealth.governance')}>
            <Health label={statusLabel(doc.status, t) + (doc.published_version ? ` v${doc.published_version}` : '')} ok={doc.status === 'Published'} />
            <Health label={t('govern.detail.reviewDate')} value={doc.review_date || '—'} />
            <Health label={t('govern.aiHealth.isIndexed')} ok={!missing.has('embedded')} />
          </Section>
        </RailFlyout>
      )}

      {panel === 'info' && (
        <RailFlyout side="right" title={t('govern.rail.info')} icon={<Info className="h-3.5 w-3.5" />} onClose={() => setPanel(null)}>
          <dl className="space-y-2.5">
            <RailRow label={t('govern.editor.space')} value={doc.space} />
            <RailRow label={t('govern.list.header.type')} value={docTypeLabel(doc.doc_type, t)} />
            <RailRow label={t('govern.list.header.status')} value={<span className={cn('rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[doc.status] || 'bg-surface-2 text-text-tertiary')}>{statusLabel(doc.status, t)}</span>} />
            <RailRow label={t('govern.info.version')} value={`v${doc.version}`} />
            <RailRow label={t('govern.info.ownerAccount')} value={doc.owner_email || '—'} />
            <RailRow label={t('govern.editor.owner')} value={doc.owner || '—'} />
            {doc.business_domain && <RailRow label={t('govern.detail.businessDomain')} value={doc.business_domain} />}
            {doc.process_ref && <RailRow label={t('govern.detail.processRef')} value={doc.process_ref} />}
            <RailRow label={t('govern.detail.importance')} value={t(`govern.importance.${doc.importance || 'normal'}`)} />
            {doc.review_date && <RailRow label={t('govern.detail.reviewDate')} value={doc.review_date} />}
            <RailRow label={t('govern.detail.lastVerified')} value={doc.last_verified_at ? relTime(doc.last_verified_at, language, t) : '-'} />
            {doc.updated_at && <RailRow label={t('govern.list.header.updated')} value={relTime(doc.updated_at, language, t)} />}
          </dl>

          {/* Source lives here — reading a doc, "where does this come from" is
              information, not a workspace of its own. */}
          <div className="mt-3 border-t border-[rgb(var(--border-line))] pt-3">
            <p className="mb-1.5 text-tiny font-emphasis uppercase tracking-[0.11em] text-text-quaternary">{t('govern.info.source')}</p>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-2">
              <div className="min-w-0">
                <p className="truncate text-tiny font-emphasis text-text-primary">
                  {doc.source_type ? t(`govern.source.typeShort.${doc.source_type}`) : t('govern.source.typeManual')}
                </p>
                {doc.source_url && <p className="truncate text-tiny text-text-quaternary">{doc.source_url}</p>}
              </div>
              {doc.source_type && doc.last_sync_status && (
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-tiny',
                  doc.last_sync_status === 'error' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success')}>
                  {t(`govern.source.status.${doc.last_sync_status}`)}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              {isSourceOwned(doc.source_type) && (
                <Button size="xs" variant="secondary" loading={syncing} leadingIcon={<RefreshCw className="h-3 w-3" />} onClick={onSyncNow}>
                  {t('govern.source.syncNow')}
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={onOpenSource}>{t('govern.aiHealth.settings')}</Button>
            </div>
          </div>

          <div className="mt-3 border-t border-[rgb(var(--border-line))] pt-3">
            <p className="mb-1.5 text-tiny font-emphasis uppercase tracking-[0.11em] text-text-quaternary">{t('govern.info.usage')}</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-[rgb(var(--border-line))] px-2.5 py-2">
                <b className="block text-body font-emphasis text-text-primary">{doc.view_count ?? 0}</b>
                <span className="text-tiny uppercase tracking-[0.08em] text-text-quaternary">{t('govern.detail.views')}</span>
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] px-2.5 py-2">
                <b className="block text-body font-emphasis text-text-primary">{usage?.retrieval_count ?? doc.retrieval_count ?? 0}</b>
                <span className="text-tiny uppercase tracking-[0.08em] text-text-quaternary">{t('govern.info.aiUses')}</span>
              </div>
            </div>
          </div>

          <Button size="sm" variant="secondary" className="mt-3 w-full" leadingIcon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verifyBusy} onClick={doVerify}>
            {t('govern.detail.verify')}
          </Button>
        </RailFlyout>
      )}

      {panel === 'backlinks' && (
        <RailFlyout side="right" title={t('govern.backlinks.title')} icon={<Link2 className="h-3.5 w-3.5" />} onClose={() => setPanel(null)}>
          <div className="space-y-1">
            {backlinks.map((b) => (
              <button key={b.id} onClick={() => { onOpenDoc(b.id); setPanel(null); }} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-2">
                <span className="block truncate text-caption font-emphasis text-text-secondary">{b.title}</span>
                <span className="block truncate text-tiny text-text-quaternary">{b.space}</span>
              </button>
            ))}
          </div>
        </RailFlyout>
      )}
    </div>
  );
}

function WebSnapshotView({ docId }: { docId: number }) {
  const { t } = useI18n();
  const [snap, setSnap] = useState<DocSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let on = true;
    setLoading(true); setFailed(false);
    getDocSnapshot(docId)
      .then((s) => { if (on) setSnap(s); })
      .catch(() => { if (on) setFailed(true); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [docId]);

  if (loading) return <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-brand" /></div>;
  if (failed || !snap) {
    return (
      <p className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center text-caption text-text-tertiary">
        {t('govern.snapshot.none')}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-white">
      <iframe
        title={t('govern.snapshot.title')}
        srcDoc={snap.html}
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[70vh] w-full border-0"
      />
    </div>
  );
}

function ContentTab({ doc, onDocLink }: { doc: KnowledgeDoc; onDocLink?: (id: number) => void }) {
  const { t } = useI18n();
  const missing = doc.missing_metric_tokens ?? [];
  const hasSnapshot = doc.source_type === 'web';
  const [view, setView] = useState<'text' | 'snapshot'>('text');
  return (
    <div className="min-w-0">
      {hasSnapshot && (
        <div className="mb-3 flex justify-end">
          <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-0.5 shadow-linear-sm">
          {(['text', 'snapshot'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={cn('rounded-md px-2.5 py-1 text-tiny font-emphasis transition-colors',
                view === v ? 'bg-brand text-white' : 'text-text-tertiary hover:text-text-primary')}>
              {t(v === 'text' ? 'govern.snapshot.viewText' : 'govern.snapshot.viewOriginal')}
            </button>
          ))}
          </div>
        </div>
      )}

      {hasSnapshot && view === 'snapshot'
        ? <WebSnapshotView docId={doc.id} />
        : (
          <>
            <DocHeader doc={doc} />
            {doc.body
              ? <Markdown source={resolveBody(doc)} onDocLink={onDocLink} />
              : <p className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center text-caption text-text-tertiary">{t('govern.content.empty')}</p>}
          </>
        )}

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

// ── Source & Sync — connect this doc to a Google Doc / uploaded file / web
// page instead of only hand-typing, with a "Sync now" action and (for
// google_doc/web) a recurring schedule. ──────────────────────────────────────
function SourceTab({ doc, onRefresh }: { doc: KnowledgeDoc; onRefresh: () => void }) {
  const { t, language } = useI18n();
  const [info, setInfo] = useState<DocSourceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [sourceType, setSourceType] = useState('');
  const [datasourceId, setDatasourceId] = useState('');
  const [googleDocRef, setGoogleDocRef] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [schedule, setSchedule] = useState<DocSyncSchedule>({ mode: 'manual' });

  // Re-fetchable: reconnecting Google must refresh the connection state in place.
  const reload = useCallback(() => {
    setLoading(true);
    getDocSource(doc.id)
      .then((d) => {
        setInfo(d);
        setSourceType(d.source_type || '');
        setDatasourceId(typeof d.source_config?.datasource_id === 'number' ? String(d.source_config.datasource_id) : '');
        setGoogleDocRef(typeof d.source_config?.google_doc_id === 'string' ? d.source_config.google_doc_id : '');
        setWebUrl(typeof d.source_config?.url === 'string' ? d.source_config.url : '');
        setSchedule(d.sync_schedule || { mode: 'manual' });
      })
      .catch(() => toast.error(t('govern.source.loadFailed')))
      .finally(() => setLoading(false));
  }, [doc.id, t]);
  useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    setSaving(true);
    try {
      const source_config: Record<string, unknown> =
        sourceType === 'google_doc' ? { datasource_id: Number(datasourceId) || null, google_doc_id: googleDocRef }
        : sourceType === 'web' ? { url: webUrl }
        : {};
      await putDocSource(doc.id, {
        source_type: sourceType || null, source_config,
        sync_schedule: sourceType === 'google_doc' || sourceType === 'web' ? schedule : null,
      });
      toast.success(t('govern.source.saved'));
      onRefresh();
    } catch (e) { toast.error(errDetail(e) || t('govern.source.saveFailed')); }
    finally { setSaving(false); }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await syncDocSource(doc.id);
      toast.success(res.detail || t('govern.source.syncOk'));
      onRefresh();
    } catch (e) { toast.error(errDetail(e) || t('govern.source.syncFailed')); }
    finally { setSyncing(false); }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadDocSourceFile(doc.id, file);
      toast.success(t('govern.source.uploadOk', { chars: res.extracted_chars }));
      onRefresh();
    } catch (err) { toast.error(errDetail(err) || t('govern.source.uploadFailed')); }
    finally { setUploading(false); }
  };

  if (loading) return <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-brand" /></div>;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <RailCard title={t('govern.source.title')} icon={<Database className="h-3.5 w-3.5" />}>
        <div className="space-y-3">
          <div>
            <Label>{t('govern.source.type')}</Label>
            <Select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              <option value="">{t('govern.source.typeManual')}</option>
              <option value="google_doc">{t('govern.source.typeGoogleDoc')}</option>
              <option value="file">{t('govern.source.typeFile')}</option>
              <option value="web">{t('govern.source.typeWeb')}</option>
            </Select>
          </div>

          {sourceType === 'google_doc' && (
            <>
              <div>
                <Label>{t('govern.gdocs.source')}</Label>
                <GoogleDocsSourcePicker sources={info?.google_sources ?? []} value={datasourceId} onChange={setDatasourceId} />
              </div>
              <div>
                <Label>{t('govern.source.googleDocUrl')}</Label>
                <Input value={googleDocRef} onChange={(e) => setGoogleDocRef(e.target.value)} placeholder="https://docs.google.com/document/d/..." />
              </div>
            </>
          )}

          {sourceType === 'web' && (
            <div>
              <Label>{t('govern.source.webUrl')}</Label>
              <Input value={webUrl} onChange={(e) => setWebUrl(e.target.value)} placeholder="https://example.com/article" />
            </div>
          )}

          {sourceType === 'file' && (
            <div>
              <input ref={fileRef} type="file" accept=".pdf,.docx,.xlsx" className="hidden" onChange={onFile} />
              <Button size="sm" variant="secondary" leadingIcon={<Upload className="h-3.5 w-3.5" />} loading={uploading} onClick={() => fileRef.current?.click()}>
                {t('govern.source.uploadFile')}
              </Button>
              {info?.file && (
                <p className="mt-2 text-tiny text-text-tertiary">{info.file.filename} · {(info.file.byte_size / 1024).toFixed(0)} KB</p>
              )}
            </div>
          )}

          {(sourceType === 'google_doc' || sourceType === 'web') && (
            <div>
              <Label>{t('govern.source.schedule')}</Label>
              <Select value={schedule.mode} onChange={(e) => setSchedule({ ...schedule, mode: e.target.value as DocSyncSchedule['mode'] })}>
                <option value="manual">{t('govern.source.scheduleManual')}</option>
                <option value="hourly">{t('govern.source.scheduleHourly')}</option>
                <option value="daily">{t('govern.source.scheduleDaily')}</option>
                <option value="cron">{t('govern.source.scheduleCron')}</option>
              </Select>
              {schedule.mode === 'daily' && (
                <Input className="mt-2" type="time" value={schedule.at || '02:00'} onChange={(e) => setSchedule({ ...schedule, at: e.target.value })} />
              )}
              {schedule.mode === 'cron' && (
                <Input className="mt-2" value={schedule.cron || ''} placeholder="0 2 * * *" onChange={(e) => setSchedule({ ...schedule, cron: e.target.value })} />
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="secondary" leadingIcon={<Save className="h-3.5 w-3.5" />} loading={saving} onClick={save}>{t('govern.action.save')}</Button>
            {(sourceType === 'google_doc' || sourceType === 'web') && (
              <Button size="sm" variant="primary" leadingIcon={<RefreshCw className="h-3.5 w-3.5" />} loading={syncing} onClick={syncNow}>{t('govern.source.syncNow')}</Button>
            )}
          </div>
        </div>
      </RailCard>

      <RailCard title={t('govern.source.status')}>
        <dl className="space-y-2.5">
          <RailRow label={t('govern.source.lastSynced')} value={info?.last_synced_at ? relTime(info.last_synced_at, language, t) : '-'} />
          <RailRow label={t('govern.source.statusLabel')} value={info?.last_sync_status ? t(`govern.source.status.${info.last_sync_status}`) : '—'} />
        </dl>
        {info?.last_sync_status === 'error' && (
          <div className="mt-2.5 rounded-lg bg-danger/10 px-2.5 py-2 text-tiny text-danger">{t('govern.source.errorHint')}</div>
        )}
      </RailCard>
    </div>
  );
}

// ── Embedding — configurable chunk strategy/size/overlap/model with a real
// preview (same code path as the actual embed) before committing. ───────────
// ── Vector store browser — what actually lives in the index for this doc.
// Mirrors a Pinecone console: one row per vector (id, the text it encodes,
// model, dimensions, a peek at raw values) plus a query box to see which
// chunk the AI would actually retrieve, and how strongly it matched.
function VectorBrowser({ doc }: { doc: KnowledgeDoc }) {
  const { t, language } = useI18n();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{ vectors: DocVector[]; total: number; dims: number | null; model: string | null } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [querying, setQuerying] = useState(false);
  const [matches, setMatches] = useState<VectorMatch[] | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getDocVectors(doc.id)
      .then(setData)
      .catch((e) => toast.error(errDetail(e) || t('govern.vectors.loadFailed')))
      .finally(() => setLoading(false));
  }, [doc.id, t]);
  useEffect(() => { load(); }, [load]);

  const runQuery = async () => {
    if (!q.trim()) return;
    setQuerying(true);
    try { setMatches(await queryDocVectors(doc.id, q.trim())); }
    catch (e) { toast.error(errDetail(e) || t('govern.vectors.queryFailed')); }
    finally { setQuerying(false); }
  };

  if (loading) return <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-brand" /></div>;

  const vectors = data?.vectors ?? [];
  if (vectors.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center">
        <Boxes className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
        <p className="text-caption text-text-tertiary">{t('govern.vectors.empty')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* index-level facts, the way a vector DB console leads with them */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: t('govern.vectors.count'), value: data?.total ?? 0 },
          { label: t('govern.vectors.dims'), value: data?.dims ?? '—' },
          { label: t('govern.vectors.model'), value: data?.model || '—' },
          { label: t('govern.vectors.metric'), value: 'cosine' },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
            <p className="truncate text-caption font-emphasis text-text-primary" title={String(c.value)}>{c.value}</p>
            <p className="mt-0.5 text-tiny uppercase tracking-[0.08em] text-text-quaternary">{c.label}</p>
          </div>
        ))}
      </div>

      {/* query box — prove retrieval works for a real question */}
      <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2.5">
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('govern.vectors.queryPlaceholder')}
            onKeyDown={(e) => { if (e.key === 'Enter') runQuery(); }} />
          <Button size="sm" variant="primary" loading={querying} leadingIcon={<Search className="h-3.5 w-3.5" />} onClick={runQuery}>
            {t('govern.vectors.query')}
          </Button>
        </div>
        {matches && (
          <div className="mt-2 space-y-1.5">
            {matches.length === 0 ? (
              <p className="text-tiny text-text-quaternary">{t('govern.vectors.noMatches')}</p>
            ) : matches.map((m) => (
              <div key={m.chunk_index} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-tiny font-emphasis text-text-secondary">
                    #{m.chunk_index}
                    {m.trust === 'external' && (
                      <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-tiny font-normal text-warning" title={t('govern.trust.hint')}>
                        {t('govern.trust.external')}
                      </span>
                    )}
                    {m.matched_by && (
                      <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny font-normal text-text-tertiary"
                        title={t('govern.vectors.matchedByHint')}>
                        {t(`govern.vectors.matchedBy.${m.matched_by}`)}
                      </span>
                    )}
                  </span>
                  <span className={cn('rounded-full px-2 py-0.5 text-tiny font-emphasis',
                    m.score >= 0.5 ? 'bg-success/10 text-success' : m.score >= 0.3 ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-text-tertiary')}>
                    {m.score.toFixed(3)}
                  </span>
                </div>
                <p className="line-clamp-3 text-tiny leading-relaxed text-text-tertiary">{m.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* the vectors themselves */}
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
        {vectors.map((v) => (
          <div key={v.id} className="border-t border-[rgb(var(--border-line))] first:border-t-0">
            <button onClick={() => setOpen(open === v.id ? null : v.id)}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-surface-2">
              <span className="mt-0.5 flex shrink-0 items-center gap-1">
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-tiny text-text-tertiary">#{v.chunk_index}</span>
                {v.trust && v.trust !== 'authored' && (
                  <span className={cn('rounded-full px-1.5 py-0.5 text-tiny',
                    v.trust === 'external' ? 'bg-warning/15 text-warning' : 'bg-surface-2 text-text-tertiary')}
                    title={t('govern.trust.hint')}>
                    {t(`govern.trust.${v.trust}`)}
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 block text-tiny leading-relaxed text-text-secondary">{v.content}</span>
                <span className="mt-1 block font-mono text-tiny text-text-quaternary">
                  {v.has_vector
                    ? `[${v.preview.map((n) => n.toFixed(4)).join(', ')}${v.dims ? `, … ${v.dims}d` : ''}]`
                    : t('govern.vectors.noVector')}
                </span>
              </span>
              <span className="whitespace-nowrap text-tiny text-text-quaternary">{t('govern.embedding.chars', { n: v.char_count })}</span>
              <ChevronDown className={cn('mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-text-quaternary transition-transform', open === v.id && 'rotate-180')} />
            </button>
            {open === v.id && (
              <div className="border-t border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5">
                <dl className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-tiny">
                  <div className="flex justify-between gap-2"><dt className="text-text-quaternary">ID</dt><dd className="font-mono text-text-secondary">{v.id}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-text-quaternary">{t('govern.vectors.dims')}</dt><dd className="font-mono text-text-secondary">{v.dims ?? '—'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-text-quaternary">{t('govern.vectors.model')}</dt><dd className="truncate font-mono text-text-secondary">{v.model || '—'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-text-quaternary">{t('govern.vectors.created')}</dt><dd className="text-text-secondary">{relTime(v.created_at, language, t)}</dd></div>
                  <div className="col-span-2 flex justify-between gap-2"><dt className="text-text-quaternary">{t('govern.vectors.hash')}</dt><dd className="truncate font-mono text-text-secondary">{v.content_hash.slice(0, 24)}…</dd></div>
                </dl>
                <p className="whitespace-pre-wrap text-tiny leading-relaxed text-text-secondary">{v.content}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmbeddingTab({ doc, onRefresh }: { doc: KnowledgeDoc; onRefresh: () => void }) {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<EmbeddingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [strategy, setStrategy] = useState('paragraph');
  const [size, setSize] = useState(850);
  const [overlap, setOverlap] = useState(0);
  const [model, setModel] = useState('');
  const [allowEgress, setAllowEgress] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ChunkPreviewResult | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let on = true;
    setLoading(true);
    getEmbeddingConfig(doc.id)
      .then((c) => {
        if (!on) return;
        setCfg(c); setStrategy(c.chunk_strategy); setSize(c.chunk_size); setOverlap(c.chunk_overlap); setModel(c.embedding_model || '');
        setAllowEgress(c.allow_external_embedding !== false);
      })
      .catch(() => toast.error(t('govern.embedding.loadFailed')))
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [doc.id, t]);

  const doPreview = async () => {
    setPreviewing(true);
    try { setPreview(await previewChunks(doc.id, { chunk_strategy: strategy, chunk_size: size, chunk_overlap: overlap })); }
    catch (e) { toast.error(errDetail(e) || t('govern.embedding.previewFailed')); }
    finally { setPreviewing(false); }
  };

  const saveAndReembed = async () => {
    setSaving(true);
    try {
      // The egress veto is a property of the DOCUMENT, so it is saved through
      // the document before re-indexing — otherwise re-indexing would run under
      // the old permission and send text the user just forbade.
      if (allowEgress !== (cfg?.allow_external_embedding !== false)) {
        await upsertKnowledgeDoc(docToWrite(doc, { allow_external_embedding: allowEgress }));
      }
      const res = await reembedDoc(doc.id, { chunk_strategy: strategy, chunk_size: size, chunk_overlap: overlap, embedding_model: model.trim() || null });
      toast.success(t('govern.embedding.reembedOk', { chunks: res.chunks }));
      onRefresh();
    } catch (e) { toast.error(errDetail(e) || t('govern.embedding.reembedFailed')); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-brand" /></div>;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <RailCard title={t('govern.embedding.title')} icon={<Boxes className="h-3.5 w-3.5" />}>
        <div className="space-y-3">
          <div>
            <Label>{t('govern.embedding.strategy')}</Label>
            <Select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="paragraph">{t('govern.embedding.strategyParagraph')}</option>
              <option value="heading">{t('govern.embedding.strategyHeading')}</option>
              <option value="fixed">{t('govern.embedding.strategyFixed')}</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('govern.embedding.chunkSize')}</Label>
              <Input type="number" min={100} max={1400} value={size} onChange={(e) => setSize(Number(e.target.value) || 850)} />
            </div>
            <div>
              <Label>{t('govern.embedding.overlap')}</Label>
              <Input type="number" min={0} value={overlap} onChange={(e) => setOverlap(Number(e.target.value) || 0)} />
            </div>
          </div>
          <div>
            <Label>{t('govern.embedding.model')}</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t('govern.embedding.modelPlaceholder')} />
            <p className="mt-1 text-tiny text-text-quaternary">{t('govern.embedding.modelHint')}</p>
          </div>
          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2.5">
            <label className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={!allowEgress}
                onChange={(e) => setAllowEgress(!e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-tiny font-emphasis text-text-secondary">{t('govern.egress.blockLabel')}</span>
                <span className="mt-0.5 block text-tiny text-text-quaternary">{t('govern.egress.blockHint')}</span>
              </span>
            </label>
            {!allowEgress && (
              <p className="mt-1.5 flex items-start gap-1.5 text-tiny text-warning">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />{t('govern.egress.blockedConsequence')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="secondary" loading={previewing} onClick={doPreview}>{t('govern.embedding.preview')}</Button>
            <Button size="sm" variant="primary" leadingIcon={<RefreshCw className="h-3.5 w-3.5" />} loading={saving} onClick={saveAndReembed}>{t('govern.embedding.saveReembed')}</Button>
          </div>
          {cfg && <p className="text-tiny text-text-quaternary">{t('govern.embedding.currentChunks', { count: cfg.chunk_count })}</p>}
        </div>
      </RailCard>

      <RailCard title={t('govern.embedding.previewTitle')}>
        {!preview ? (
          <p className="text-tiny text-text-quaternary">{t('govern.embedding.previewEmpty')}</p>
        ) : preview.chunks.length === 0 ? (
          <p className="text-tiny text-text-quaternary">{t('govern.embedding.previewNoChunks')}</p>
        ) : (
          <div className="max-h-[28rem] space-y-2 overflow-y-auto">
            {preview.chunks.map((c) => (
              <div key={c.index} className="rounded-lg bg-surface-2 p-2.5">
                <div className="mb-1 flex items-center justify-between text-tiny text-text-quaternary">
                  <span>{t('govern.embedding.chunkN', { n: c.index + 1 })}</span>
                  <span>{t('govern.embedding.chars', { n: c.char_count })}</span>
                </div>
                <p className="line-clamp-4 text-tiny text-text-secondary">{c.text}</p>
              </div>
            ))}
          </div>
        )}
      </RailCard>
    </div>
  );
}

// ── History — unified sync + embed run timeline, merged with the existing
// content-version history so there's one place to see everything that
// happened to this doc. ──────────────────────────────────────────────────────
function HistoryTab({ doc }: { doc: KnowledgeDoc }) {
  const { t, language } = useI18n();
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<DocHistory | null>(null);

  useEffect(() => {
    let on = true;
    setLoading(true);
    getDocHistory(doc.id)
      .then((h) => { if (on) setHistory(h); })
      .catch(() => toast.error(t('govern.history.loadFailed')))
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [doc.id, t]);

  if (loading) return <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-brand" /></div>;

  type Row = { key: string; kind: 'sync' | 'embed' | 'version'; at: string; title: string; detail?: string | null; status?: string };
  const rows: Row[] = [
    ...(history?.runs ?? []).map((r): Row => ({
      key: `run-${r.id}`, kind: r.run_type, at: r.started_at,
      title: r.run_type === 'sync' ? t('govern.history.syncRun') : t('govern.history.embedRun'),
      detail: r.detail, status: r.status,
    })),
    ...(history?.versions ?? []).map((v): Row => ({
      key: `v-${v.version}`, kind: 'version', at: v.created_at || '',
      title: t('govern.history.versionRow', { n: v.version }), detail: v.change_note, status: v.is_published ? 'published' : undefined,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center">
        <Clock3 className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
        <p className="text-caption text-text-tertiary">{t('govern.history.tabEmpty')}</p>
      </div>
    );
  }

  const KIND_ICON: Record<Row['kind'], ReactNode> = {
    sync: <RefreshCw className="h-3.5 w-3.5" />, embed: <Boxes className="h-3.5 w-3.5" />, version: <History className="h-3.5 w-3.5" />,
  };
  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <ul className="divide-y divide-[rgb(var(--border-line))]">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-tertiary">{KIND_ICON[r.kind]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption font-emphasis text-text-primary">{r.title}</span>
                <span className="text-tiny text-text-quaternary">{relTime(r.at, language, t)}</span>
              </div>
              {r.detail && <p className="mt-0.5 truncate text-tiny text-text-tertiary">{r.detail}</p>}
            </div>
            {r.status && (
              <span className={cn('rounded-full px-2 py-0.5 text-tiny', r.status === 'error' ? 'bg-danger/10 text-danger' : r.status === 'published' ? 'bg-success/10 text-success' : 'bg-surface-2 text-text-tertiary')}>
                {r.status}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Usage — which dashboards/AI bots use this doc + retrieval_count. The rail
// keeps its at-a-glance retrieval_count number; this tab is the detailed view. ─
function UsageTab({ doc }: { doc: KnowledgeDoc }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<DocUsage | null>(null);

  useEffect(() => {
    let on = true;
    setLoading(true);
    getDocUsage(doc.id)
      .then((u) => { if (on) setUsage(u); })
      .catch(() => toast.error(t('govern.usage.loadFailed')))
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [doc.id, t]);

  if (loading) return <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-brand" /></div>;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <RailCard title={t('govern.usage.dashboards')} icon={<Network className="h-3.5 w-3.5" />}>
        {!usage || usage.dashboards.length === 0 ? (
          <p className="text-tiny text-text-quaternary">{t('govern.usage.noDashboards')}</p>
        ) : (
          <div className="space-y-1">
            {usage.dashboards.map((d) => (
              <Link key={d.id} href={`/dashboards/${d.id}`} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-caption text-text-secondary hover:bg-surface-2">
                <span className="truncate">{d.name}</span>
                <ExternalLink className="h-3.5 w-3.5 text-text-quaternary" />
              </Link>
            ))}
          </div>
        )}
      </RailCard>
      <RailCard title={t('govern.usage.stats')}>
        <RailRow label={t('govern.detail.aiRetrievals')} value={usage?.retrieval_count ?? 0} />
      </RailCard>
    </div>
  );
}

// Read-only banner + body when the reader is showing a PAST version instead of
// the current working content.
function VersionViewer({ version, onClose }: { version: KnowledgeDocVersion; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2">
        <span className="flex items-center gap-1.5 text-caption text-brand">
          <History className="h-3.5 w-3.5" />
          {t('govern.history.readonlyTitle', { version: version.version })}
          {version.is_published && <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-tiny text-success">{t('govern.version.published')}</span>}
        </span>
        <button onClick={onClose} className="flex items-center gap-1 text-tiny text-text-tertiary hover:text-text-primary"><X className="h-3.5 w-3.5" />{t('govern.version.backToCurrent')}</button>
      </div>
      {version.body ? <Markdown source={version.body} /> : <p className="text-caption text-text-tertiary">{t('govern.history.emptyBody')}</p>}
    </div>
  );
}

// Compact versions control that lives in the header bar: a small button showing
// the live version, expanding a dropdown to view any version, see live/latest
// badges, and publish a chosen one — no inline list on the reading surface.
function VersionsDropdown({ docId, publishedVersion, latestVersion, refreshKey, viewingVersion, onView, onExitView, onPublished }: {
  docId: number; publishedVersion: number | null; latestVersion: number; refreshKey: number; viewingVersion: number | null;
  onView: (n: number) => void; onExitView: () => void; onPublished: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<KnowledgeDocVersion[] | null>(null);
  const [publishFor, setPublishFor] = useState<number | null>(null);
  useEffect(() => {
    if (!open && versions !== null) return;
    let on = true;
    listDocVersions(docId).then((v) => { if (on) setVersions(v); }).catch(() => { if (on) setVersions([]); });
    return () => { on = false; };
  }, [docId, refreshKey, open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn('inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-caption font-medium transition-colors',
          open ? 'border-brand/40 bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2')}
        title={t('govern.version.title')}
      >
        <History className="h-3.5 w-3.5" />
        <span>{t('govern.version.live')} v{publishedVersion ?? latestVersion}</span>
        {latestVersion !== (publishedVersion ?? latestVersion) && <span className="rounded-full bg-warning/15 px-1.5 text-tiny text-warning">{t('govern.version.draftBadge')} v{latestVersion}</span>}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-20 cursor-default" aria-hidden onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-30 mt-1.5 max-h-[70vh] w-[420px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
            <p className="flex items-center gap-1.5 border-b border-[rgb(var(--border-line))] bg-surface-2/50 px-3.5 py-2 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">
              <History className="h-3.5 w-3.5" />{t('govern.version.title')}
            </p>
            {versions === null ? (
              <p className="px-3.5 py-5 text-center text-caption text-text-tertiary">{t('govern.loading')}</p>
            ) : versions.length === 0 ? (
              <p className="px-3.5 py-5 text-center text-caption text-text-tertiary">{t('govern.history.empty')}</p>
            ) : (
              <ul className="divide-y divide-[rgb(var(--border-line))]">
                {versions.map((v) => {
                  const isViewing = viewingVersion === v.version;
                  return (
                    <li key={v.version} className={cn('flex items-start justify-between gap-3 px-3.5 py-2.5', isViewing && 'bg-brand/5')}>
                      <div className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-caption font-strong text-text-primary">v{v.version}</span>
                          {v.is_published && <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-tiny font-emphasis text-success">{t('govern.version.published')}</span>}
                          {v.is_latest && <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">{t('govern.version.latest')}</span>}
                        </span>
                        {v.change_note && <span className="mt-0.5 block text-tiny text-text-secondary">{v.change_note}</span>}
                        <span className="mt-0.5 block text-tiny text-text-quaternary">{v.changed_by || t('govern.history.system')} · {v.created_at ? relTime(v.created_at, locale, t) : ''}</span>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2">
                        {isViewing
                          ? <button onClick={() => { onExitView(); }} className="text-tiny text-text-tertiary hover:text-text-primary">{t('govern.version.backToCurrent')}</button>
                          : <button onClick={() => { onView(v.version); setOpen(false); }} className="inline-flex items-center gap-1 text-tiny text-brand hover:underline"><Eye className="h-3 w-3" />{t('govern.action.view')}</button>}
                        {!v.is_published && (
                          <Button size="xs" variant="secondary" leadingIcon={<Upload className="h-3.5 w-3.5" />} onClick={() => setPublishFor(v.version)}>{t('govern.version.publish')}</Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
      {publishFor != null && (
        <PublishDialog docId={docId} version={publishFor} onClose={() => setPublishFor(null)}
          onDone={() => { setPublishFor(null); setOpen(false); onPublished(); }} />
      )}
    </div>
  );
}

// Publish a specific version — requires a short change note; an AiButton drafts
// it from the DIFF (never the whole doc).
function PublishDialog({ docId, version, onClose, onDone }: { docId: number; version: number; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const genNote = async () => {
    setAiBusy(true);
    try { setNote(await aiChangeNote(docId, version)); }
    catch (e) { toast.error(errDetail(e) || t('govern.version.aiNoteFailed')); }
    finally { setAiBusy(false); }
  };
  const doPublish = async () => {
    if (!note.trim()) { toast.error(t('govern.version.noteRequired')); return; }
    setBusy(true);
    try { await publishVersion(docId, version, note.trim()); toast.success(t('govern.version.publishOk', { version })); onDone(); }
    catch (e) { toast.error(errDetail(e) || t('govern.version.publishFailed')); }
    finally { setBusy(false); }
  };
  return (
    <AppModalShell
      onClose={onClose} title={t('govern.version.publishTitle', { version })} icon={<Upload className="h-4 w-4" />} maxWidthClass="max-w-md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('govern.action.cancel')}</Button>
          <Button variant="primary" leadingIcon={<Upload className="h-4 w-4" />} loading={busy} disabled={busy || !note.trim()} onClick={doPublish}>{t('govern.version.publish')}</Button>
        </>
      )}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label required>{t('govern.version.changeNote')}</Label>
          <AiButton size="xs" loading={aiBusy} onClick={genNote}>{t('govern.version.aiNote')}</AiButton>
        </div>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('govern.version.changeNotePlaceholder')} autoFocus />
        <p className="text-tiny text-text-quaternary">{t('govern.version.publishHint')}</p>
      </div>
    </AppModalShell>
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
function MarkdownToolbar({ wrap, prefix, block, onWikilink, onCallout }: {
  wrap: (b: string, a: string, ph: string) => void; prefix: (p: string) => void; block: (b: string) => void;
  onWikilink: () => void; onCallout: () => void;
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
      <FmtBtn title={t('govern.toolbar.callout')} onClick={onCallout}><Info className="h-3.5 w-3.5" /></FmtBtn>
      <Div />
      <FmtBtn title={t('govern.toolbar.link')} onClick={() => wrap('[', '](https://)', t('govern.toolbar.sample.link'))}><Link2 className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.wikilink')} onClick={onWikilink}><FileText className="h-3.5 w-3.5" /></FmtBtn>
      <FmtBtn title={t('govern.toolbar.table')} onClick={() => block(t('govern.toolbar.tableBlock'))}><Table className="h-3.5 w-3.5" /></FmtBtn>
    </div>
  );
}

function EditorScreen({ docId, seed, managed, allDocs, onCancel, onSaved, onOpenMetric }: {
  docId: number | null; seed?: KnowledgeDocWrite | null; managed: ManagedMetric[];
  allDocs: { id: number; title: string }[];
  onCancel: () => void; onSaved: (id: number) => void; onOpenMetric: (s: MetricModalState) => void;
}) {
  const { t } = useI18n();
  const [wikiQuery, setWikiQuery] = useState<string | null>(null);  // open [[…]] autocomplete
  const [editing, setEditing] = useState<KnowledgeDocWrite | null>(docId ? null : (seed ?? newDoc()));
  const [sourceOwned, setSourceOwned] = useState(false);
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
    if (sourceOwned) {
      toast.error(t('govern.editor.sourceOwnedReadOnly'));
      return;
    }
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
      .then((d) => { if (!on) return; setEditing(docToWrite(d)); setTagsText((d.tags ?? []).join(', ')); setSourceOwned(isSourceOwned(d.source_type)); })
      .catch(() => { if (on) toast.error(t('govern.detail.openFailed')); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [docId, t]);

  const upd = (patch: Partial<KnowledgeDocWrite>) => setEditing((p) => (p ? { ...p, ...patch } : p));

  // Changing the doc TYPE on an empty document inserts that type's markdown
  // skeleton (KPI/domain, SOP, report, AI know-how) — structure without forms.
  const changeType = (type: string) => setEditing((p) => {
    if (!p) return p;
    const empty = !sourceOwned && !(p.body || '').trim();
    const tpl = docTemplate(type, t);
    return { ...p, doc_type: type, body: empty && tpl ? tpl : p.body };
  });

  const insertToken = (token: string) => {
    if (sourceOwned) {
      toast.error(t('govern.editor.sourceOwnedReadOnly'));
      return;
    }
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
  // Obsidian authoring: [[wikilink]] autocomplete + callout skeleton.
  const onBodyChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value; const caret = e.target.selectionStart ?? val.length;
    upd({ body: val });
    const m = val.slice(0, caret).match(/\[\[([^\]\n]*)$/);  // open [[ with no closing ]] yet
    setWikiQuery(m ? m[1] : null);
  };
  const insertWikilink = () => { insertToken('[[]]'); const el = bodyRef.current; requestAnimationFrame(() => { if (el) { const p = (el.selectionStart ?? 2) - 2; el.setSelectionRange(p, p); } }); setWikiQuery(''); };
  const insertCallout = () => blockFmt('> [!note] \n> ');
  const pickWiki = (title: string) => {
    const el = bodyRef.current; const val = editing?.body ?? ''; const caret = el?.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/\[\[([^\]\n]*)$/);
    const start = m ? caret - m[0].length : caret;
    const insert = `[[${title}]]`;
    const next = val.slice(0, start) + insert + val.slice(caret);
    setEditing((p) => (p ? { ...p, body: next } : p)); setWikiQuery(null);
    requestAnimationFrame(() => { if (el) { el.focus(); const pos = start + insert.length; el.setSelectionRange(pos, pos); } });
  };
  const wikiMatches = wikiQuery === null ? [] : allDocs
    .filter((d) => d.id !== editing?.id && (!wikiQuery.trim() || d.title.toLowerCase().includes(wikiQuery.trim().toLowerCase())))
    .slice(0, 6);

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

            {sourceOwned ? (
              <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info/[0.07] px-3 py-2 text-caption text-text-secondary">
                <Database className="mt-0.5 h-4 w-4 flex-shrink-0 text-info" />
                <span>{t('govern.editor.sourceOwnedReadOnly')}</span>
              </div>
            ) : (
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
            )}

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
                  {!sourceOwned && <MarkdownToolbar wrap={wrapFmt} prefix={prefixFmt} block={blockFmt} onWikilink={insertWikilink} onCallout={insertCallout} />}
                  {!sourceOwned && wikiQuery !== null && (
                    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-brand/30 bg-brand/[0.06] px-2.5 py-1.5">
                      <span className="text-tiny font-emphasis text-brand">{t('govern.editor.wikilinkPick')}</span>
                      {wikiMatches.length === 0
                        ? <span className="text-tiny text-text-quaternary">{t('govern.editor.wikilinkNoMatch')}</span>
                        : wikiMatches.map((d) => (
                          <button key={d.id} type="button" onClick={() => pickWiki(d.title)}
                            className="max-w-[220px] truncate rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-0.5 text-tiny text-text-secondary hover:border-brand/50 hover:text-brand">
                            {d.title}
                          </button>
                        ))}
                      <button type="button" onClick={() => setWikiQuery(null)} className="ml-auto text-tiny text-text-quaternary hover:text-text-primary">✕</button>
                    </div>
                  )}
                  <Textarea ref={bodyRef} rows={24} readOnly={sourceOwned} className={cn('font-mono text-[13px]', sourceOwned && 'bg-surface-2 text-text-tertiary')} value={editing.body ?? ''} onChange={sourceOwned ? undefined : onBodyChange}
                    onKeyDown={(e) => { if (e.key === 'Escape' && wikiQuery !== null) setWikiQuery(null); }}
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
