'use client';

/**
 * Observability — Data Quality console, built on the core list layout
 * (PageListLayout + ModuleOverview + PaginatedCollection) so it matches every
 * other module. ONE surface: a paginated dataset-health list (score · rules ·
 * pass/fail · failures flagged red). Click a dataset → set up & monitor its
 * quality rules IN-PLACE (the full DatasetQualityPanel, URL-routed). Quality is
 * the whole focus — no separate Incidents/Alerts tabs; a failing dataset is the
 * incident, and you fix it where you see it.
 */
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ShieldCheck, AlertTriangle, Plus, ChevronRight, ChevronLeft, Database, Search } from 'lucide-react';

import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { useDataset } from '@/hooks/use-datasets';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { useUrlNav } from '@/hooks/use-url-nav';
import { DatasetQualityPanel } from '@/components/datasets/DatasetQualityPanel';
import { getQualityOverview, type QualityOverview } from '@/lib/catalog';

type Selected = { id: number; name: string };

export default function ObservabilityPage() {
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">Đang tải…</div>}>
      <ObservabilityModule />
    </Suspense>
  );
}

function ObservabilityModule() {
  const nav = useUrlNav();
  const datasetParam = nav.get('dataset');
  const [overview, setOverview] = useState<QualityOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    return getQualityOverview().then(setOverview).catch(() => setOverview(null)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Drill-in is URL-driven (?dataset=<id>) so F5 / back / share work.
  const selected = useMemo<Selected | null>(() => {
    const id = datasetParam ? Number(datasetParam) : 0;
    if (!id) return null;
    const found = overview?.datasets.find((d) => d.dataset_id === id)
      ?? overview?.incidents.find((i) => i.dataset_id === id)
      ?? overview?.candidates.find((c) => c.dataset_id === id);
    return { id, name: found?.dataset ?? '' };
  }, [datasetParam, overview]);

  const open = (d: Selected) => nav.set({ dataset: String(d.id) });
  const back = () => { nav.set({ dataset: null }); reload(); };

  if (selected) {
    return (
      <DetailShell>
        <DatasetQualityDetail dataset={selected} onBack={back} />
      </DetailShell>
    );
  }
  return <HealthList overview={overview} loading={loading} onOpen={open} nav={nav} />;
}

/** Same outer chrome (padding + scroll) as PageListLayout, for full-pane detail views. */
function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col px-4 pt-6 sm:px-6 xl:px-8">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</div>
    </div>
  );
}

// ── tiny local presentational helpers ───────────────────────────────────────
function ScoreBadge({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-tiny text-text-quaternary">—</span>;
  const s = Math.round(score);
  const tone = s >= 90 ? 'bg-success/10 text-success' : s >= 70 ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger';
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-caption font-emphasis', tone)}>{s}</span>;
}

function RunPill({ status }: { status?: string | null }) {
  const s = (status || 'queued').toLowerCase();
  const map: Record<string, string> = {
    success: 'bg-success/10 text-success', completed: 'bg-success/10 text-success',
    failed: 'bg-danger/10 text-danger', error: 'bg-danger/10 text-danger',
    running: 'bg-info/10 text-info', queued: 'bg-surface-2 text-text-tertiary',
  };
  return <span className={cn('rounded-full px-2 py-0.5 text-tiny font-emphasis capitalize', map[s] ?? 'bg-surface-2 text-text-tertiary')}>{status || 'queued'}</span>;
}

// ── The dataset-health list (the whole Observability surface) ────────────────
function HealthList({ overview, loading, onOpen, nav }: {
  overview: QualityOverview | null; loading: boolean; onOpen: (d: Selected) => void; nav: ReturnType<typeof useUrlNav>;
}) {
  const [pick, setPick] = useState(false);
  const onlyIssues = nav.get('issues') === '1';
  const s = overview?.summary;
  const rows = overview?.datasets ?? [];
  const candidates = overview?.candidates ?? [];

  return (
    <>
      <PageListLayout
        title="Observability"
        description="Sức khoẻ & chất lượng dữ liệu — điểm, quy tắc và sự cố trên mọi dataset. Bấm một dataset để thiết lập & theo dõi quy tắc ngay tại chỗ."
        overview={(
          <ModuleOverview
            stats={[
              { label: 'Dataset', value: s?.datasets ?? 0, helper: 'Số dataset đang theo dõi chất lượng' },
              { label: 'Điểm TB', value: s?.avgScore != null ? s.avgScore : '—', helper: 'Điểm chất lượng trung bình' },
              { label: 'Kiểm tra đạt', value: s?.passed ?? 0, helper: 'Tổng số kiểm tra đạt ở lần chạy gần nhất' },
              { label: 'Sự cố', value: s?.incidents ?? 0, helper: 'Số kiểm tra đang thất bại' },
            ]}
          />
        )}
        action={(
          <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} disabled={!candidates.length} onClick={() => setPick(true)}>
            Thiết lập dataset
          </Button>
        )}
        isLoading={loading}
        loadingText="Đang tải…"
        searchPlaceholder="Tìm dataset, chủ sở hữu…"
        viewToggle={false}
        toolbarExtra={(
          <FilterTag tone="danger" active={onlyIssues} onClick={() => nav.set({ issues: onlyIssues ? null : '1' })}>
            <AlertTriangle className="mr-1 h-3 w-3" /> Chỉ dataset có sự cố{s?.incidents ? ` (${s.incidents})` : ''}
          </FilterTag>
        )}
      >
        {({ filterText }) => {
          const needle = filterText.trim().toLowerCase();
          const filtered = rows.filter((r) =>
            (!needle || r.dataset.toLowerCase().includes(needle) || (r.owner || '').toLowerCase().includes(needle))
            && (!onlyIssues || r.failed > 0));

          if (rows.length === 0) {
            return (
              <div className="py-16 text-center">
                <ShieldCheck className="mx-auto mb-4 h-14 w-14 text-text-quaternary" />
                <h2 className="mb-2 text-small font-strong text-text-primary">Chưa có dataset nào theo dõi chất lượng</h2>
                <p className="mb-6 text-caption text-text-tertiary">Bấm “Thiết lập dataset” để thêm quy tắc chất lượng và chạy kiểm tra đầu tiên.</p>
                <Button variant="primary" size="lg" leadingIcon={<Plus className="h-4 w-4" />} disabled={!candidates.length} onClick={() => setPick(true)}>Thiết lập dataset</Button>
              </div>
            );
          }
          if (filtered.length === 0) {
            return (
              <div className="flex h-48 flex-col items-center justify-center text-center">
                <Search className="mb-2 h-8 w-8 text-text-quaternary" />
                <p className="text-caption text-text-tertiary">{onlyIssues ? 'Không có dataset nào đang có sự cố.' : <>Không có dataset khớp “<strong className="text-text-secondary">{filterText}</strong>”</>}</p>
              </div>
            );
          }

          return (
            <PaginatedCollection items={filtered} viewMode="list" resetKey={`${filterText}|${onlyIssues}`}>
              {({ pageItems, pagination, hasFooter }) => (
                <div>
                  <div className={cn('border border-[rgb(var(--border-line))] bg-surface-1', hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl')}>
                    <div className="app-list-table-wrap">
                      <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                        <thead className="bg-surface-2"><tr>
                          <th className="app-list-header w-[34%]">Dataset</th>
                          <th className="app-list-header w-[10%]">Điểm</th>
                          <th className="app-list-header w-[12%]">Quy tắc</th>
                          <th className="app-list-header w-[20%]">Đạt / Lỗi</th>
                          <th className="app-list-header w-[16%]">Lần chạy</th>
                          <th className="app-list-header w-[64px] text-right" />
                        </tr></thead>
                        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                          {pageItems.map((r) => (
                            <tr key={r.dataset_id} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen({ id: r.dataset_id, name: r.dataset })}>
                              <td className="app-list-cell">
                                <span className="flex w-full items-start gap-3 text-left">
                                  <span className={cn('mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md', r.failed > 0 ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand')}>
                                    {r.failed > 0 ? <AlertTriangle className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                                  </span>
                                  <span className="min-w-0">
                                    <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{r.dataset}</span>
                                    <span className="app-list-text-sub mt-0.5 block text-tiny text-text-quaternary">{r.owner ? r.owner.split('@')[0] : '—'} · {r.coveredTables} bảng</span>
                                  </span>
                                </span>
                              </td>
                              <td className="app-list-cell"><ScoreBadge score={r.score} /></td>
                              <td className="app-list-cell text-caption text-text-tertiary">{r.enabledRules}/{r.totalRules}</td>
                              <td className="app-list-cell">
                                <span className="flex items-center gap-2 text-caption">
                                  <span className="text-success">{r.passed} đạt</span>
                                  <span className={r.failed > 0 ? 'font-emphasis text-danger' : 'text-text-quaternary'}>{r.failed} lỗi</span>
                                </span>
                              </td>
                              <td className="app-list-cell"><RunPill status={r.lastRunStatus} /></td>
                              <td className="app-list-cell-tight text-right"><ChevronRight className="inline h-4 w-4 text-text-quaternary" /></td>
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

      {pick && <SetupPickerModal candidates={candidates} onClose={() => setPick(false)} onPick={(c) => { setPick(false); onOpen({ id: c.dataset_id, name: c.dataset }); }} />}
    </>
  );
}

function SetupPickerModal({ candidates, onClose, onPick }: { candidates: { dataset_id: number; dataset: string }[]; onClose: () => void; onPick: (c: { dataset_id: number; dataset: string }) => void }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return candidates.filter((c) => !n || c.dataset.toLowerCase().includes(n));
  }, [candidates, q]);
  return (
    <Modal isOpen onClose={onClose} title="Thiết lập chất lượng cho dataset" size="md" footer={<Button variant="ghost" onClick={onClose}>Đóng</Button>}>
      <div className="space-y-3">
        <p className="text-caption text-text-tertiary">Chọn một dataset chưa theo dõi để thêm quy tắc chất lượng và chạy kiểm tra ngay tại đây.</p>
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm dataset…" leadingIcon={<Search />} />
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-caption text-text-quaternary">Tất cả dataset đều đã được theo dõi.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-[rgb(var(--border-line))] overflow-y-auto rounded-lg border border-[rgb(var(--border-line))]">
            {filtered.map((c) => (
              <li key={c.dataset_id}>
                <button onClick={() => onPick(c)} className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-surface-2">
                  <span className="flex items-center gap-1.5 text-caption text-text-secondary"><Database className="h-3.5 w-3.5 text-text-quaternary" />{c.dataset}</span>
                  <ChevronRight className="h-4 w-4 text-text-quaternary" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ── In-place quality manager (setup + monitor; no navigation away) ───────────
function DatasetQualityDetail({ dataset, onBack }: { dataset: Selected; onBack: () => void }) {
  const { data, isLoading } = useDataset(dataset.id);
  const canEdit = getResourcePermissions(data?.user_permission).canEdit;
  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
        <ChevronLeft className="h-3.5 w-3.5" /> Observability
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-brand" />
        <h1 className="text-h1 font-emphasis text-text-primary">{data?.name || dataset.name || 'Dataset'}</h1>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">Chất lượng dữ liệu</span>
      </div>
      {isLoading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : data ? (
        <DatasetQualityPanel datasetId={dataset.id} tables={data.tables ?? []} canEdit={canEdit} />
      ) : (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center">
          <p className="text-small font-emphasis text-text-primary">Không tải được dataset</p>
          <p className="mt-1 text-caption text-text-tertiary">Thử lại hoặc kiểm tra quyền truy cập dataset này.</p>
        </div>
      )}
    </div>
  );
}
