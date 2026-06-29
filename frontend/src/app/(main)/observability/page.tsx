'use client';

/**
 * Observability module — Data Quality · Incident Manager · Alerts (horizontal Tabs).
 *
 * Data Quality + Incident Manager surface AppBI's OWN dataset quality engine
 * (rules run against live data), aggregated org-wide & permission-aware — the
 * official home for quality (the per-dataset Quality tab is retired).
 *
 * Quality MANAGEMENT is embedded right here as a master→detail (like Govern):
 * pick/click a dataset → its quality manager opens IN-PLACE with a back link,
 * so the user never leaves Observability. Alerts stays OM-backed (OM eventing).
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, AlertTriangle, BellRing, Radar, Activity, CheckCircle2, XCircle, Plus, ChevronRight, ChevronLeft, Database, Search } from 'lucide-react';

import { ModuleShell, PageHeader, DataTable, EmptyState, StatusPill, StatCard, type SubNavItem } from '@/components/catalog/ModuleShell';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { useDataset } from '@/hooks/use-datasets';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { useUrlNav } from '@/hooks/use-url-nav';
import { DatasetQualityPanel } from '@/components/datasets/DatasetQualityPanel';
import {
  getCatalogStatus, getQualityOverview, listAlerts,
  type QualityOverview, type Alert,
} from '@/lib/catalog';

const ITEMS: SubNavItem[] = [
  { key: 'data-quality', label: 'Data Quality', desc: 'Sức khỏe dữ liệu theo dataset', icon: <ShieldCheck className="h-4 w-4" /> },
  { key: 'incidents', label: 'Incident Manager', desc: 'Sự cố chất lượng', icon: <AlertTriangle className="h-4 w-4" /> },
  { key: 'alerts', label: 'Alerts', desc: 'Cảnh báo & thông báo', icon: <BellRing className="h-4 w-4" /> },
];

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
  const active = nav.get('tab') || 'data-quality';
  const datasetParam = nav.get('dataset');
  const [connected, setConnected] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<QualityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Selected | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    return getQualityOverview().then(setOverview).catch(() => setOverview(null)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { getCatalogStatus().then((s) => setConnected(s.connected)).catch(() => setConnected(false)); }, []);
  useEffect(() => { reload(); }, [reload]);

  // selected detail comes from the URL (?dataset=<id>) so F5/share/back work;
  // `picked` gives an instant name on click before the overview resolves it.
  const selected = useMemo<Selected | null>(() => {
    if (picked) return picked;
    const id = datasetParam ? Number(datasetParam) : 0;
    if (!id) return null;
    const found = overview?.datasets.find((d) => d.dataset_id === id)
      ?? overview?.incidents.find((i) => i.dataset_id === id)
      ?? overview?.candidates.find((c) => c.dataset_id === id);
    return { id, name: found?.dataset ?? '' };
  }, [picked, datasetParam, overview]);

  const open = (d: Selected) => { setPicked(d); nav.set({ dataset: String(d.id) }); };
  const back = () => { setPicked(null); nav.set({ dataset: null }); reload(); };

  return (
    <ModuleShell
      title="Observability"
      icon={<Radar className="h-4 w-4" />}
      items={ITEMS}
      active={active}
      onSelect={(k) => { setPicked(null); nav.set({ tab: k, dataset: null }); }}
      connected={connected}
    >
      {selected ? (
        <DatasetQualityDetail dataset={selected} onBack={back} />
      ) : (
        <>
          {active === 'data-quality' && <DataQualityPanel overview={overview} loading={loading} onOpen={open} />}
          {active === 'incidents' && <IncidentsPanel overview={overview} loading={loading} onOpen={open} />}
          {active === 'alerts' && <AlertsPanel />}
        </>
      )}
    </ModuleShell>
  );
}

function scoreTone(score?: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (score == null) return 'neutral';
  return score >= 90 ? 'success' : score >= 70 ? 'warning' : 'danger';
}

function ScoreBadge({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-tiny text-text-quaternary">—</span>;
  const s = Math.round(score);
  const tone = s >= 90 ? 'bg-success/10 text-success' : s >= 70 ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger';
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-caption font-emphasis', tone)}>{s}</span>;
}

function SeverityTag({ severity, error }: { severity: string; error?: boolean }) {
  const sev = (severity || '').toLowerCase();
  const tone: 'danger' | 'warning' | 'neutral' =
    error || sev === 'error' || sev === 'critical' ? 'danger' : sev === 'warning' || sev === 'high' ? 'warning' : 'neutral';
  return <FilterTag tone={tone}>{severity || '—'}</FilterTag>;
}

// ── In-place quality manager (no navigation away) ───────────────────────────
function DatasetQualityDetail({ dataset, onBack }: { dataset: Selected; onBack: () => void }) {
  const { data, isLoading } = useDataset(dataset.id);
  const canEdit = getResourcePermissions(data?.user_permission).canEdit;
  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
        <ChevronLeft className="h-3.5 w-3.5" /> Quay lại
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
        <EmptyState title="Không tải được dataset" hint="Thử lại hoặc kiểm tra quyền truy cập dataset này." />
      )}
    </div>
  );
}

function DataQualityPanel({ overview, loading, onOpen }: { overview: QualityOverview | null; loading: boolean; onOpen: (d: Selected) => void }) {
  const [pick, setPick] = useState(false);
  const s = overview?.summary;
  const rows = overview?.datasets ?? [];
  const candidates = overview?.candidates ?? [];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <PageHeader title="Data Quality" description="Sức khỏe dữ liệu trên các dataset — quy tắc chạy trực tiếp trên dữ liệu thật." />
        <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} disabled={!candidates.length} onClick={() => setPick(true)}>Thiết lập dataset</Button>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Dataset theo dõi" value={s?.datasets ?? 0} icon={<Database className="h-3.5 w-3.5" />} />
        <StatCard label="Điểm trung bình" value={s?.avgScore != null ? s.avgScore : '—'} tone={scoreTone(s?.avgScore)} icon={<Activity className="h-3.5 w-3.5" />} />
        <StatCard label="Kiểm tra đạt" value={s?.passed ?? 0} tone="success" icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
        <StatCard label="Sự cố" value={s?.incidents ?? 0} tone="danger" icon={<XCircle className="h-3.5 w-3.5" />} />
      </div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Chưa có dataset nào theo dõi chất lượng" hint="Bấm “Thiết lập dataset” để thêm quy tắc chất lượng cho một dataset và chạy kiểm tra." />
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="app-list-table-wrap">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2"><tr>
                <th className="app-list-header w-[34%]">Dataset</th>
                <th className="app-list-header w-[10%]">Điểm</th>
                <th className="app-list-header w-[12%]">Quy tắc</th>
                <th className="app-list-header w-[20%]">Đạt / Lỗi</th>
                <th className="app-list-header w-[16%]">Lần chạy</th>
                <th className="app-list-header w-[8%]" />
              </tr></thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {rows.map((r) => (
                  <tr key={r.dataset_id} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen({ id: r.dataset_id, name: r.dataset })}>
                    <td className="app-list-cell">
                      <span className="app-list-text-main flex items-center gap-1.5 text-caption font-emphasis text-text-primary hover:text-brand">
                        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-text-quaternary" />{r.dataset}
                      </span>
                      <span className="app-list-text-sub mt-0.5 block text-tiny text-text-quaternary">
                        {r.owner ? r.owner.split('@')[0] : '—'} · {r.coveredTables} bảng
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
                    <td className="app-list-cell"><StatusPill status={r.lastRunStatus || 'queued'} /></td>
                    <td className="app-list-cell text-right"><ChevronRight className="inline h-4 w-4 text-text-quaternary" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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

function IncidentsPanel({ overview, loading, onOpen }: { overview: QualityOverview | null; loading: boolean; onOpen: (d: Selected) => void }) {
  const incidents = overview?.incidents ?? [];
  return (
    <>
      <PageHeader title="Incident Manager" description="Các kiểm tra chất lượng đang thất bại ở lần chạy gần nhất — bấm để mở & xử lý." />
      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : incidents.length === 0 ? (
        <EmptyState title="Không có sự cố nào" hint="Mọi kiểm tra chất lượng đang đạt. Sự cố xuất hiện khi một quy tắc thất bại ở lần chạy gần nhất." />
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="app-list-table-wrap">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2"><tr>
                <th className="app-list-header w-[24%]">Kiểm tra</th>
                <th className="app-list-header w-[22%]">Vị trí</th>
                <th className="app-list-header w-[12%]">Chiều</th>
                <th className="app-list-header w-[12%]">Mức độ</th>
                <th className="app-list-header w-[14%]">Dòng lỗi</th>
                <th className="app-list-header w-[16%]">Dataset</th>
              </tr></thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {incidents.map((inc, i) => (
                  <tr key={`${inc.dataset_id}.${inc.rule}.${i}`} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen({ id: inc.dataset_id, name: inc.dataset })}>
                    <td className="app-list-cell">
                      <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-danger" />{inc.rule}</span>
                    </td>
                    <td className="app-list-cell text-caption text-text-secondary">
                      {inc.table || '—'}{inc.column ? <code className="ml-1 font-mono text-tiny text-text-tertiary">· {inc.column}</code> : ''}
                    </td>
                    <td className="app-list-cell"><FilterTag tone="neutral">{inc.dimension}</FilterTag></td>
                    <td className="app-list-cell"><SeverityTag severity={inc.severity} error={inc.error} /></td>
                    <td className="app-list-cell text-caption text-text-secondary">
                      {inc.error ? <span className="text-danger">Lỗi chạy</span> : inc.rowsFailed != null ? `${inc.rowsFailed.toLocaleString()} dòng` : '—'}
                    </td>
                    <td className="app-list-cell text-caption text-text-tertiary">{inc.dataset}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function AlertsPanel() {
  const [rows, setRows] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true;
    listAlerts().then((d) => on && setRows(d)).catch(() => on && setRows([])).finally(() => on && setLoading(false));
    return () => { on = false; };
  }, []);
  return (
    <>
      <PageHeader title="Alerts" description="Cảnh báo chất lượng tự động — sinh ra khi một kiểm tra thất bại hoặc điểm chất lượng của dataset giảm dưới ngưỡng." />
      <DataTable
        loading={loading}
        rows={rows as unknown as Record<string, unknown>[]}
        columns={[
          { key: 'name', label: 'Alert', className: 'font-emphasis text-text-primary' },
          { key: 'description', label: 'Description' },
          { key: 'alertType', label: 'Type' },
          { key: 'enabled', label: 'Enabled', render: (r) => (r.enabled ? 'Bật' : 'Tắt') },
        ]}
        empty={<EmptyState title="Không có cảnh báo nào" hint="Mọi dataset đang đạt chất lượng. Cảnh báo tự xuất hiện khi một kiểm tra thất bại hoặc điểm giảm dưới 70." />}
      />
    </>
  );
}
