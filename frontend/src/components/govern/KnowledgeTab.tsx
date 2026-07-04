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
  ExternalLink, AlertTriangle, Loader2, Library, Search, Upload,
} from 'lucide-react';

import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { FilterTag } from '@/components/ui/FilterTag';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Label, Select } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { useUrlNav } from '@/hooks/use-url-nav';
import {
  listKnowledge, getKnowledgeDoc, upsertKnowledgeDoc, deleteKnowledgeDoc, listManagedMetrics,
  listDocVersions, getDocVersion,
  type KnowledgeDoc, type KnowledgeSpace, type KnowledgeDocWrite, type KnowledgeAsset, type ManagedMetric,
  type KnowledgeDocVersion,
} from '@/lib/catalog';
import { Markdown, DOC_TYPES, DOC_TYPE_LABEL, STATUS_TONE, managedTargetLabel } from './knowledge-markdown';
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
    ...patch,
  };
}

const DOC_TYPE_ICON: Record<string, ReactNode> = {
  overview: <Compass className="h-4 w-4" />, guide: <BookOpen className="h-4 w-4" />,
  domain: <Boxes className="h-4 w-4" />, process: <Workflow className="h-4 w-4" />,
  faq: <HelpCircle className="h-4 w-4" />, article: <FileText className="h-4 w-4" />,
};
const docIcon = (t: string) => DOC_TYPE_ICON[t] ?? <FileText className="h-4 w-4" />;

const ASSET_ICON: Record<KnowledgeAsset['type'], ReactNode> = {
  dashboard: <LayoutDashboard className="h-4 w-4" />, dataset: <Database className="h-4 w-4" />, term: <TagIcon className="h-4 w-4" />,
};
const ASSET_LABEL: Record<KnowledgeAsset['type'], string> = { dashboard: 'Báo cáo', dataset: 'Dữ liệu', term: 'Thuật ngữ' };

type MetricModalState = { machineName: string | null; homeDocId: number | null; onCreated?: (mn: string) => void };

// ═══════════════════════════════════ Root ═══════════════════════════════════
export function KnowledgeTab({ nav, onOpenVocab }: { nav: ReturnType<typeof useUrlNav>; onOpenVocab?: () => void }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [managed, setManaged] = useState<ManagedMetric[]>([]);
  const [metricModal, setMetricModal] = useState<MetricModalState | null>(null);

  const docParam = nav.get('doc');
  const selId = docParam ? Number(docParam) : null;
  const mode = nav.get('m'); // 'new' | 'edit' | null

  const loadList = useCallback(async () => {
    setLoading(true);
    try { const { docs: d, spaces: s } = await listKnowledge(); setDocs(d); setSpaces(s); }
    catch { toast.error('Không tải được danh sách tài liệu'); }
    finally { setLoading(false); }
  }, []);
  const loadManaged = useCallback(() => { listManagedMetrics().then(setManaged).catch(() => {}); }, []);
  useEffect(() => { void loadList(); loadManaged(); }, [loadList, loadManaged]);

  const openDoc = (id: number) => nav.set({ doc: String(id), m: null, dt: null });
  const openList = () => nav.set({ doc: null, m: null, dt: null });
  const startNew = () => nav.set({ doc: null, m: 'new' });
  const startEdit = () => nav.set({ m: 'edit' });

  const openMetric = (s: MetricModalState) => setMetricModal(s);
  const afterMetricChange = async () => { loadManaged(); };

  let screen: ReactNode;
  if (mode === 'new' || (selId && mode === 'edit')) {
    screen = (
      <EditorScreen
        docId={mode === 'edit' ? selId : null} managed={managed}
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
        onOpen={openDoc} onNew={startNew} onOpenVocab={onOpenVocab} />
    );
  }

  return (
    <>
      {screen}
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
function ListScreen({ docs, spaces, loading, managed, onOpen, onNew, onOpenVocab }: {
  docs: KnowledgeDoc[]; spaces: KnowledgeSpace[]; loading: boolean; managed: ManagedMetric[];
  onOpen: (id: number) => void; onNew: () => void; onOpenVocab?: () => void;
}) {
  const [space, setSpace] = useState<string | null>(null);

  const linkedReports = useMemo(() => {
    const s = new Set<number>();
    docs.forEach((d) => (d.related_dashboard_ids ?? []).forEach((x) => s.add(x)));
    return s.size;
  }, [docs]);

  return (
    <PageListLayout
      title="Cẩm nang tri thức"
      description="Kho tài liệu mô tả toàn bộ hoạt động kinh doanh. Mỗi tài liệu gắn với chỉ số quản trị và báo cáo liên quan — mở một tài liệu để đọc chi tiết, xem chỉ số, liên kết và lịch sử phiên bản."
      overview={(
        <ModuleOverview
          stats={[
            { label: 'Tài liệu', value: docs.length, helper: 'Tài liệu mô tả business đang có' },
            { label: 'Chỉ số quản trị', value: managed.length, helper: 'KPI được định nghĩa trong tài liệu' },
            { label: 'Báo cáo được mô tả', value: linkedReports, helper: 'Báo cáo được liên kết trong tài liệu' },
            { label: 'Không gian', value: spaces.length, helper: 'Nhóm chủ đề tài liệu' },
          ]}
        />
      )}
      action={(
        <div className="flex items-center gap-2">
          {onOpenVocab && <Button variant="secondary" leadingIcon={<Library className="h-4 w-4" />} onClick={onOpenVocab}>Từ điển & Nhãn</Button>}
          <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={onNew}>Tạo tài liệu</Button>
        </div>
      )}
      isLoading={loading}
      loadingText="Đang tải tài liệu…"
      searchPlaceholder="Tìm tài liệu, chủ đề, nhãn…"
      viewToggle={false}
      toolbarExtra={spaces.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <FilterTag tone="brand" active={space === null} onClick={() => setSpace(null)}>Tất cả</FilterTag>
          {spaces.map((s) => (
            <FilterTag key={s.space} tone="brand" active={space === s.space} onClick={() => setSpace(s.space)}>
              {s.space} ({s.count})
            </FilterTag>
          ))}
        </div>
      ) : undefined}
    >
      {({ filterText }) => {
        const needle = filterText.trim().toLowerCase();
        const rows = docs.filter((d) =>
          (space === null || d.space === space)
          && (!needle || `${d.title} ${d.summary ?? ''} ${d.space} ${(d.tags ?? []).join(' ')}`.toLowerCase().includes(needle)));

        if (docs.length === 0) {
          return (
            <div className="py-16 text-center">
              <BookOpen className="mx-auto mb-4 h-14 w-14 text-text-quaternary" />
              <h2 className="mb-2 text-small font-strong text-text-primary">Chưa có tài liệu nào</h2>
              <p className="mb-4 text-caption text-text-tertiary">Bắt đầu ghi lại cách doanh nghiệp vận hành — mỗi tài liệu là một mảng nghiệp vụ.</p>
              <Button variant="primary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={onNew}>Tạo tài liệu</Button>
            </div>
          );
        }
        if (rows.length === 0) {
          return (
            <div className="flex h-48 flex-col items-center justify-center text-center">
              <Search className="mb-2 h-8 w-8 text-text-quaternary" />
              <p className="text-caption text-text-tertiary">Không có tài liệu khớp bộ lọc.</p>
            </div>
          );
        }
        return (
          <PaginatedCollection items={rows} viewMode="list" resetKey={`${filterText}|${space ?? ''}`}>
            {({ pageItems, pagination, hasFooter }) => (
              <div>
                <div className={cn('border border-[rgb(var(--border-line))] bg-surface-1', hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl')}>
                  <div className="app-list-table-wrap">
                    <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                      <thead className="bg-surface-2"><tr>
                        <th className="app-list-header w-[40%]">Tài liệu</th>
                        <th className="app-list-header w-[14%]">Không gian</th>
                        <th className="app-list-header w-[12%]">Loại</th>
                        <th className="app-list-header w-[10%]">Chỉ số</th>
                        <th className="app-list-header w-[10%]">Liên kết</th>
                        <th className="app-list-header w-[12%]">Trạng thái</th>
                        <th className="app-list-header w-[56px] text-right" />
                      </tr></thead>
                      <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                        {pageItems.map((d) => {
                          const links = (d.related_dashboard_ids?.length ?? 0) + (d.related_dataset_ids?.length ?? 0);
                          return (
                            <tr key={d.id} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen(d.id)}>
                              <td className="app-list-cell">
                                <span className="flex w-full items-start gap-3 text-left">
                                  <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                                    {d.pinned ? <Pin className="h-4 w-4" /> : docIcon(d.doc_type)}
                                  </span>
                                  <span className="min-w-0">
                                    <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{d.title}</span>
                                    {d.summary && <span className="app-list-text-sub mt-0.5 block text-tiny text-text-quaternary line-clamp-1">{d.summary}</span>}
                                  </span>
                                </span>
                              </td>
                              <td className="app-list-cell"><span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{d.space}</span></td>
                              <td className="app-list-cell text-caption text-text-tertiary">{DOC_TYPE_LABEL[d.doc_type] || d.doc_type}</td>
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
                                <span className="inline-flex items-center gap-1.5">
                                  <span className={cn('rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[d.status] || 'bg-surface-2 text-text-tertiary')}>{d.status}</span>
                                  <span className="text-tiny text-text-quaternary">v{d.version}</span>
                                </span>
                              </td>
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
        );
      }}
    </PageListLayout>
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
  { key: 'noidung', label: 'Nội dung', icon: <FileText className="h-4 w-4" /> },
  { key: 'chiso', label: 'Chỉ số', icon: <Sigma className="h-4 w-4" /> },
  { key: 'lienket', label: 'Liên kết', icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: 'lichsu', label: 'Lịch sử', icon: <History className="h-4 w-4" /> },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['key'];

// Segmented tab control — same treatment as the Dataset detail tab bar.
function SegmentedTabs({ items, value, onChange }: {
  items: { key: string; label: string; icon?: ReactNode }[]; value: string; onChange: (k: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-caption font-emphasis transition-colors',
            value === it.key ? 'bg-surface-1 text-brand shadow-linear-sm' : 'text-text-tertiary hover:bg-surface-1',
          )}
        >
          {it.icon}{it.label}
        </button>
      ))}
    </div>
  );
}

function DetailScreen({ docId, nav, onBack, onEdit, onDeleted, onOpenMetric, onListChanged, onOpenDoc }: {
  docId: number; nav: ReturnType<typeof useUrlNav>; managed: ManagedMetric[];
  onBack: () => void; onEdit: () => void; onDeleted: () => void;
  onOpenMetric: (s: MetricModalState) => void; onListChanged: () => Promise<void> | void;
  onOpenDoc: (id: number) => void;
}) {
  const [doc, setDoc] = useState<KnowledgeDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const tab = (nav.get('dt') as DetailTab) || 'noidung';
  const setTab = (t: string) => nav.set({ dt: t });

  useEffect(() => {
    let on = true;
    setLoading(true);
    getKnowledgeDoc(docId)
      .then((d) => { if (on) setDoc(d); })
      .catch(() => { if (on) { setDoc(null); toast.error('Không mở được tài liệu'); } })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [docId, refresh]);

  const remove = async () => {
    if (!doc || !window.confirm(`Xoá tài liệu "${doc.title}"?`)) return;
    try { await deleteKnowledgeDoc(doc.id); toast.success('Đã xoá'); onDeleted(); }
    catch { toast.error('Xoá thất bại'); }
  };

  // Define a NEW metric homed to this doc → append its token to the body & save.
  const defineMetric = () => {
    if (!doc) return;
    onOpenMetric({
      machineName: null, homeDocId: doc.id,
      onCreated: async (mn) => {
        try {
          const body = `${doc.body ?? ''}${(doc.body ?? '').trim() ? '\n\n' : ''}{{metric:${mn}}}`;
          await upsertKnowledgeDoc(docToWrite(doc, { body, change_note: `Thêm chỉ số ${mn}` }));
          await onListChanged(); setRefresh((v) => v + 1);
        } catch (e) { toast.error(errDetail(e) || 'Không gắn được chỉ số vào tài liệu'); }
      },
    });
  };
  const editMetric = (machineName: string) => onOpenMetric({
    machineName, homeDocId: null, onCreated: undefined,
  });

  if (loading) return <DetailShell><div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div></DetailShell>;
  if (!doc) return (
    <DetailShell>
      <button onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary"><ChevronLeft className="h-3.5 w-3.5" /> Cẩm nang tri thức</button>
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center">
        <p className="text-small font-emphasis text-text-primary">Không tải được tài liệu</p>
      </div>
    </DetailShell>
  );

  const metrics = doc.metrics_on_page ?? [];
  const assets = doc.assets_on_page ?? [];
  const items = DETAIL_TABS.map((t) => ({
    key: t.key, icon: t.icon,
    label: t.key === 'chiso' && metrics.length ? `${t.label} · ${metrics.length}`
      : t.key === 'lienket' && assets.length ? `${t.label} · ${assets.length}` : t.label,
  }));

  return (
    <DetailShell>
      <div className="space-y-4 pb-8">
        <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
          <ChevronLeft className="h-3.5 w-3.5" /> Cẩm nang tri thức
        </button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-tiny text-text-quaternary">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-text-tertiary">{doc.space}</span>
              <span>· {DOC_TYPE_LABEL[doc.doc_type] || doc.doc_type}</span>
              <span className={cn('rounded-full px-2 py-0.5', STATUS_TONE[doc.status] || '')}>{doc.status}</span>
              <span>· v{doc.version}</span>
              {doc.owner && <span>· {doc.owner}</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/10 text-brand">{doc.pinned ? <Pin className="h-4 w-4" /> : docIcon(doc.doc_type)}</span>
              <h1 className="text-h1 font-emphasis text-text-primary">{doc.title}</h1>
            </div>
            {doc.summary && <p className="mt-1.5 max-w-2xl text-caption text-text-tertiary">{doc.summary}</p>}
          </div>
          <div className="flex flex-shrink-0 gap-1.5">
            <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>Sửa</Button>
            <Button size="sm" variant="ghost" leadingIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>Xoá</Button>
          </div>
        </div>

        <SegmentedTabs items={items} value={tab} onChange={setTab} />

        <div className="grid gap-5 pt-1 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            {tab === 'noidung' && <ContentTab doc={doc} />}
            {tab === 'chiso' && <MetricsTab doc={doc} onDefine={defineMetric} onEdit={editMetric} />}
            {tab === 'lienket' && <LinksTab doc={doc} />}
            {tab === 'lichsu' && <HistoryTab docId={doc.id} />}
          </div>
          <InfoRail doc={doc} onTab={setTab} onOpenDoc={onOpenDoc} />
        </div>
      </div>
    </DetailShell>
  );
}

// Right-side properties rail — fills the detail width like Dataset/Explore's
// second pane, with doc facts + quick links to the other tabs.
function RailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-tiny text-text-quaternary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-caption text-text-secondary">{value}</dd>
    </div>
  );
}

function InfoRail({ doc, onTab, onOpenDoc }: { doc: KnowledgeDoc; onTab: (t: string) => void; onOpenDoc: (id: number) => void }) {
  const metrics = doc.metrics_on_page ?? [];
  const assets = doc.assets_on_page ?? [];
  const related = doc.related_docs ?? [];
  return (
    <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <p className="mb-3 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">Thông tin</p>
        <dl className="space-y-2.5">
          <RailRow label="Không gian" value={doc.space} />
          <RailRow label="Loại" value={DOC_TYPE_LABEL[doc.doc_type] || doc.doc_type} />
          <RailRow label="Trạng thái" value={<span className={cn('rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[doc.status] || 'bg-surface-2 text-text-tertiary')}>{doc.status}</span>} />
          <RailRow label="Phiên bản" value={`v${doc.version}`} />
          <RailRow label="Chủ sở hữu" value={doc.owner || '—'} />
          {doc.updated_at && <RailRow label="Cập nhật" value={new Date(doc.updated_at).toLocaleDateString('vi-VN')} />}
        </dl>
      </div>

      {(metrics.length > 0 || assets.length > 0) && (
        <div className="space-y-1 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-2">
          <button onClick={() => onTab('chiso')} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-caption text-text-secondary hover:bg-surface-2">
            <span className="flex items-center gap-2"><Sigma className="h-4 w-4 text-text-quaternary" />Chỉ số quản trị</span>
            <span className="font-emphasis text-text-primary">{metrics.length}</span>
          </button>
          <button onClick={() => onTab('lienket')} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-caption text-text-secondary hover:bg-surface-2">
            <span className="flex items-center gap-2"><LayoutDashboard className="h-4 w-4 text-text-quaternary" />Báo cáo & dữ liệu</span>
            <span className="font-emphasis text-text-primary">{assets.length}</span>
          </button>
        </div>
      )}

      {related.length > 0 && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <p className="mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">
            <BookOpen className="h-3.5 w-3.5" />Tài liệu liên quan
          </p>
          <p className="mb-2 text-tiny text-text-quaternary">Dùng chung chỉ số quản trị với tài liệu này.</p>
          <div className="space-y-1">
            {related.map((r) => (
              <button key={r.id} onClick={() => onOpenDoc(r.id)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-2">
                <span className="block truncate text-caption font-emphasis text-text-secondary hover:text-brand">{r.title}</span>
                <span className="block truncate text-tiny text-text-quaternary">{r.space} · {r.shared_metrics.join(', ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {doc.related_terms.length > 0 && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <p className="mb-2 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">Thuật ngữ đi kèm</p>
          <div className="flex flex-wrap gap-1.5">
            {doc.related_terms.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded bg-info/10 px-2 py-0.5 text-tiny text-info"><TagIcon className="h-3 w-3" />{t}</span>
            ))}
          </div>
        </div>
      )}
    </aside>
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

function ContentTab({ doc }: { doc: KnowledgeDoc }) {
  const missing = doc.missing_metric_tokens ?? [];
  return (
    <div className="min-w-0">
      {doc.body
        ? <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-6"><Markdown source={resolveBody(doc)} /></div>
        : <p className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center text-caption text-text-tertiary">Tài liệu chưa có nội dung. Bấm “Sửa” để viết.</p>}

      {missing.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Có {missing.length} chỉ số được nhắc tới nhưng chưa tồn tại: {missing.map((t) => <code key={t} className="mx-0.5 font-mono">{t}</code>)} — mở tab <strong>Chỉ số</strong> để định nghĩa.</span>
        </div>
      )}
    </div>
  );
}

function MetricsTab({ doc, onDefine, onEdit }: { doc: KnowledgeDoc; onDefine: () => void; onEdit: (mn: string) => void }) {
  const metrics = doc.metrics_on_page ?? [];
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-text-tertiary">Chỉ số quản trị được định nghĩa hoặc dùng lại trong tài liệu này.</p>
        <Button size="sm" variant="primary" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={onDefine}>Định nghĩa chỉ số</Button>
      </div>
      {metrics.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center">
          <Sigma className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
          <p className="text-caption text-text-tertiary">Chưa có chỉ số nào. Bấm “Định nghĩa chỉ số” để tạo KPI lấy tài liệu này làm nguồn (SSOT).</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="app-list-table-wrap">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2"><tr>
                <th className="app-list-header w-[46%]">Chỉ số</th>
                <th className="app-list-header w-[20%]">Vai trò</th>
                <th className="app-list-header w-[12%]">Đơn vị</th>
                <th className="app-list-header w-[16%]">Mục tiêu</th>
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
                        ? <span className="rounded-full bg-brand/10 px-2 py-0.5 text-tiny text-brand">Nguồn định nghĩa</span>
                        : <span className="rounded-full bg-surface-3 px-2 py-0.5 text-tiny text-text-tertiary" title={m.home_doc_title || undefined}>↩ Dùng lại</span>}
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
  const assets = doc.assets_on_page ?? [];
  if (assets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center">
        <LayoutDashboard className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
        <p className="text-caption text-text-tertiary">Chưa liên kết báo cáo/dữ liệu nào. Khi soạn thảo, chèn <code className="font-mono">{'{{dashboard:id}}'}</code> hoặc <code className="font-mono">{'{{dataset:id}}'}</code> vào nội dung.</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="app-list-table-wrap">
        <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
          <thead className="bg-surface-2"><tr>
            <th className="app-list-header w-[58%]">Tài nguyên</th>
            <th className="app-list-header w-[22%]">Loại</th>
            <th className="app-list-header w-[20%] text-right">Mở</th>
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
                        : !a.exists ? <span className="mt-0.5 block text-tiny text-danger">không tồn tại</span> : null}
                    </span>
                  </span>
                </td>
                <td className="app-list-cell"><span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{ASSET_LABEL[a.type]}</span></td>
                <td className="app-list-cell-tight text-right">
                  {a.exists && a.open_path
                    ? <Link href={a.open_path} className="inline-flex items-center gap-1 text-tiny text-brand hover:underline"><ExternalLink className="h-3 w-3" />Mở</Link>
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
  const [versions, setVersions] = useState<KnowledgeDocVersion[] | null>(null);
  const [viewV, setViewV] = useState<KnowledgeDocVersion | null>(null);
  useEffect(() => { let on = true; listDocVersions(docId).then((v) => { if (on) setVersions(v); }).catch(() => { if (on) setVersions([]); }); return () => { on = false; }; }, [docId]);
  const viewVersion = async (n: number) => { try { setViewV(await getDocVersion(docId, n)); } catch { toast.error('Không tải được phiên bản'); } };

  return (
    <div className="min-w-0">
      <p className="mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary"><History className="h-3.5 w-3.5" /> Lịch sử phiên bản (đã khoá)</p>
      {versions === null ? (
        <p className="py-6 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : versions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-8 text-center text-caption text-text-tertiary">Chưa có phiên bản nào được ghi. Mỗi lần lưu tài liệu sẽ tạo một bản khoá.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 divide-y divide-[rgb(var(--border-line))]">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-surface-2">
              <div className="min-w-0">
                <span className="font-strong text-text-primary">v{v.version}</span>
                {v.change_note && <span className="ml-2 text-caption text-text-secondary">{v.change_note}</span>}
                <span className="ml-2 text-tiny text-text-quaternary">{v.changed_by || 'hệ thống'} · {v.created_at ? new Date(v.created_at).toLocaleString('vi-VN') : ''}</span>
              </div>
              <button onClick={() => viewVersion(v.version)} className="flex-shrink-0 text-caption text-brand hover:underline">Xem</button>
            </li>
          ))}
        </ul>
      )}
      {viewV && (
        <div className="mt-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-caption font-strong text-text-primary">Nội dung v{viewV.version} (chỉ đọc)</span>
            <button onClick={() => setViewV(null)} className="text-text-quaternary hover:text-text-secondary"><X className="h-3.5 w-3.5" /></button>
          </div>
          {viewV.body ? <Markdown source={viewV.body} /> : <p className="text-caption text-text-tertiary">(trống)</p>}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════ Editor ═════════════════════════════════════
function EditorScreen({ docId, managed, onCancel, onSaved, onOpenMetric }: {
  docId: number | null; managed: ManagedMetric[];
  onCancel: () => void; onSaved: (id: number) => void; onOpenMetric: (s: MetricModalState) => void;
}) {
  const [editing, setEditing] = useState<KnowledgeDocWrite | null>(docId ? null : newDoc());
  const [tagsText, setTagsText] = useState('');
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
      toast.success(`Đã nhập nội dung từ “${f.name}”`);
    } catch { toast.error('Không đọc được tệp'); }
  };

  useEffect(() => {
    if (!docId) return;
    let on = true; setLoading(true);
    getKnowledgeDoc(docId)
      .then((d) => { if (!on) return; setEditing(docToWrite(d)); setTagsText((d.tags ?? []).join(', ')); })
      .catch(() => { if (on) toast.error('Không mở được tài liệu'); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [docId]);

  const upd = (patch: Partial<KnowledgeDocWrite>) => setEditing((p) => (p ? { ...p, ...patch } : p));

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

  const defineMetric = () => {
    if (!editing?.id) { toast.error('Hãy lưu tài liệu trước khi định nghĩa chỉ số'); return; }
    onOpenMetric({ machineName: null, homeDocId: editing.id, onCreated: (mn) => insertToken(`{{metric:${mn}}}`) });
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.title.trim()) { toast.error('Tiêu đề không được để trống'); return; }
    setSaving(true);
    try {
      const body: KnowledgeDocWrite = {
        ...editing, tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
        change_note: changeNote.trim() || undefined,
      };
      const r = await upsertKnowledgeDoc(body);
      toast.success(editing.id ? `Đã cập nhật (v${r.version})` : 'Đã tạo tài liệu');
      onSaved(r.id);
    } catch (e) { toast.error(errDetail(e) || 'Lưu thất bại'); }
    finally { setSaving(false); }
  };

  if (loading || !editing) return <DetailShell><div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div></DetailShell>;

  return (
    <DetailShell>
      <div className="pb-10">
        {/* top bar: back + save actions (full width) */}
        <div className="flex items-center justify-between gap-3">
          <button onClick={onCancel} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
            <ChevronLeft className="h-3.5 w-3.5" /> {editing.id ? 'Huỷ chỉnh sửa' : 'Huỷ tạo mới'}
          </button>
          <div className="flex gap-2">
            <Button variant="secondary" leadingIcon={<X className="h-4 w-4" />} onClick={onCancel} disabled={saving}>Huỷ</Button>
            <Button variant="primary" leadingIcon={<Save className="h-4 w-4" />} onClick={save} loading={saving} disabled={saving}>{editing.id ? 'Lưu thay đổi' : 'Lưu tài liệu'}</Button>
          </div>
        </div>
        <h1 className="mb-4 mt-3 text-h1 font-emphasis text-text-primary">{editing.id ? 'Chỉnh sửa tài liệu' : 'Tạo tài liệu'}</h1>

        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.html,.htm,text/plain,text/markdown,text/html" className="hidden" onChange={onImportFile} />

        {/* full-width 2-column: editor (left) + properties (right) */}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-3">
            <div className="space-y-1.5"><Label required>Tiêu đề</Label><Input value={editing.title} onChange={(e) => upd({ title: e.target.value })} placeholder="Vd: Tổng quan Báo cáo Doanh thu" /></div>
            <div className="space-y-1.5"><Label>Tóm tắt</Label><Input value={editing.summary ?? ''} onChange={(e) => upd({ summary: e.target.value })} placeholder="Một dòng mô tả tài liệu này (cũng là đoạn AI Bot đọc)" /></div>

            {/* insert-token + import toolbar */}
            <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">Chèn vào nội dung</p>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="xs" leadingIcon={<Upload className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()}>Nhập từ tệp</Button>
                  <Button variant="primary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={defineMetric}>Định nghĩa chỉ số</Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <TokenInserter managed={managed} insertToken={insertToken} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Nội dung (Markdown)</Label>
              <Textarea ref={bodyRef} rows={28} className="font-mono text-[13px]" value={editing.body ?? ''} onChange={(e) => upd({ body: e.target.value })}
                placeholder={'# Tiêu đề\n\nDùng **đậm**, *nghiêng*, `code`, [link](url), bảng…\n\nChèn thẻ: {{metric:slug}}, {{dashboard:12}}, {{dataset:5}}, {{term:glossary.term}}\n\nHoặc bấm “Nhập từ tệp” để đưa nội dung .md / .txt / .html vào đây rồi chỉnh sửa.'} />
            </div>
          </div>

          {/* properties rail */}
          <aside className="space-y-4 lg:sticky lg:top-0 lg:self-start">
            <div className="space-y-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
              <p className="text-tiny font-emphasis uppercase tracking-[0.08em] text-text-quaternary">Thuộc tính</p>
              <div className="space-y-1.5"><Label>Không gian (space)</Label><Input value={editing.space ?? ''} onChange={(e) => upd({ space: e.target.value })} placeholder="Doanh thu, Vận hành…" /></div>
              <div className="space-y-1.5"><Label>Loại</Label>
                <Select value={editing.doc_type ?? 'article'} onChange={(e) => upd({ doc_type: e.target.value })}>{DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}</Select>
              </div>
              <div className="space-y-1.5"><Label>Trạng thái</Label>
                <Select value={editing.status ?? 'Draft'} onChange={(e) => upd({ status: e.target.value as KnowledgeDoc['status'] })}>{['Draft', 'Published', 'Archived'].map((s) => <option key={s} value={s}>{s}</option>)}</Select>
              </div>
              <div className="space-y-1.5"><Label>Chủ sở hữu</Label><Input value={editing.owner ?? ''} onChange={(e) => upd({ owner: e.target.value })} placeholder="Team / người phụ trách" /></div>
              <label className="flex items-center gap-2 text-caption text-text-secondary"><input type="checkbox" checked={!!editing.pinned} onChange={(e) => upd({ pinned: e.target.checked })} className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" /> Ghim tài liệu</label>
              <div className="space-y-1.5"><Label>Nhãn (tags, ngăn bởi phẩy)</Label><Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="doanh thu, onboarding" /></div>
              <div className="space-y-1.5"><Label>Ghi chú thay đổi</Label><Input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="Vd: nâng mục tiêu SLA lên 92%" /></div>
            </div>
          </aside>
        </div>
      </div>
    </DetailShell>
  );
}

function TokenInserter({ managed, insertToken }: { managed: ManagedMetric[]; insertToken: (t: string) => void }) {
  const [pickMetric, setPickMetric] = useState('');
  const [dashId, setDashId] = useState('');
  const [dsId, setDsId] = useState('');
  const [termFqn, setTermFqn] = useState('');
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Select size="sm" className="w-48" value={pickMetric} onChange={(e) => setPickMetric(e.target.value)} aria-label="Chọn chỉ số">
          <option value="">Chọn chỉ số…</option>
          {managed.map((m) => <option key={m.machine_name} value={m.machine_name}>{m.name}</option>)}
        </Select>
        <Button variant="secondary" size="sm" leadingIcon={<Sigma className="h-3.5 w-3.5" />} disabled={!pickMetric} onClick={() => insertToken(`{{metric:${pickMetric}}}`)}>Chỉ số có sẵn</Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Input size="sm" className="w-24" value={dashId} onChange={(e) => setDashId(e.target.value)} placeholder="id báo cáo" />
        <Button variant="secondary" size="sm" leadingIcon={<LayoutDashboard className="h-3.5 w-3.5" />} disabled={!dashId.trim()} onClick={() => { insertToken(`{{dashboard:${dashId.trim()}}}`); setDashId(''); }}>Báo cáo</Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Input size="sm" className="w-24" value={dsId} onChange={(e) => setDsId(e.target.value)} placeholder="id dữ liệu" />
        <Button variant="secondary" size="sm" leadingIcon={<Database className="h-3.5 w-3.5" />} disabled={!dsId.trim()} onClick={() => { insertToken(`{{dataset:${dsId.trim()}}}`); setDsId(''); }}>Dữ liệu</Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Input size="sm" className="w-40" value={termFqn} onChange={(e) => setTermFqn(e.target.value)} placeholder="glossary.term" />
        <Button variant="secondary" size="sm" leadingIcon={<TagIcon className="h-3.5 w-3.5" />} disabled={!termFqn.trim()} onClick={() => { insertToken(`{{term:${termFqn.trim()}}}`); setTermFqn(''); }}>Thuật ngữ</Button>
      </div>
    </>
  );
}
