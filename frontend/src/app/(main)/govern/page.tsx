'use client';

/**
 * Govern — Metrics console, built on the core list layout (PageListLayout +
 * ModuleOverview + PaginatedCollection) so it matches every other module.
 * Metrics IS the surface: a paginated, searchable, filterable library of the
 * shared KPI measures. Opening a metric drills into its detail (overview /
 * expression / used-in / variants) where you assign glossary terms + tags via a
 * MODAL. The vocabulary itself (glossary terms + classification tags) is created
 * & curated in one "Từ điển & Nhãn" modal — no separate tabs. Clicking a term/
 * tag's usage count filters the metrics list to where it's used.
 */
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { BookText, Tags, Sigma, Search, Plus, ChevronLeft, BarChart3, LayoutDashboard, Pencil, AlertTriangle, Trash2, Library, Lock, Layers, Check } from 'lucide-react';

import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { Tabs } from '@/components/ui/Tabs';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Label, Select } from '@/components/ui/Input';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useUrlNav } from '@/hooks/use-url-nav';
import {
  getMetrics, getMetricUsage, updateMetric, getMetricVariants,
  getGlossaries, listGlossaryTerms, upsertGlossary, deleteGlossary, upsertTerm, deleteTerm,
  listClassifications, getTags, upsertClassification, deleteClassification, upsertTag, deleteTag,
  type GlossaryTerm, type Glossary, type Classification, type Tag, type Metric, type MetricsLibrary, type MetricUsage, type MetricVariants,
  type VocabRef,
} from '@/lib/catalog';

function errDetail(err: unknown): string | undefined {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}

/** Seed descriptions may carry markdown/HTML; render them as clean text. */
function cleanDesc(s?: string | null): string {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const TYPE_TONE: Record<string, 'brand' | 'info' | 'success' | 'warning' | 'neutral'> = {
  sum: 'brand', avg: 'brand', average: 'brand', min: 'info', max: 'info',
  count: 'success', count_distinct: 'success', percent_of_total: 'warning', formula: 'warning', window: 'warning',
};

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-tiny text-text-quaternary">{hint}</p>}
    </div>
  );
}

function EmptyCard({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-12 text-center">
      <p className="text-small font-emphasis text-text-primary">{title}</p>
      {hint && <p className="mt-1 text-caption text-text-tertiary">{hint}</p>}
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel = 'Xoá', onConfirm, onClose, loading }: { title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onClose: () => void; loading?: boolean }) {
  return (
    <Modal isOpen onClose={onClose} title={title} size="sm"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={loading}>Huỷ</Button>
        <Button variant="danger" onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </>)}>
      <p className="text-caption text-text-secondary">{message}</p>
    </Modal>
  );
}

function VocabChips({ items, tone, empty = '—' }: { items?: VocabRef[]; tone: 'brand' | 'info'; empty?: string }) {
  if (!items || items.length === 0) return <span className="text-tiny text-text-quaternary">{empty}</span>;
  const cls = tone === 'brand' ? 'bg-brand/10 text-brand' : 'bg-info/10 text-info';
  return (
    <span className="flex flex-wrap gap-1">
      {items.slice(0, 2).map((v) => (
        <span key={v.fqn} className={cn('inline-block max-w-[130px] truncate rounded px-1.5 py-0.5 text-tiny', cls)} title={v.label}>{v.label}</span>
      ))}
      {items.length > 2 && <span className="text-tiny text-text-quaternary">+{items.length - 2}</span>}
    </span>
  );
}

function ExclusivityTag({ mx }: { mx: boolean }) {
  return mx
    ? <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-tiny text-info"><Layers className="h-3 w-3" />Chọn 1</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary"><Tags className="h-3 w-3" />Chọn nhiều</span>;
}

export default function GovernPage() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">Đang tải…</div>}>
      <GovernModule />
    </Suspense>
  );
}

/** Same outer chrome (padding + scroll) as PageListLayout, for full-pane detail views. */
function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col px-4 pt-6 sm:px-6 xl:px-8">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</div>
    </div>
  );
}

function GovernModule() {
  const nav = useUrlNav();
  const [lib, setLib] = useState<MetricsLibrary | null>(null);
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [classes, setClasses] = useState<Classification[]>([]);
  const [loading, setLoading] = useState(true);

  const reloadMetrics = useCallback(() => getMetrics().then(setLib).catch(() => setLib({ metrics: [], total: 0, datasets: 0, conflicts: 0 })), []);
  const reloadVocab = useCallback(async () => {
    try { const [t, c] = await Promise.all([listGlossaryTerms(), listClassifications()]); setTerms(t); setClasses(c); }
    catch { /* ignore */ }
  }, []);
  useEffect(() => {
    let on = true;
    setLoading(true);
    Promise.all([reloadMetrics(), reloadVocab()]).finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [reloadMetrics, reloadVocab]);

  const metrics = lib?.metrics ?? [];
  const mKey = nav.get('m');
  const selMetric = mKey ? metrics.find((m) => `${m.view_id}.${m.name}` === mKey) ?? null : null;
  const totalTags = useMemo(() => classes.reduce((s, c) => s + (c.termCount || 0), 0), [classes]);

  if (selMetric) {
    return <DetailShell><MetricDetail key={mKey!} metric={selMetric} onBack={() => nav.set({ m: null })} /></DetailShell>;
  }
  if (mKey && loading) {
    return <DetailShell><p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p></DetailShell>;
  }
  return (
    <GovernList
      lib={lib} termCount={terms.length} tagCount={totalTags} loading={loading}
      onOpenMetric={(m) => nav.set({ m: `${m.view_id}.${m.name}` })}
      onReloadVocab={reloadVocab}
    />
  );
}

// ── The Metrics list (the whole Govern surface) ──────────────────────────────
function GovernList({ lib, termCount, tagCount, loading, onOpenMetric, onReloadVocab }: {
  lib: MetricsLibrary | null;
  termCount: number;
  tagCount: number;
  loading: boolean;
  onOpenMetric: (m: Metric) => void;
  onReloadVocab: () => Promise<void>;
}) {
  const router = useRouter();
  const [vocabOpen, setVocabOpen] = useState(false);
  const [addMetric, setAddMetric] = useState(false);
  const [source, setSource] = useState('');
  const [type, setType] = useState('');
  const [onlyConflict, setOnlyConflict] = useState(false);
  const [vocabFilter, setVocabFilter] = useState<{ kind: 'term' | 'tag'; ref: VocabRef } | null>(null);

  const metrics = lib?.metrics ?? [];
  const sources = useMemo(() => Array.from(new Set(metrics.map((m) => m.dataset).filter(Boolean))).sort() as string[], [metrics]);
  const types = useMemo(() => Array.from(new Set(metrics.map((m) => m.type).filter(Boolean))).sort(), [metrics]);
  const activeCount = (source ? 1 : 0) + (type ? 1 : 0) + (onlyConflict ? 1 : 0) + (vocabFilter ? 1 : 0);
  const clearAll = () => { setSource(''); setType(''); setOnlyConflict(false); setVocabFilter(null); };

  return (
    <>
      <PageListLayout
        title="Govern"
        description="Chỉ số KPI dùng chung — định nghĩa một lần, dùng nhất quán mọi nơi; gắn thuật ngữ & nhãn để chuẩn hoá ngữ nghĩa dữ liệu."
        overview={(
          <ModuleOverview
            stats={[
              { label: 'Chỉ số', value: lib?.total ?? 0, helper: 'Tổng số chỉ số (measure) bạn truy cập được' },
              { label: 'Xung đột', value: lib?.conflicts ?? 0, helper: 'Số tên chỉ số có nhiều định nghĩa khác nhau cùng nguồn' },
              { label: 'Thuật ngữ', value: termCount, helper: 'Thuật ngữ nghiệp vụ trong từ điển' },
              { label: 'Nhãn', value: tagCount, helper: 'Nhãn phân loại đã tạo' },
            ]}
          />
        )}
        action={(
          <div className="flex items-center gap-2">
            <Button variant="secondary" leadingIcon={<Library className="h-4 w-4" />} onClick={() => setVocabOpen(true)}>Từ điển &amp; Nhãn</Button>
            <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setAddMetric(true)}>Thêm chỉ số</Button>
          </div>
        )}
        isLoading={loading}
        loadingText="Đang tải…"
        searchPlaceholder="Tìm chỉ số, dataset…"
        viewToggle={false}
        toolbarExtra={(
          <div className="flex items-center gap-2">
            <Select size="sm" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Lọc theo nguồn">
              <option value="">Mọi nguồn</option>
              {sources.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <Select size="sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Lọc theo loại">
              <option value="">Mọi loại</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>
        )}
        activeFilters={(activeCount > 0 || !!lib?.conflicts) ? (
          <>
            {!!lib?.conflicts && (
              <FilterTag tone="warning" active={onlyConflict} onClick={() => setOnlyConflict((v) => !v)}>
                <AlertTriangle className="mr-1 h-3 w-3" /> {lib.conflicts} xung đột
              </FilterTag>
            )}
            {vocabFilter && (
              <FilterTag tone={vocabFilter.kind === 'term' ? 'brand' : 'info'} active onClick={() => setVocabFilter(null)}>
                {vocabFilter.kind === 'term' ? 'Thuật ngữ' : 'Nhãn'}: {vocabFilter.ref.label}
              </FilterTag>
            )}
            {source && <FilterTag tone="neutral" active onClick={() => setSource('')}>Nguồn: {source}</FilterTag>}
            {type && <FilterTag tone="neutral" active onClick={() => setType('')}>Loại: {type}</FilterTag>}
            {activeCount > 0 && <Button variant="ghost" size="xs" onClick={clearAll}>Xoá lọc</Button>}
          </>
        ) : null}
      >
        {({ filterText }) => {
          const needle = filterText.trim().toLowerCase();
          const filtered = metrics.filter((m) => {
            const matchSearch = !needle || m.label.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle) || (m.dataset || '').toLowerCase().includes(needle);
            const matchSource = !source || m.dataset === source;
            const matchType = !type || m.type === type;
            const matchConflict = !onlyConflict || m.conflict;
            const matchVocab = !vocabFilter || (vocabFilter.kind === 'term'
              ? (m.glossaryTerms || []).some((v) => v.fqn === vocabFilter.ref.fqn)
              : (m.tags || []).some((v) => v.fqn === vocabFilter.ref.fqn));
            return matchSearch && matchSource && matchType && matchConflict && matchVocab;
          });

          if (metrics.length === 0) {
            return (
              <div className="py-16 text-center">
                <Sigma className="mx-auto mb-4 h-14 w-14 text-text-quaternary" />
                <h2 className="mb-2 text-small font-strong text-text-primary">Chưa có chỉ số nào</h2>
                <p className="text-caption text-text-tertiary">Tạo measure trong một Dataset — nó sẽ tự xuất hiện trong thư viện chỉ số dùng chung này.</p>
              </div>
            );
          }
          if (filtered.length === 0) {
            return (
              <div className="flex h-48 flex-col items-center justify-center text-center">
                <Search className="mb-2 h-8 w-8 text-text-quaternary" />
                <p className="text-caption text-text-tertiary">Không có chỉ số khớp bộ lọc hiện tại.</p>
              </div>
            );
          }

          return (
            <PaginatedCollection items={filtered} viewMode="list" resetKey={`${filterText}|${source}|${type}|${onlyConflict}|${vocabFilter?.ref.fqn || ''}`}>
              {({ pageItems, pagination, hasFooter }) => (
                <div>
                  <div className={cn('border border-[rgb(var(--border-line))] bg-surface-1', hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl')}>
                    <div className="app-list-table-wrap">
                      <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                        <thead className="bg-surface-2"><tr>
                          <th className="app-list-header w-[28%]">Chỉ số</th>
                          <th className="app-list-header w-[28%]">Mô tả</th>
                          <th className="app-list-header w-[13%]">Nhãn</th>
                          <th className="app-list-header w-[16%]">Thuật ngữ</th>
                          <th className="app-list-header w-[15%]">Chủ sở hữu</th>
                        </tr></thead>
                        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                          {pageItems.map((m, i) => (
                            <tr key={`${m.dataset}.${m.name}.${i}`} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpenMetric(m)}>
                              <td className="app-list-cell">
                                <span className="app-list-text-main flex items-center gap-1.5 text-caption font-emphasis text-text-primary hover:text-brand">
                                  {m.label}
                                  <FilterTag tone={TYPE_TONE[m.type] ?? 'neutral'}>{m.type}</FilterTag>
                                  {m.conflict && (
                                    <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/10 px-1.5 text-tiny text-warning" title={`${m.distinctDefs} định nghĩa khác nhau cùng tên`}>
                                      <AlertTriangle className="h-2.5 w-2.5" />{m.distinctDefs}
                                    </span>
                                  )}
                                </span>
                                <span className="app-list-text-sub mt-0.5 block text-tiny text-text-tertiary">
                                  <code className="font-mono">{m.name}</code>
                                  {m.dataset && <span className="text-text-quaternary"> · {m.dataset}</span>}
                                </span>
                              </td>
                              <td className="app-list-cell">
                                {m.description
                                  ? <span className="text-caption text-text-secondary">{m.description}</span>
                                  : <code className="font-mono text-tiny text-text-quaternary">{m.definition || '—'}</code>}
                              </td>
                              <td className="app-list-cell"><VocabChips items={m.tags} tone="info" /></td>
                              <td className="app-list-cell"><VocabChips items={m.glossaryTerms} tone="brand" /></td>
                              <td className="app-list-cell text-caption text-text-tertiary">{m.owner ? m.owner.split('@')[0] : '—'}</td>
                            </tr>
                          ))}
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

      {vocabOpen && (
        <VocabManagerModal
          metrics={metrics}
          onClose={() => setVocabOpen(false)}
          onChanged={onReloadVocab}
          onFilterMetrics={(f) => { setVocabFilter(f); setVocabOpen(false); }}
        />
      )}

      {addMetric && (
        <Modal isOpen onClose={() => setAddMetric(false)} title="Thêm chỉ số" size="sm"
          footer={(<>
            <Button variant="ghost" onClick={() => setAddMetric(false)}>Đóng</Button>
            <Button variant="primary" onClick={() => router.push('/datasets')}>Mở Datasets</Button>
          </>)}>
          <p className="text-caption text-text-secondary">
            Chỉ số trong AppBI là một <strong className="text-text-primary">measure</strong> định nghĩa bên trong Dataset. Mở Dataset, thêm
            measure (SUM/COUNT/công thức…) — nó sẽ tự xuất hiện trong thư viện này, dùng nhất quán ở mọi chart & dashboard.
          </p>
        </Modal>
      )}
    </>
  );
}

// ── Metric detail (overview / expression / used-in / variants) ───────────────
function MetricDetail({ metric, onBack }: { metric: Metric; onBack: () => void }) {
  const router = useRouter();
  const [m, setM] = useState<Metric>(metric);
  const [tab, setTab] = useState('overview');
  const [usage, setUsage] = useState<MetricUsage | null>(null);
  const [variants, setVariants] = useState<MetricVariants | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [form, setForm] = useState({ label: metric.label, description: metric.description || '' });

  useEffect(() => {
    let on = true;
    if (metric.table_id) {
      getMetricUsage(metric.table_id, metric.name).then((u) => on && setUsage(u)).catch(() => on && setUsage(null));
    } else {
      setUsage({ charts: [], dashboards: [], chartCount: 0, dashboardCount: 0 });
    }
    return () => { on = false; };
  }, [metric.table_id, metric.name]);

  useEffect(() => {
    if (tab !== 'variants' || variants) return;
    let on = true;
    getMetricVariants(metric.name).then((v) => on && setVariants(v)).catch(() => on && setVariants(null));
    return () => { on = false; };
  }, [tab, variants, metric.name]);

  const save = async () => {
    if (!m.view_id) return;
    setSaving(true);
    try {
      await updateMetric({ view_id: m.view_id, name: m.name, label: form.label, description: form.description });
      setM({ ...m, label: form.label, description: form.description || null });
      setEditing(false);
      toast.success('Đã lưu chỉ số', { description: form.label });
    } catch (err: unknown) {
      toast.error(errDetail(err) || 'Không lưu được. Bạn cần quyền edit dataset này.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
        <ChevronLeft className="h-3.5 w-3.5" /> Govern
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-h1 font-emphasis text-text-primary">{m.label}</h1>
            <FilterTag tone={TYPE_TONE[m.type] ?? 'neutral'}>{m.type}</FilterTag>
            {m.shared && <span className="rounded-full bg-info/10 px-2 py-0.5 text-tiny text-info">Shared</span>}
            {m.hidden && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-tiny text-warning">hidden</span>}
          </div>
          <p className="mt-0.5 text-caption text-text-tertiary">
            <code className="font-mono">{m.name}</code>
            {m.dataset && <span> · {m.dataset}{m.table ? ` / ${m.table}` : ''}</span>}
            {m.owner && <span className="text-text-quaternary"> · owner {m.owner.split('@')[0]}</span>}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {!editing && tab === 'overview' && (
            <Button variant="secondary" size="sm" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setForm({ label: m.label, description: m.description || '' }); setEditing(true); }}>
              Sửa
            </Button>
          )}
          {m.dataset_id && (
            <Button variant="ghost" size="sm" onClick={() => router.push(`/datasets/${m.dataset_id}`)}>Sửa công thức trong Dataset</Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <Meta label="Dataset" value={m.dataset || '—'} />
        <Meta label="Table" value={m.table || '—'} />
        <Meta label="Type" value={m.type} />
        <Meta label="Format" value={m.format || '—'} />
      </div>

      <Tabs
        size="sm"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'overview', label: 'Tổng quan' },
          { key: 'expression', label: 'Công thức' },
          { key: 'usage', label: 'Đang dùng', badge: usage ? <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-tiny text-text-tertiary">{usage.chartCount + usage.dashboardCount}</span> : undefined },
          ...(m.variants && m.variants > 1
            ? [{ key: 'variants', label: 'Trùng tên', badge: <span className={cn('ml-1 rounded-full px-1.5 text-tiny', m.conflict ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-text-tertiary')}>{m.variants}</span> }]
            : []),
        ]}
      />

      {tab === 'overview' && !editing && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Mô tả</div>
          <p className="text-caption text-text-secondary">{m.description || 'Chưa có mô tả. Bấm Sửa để thêm.'}</p>
        </div>
      )}

      {tab === 'overview' && !editing && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-tiny uppercase tracking-[0.08em] text-text-tertiary">Nhãn &amp; Thuật ngữ</div>
            <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAssignOpen(true)}>Gán</Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 flex items-center gap-1 text-tiny text-text-quaternary"><Tags className="h-3 w-3" /> Nhãn (Classification)</div>
              <VocabChips items={m.tags} tone="info" empty="Chưa gán" />
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-1 text-tiny text-text-quaternary"><BookText className="h-3 w-3" /> Thuật ngữ (Glossary)</div>
              <VocabChips items={m.glossaryTerms} tone="brand" empty="Chưa gán" />
            </div>
          </div>
          <p className="mt-3 text-tiny text-text-quaternary">Gắn thuật ngữ nghiệp vụ + nhãn phân loại để chỉ số có ngữ cảnh chung — quản lý từ điển ở nút “Từ điển &amp; Nhãn”.</p>
        </div>
      )}

      {assignOpen && (
        <AssignVocabModal
          currentTerms={m.glossaryTerms || []}
          currentTags={m.tags || []}
          onClose={() => setAssignOpen(false)}
          onSave={async (terms, tags) => {
            if (!m.view_id) { toast.error('Chỉ số này không sửa được nhãn.'); return; }
            await updateMetric({ view_id: m.view_id, name: m.name, glossary_terms: terms, tags });
            setM({ ...m, glossaryTerms: terms, tags });
            setAssignOpen(false);
            toast.success('Đã cập nhật nhãn & thuật ngữ');
          }}
        />
      )}

      {tab === 'overview' && editing && (
        <div className="space-y-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <Field label="Tên hiển thị"><Input size="sm" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
          <Field label="Mô tả"><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Mô tả nghiệp vụ của chỉ số…" /></Field>
          <p className="text-tiny text-text-quaternary">Chỉ sửa tên hiển thị + mô tả — KHÔNG đụng công thức/type/format (lấy từ measure). Lưu qua đường validate của Dataset, cập nhật cho mọi nơi dùng chỉ số này.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Huỷ</Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={saving || !form.label.trim()}>Lưu</Button>
          </div>
        </div>
      )}

      {tab === 'expression' && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-2 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Công thức ({m.type})</div>
          <pre className="overflow-x-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3 font-mono text-tiny text-text-secondary">{m.definition || '—'}</pre>
          <p className="mt-2 text-tiny text-text-quaternary">Công thức sửa ở Dataset (đường validate) — bấm “Sửa công thức trong Dataset” ở trên.</p>
        </div>
      )}

      {tab === 'usage' && (
        <div className="space-y-4">
          {!usage ? (
            <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
          ) : usage.chartCount === 0 && usage.dashboardCount === 0 ? (
            <EmptyCard title="Chưa dùng ở đâu" hint="Chỉ số này chưa được dùng trong chart/dashboard nào (hoặc tham chiếu gián tiếp)." />
          ) : (
            <>
              <UsageGroup
                icon={<BarChart3 className="h-4 w-4" />}
                title={`Charts (${usage.chartCount})`}
                rows={usage.charts.map((c) => ({ id: c.id, name: c.name, sub: c.chartType || '' }))}
                onOpen={(id) => router.push(`/explore/${id}`)}
              />
              <UsageGroup
                icon={<LayoutDashboard className="h-4 w-4" />}
                title={`Dashboards (${usage.dashboardCount})`}
                rows={usage.dashboards.map((d) => ({ id: d.id, name: d.name, sub: '' }))}
                onOpen={(id) => router.push(`/dashboards/${id}`)}
              />
            </>
          )}
        </div>
      )}

      {tab === 'variants' && (
        <div className="space-y-3">
          {!variants ? (
            <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
          ) : (
            <>
              <div className={cn('rounded-lg border px-4 py-2.5 text-caption', m.conflict ? 'border-warning/30 bg-warning/10 text-warning' : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary')}>
                {m.conflict ? (
                  <><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Cùng nguồn <code className="font-mono">{m.source}</code> nhưng có <strong>{m.distinctDefs} định nghĩa KHÁC nhau</strong> cho “{m.name}” — cần rà & thống nhất về 1 định nghĩa chuẩn.</>
                ) : variants.count > 1 ? (
                  <>Cùng tên ở {variants.count} nơi nhưng <strong>khác nguồn</strong> → là các chỉ số độc lập, không xung đột.</>
                ) : (
                  <>Chỉ 1 nơi định nghĩa chỉ số này.</>
                )}
              </div>
              <p className="text-tiny text-text-quaternary">Hàng tô vàng = cùng nguồn với chỉ số đang xem (chỗ thực sự phải thống nhất). Bấm 1 hàng để mở dataset đó.</p>
              <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
                <div className="app-list-table-wrap">
                  <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                    <thead className="bg-surface-2"><tr>
                      <th className="app-list-header w-[20%]">Dataset</th>
                      <th className="app-list-header w-[14%]">Nguồn</th>
                      <th className="app-list-header w-[12%]">Chủ sở hữu</th>
                      <th className="app-list-header w-[8%]">Loại</th>
                      <th className="app-list-header">Định nghĩa</th>
                    </tr></thead>
                    <tbody className="divide-y divide-[rgb(var(--border-line))]">
                      {variants.variants.map((v, i) => {
                        const isCurrent = v.view_id === m.view_id;
                        const sameSource = (v.source || '') === (m.source || '');
                        return (
                          <tr key={i} className={cn(sameSource ? 'bg-warning/10' : '', isCurrent ? 'bg-brand/8' : 'cursor-pointer', 'hover:bg-surface-2')} onClick={() => !isCurrent && v.dataset_id && router.push(`/datasets/${v.dataset_id}`)}>
                            <td className="app-list-cell text-caption text-text-secondary">
                              {v.dataset || '—'}
                              {isCurrent && <span className="ml-1 rounded-full bg-brand/10 px-1.5 text-tiny text-brand">đang xem</span>}
                            </td>
                            <td className="app-list-cell text-tiny"><span className={cn('font-mono', sameSource ? 'text-warning' : 'text-text-tertiary')}>{v.source || '—'}</span></td>
                            <td className="app-list-cell text-tiny text-text-tertiary">{v.owner ? v.owner.split('@')[0] : '—'}</td>
                            <td className="app-list-cell"><FilterTag tone={TYPE_TONE[v.type] ?? 'neutral'}>{v.type}</FilterTag></td>
                            <td className="app-list-cell"><code className="font-mono text-tiny text-text-secondary">{v.definition || '—'}</code></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-tiny uppercase tracking-[0.08em] text-text-quaternary">{label}</span>
      <span className="text-caption font-emphasis text-text-primary">{value}</span>
    </div>
  );
}

function UsageGroup({ icon, title, rows, onOpen }: { icon: ReactNode; title: string; rows: { id: number; name: string; sub: string }[]; onOpen: (id: number) => void }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-2.5 text-caption font-emphasis text-text-primary">
        <span className="text-text-tertiary">{icon}</span>{title}
      </div>
      <ul className="divide-y divide-[rgb(var(--border-line))]">
        {rows.map((r) => (
          <li key={r.id}>
            <button onClick={() => onOpen(r.id)} className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-surface-2">
              <span className="text-caption text-text-secondary hover:text-brand">{r.name}</span>
              {r.sub && <span className="text-tiny text-text-quaternary">{r.sub}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Assign vocab to a metric (the per-metric modal) ──────────────────────────
function AssignVocabModal({ currentTerms, currentTags, onClose, onSave }: {
  currentTerms: VocabRef[];
  currentTags: VocabRef[];
  onClose: () => void;
  onSave: (terms: VocabRef[], tags: VocabRef[]) => Promise<void>;
}) {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [selTerms, setSelTerms] = useState<Record<string, VocabRef>>(() => Object.fromEntries(currentTerms.map((t) => [t.fqn, t])));
  const [selTags, setSelTags] = useState<Record<string, VocabRef>>(() => Object.fromEntries(currentTags.map((t) => [t.fqn, t])));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let on = true;
    Promise.all([listGlossaryTerms(), getTags()])
      .then(([tm, tg]) => { if (on) { setTerms(tm); setTags(tg); } })
      .catch(() => {})
      .finally(() => on && setLoading(false));
    return () => { on = false; };
  }, []);

  const submit = async () => {
    setSaving(true);
    try { await onSave(Object.values(selTerms), Object.values(selTags)); }
    catch (err) { toast.error(errDetail(err) || 'Không lưu được. Cần quyền edit dataset này.'); }
    finally { setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title="Gán nhãn & thuật ngữ cho chỉ số" size="lg"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Huỷ</Button>
        <Button variant="primary" onClick={submit} loading={saving}>Lưu</Button>
      </>)}>
      {loading ? (
        <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><Tags className="h-4 w-4 text-text-tertiary" />Nhãn ({Object.keys(selTags).length})</div>
            {tags.length === 0 ? (
              <p className="text-tiny text-text-quaternary">Chưa có nhãn — tạo ở “Từ điển &amp; Nhãn”.</p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {tags.map((t) => {
                  const on = !!selTags[t.fqn];
                  return (
                    <li key={t.fqn}>
                      <button type="button" onClick={() => setSelTags((s) => { const n = { ...s }; if (n[t.fqn]) delete n[t.fqn]; else n[t.fqn] = { fqn: t.fqn, label: t.name }; return n; })}
                        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption hover:bg-surface-2', on && 'bg-info/10')}>
                        <span className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border', on ? 'border-info bg-info text-text-inverse' : 'border-[rgb(var(--border-strong))]')}>{on && <Check className="h-3 w-3" />}</span>
                        <span className="truncate text-text-primary">{t.name}</span>
                        {t.classification && <span className="flex-shrink-0 text-tiny text-text-quaternary">· {t.classification}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><BookText className="h-4 w-4 text-text-tertiary" />Thuật ngữ ({Object.keys(selTerms).length})</div>
            {terms.length === 0 ? (
              <p className="text-tiny text-text-quaternary">Chưa có thuật ngữ — tạo ở “Từ điển &amp; Nhãn”.</p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {terms.map((t) => {
                  const on = !!selTerms[t.fqn];
                  return (
                    <li key={t.fqn}>
                      <button type="button" onClick={() => setSelTerms((s) => { const n = { ...s }; if (n[t.fqn]) delete n[t.fqn]; else n[t.fqn] = { fqn: t.fqn, label: t.name }; return n; })}
                        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption hover:bg-surface-2', on && 'bg-brand/10')}>
                        <span className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border', on ? 'border-brand bg-brand text-text-inverse' : 'border-[rgb(var(--border-strong))]')}>{on && <Check className="h-3 w-3" />}</span>
                        <span className="truncate text-text-primary">{t.name}</span>
                        {t.glossary && <span className="flex-shrink-0 text-tiny text-text-quaternary">· {t.glossary}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ══════════════════════ Từ điển & Nhãn (vocab manager modal) ════════════════
function VocabManagerModal({ metrics, onClose, onChanged, onFilterMetrics }: {
  metrics: Metric[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onFilterMetrics: (f: { kind: 'term' | 'tag'; ref: VocabRef }) => void;
}) {
  const [seg, setSeg] = useState<'terms' | 'tags'>('terms');
  const [glossaries, setGlossaries] = useState<Glossary[]>([]);
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [classes, setClasses] = useState<Classification[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [g, t, c, tg] = await Promise.all([getGlossaries(), listGlossaryTerms(), listClassifications(), getTags()]);
      setGlossaries(g); setTerms(t); setClasses(c); setTags(tg);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Usage counts come free from the already-loaded metrics — no extra requests.
  const termUsage = useMemo(() => {
    const m = new Map<string, number>();
    metrics.forEach((mt) => (mt.glossaryTerms || []).forEach((v) => m.set(v.fqn, (m.get(v.fqn) || 0) + 1)));
    return m;
  }, [metrics]);
  const tagUsage = useMemo(() => {
    const m = new Map<string, number>();
    metrics.forEach((mt) => (mt.tags || []).forEach((v) => m.set(v.fqn, (m.get(v.fqn) || 0) + 1)));
    return m;
  }, [metrics]);

  const refresh = async () => { await reload(); await onChanged(); };

  return (
    <Modal isOpen onClose={onClose} title="Từ điển & Nhãn" size="lg" footer={<Button variant="ghost" onClick={onClose}>Đóng</Button>}>
      <div className="space-y-4">
        <p className="text-caption text-text-tertiary">Quản lý thuật ngữ nghiệp vụ &amp; nhãn phân loại dùng chung. Gắn vào chỉ số ở trang chi tiết mỗi chỉ số; bấm “n chỉ số” để lọc xem chỉ số nào đang dùng.</p>
        <div className="flex items-center gap-1.5">
          <FilterTag tone="brand" active={seg === 'terms'} onClick={() => setSeg('terms')}><BookText className="mr-1 h-3 w-3" />Thuật ngữ ({terms.length})</FilterTag>
          <FilterTag tone="info" active={seg === 'tags'} onClick={() => setSeg('tags')}><Tags className="mr-1 h-3 w-3" />Phân loại ({classes.length})</FilterTag>
        </div>
        {loading ? (
          <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
        ) : seg === 'terms' ? (
          <TermsManager glossaries={glossaries} terms={terms} usage={termUsage} onChanged={refresh} onFilter={(ref) => onFilterMetrics({ kind: 'term', ref })} />
        ) : (
          <TagsManager classes={classes} tags={tags} usage={tagUsage} onChanged={refresh} onFilter={(ref) => onFilterMetrics({ kind: 'tag', ref })} />
        )}
      </div>
    </Modal>
  );
}

function GlossaryInlineManager({ glossaries, onChanged }: { glossaries: Glossary[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDel, setPendingDel] = useState<Glossary | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await upsertGlossary({ name }); setName(''); toast.success('Đã tạo bộ thuật ngữ', { description: name }); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không tạo được.'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!pendingDel) return;
    setBusy(true);
    try { await deleteGlossary(pendingDel.fqn); toast.success('Đã xoá bộ thuật ngữ'); setPendingDel(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
      <div className="text-tiny uppercase tracking-[0.08em] text-text-tertiary">Bộ thuật ngữ</div>
      {glossaries.length > 0 && (
        <ul className="space-y-1">
          {glossaries.map((g) => (
            <li key={g.machine_name} className="flex items-center justify-between gap-2 text-caption text-text-secondary">
              <span className="flex items-center gap-1.5"><Library className="h-3.5 w-3.5 text-text-quaternary" />{g.name} <span className="text-tiny text-text-quaternary">({g.termCount})</span>{g.provider === 'system' && <Lock className="h-3 w-3 text-text-quaternary" />}</span>
              {g.provider !== 'system' && <button onClick={() => setPendingDel(g)} disabled={busy} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá"><Trash2 className="h-3.5 w-3.5" /></button>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên bộ thuật ngữ mới…" />
        <Button variant="secondary" size="sm" loading={busy} disabled={busy || !name.trim()} onClick={create}>Tạo</Button>
      </div>
      {pendingDel && <ConfirmModal title="Xoá bộ thuật ngữ?" message={<>Xoá <strong>{pendingDel.name}</strong>{pendingDel.termCount > 0 ? ` cùng ${pendingDel.termCount} thuật ngữ bên trong` : ''}?</>} onConfirm={del} onClose={() => setPendingDel(null)} loading={busy} />}
    </div>
  );
}

function TermsManager({ glossaries, terms, usage, onChanged, onFilter }: {
  glossaries: Glossary[]; terms: GlossaryTerm[]; usage: Map<string, number>;
  onChanged: () => Promise<void>; onFilter: (ref: VocabRef) => void;
}) {
  const [glossOpen, setGlossOpen] = useState(false);
  const [form, setForm] = useState<{ open: boolean; machine?: string; glossary: string; name: string; def: string; syn: string }>(
    { open: false, glossary: '', name: '', def: '', syn: '' });
  const [busy, setBusy] = useState(false);
  const [delTerm, setDelTerm] = useState<GlossaryTerm | null>(null);
  const hasGloss = glossaries.length > 0;

  const openAdd = () => setForm({ open: true, glossary: glossaries[0]?.machine_name || '', name: '', def: '', syn: '' });
  const openEdit = (t: GlossaryTerm) => setForm({ open: true, machine: t.machine_name, glossary: t.glossaryFqn || '', name: t.name, def: t.definition || '', syn: (t.synonyms || []).join(', ') });

  const save = async () => {
    if (!form.name.trim() || !form.glossary) return;
    setBusy(true);
    try {
      await upsertTerm({ glossary: form.glossary, machine_name: form.machine, name: form.name, description: form.def, synonyms: form.syn.split(',').map((s) => s.trim()).filter(Boolean) });
      toast.success(form.machine ? 'Đã lưu thuật ngữ' : 'Đã thêm thuật ngữ', { description: form.name });
      setForm((f) => ({ ...f, open: false })); await onChanged();
    } catch (e) { toast.error(errDetail(e) || 'Không lưu được.'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!delTerm) return;
    setBusy(true);
    try { await deleteTerm(delTerm.fqn); toast.success('Đã xoá', { description: delTerm.name }); setDelTerm(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-caption text-text-tertiary">{terms.length} thuật ngữ · {glossaries.length} bộ</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="xs" leadingIcon={<Library className="h-3.5 w-3.5" />} onClick={() => setGlossOpen((v) => !v)}>Bộ thuật ngữ</Button>
          <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} disabled={!hasGloss} onClick={openAdd}>Thêm thuật ngữ</Button>
        </div>
      </div>

      {glossOpen && <GlossaryInlineManager glossaries={glossaries} onChanged={onChanged} />}

      {form.open && (
        <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
          {glossaries.length > 1 && (
            <Field label="Bộ thuật ngữ">
              <Select size="sm" value={form.glossary} onChange={(e) => setForm({ ...form, glossary: e.target.value })} disabled={!!form.machine}>
                {glossaries.map((g) => <option key={g.machine_name} value={g.machine_name}>{g.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Tên thuật ngữ"><Input size="sm" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="vd: Khách hàng hoạt động" /></Field>
          <Field label="Định nghĩa"><Textarea rows={2} value={form.def} onChange={(e) => setForm({ ...form, def: e.target.value })} placeholder="Định nghĩa nghiệp vụ rõ ràng…" /></Field>
          <Field label="Từ đồng nghĩa" hint="Phân tách bằng dấu phẩy"><Input size="sm" value={form.syn} onChange={(e) => setForm({ ...form, syn: e.target.value })} placeholder="active user, KH active" /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setForm((f) => ({ ...f, open: false }))} disabled={busy}>Huỷ</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={busy || !form.name.trim()} onClick={save}>Lưu</Button>
          </div>
        </div>
      )}

      {!hasGloss ? (
        <p className="py-6 text-center text-caption text-text-quaternary">Tạo một “Bộ thuật ngữ” trước (nút Bộ thuật ngữ), rồi thêm thuật ngữ.</p>
      ) : terms.length === 0 ? (
        <p className="py-6 text-center text-caption text-text-quaternary">Chưa có thuật ngữ nào.</p>
      ) : (
        <ul className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
          {terms.map((t) => {
            const sys = t.provider === 'system';
            const n = usage.get(t.fqn) || 0;
            return (
              <li key={t.fqn} className="flex items-start justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><BookText className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />{t.name}{sys && <Lock className="h-3 w-3 text-text-quaternary" />}<span className="text-tiny text-text-quaternary">· {t.glossary}</span></span>
                  {t.definition && <span className="mt-0.5 line-clamp-1 block text-tiny text-text-tertiary">{t.definition}</span>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button onClick={() => n > 0 && onFilter({ fqn: t.fqn, label: t.name })} disabled={n === 0} className={cn('rounded px-1.5 py-0.5 text-tiny', n > 0 ? 'bg-brand/10 text-brand hover:bg-brand/20' : 'text-text-quaternary')} title="Lọc chỉ số dùng thuật ngữ này">{n} chỉ số</button>
                  {!sys && <>
                    <button onClick={() => openEdit(t)} className="p-1 text-text-quaternary hover:text-text-primary" aria-label="Sửa"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => setDelTerm(t)} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá"><Trash2 className="h-3.5 w-3.5" /></button>
                  </>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {delTerm && <ConfirmModal title="Xoá thuật ngữ?" message={<>Xoá <strong>{delTerm.name}</strong> khỏi từ điển dùng chung?</>} onConfirm={del} onClose={() => setDelTerm(null)} loading={busy} />}
    </div>
  );
}

function TagsManager({ classes, tags, usage, onChanged, onFilter }: {
  classes: Classification[]; tags: Tag[]; usage: Map<string, number>;
  onChanged: () => Promise<void>; onFilter: (ref: VocabRef) => void;
}) {
  const [addClass, setAddClass] = useState(false);
  const [cForm, setCForm] = useState({ name: '', desc: '', mx: false });
  const [busy, setBusy] = useState(false);
  const [addTagFor, setAddTagFor] = useState<string | null>(null);
  const [tagName, setTagName] = useState('');
  const [delTag, setDelTag] = useState<Tag | null>(null);
  const [delClass, setDelClass] = useState<Classification | null>(null);

  const tagsByClass = useMemo(() => {
    const m = new Map<string, Tag[]>();
    tags.forEach((t) => { const k = t.classification || ''; if (!m.has(k)) m.set(k, []); m.get(k)!.push(t); });
    return m;
  }, [tags]);

  const createClass = async () => {
    if (!cForm.name.trim()) return;
    setBusy(true);
    try { await upsertClassification({ name: cForm.name, description: cForm.desc, mutuallyExclusive: cForm.mx }); toast.success('Đã tạo phân loại', { description: cForm.name }); setAddClass(false); setCForm({ name: '', desc: '', mx: false }); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không tạo được.'); } finally { setBusy(false); }
  };
  const createTag = async (cmachine: string) => {
    if (!tagName.trim()) return;
    setBusy(true);
    try { await upsertTag({ classification: cmachine, name: tagName }); toast.success('Đã thêm tag', { description: tagName }); setAddTagFor(null); setTagName(''); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không thêm được.'); } finally { setBusy(false); }
  };
  const doDelTag = async () => {
    if (!delTag) return;
    setBusy(true);
    try { await deleteTag(delTag.fqn); toast.success('Đã xoá tag'); setDelTag(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };
  const doDelClass = async () => {
    if (!delClass) return;
    setBusy(true);
    try { await deleteClassification(delClass.fqn); toast.success('Đã xoá phân loại'); setDelClass(null); await onChanged(); }
    catch (e) { toast.error(errDetail(e) || 'Không xoá được.'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-text-tertiary">{classes.length} phân loại · {tags.length} nhãn</span>
        <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAddClass((v) => !v)}>Thêm phân loại</Button>
      </div>

      {addClass && (
        <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
          <Field label="Tên phân loại"><Input size="sm" autoFocus value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} placeholder="vd: Độ nhạy cảm" /></Field>
          <Field label="Mô tả"><Input size="sm" value={cForm.desc} onChange={(e) => setCForm({ ...cForm, desc: e.target.value })} placeholder="Nhóm nhãn này dùng để…" /></Field>
          <label className="flex items-center gap-2 text-caption text-text-secondary"><input type="checkbox" checked={cForm.mx} onChange={(e) => setCForm({ ...cForm, mx: e.target.checked })} className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" />Chọn 1 (loại trừ) — mỗi đối tượng chỉ mang 1 nhãn</label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAddClass(false)} disabled={busy}>Huỷ</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={busy || !cForm.name.trim()} onClick={createClass}>Tạo</Button>
          </div>
        </div>
      )}

      {classes.length === 0 ? (
        <p className="py-6 text-center text-caption text-text-quaternary">Chưa có phân loại nào.</p>
      ) : (
        <ul className="space-y-2">
          {classes.map((c) => {
            const sys = c.provider === 'system';
            const ctags = tagsByClass.get(c.machine_name) || [];
            return (
              <li key={c.machine_name} className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-caption font-emphasis text-text-primary"><Tags className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" /><span className="truncate">{c.name}</span>{sys && <Lock className="h-3 w-3 flex-shrink-0 text-text-quaternary" />}<ExclusivityTag mx={c.mutuallyExclusive} /></span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {!sys && <button onClick={() => { setAddTagFor(addTagFor === c.machine_name ? null : c.machine_name); setTagName(''); }} className="p-1 text-text-quaternary hover:text-text-primary" aria-label="Thêm tag" title="Thêm tag"><Plus className="h-3.5 w-3.5" /></button>}
                    {!sys && <button onClick={() => setDelClass(c)} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá phân loại"><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                </div>
                {addTagFor === c.machine_name && (
                  <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2">
                    <Input size="sm" autoFocus value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="Tên tag mới…" />
                    <Button variant="secondary" size="sm" loading={busy} disabled={busy || !tagName.trim()} onClick={() => createTag(c.machine_name)}>Thêm</Button>
                  </div>
                )}
                {ctags.length === 0 ? (
                  <p className="px-3 py-2 text-tiny text-text-quaternary">Chưa có tag.</p>
                ) : (
                  <ul className="divide-y divide-[rgb(var(--border-line))]">
                    {ctags.map((tg) => {
                      const n = usage.get(tg.fqn) || 0;
                      return (
                        <li key={tg.fqn} className="flex items-center justify-between gap-2 px-3 py-2">
                          <span className="min-w-0 truncate text-caption text-text-secondary">{tg.name}{tg.description && <span className="ml-1.5 text-tiny text-text-quaternary">{cleanDesc(tg.description)}</span>}</span>
                          <div className="flex flex-shrink-0 items-center gap-1">
                            <button onClick={() => n > 0 && onFilter({ fqn: tg.fqn, label: tg.name })} disabled={n === 0} className={cn('rounded px-1.5 py-0.5 text-tiny', n > 0 ? 'bg-info/10 text-info hover:bg-info/20' : 'text-text-quaternary')} title="Lọc chỉ số mang nhãn này">{n} chỉ số</button>
                            {!sys && <button onClick={() => setDelTag(tg)} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá tag"><Trash2 className="h-3.5 w-3.5" /></button>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {delTag && <ConfirmModal title="Xoá tag?" message={<>Xoá tag <strong>{delTag.name}</strong>?</>} onConfirm={doDelTag} onClose={() => setDelTag(null)} loading={busy} />}
      {delClass && <ConfirmModal title="Xoá phân loại?" message={<>Xoá <strong>{delClass.name}</strong> cùng toàn bộ tag bên trong?</>} onConfirm={doDelClass} onClose={() => setDelClass(null)} loading={busy} />}
    </div>
  );
}
