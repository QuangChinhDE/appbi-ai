'use client';

/**
 * Govern module — Glossary · Classification · Metrics (horizontal Tabs).
 *
 * Metrics brings OpenMetadata's metric user-flow into AppBI (adapted to the
 * "metric = dataset measure" model):
 *   • List (Name/Description/Tags/Glossary/Owners + Add Metric)  — mirrors OM list
 *   • Open a metric → detail VIEW with tabs:
 *       Overview (meta + description) · Expression (formula) · Used in (lineage:
 *       charts & dashboards using this measure)
 * Formula edit / create routes to the canonical Dataset measure editor.
 */
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { BookText, Tags, Sigma, Landmark, Search, Plus, ChevronLeft, BarChart3, LayoutDashboard, Pencil, AlertTriangle, Trash2, Library, Lock, Layers, Check } from 'lucide-react';

import { ModuleShell, EmptyState, StatusPill, type SubNavItem } from '@/components/catalog/ModuleShell';
import { Tabs } from '@/components/ui/Tabs';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Label, Select } from '@/components/ui/Input';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useUrlNav } from '@/hooks/use-url-nav';
import {
  getCatalogStatus, getMetrics, getMetricUsage, updateMetric, getMetricVariants, getVocabUsage,
  getGlossaries, listGlossaryTerms, upsertGlossary, deleteGlossary, upsertTerm, deleteTerm,
  listClassifications, getTags, upsertClassification, deleteClassification, upsertTag, deleteTag,
  type GlossaryTerm, type Glossary, type Classification, type Tag, type Metric, type MetricsLibrary, type MetricUsage, type MetricVariants,
  type VocabRef, type VocabUsage,
} from '@/lib/catalog';

function errDetail(err: unknown): string | undefined {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}

/** OM seed descriptions carry markdown/HTML (**bold**, <br/>, `code`); render them as clean text. */
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

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-tiny text-text-quaternary">{hint}</p>}
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
    <Modal isOpen onClose={onClose} title="Gán nhãn & thuật ngữ cho metric" size="lg"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Huỷ</Button>
        <Button variant="primary" onClick={submit} loading={saving}>Lưu</Button>
      </>)}>
      {loading ? (
        <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><Tags className="h-4 w-4 text-text-tertiary" />Tags ({Object.keys(selTags).length})</div>
            {tags.length === 0 ? (
              <p className="text-tiny text-text-quaternary">Chưa có tag — tạo ở tab Classification.</p>
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
            <div className="mb-2 flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><BookText className="h-4 w-4 text-text-tertiary" />Glossary Terms ({Object.keys(selTerms).length})</div>
            {terms.length === 0 ? (
              <p className="text-tiny text-text-quaternary">Chưa có thuật ngữ — tạo ở tab Glossary.</p>
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

const ITEMS: SubNavItem[] = [
  { key: 'metrics', label: 'Metrics', desc: 'Thư viện chỉ số KPI', icon: <Sigma className="h-4 w-4" /> },
  { key: 'glossary', label: 'Glossary', desc: 'Định nghĩa nghiệp vụ', icon: <BookText className="h-4 w-4" /> },
  { key: 'classification', label: 'Classification', desc: 'Nhãn & phân loại', icon: <Tags className="h-4 w-4" /> },
];

export default function GovernPage() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">Đang tải…</div>}>
      <GovernModule />
    </Suspense>
  );
}

function GovernModule() {
  const nav = useUrlNav();
  const active = nav.get('tab') || 'metrics';
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => { getCatalogStatus().then((s) => setConnected(s.connected)).catch(() => setConnected(false)); }, []);
  return (
    <ModuleShell title="Govern" icon={<Landmark className="h-4 w-4" />} items={ITEMS} active={active}
      onSelect={(k) => nav.set({ tab: k, m: null, term: null, cls: null })} connected={connected}>
      {active === 'metrics' && <MetricsPanel />}
      {active === 'glossary' && <GlossaryPanel />}
      {active === 'classification' && <ClassificationPanel />}
    </ModuleShell>
  );
}

const TYPE_TONE: Record<string, 'brand' | 'info' | 'success' | 'warning' | 'neutral'> = {
  sum: 'brand', avg: 'brand', average: 'brand', min: 'info', max: 'info',
  count: 'success', count_distinct: 'success', percent_of_total: 'warning', formula: 'warning', window: 'warning',
};

function MetricsPanel() {
  const router = useRouter();
  const [lib, setLib] = useState<MetricsLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const nav = useUrlNav();
  const [picked, setPicked] = useState<Metric | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [onlyConflict, setOnlyConflict] = useState(false);

  useEffect(() => {
    let on = true;
    getMetrics()
      .then((d) => on && setLib(d))
      .catch(() => on && setLib({ metrics: [], total: 0, datasets: 0, conflicts: 0 }))
      .finally(() => on && setLoading(false));
    return () => { on = false; };
  }, []);

  const metrics = lib?.metrics ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return metrics.filter((m) => {
      const match = !needle
        || m.label.toLowerCase().includes(needle)
        || m.name.toLowerCase().includes(needle)
        || (m.dataset || '').toLowerCase().includes(needle);
      return match && (!onlyConflict || m.conflict);
    });
  }, [metrics, q, onlyConflict]);

  const mKey = nav.get('m');
  const selected = picked ?? (mKey ? metrics.find((m) => `${m.view_id}.${m.name}` === mKey) ?? null : null);
  if (selected) return <MetricDetail key={`${selected.view_id}.${selected.name}`} metric={selected} onBack={() => { setPicked(null); nav.set({ m: null }); }} />;

  return (
    <div className="space-y-4 pb-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-emphasis text-text-primary">Metrics</h1>
          <p className="mt-1 max-w-2xl text-caption text-text-tertiary">
            Thư viện chỉ số KPI dùng chung — định nghĩa từ dataset, một measure dùng nhất quán mọi nơi.
          </p>
        </div>
        <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setShowAdd(true)}>Add Metric</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[240px] max-w-md flex-[0_0_320px]">
          <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm metric, dataset…" leadingIcon={<Search />} />
        </div>
        {!!lib?.conflicts && (
          <FilterTag tone="warning" active={onlyConflict} onClick={() => setOnlyConflict(!onlyConflict)}>
            <AlertTriangle className="mr-1 h-3 w-3" /> {lib.conflicts} tên xung đột định nghĩa
          </FilterTag>
        )}
      </div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : filtered.length === 0 ? (
        <EmptyState title="Chưa có metric nào" hint="Tạo measure trong dataset để chúng xuất hiện ở thư viện KPI này." />
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="app-list-table-wrap">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2">
                <tr>
                  <th className="app-list-header w-[28%]">Name</th>
                  <th className="app-list-header w-[30%]">Description</th>
                  <th className="app-list-header w-[12%]">Tags</th>
                  <th className="app-list-header w-[15%]">Glossary Terms</th>
                  <th className="app-list-header w-[15%]">Owners</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {filtered.map((m, i) => (
                  <tr key={`${m.dataset}.${m.name}.${i}`} className="cursor-pointer hover:bg-surface-2" onClick={() => { setPicked(m); nav.set({ m: `${m.view_id}.${m.name}` }); }}>
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
                        : <code className="font-mono text-tiny text-text-tertiary">{m.definition || '—'}</code>}
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
      )}

      {showAdd && (
        <Modal isOpen onClose={() => setShowAdd(false)} title="Thêm Metric" size="sm"
          footer={(<>
            <Button variant="ghost" onClick={() => setShowAdd(false)}>Đóng</Button>
            <Button variant="primary" onClick={() => router.push('/datasets')}>Mở Datasets</Button>
          </>)}>
          <p className="text-caption text-text-secondary">
            Metric trong AppBI là <strong className="text-text-primary">measure</strong> định nghĩa bên trong một Dataset. Mở Dataset, thêm
            measure (SUM/COUNT/công thức…) — nó sẽ tự xuất hiện trong thư viện này.
          </p>
        </Modal>
      )}
    </div>
  );
}

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
      toast.success('Đã lưu metric', { description: form.label });
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail || 'Không lưu được. Bạn cần quyền edit dataset này.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
        <ChevronLeft className="h-3.5 w-3.5" /> Metrics
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
          { key: 'overview', label: 'Overview' },
          { key: 'expression', label: 'Expression' },
          { key: 'usage', label: 'Used in', badge: usage ? <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-tiny text-text-tertiary">{usage.chartCount + usage.dashboardCount}</span> : undefined },
          ...(m.variants && m.variants > 1
            ? [{ key: 'variants', label: 'Trùng tên', badge: <span className={cn('ml-1 rounded-full px-1.5 text-tiny', m.conflict ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-text-tertiary')}>{m.variants}</span> }]
            : []),
        ]}
      />

      {tab === 'overview' && !editing && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Description</div>
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
              <div className="mb-1.5 flex items-center gap-1 text-tiny text-text-quaternary"><Tags className="h-3 w-3" /> Tags (Classification)</div>
              <VocabChips items={m.tags} tone="info" empty="Chưa gán" />
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-1 text-tiny text-text-quaternary"><BookText className="h-3 w-3" /> Glossary Terms</div>
              <VocabChips items={m.glossaryTerms} tone="brand" empty="Chưa gán" />
            </div>
          </div>
          <p className="mt-3 text-tiny text-text-quaternary">Gắn thuật ngữ nghiệp vụ + nhãn phân loại để metric có ngữ cảnh chung — và tra ngược "đang dùng ở đâu" từ Glossary.</p>
        </div>
      )}

      {assignOpen && (
        <AssignVocabModal
          currentTerms={m.glossaryTerms || []}
          currentTags={m.tags || []}
          onClose={() => setAssignOpen(false)}
          onSave={async (terms, tags) => {
            if (!m.view_id) { toast.error('Metric này không sửa được nhãn.'); return; }
            await updateMetric({ view_id: m.view_id, name: m.name, glossary_terms: terms, tags });
            setM({ ...m, glossaryTerms: terms, tags });
            setAssignOpen(false);
            toast.success('Đã cập nhật nhãn & thuật ngữ');
          }}
        />
      )}

      {tab === 'overview' && editing && (
        <div className="space-y-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="flex flex-col gap-1.5">
            <Label>Display Name</Label>
            <Input size="sm" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Description</Label>
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Mô tả nghiệp vụ của metric…" />
          </div>
          <p className="text-tiny text-text-quaternary">Chỉ sửa tên hiển thị + mô tả — KHÔNG đụng công thức/type/format (lấy từ measure). Lưu qua đường validate của Dataset, cập nhật cho mọi nơi + mọi user dùng metric này.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Huỷ</Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={saving || !form.label.trim()}>Lưu</Button>
          </div>
        </div>
      )}

      {tab === 'expression' && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-2 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Expression ({m.type})</div>
          <pre className="overflow-x-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3 font-mono text-tiny text-text-secondary">{m.definition || '—'}</pre>
          <p className="mt-2 text-tiny text-text-quaternary">Công thức sửa ở Dataset (đường validate) — bấm "Sửa công thức trong Dataset" ở trên.</p>
        </div>
      )}

      {tab === 'usage' && (
        <div className="space-y-4">
          {!usage ? (
            <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
          ) : usage.chartCount === 0 && usage.dashboardCount === 0 ? (
            <EmptyState title="Chưa dùng ở đâu" hint="Measure này chưa được dùng trong chart/dashboard nào (hoặc tham chiếu gián tiếp)." />
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
                  <><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Cùng nguồn <code className="font-mono">{m.source}</code> nhưng có <strong>{m.distinctDefs} định nghĩa KHÁC nhau</strong> cho "{m.name}" — cần rà & thống nhất về 1 định nghĩa chuẩn.</>
                ) : variants.count > 1 ? (
                  <>Cùng tên ở {variants.count} nơi nhưng <strong>khác nguồn</strong> → là các metric độc lập, không xung đột.</>
                ) : (
                  <>Chỉ 1 nơi định nghĩa metric này.</>
                )}
              </div>
              <p className="text-tiny text-text-quaternary">Hàng tô vàng = cùng nguồn với metric đang xem (chỗ thực sự phải thống nhất). Bấm 1 hàng để mở dataset đó.</p>
              <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
                <div className="app-list-table-wrap">
                  <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                    <thead className="bg-surface-2"><tr>
                      <th className="app-list-header w-[20%]">Dataset</th>
                      <th className="app-list-header w-[14%]">Source</th>
                      <th className="app-list-header w-[12%]">Owner</th>
                      <th className="app-list-header w-[8%]">Type</th>
                      <th className="app-list-header">Definition</th>
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

// ════════════════════════ GLOSSARY ════════════════════════════════════════
// OM flow: a Glossary (container) holds Terms. We surface terms as the primary
// objects (chips filter by glossary) + master→detail edit, mirroring Metrics.
function GlossaryPanel() {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [glossaries, setGlossaries] = useState<Glossary[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [glossaryFilter, setGlossaryFilter] = useState('');
  const nav = useUrlNav();
  const [picked, setPicked] = useState<GlossaryTerm | null>(null);
  const [addTerm, setAddTerm] = useState(false);
  const [addGloss, setAddGloss] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [g, t] = await Promise.all([getGlossaries(), listGlossaryTerms()]);
      setGlossaries(g); setTerms(t);
    } catch { setGlossaries([]); setTerms([]); } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return terms.filter((t) => {
      const inGloss = !glossaryFilter || t.glossaryFqn === glossaryFilter;
      const match = !needle || t.name.toLowerCase().includes(needle)
        || (t.definition || '').toLowerCase().includes(needle)
        || (t.synonyms || []).some((s) => s.toLowerCase().includes(needle));
      return inGloss && match;
    });
  }, [terms, q, glossaryFilter]);

  const termKey = nav.get('term');
  const selected = picked ?? (termKey ? terms.find((t) => t.fqn === termKey) ?? null : null);
  if (selected) {
    const back = () => { setPicked(null); nav.set({ term: null }); };
    return <TermDetail key={selected.fqn} term={selected} onBack={back}
      onChanged={reload} onDeleted={async () => { back(); await reload(); }} />;
  }

  const hasGloss = glossaries.length > 0;
  return (
    <div className="space-y-4 pb-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-emphasis text-text-primary">Glossary</h1>
          <p className="mt-1 max-w-2xl text-caption text-text-tertiary">
            Từ điển nghiệp vụ dùng chung — định nghĩa thuật ngữ một lần để cả tổ chức hiểu & dùng giống nhau.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" leadingIcon={<Library className="h-4 w-4" />} onClick={() => setAddGloss(true)}>Bộ thuật ngữ</Button>
          <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} disabled={!hasGloss} onClick={() => setAddTerm(true)}>Add Term</Button>
        </div>
      </div>

      {hasGloss && (
        <div className="flex flex-wrap items-center gap-2">
          <FilterTag tone="neutral" active={glossaryFilter === ''} onClick={() => setGlossaryFilter('')}>Tất cả ({terms.length})</FilterTag>
          {glossaries.map((g) => (
            <FilterTag key={g.machine_name} tone="brand" active={glossaryFilter === g.machine_name} onClick={() => setGlossaryFilter(g.machine_name)}>
              {g.name} ({g.termCount})
            </FilterTag>
          ))}
        </div>
      )}

      <div className="min-w-[240px] max-w-md">
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm thuật ngữ, định nghĩa…" leadingIcon={<Search />} />
      </div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : !hasGloss ? (
        <EmptyState title="Chưa có bộ thuật ngữ" hint='Tạo một "Bộ thuật ngữ" trước (vd "Nghiệp vụ bán hàng"), rồi thêm các thuật ngữ vào.' />
      ) : filtered.length === 0 ? (
        <EmptyState title="Chưa có thuật ngữ nào" hint="Bấm Add Term để thêm định nghĩa nghiệp vụ đầu tiên." />
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="app-list-table-wrap">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2"><tr>
                <th className="app-list-header w-[26%]">Term</th>
                <th className="app-list-header w-[34%]">Definition</th>
                <th className="app-list-header w-[20%]">Synonyms</th>
                <th className="app-list-header w-[12%]">Glossary</th>
                <th className="app-list-header w-[8%]">Status</th>
              </tr></thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {filtered.map((t) => (
                  <tr key={t.fqn} className="cursor-pointer hover:bg-surface-2" onClick={() => { setPicked(t); nav.set({ term: t.fqn }); }}>
                    <td className="app-list-cell">
                      <span className="app-list-text-main flex items-center gap-1.5 text-caption font-emphasis text-text-primary hover:text-brand">
                        <BookText className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />{t.name}
                        {t.provider === 'system' && <Lock className="h-3 w-3 text-text-quaternary" />}
                      </span>
                    </td>
                    <td className="app-list-cell"><span className="line-clamp-2 text-caption text-text-secondary">{t.definition || '—'}</span></td>
                    <td className="app-list-cell">
                      {t.synonyms?.length ? (
                        <span className="flex flex-wrap gap-1">
                          {t.synonyms.slice(0, 3).map((s) => <span key={s} className="rounded bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">{s}</span>)}
                          {t.synonyms.length > 3 && <span className="text-tiny text-text-quaternary">+{t.synonyms.length - 3}</span>}
                        </span>
                      ) : <span className="text-tiny text-text-quaternary">—</span>}
                    </td>
                    <td className="app-list-cell text-caption text-text-tertiary">{t.glossary || '—'}</td>
                    <td className="app-list-cell"><StatusPill status={(t.status as string) || 'draft'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {addGloss && <GlossaryManagerModal glossaries={glossaries} onClose={() => setAddGloss(false)} onChanged={reload} />}
      {addTerm && <TermFormModal glossaries={glossaries} defaultGlossary={glossaryFilter || glossaries[0]?.machine_name} onClose={() => setAddTerm(false)} onSaved={async () => { setAddTerm(false); await reload(); }} />}
    </div>
  );
}

function TermDetail({ term, onBack, onChanged, onDeleted }: { term: GlossaryTerm; onBack: () => void; onChanged: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const [t, setT] = useState(term);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [form, setForm] = useState({ name: term.name, description: term.definition || '', synonyms: (term.synonyms || []).join(', ') });
  const [usage, setUsage] = useState<VocabUsage | null>(null);
  const nav = useUrlNav();
  const system = t.provider === 'system';
  const syns = (t.synonyms || []);

  useEffect(() => {
    let on = true;
    getVocabUsage(term.fqn).then((u) => on && setUsage(u)).catch(() => on && setUsage(null));
    return () => { on = false; };
  }, [term.fqn]);

  const save = async () => {
    if (!t.glossaryFqn) return;
    setSaving(true);
    const synonyms = form.synonyms.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await upsertTerm({ glossary: t.glossaryFqn, machine_name: t.machine_name, name: form.name, description: form.description, synonyms });
      setT({ ...t, name: form.name, definition: form.description || null, synonyms });
      setEditing(false);
      toast.success('Đã lưu thuật ngữ', { description: form.name });
      await onChanged();
    } catch (err) { toast.error(errDetail(err) || 'Không lưu được thuật ngữ.'); } finally { setSaving(false); }
  };
  const del = async () => {
    setSaving(true);
    try { await deleteTerm(t.fqn); toast.success('Đã xoá thuật ngữ', { description: t.name }); await onDeleted(); }
    catch (err) { toast.error(errDetail(err) || 'Không xoá được.'); setSaving(false); setConfirmDel(false); }
  };

  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
        <ChevronLeft className="h-3.5 w-3.5" /> Glossary
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-h1 font-emphasis text-text-primary">{t.name}</h1>
            <StatusPill status={t.status || 'draft'} />
            {system && <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary"><Lock className="h-3 w-3" />Hệ thống</span>}
          </div>
          <p className="mt-0.5 text-caption text-text-tertiary">
            <code className="font-mono">{t.machine_name}</code>
            {t.glossary && <span className="text-text-quaternary"> · {t.glossary}</span>}
          </p>
        </div>
        {!system && (
          <div className="flex flex-shrink-0 items-center gap-2">
            {!editing && <Button variant="secondary" size="sm" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setForm({ name: t.name, description: t.definition || '', synonyms: syns.join(', ') }); setEditing(true); }}>Sửa</Button>}
            {!editing && <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10" leadingIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDel(true)}>Xoá</Button>}
          </div>
        )}
      </div>

      {!editing ? (
        <>
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
            <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Định nghĩa</div>
            <p className="text-caption text-text-secondary">{t.definition || 'Chưa có định nghĩa. Bấm Sửa để thêm.'}</p>
          </div>
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
            <div className="mb-2 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Từ đồng nghĩa</div>
            {syns.length ? (
              <span className="flex flex-wrap gap-1.5">{syns.map((s) => <span key={s} className="rounded-md bg-surface-2 px-2 py-0.5 text-caption text-text-secondary">{s}</span>)}</span>
            ) : <p className="text-caption text-text-quaternary">Chưa có từ đồng nghĩa.</p>}
          </div>
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
            <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-2.5 text-caption font-emphasis text-text-primary">
              <Sigma className="h-4 w-4 text-text-tertiary" />Metrics đang dùng thuật ngữ này
              <span className="rounded-full bg-surface-2 px-1.5 text-tiny text-text-tertiary">{usage?.count ?? '…'}</span>
            </div>
            {!usage ? (
              <p className="py-6 text-center text-caption text-text-tertiary">Đang tải…</p>
            ) : usage.count === 0 ? (
              <p className="px-4 py-6 text-caption text-text-quaternary">Chưa metric nào gắn thuật ngữ này. Mở một metric → “Gán” để liên kết.</p>
            ) : (
              <ul className="divide-y divide-[rgb(var(--border-line))]">
                {usage.metrics.map((mu, i) => (
                  <li key={`${mu.view_id}.${mu.name}.${i}`}>
                    <button onClick={() => mu.view_id && nav.set({ tab: 'metrics', term: null, m: `${mu.view_id}.${mu.name}` })}
                      className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-surface-2">
                      <span className="flex items-center gap-1.5 text-caption text-text-secondary hover:text-brand"><Sigma className="h-3.5 w-3.5 text-text-quaternary" />{mu.label}</span>
                      <span className="text-tiny text-text-quaternary">{mu.dataset || ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <Field label="Tên thuật ngữ"><Input size="sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Định nghĩa"><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Định nghĩa nghiệp vụ rõ ràng…" /></Field>
          <Field label="Từ đồng nghĩa" hint="Phân tách bằng dấu phẩy"><Input size="sm" value={form.synonyms} onChange={(e) => setForm({ ...form, synonyms: e.target.value })} placeholder="active user, KH active" /></Field>
          <p className="text-tiny text-text-quaternary">Lưu vào catalog dùng chung — mọi người tra cứu cùng một định nghĩa.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Huỷ</Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={saving || !form.name.trim()}>Lưu</Button>
          </div>
        </div>
      )}

      {confirmDel && <ConfirmModal title="Xoá thuật ngữ?" message={<>Xoá <strong>{t.name}</strong> khỏi catalog dùng chung. Không thể hoàn tác.</>} onConfirm={del} onClose={() => setConfirmDel(false)} loading={saving} />}
    </div>
  );
}

function GlossaryManagerModal({ glossaries, onClose, onChanged }: { glossaries: Glossary[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [creating, setCreating] = useState(glossaries.length === 0);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [eForm, setEForm] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [pendingDel, setPendingDel] = useState<Glossary | null>(null);

  const create = async () => {
    setBusy(true);
    try { await upsertGlossary({ name, description: desc }); setName(''); setDesc(''); setCreating(false); toast.success('Đã tạo bộ thuật ngữ', { description: name }); await onChanged(); }
    catch (err) { toast.error(errDetail(err) || 'Không tạo được.'); } finally { setBusy(false); }
  };
  const saveEdit = async (g: Glossary) => {
    setBusy(true);
    try { await upsertGlossary({ machine_name: g.machine_name, name: eForm.name, description: eForm.description }); setEditing(null); toast.success('Đã lưu'); await onChanged(); }
    catch (err) { toast.error(errDetail(err) || 'Không lưu được.'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!pendingDel) return;
    setBusy(true);
    try { await deleteGlossary(pendingDel.fqn); setPendingDel(null); toast.success('Đã xoá bộ thuật ngữ'); await onChanged(); }
    catch (err) { toast.error(errDetail(err) || 'Không xoá được.'); } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title="Bộ thuật ngữ" size="md" footer={<Button variant="ghost" onClick={onClose}>Đóng</Button>}>
      <div className="space-y-3">
        <p className="text-caption text-text-tertiary">Bộ thuật ngữ gom các thuật ngữ theo lĩnh vực (vd Bán hàng, Tài chính).</p>
        {glossaries.length > 0 && (
          <ul className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
            {glossaries.map((g) => (
              <li key={g.machine_name} className="px-3 py-2.5">
                {editing === g.machine_name ? (
                  <div className="space-y-2">
                    <Input size="sm" value={eForm.name} onChange={(e) => setEForm({ ...eForm, name: e.target.value })} />
                    <Textarea rows={2} value={eForm.description} onChange={(e) => setEForm({ ...eForm, description: e.target.value })} placeholder="Mô tả" />
                    <div className="flex justify-end gap-2">
                      <Button size="xs" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Huỷ</Button>
                      <Button size="xs" variant="primary" loading={busy} onClick={() => saveEdit(g)} disabled={busy || !eForm.name.trim()}>Lưu</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary">
                        <Library className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />{g.name}
                        {g.provider === 'system' && <Lock className="h-3 w-3 text-text-quaternary" />}
                      </span>
                      {g.description && <span className="mt-0.5 line-clamp-1 block text-tiny text-text-tertiary">{g.description}</span>}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <span className="text-tiny text-text-quaternary">{g.termCount} thuật ngữ</span>
                      {g.provider !== 'system' && (
                        <>
                          <button onClick={() => { setEditing(g.machine_name); setEForm({ name: g.name, description: g.description || '' }); }} className="p-1 text-text-quaternary hover:text-text-primary" aria-label="Sửa"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => setPendingDel(g)} className="p-1 text-text-quaternary hover:text-danger" aria-label="Xoá"><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {creating ? (
          <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
            <Input size="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Nghiệp vụ bán hàng" />
            <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Mô tả (tuỳ chọn)" />
            <div className="flex justify-end gap-2">
              <Button size="xs" variant="ghost" onClick={() => setCreating(false)} disabled={busy}>Huỷ</Button>
              <Button size="xs" variant="primary" loading={busy} onClick={create} disabled={busy || !name.trim()}>Tạo</Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>Tạo bộ thuật ngữ mới</Button>
        )}
      </div>
      {pendingDel && <ConfirmModal title="Xoá bộ thuật ngữ?" message={<>Xoá <strong>{pendingDel.name}</strong>{pendingDel.termCount > 0 ? ` cùng ${pendingDel.termCount} thuật ngữ bên trong` : ''}. Không thể hoàn tác.</>} onConfirm={del} onClose={() => setPendingDel(null)} loading={busy} />}
    </Modal>
  );
}

function TermFormModal({ glossaries, defaultGlossary, onClose, onSaved }: { glossaries: Glossary[]; defaultGlossary?: string; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [glossary, setGlossary] = useState(defaultGlossary || glossaries[0]?.machine_name || '');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [syn, setSyn] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      await upsertTerm({ glossary, name, description: desc, synonyms: syn.split(',').map((s) => s.trim()).filter(Boolean) });
      toast.success('Đã thêm thuật ngữ', { description: name }); await onSaved();
    } catch (err) { toast.error(errDetail(err) || 'Không lưu được.'); setSaving(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Thêm thuật ngữ" size="sm"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Huỷ</Button>
        <Button variant="primary" onClick={submit} loading={saving} disabled={saving || !name.trim() || !glossary}>Lưu</Button>
      </>)}>
      <div className="space-y-3">
        <Field label="Bộ thuật ngữ"><Select size="sm" value={glossary} onChange={(e) => setGlossary(e.target.value)}>{glossaries.map((g) => <option key={g.machine_name} value={g.machine_name}>{g.name}</option>)}</Select></Field>
        <Field label="Tên thuật ngữ"><Input size="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Khách hàng hoạt động" /></Field>
        <Field label="Định nghĩa"><Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Định nghĩa nghiệp vụ rõ ràng…" /></Field>
        <Field label="Từ đồng nghĩa" hint="Phân tách bằng dấu phẩy"><Input size="sm" value={syn} onChange={(e) => setSyn(e.target.value)} placeholder="active user, KH active" /></Field>
      </div>
    </Modal>
  );
}

// ════════════════════════ CLASSIFICATION ══════════════════════════════════
function ExclusivityTag({ mx }: { mx: boolean }) {
  return mx
    ? <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-tiny text-info"><Layers className="h-3 w-3" />Chọn 1 (loại trừ)</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary"><Tags className="h-3 w-3" />Chọn nhiều</span>;
}

function ClassificationPanel() {
  const [items, setItems] = useState<Classification[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const nav = useUrlNav();
  const [picked, setPicked] = useState<Classification | null>(null);
  const [addClass, setAddClass] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setItems(await listClassifications()); } catch { setItems([]); } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return items.filter((c) => !n || c.name.toLowerCase().includes(n) || (c.description || '').toLowerCase().includes(n));
  }, [items, q]);

  const clsKey = nav.get('cls');
  const selected = picked ?? (clsKey ? items.find((c) => c.machine_name === clsKey) ?? null : null);
  if (selected) {
    const back = () => { setPicked(null); nav.set({ cls: null }); };
    return <ClassificationDetail key={selected.machine_name} cls={selected} onBack={back}
      onChanged={reload} onDeleted={async () => { back(); await reload(); }} />;
  }

  return (
    <div className="space-y-4 pb-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-emphasis text-text-primary">Classification</h1>
          <p className="mt-1 max-w-2xl text-caption text-text-tertiary">
            Nhãn phân loại dữ liệu — gom thành nhóm (vd PII, Tier) để gắn nhãn bảng/cột/metric một cách nhất quán.
          </p>
        </div>
        <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setAddClass(true)}>Add Classification</Button>
      </div>
      <div className="min-w-[240px] max-w-md"><Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm phân loại…" leadingIcon={<Search />} /></div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : filtered.length === 0 ? (
        <EmptyState title="Chưa có phân loại nào" hint="Bấm Add Classification để tạo nhóm nhãn đầu tiên." />
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="app-list-table-wrap">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2"><tr>
                <th className="app-list-header w-[28%]">Classification</th>
                <th className="app-list-header w-[36%]">Description</th>
                <th className="app-list-header w-[22%]">Type</th>
                <th className="app-list-header w-[14%]">Tags</th>
              </tr></thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {filtered.map((c) => (
                  <tr key={c.machine_name} className="cursor-pointer hover:bg-surface-2" onClick={() => { setPicked(c); nav.set({ cls: c.machine_name }); }}>
                    <td className="app-list-cell">
                      <span className="app-list-text-main flex items-center gap-1.5 text-caption font-emphasis text-text-primary hover:text-brand">
                        <Tags className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />{c.name}
                        {c.provider === 'system' && <Lock className="h-3 w-3 text-text-quaternary" />}
                      </span>
                    </td>
                    <td className="app-list-cell"><span className="line-clamp-2 text-caption text-text-secondary">{cleanDesc(c.description) || '—'}</span></td>
                    <td className="app-list-cell"><ExclusivityTag mx={c.mutuallyExclusive} /></td>
                    <td className="app-list-cell text-caption text-text-tertiary">{c.termCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {addClass && <ClassificationFormModal onClose={() => setAddClass(false)} onSaved={async () => { setAddClass(false); await reload(); }} />}
    </div>
  );
}

function ClassificationDetail({ cls, onBack, onChanged, onDeleted }: { cls: Classification; onBack: () => void; onChanged: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const [c, setC] = useState(cls);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loadingTags, setLoadingTags] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: cls.name, description: cls.description || '' });
  const [addTag, setAddTag] = useState(false);
  const [confirmDelClass, setConfirmDelClass] = useState(false);
  const [pendingTag, setPendingTag] = useState<Tag | null>(null);
  const [delingTag, setDelingTag] = useState(false);
  const system = c.provider === 'system';

  const reloadTags = useCallback(async () => {
    setLoadingTags(true);
    try { setTags(await getTags(c.machine_name)); } catch { setTags([]); } finally { setLoadingTags(false); }
  }, [c.machine_name]);
  useEffect(() => { reloadTags(); }, [reloadTags]);

  const saveClass = async () => {
    setSaving(true);
    try {
      await upsertClassification({ machine_name: c.machine_name, name: form.name, description: form.description, mutuallyExclusive: c.mutuallyExclusive });
      setC({ ...c, name: form.name, description: form.description || null });
      setEditing(false);
      toast.success('Đã lưu phân loại', { description: form.name });
      await onChanged();
    } catch (err) { toast.error(errDetail(err) || 'Không lưu được.'); } finally { setSaving(false); }
  };
  const delClass = async () => {
    setSaving(true);
    try { await deleteClassification(c.fqn); toast.success('Đã xoá phân loại', { description: c.name }); await onDeleted(); }
    catch (err) { toast.error(errDetail(err) || 'Không xoá được.'); setSaving(false); setConfirmDelClass(false); }
  };
  const delTag = async () => {
    if (!pendingTag) return;
    setDelingTag(true);
    try { await deleteTag(pendingTag.fqn); toast.success('Đã xoá tag', { description: pendingTag.name }); setPendingTag(null); await reloadTags(); await onChanged(); }
    catch (err) { toast.error(errDetail(err) || 'Không xoá được.'); } finally { setDelingTag(false); }
  };

  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
        <ChevronLeft className="h-3.5 w-3.5" /> Classification
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-h1 font-emphasis text-text-primary">{c.name}</h1>
            <ExclusivityTag mx={c.mutuallyExclusive} />
            {system && <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary"><Lock className="h-3 w-3" />Hệ thống</span>}
          </div>
          <p className="mt-0.5 text-caption text-text-tertiary"><code className="font-mono">{c.machine_name}</code> · {loadingTags ? c.termCount : tags.length} tag</p>
        </div>
        {!system && (
          <div className="flex flex-shrink-0 items-center gap-2">
            {!editing && <Button variant="secondary" size="sm" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setForm({ name: c.name, description: c.description || '' }); setEditing(true); }}>Sửa</Button>}
            {!editing && <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10" leadingIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDelClass(true)}>Xoá</Button>}
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <Field label="Tên phân loại"><Input size="sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Mô tả"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Huỷ</Button>
            <Button variant="primary" size="sm" onClick={saveClass} loading={saving} disabled={saving || !form.name.trim()}>Lưu</Button>
          </div>
        </div>
      ) : c.description ? (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Mô tả</div>
          <p className="text-caption text-text-secondary">{cleanDesc(c.description)}</p>
        </div>
      ) : null}

      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-4 py-2.5">
          <span className="flex items-center gap-2 text-caption font-emphasis text-text-primary"><Tags className="h-4 w-4 text-text-tertiary" />Tags ({tags.length})</span>
          {!system && <Button variant="secondary" size="xs" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAddTag(true)}>Add Tag</Button>}
        </div>
        {loadingTags ? (
          <p className="py-8 text-center text-caption text-text-tertiary">Đang tải…</p>
        ) : tags.length === 0 ? (
          <p className="py-8 text-center text-caption text-text-quaternary">Chưa có tag nào trong phân loại này.</p>
        ) : (
          <ul className="divide-y divide-[rgb(var(--border-line))]">
            {tags.map((tag) => (
              <li key={tag.fqn} className="group flex items-center justify-between px-4 py-2.5 hover:bg-surface-2">
                <div className="min-w-0">
                  <span className="text-caption font-emphasis text-text-primary">{tag.name}</span>
                  {tag.description && <span className="ml-2 text-caption text-text-tertiary">{cleanDesc(tag.description)}</span>}
                  <code className="ml-2 font-mono text-tiny text-text-quaternary">{c.machine_name}.{tag.machine_name}</code>
                </div>
                {!system && (
                  <button onClick={() => setPendingTag(tag)} className="flex-shrink-0 p-1 text-text-quaternary hover:text-danger" aria-label="Xoá tag">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {system && <p className="text-tiny text-text-quaternary">Phân loại hệ thống của OpenMetadata — chỉ đọc. Tạo phân loại riêng để tự quản lý.</p>}

      {addTag && <TagFormModal classification={c.machine_name} onClose={() => setAddTag(false)} onSaved={async () => { setAddTag(false); await reloadTags(); await onChanged(); }} />}
      {confirmDelClass && <ConfirmModal title="Xoá phân loại?" message={<>Xoá <strong>{c.name}</strong> cùng toàn bộ {c.termCount} tag bên trong. Không thể hoàn tác.</>} onConfirm={delClass} onClose={() => setConfirmDelClass(false)} loading={saving} />}
      {pendingTag && <ConfirmModal title="Xoá tag?" message={<>Xoá tag <strong>{pendingTag.name}</strong>.</>} onConfirm={delTag} onClose={() => setPendingTag(null)} loading={delingTag} />}
    </div>
  );
}

function ClassificationFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [mx, setMx] = useState(false);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try { await upsertClassification({ name, description: desc, mutuallyExclusive: mx }); toast.success('Đã tạo phân loại', { description: name }); await onSaved(); }
    catch (err) { toast.error(errDetail(err) || 'Không tạo được.'); setSaving(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Phân loại mới" size="sm"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Huỷ</Button>
        <Button variant="primary" onClick={submit} loading={saving} disabled={saving || !name.trim()}>Tạo</Button>
      </>)}>
      <div className="space-y-3">
        <Field label="Tên phân loại"><Input size="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Độ nhạy cảm" /></Field>
        <Field label="Mô tả"><Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Nhóm nhãn này dùng để…" /></Field>
        <div className="flex flex-col gap-1.5">
          <Label>Kiểu gắn nhãn</Label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMx(false)} className={cn('flex flex-col gap-1 rounded-lg border p-3 text-left transition', !mx ? 'border-brand bg-brand/5' : 'border-[rgb(var(--border-line))] hover:bg-surface-2')}>
              <span className={cn('flex items-center gap-1.5 text-caption font-emphasis', !mx ? 'text-brand' : 'text-text-primary')}><Tags className="h-3.5 w-3.5" />Chọn nhiều</span>
              <span className="text-tiny text-text-tertiary">Một đối tượng có thể mang nhiều nhãn cùng lúc.</span>
            </button>
            <button type="button" onClick={() => setMx(true)} className={cn('flex flex-col gap-1 rounded-lg border p-3 text-left transition', mx ? 'border-brand bg-brand/5' : 'border-[rgb(var(--border-line))] hover:bg-surface-2')}>
              <span className={cn('flex items-center gap-1.5 text-caption font-emphasis', mx ? 'text-brand' : 'text-text-primary')}><Layers className="h-3.5 w-3.5" />Chọn 1 (loại trừ)</span>
              <span className="text-tiny text-text-tertiary">Mỗi đối tượng chỉ thuộc 1 nhãn — vd Tier1 hoặc Tier2.</span>
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function TagFormModal({ classification, onClose, onSaved }: { classification: string; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try { await upsertTag({ classification, name, description: desc }); toast.success('Đã thêm tag', { description: name }); await onSaved(); }
    catch (err) { toast.error(errDetail(err) || 'Không lưu được.'); setSaving(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Thêm Tag" size="sm"
      footer={(<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Huỷ</Button>
        <Button variant="primary" onClick={submit} loading={saving} disabled={saving || !name.trim()}>Lưu</Button>
      </>)}>
      <div className="space-y-3">
        <Field label="Tên tag"><Input size="sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Nhạy cảm" /></Field>
        <Field label="Mô tả"><Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Tag này nghĩa là…" /></Field>
      </div>
    </Modal>
  );
}
