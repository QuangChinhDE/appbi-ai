'use client';

/**
 * Incidents tab — the ONE feed for breaches from every detector (quality ·
 * anomaly · freshness · volume · schema). Full lifecycle: open → acknowledged →
 * resolved, with MTTR. Backed by /observability/incidents.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, RotateCcw, CheckCircle2, ChevronDown, ChevronRight, Bell } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { SeverityBadge, StatusPill, PillarBadge, relativeTime, fmtDuration } from './ui';
import { AlertChannelsModal } from './AlertChannelsModal';
import {
  listIncidents, updateIncident, type Incident, type Pillar, type Severity, PILLAR_LABEL,
} from '@/lib/observability';

const PILLARS: Pillar[] = ['freshness', 'volume', 'schema', 'distribution', 'quality'];

export function IncidentsTab({ datasetId, showChannels = true }: { datasetId?: number; showChannels?: boolean } = {}) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [pillar, setPillar] = useState<Pillar | null>(null);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [channelsOpen, setChannelsOpen] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    return listIncidents({
      status: showResolved ? undefined : 'open',
      pillar: pillar ?? undefined,
      severity: severity ?? undefined,
      datasetId,
    }).then(setIncidents).catch(() => setIncidents([])).finally(() => setLoading(false));
  }, [showResolved, pillar, severity, datasetId]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (inc: Incident, action: 'acknowledge' | 'resolve' | 'reopen') => {
    setBusyId(inc.id);
    try { await updateIncident(inc.id, action); await reload(); }
    catch { toast.error('Cập nhật sự cố thất bại'); }
    finally { setBusyId(null); }
  };

  const toggleExpand = (id: number) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const counts = useMemo(() => {
    const open = incidents.filter((i) => i.status !== 'resolved');
    return {
      total: incidents.length,
      critical: open.filter((i) => i.severity === 'critical').length,
      open: open.length,
    };
  }, [incidents]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-text-tertiary">Mọi sự cố từ chất lượng · bất thường · độ tươi · khối lượng · lược đồ — một vòng đời chung.</p>
        {showChannels && <Button variant="secondary" size="sm" leadingIcon={<Bell className="h-4 w-4" />} onClick={() => setChannelsOpen(true)}>Kênh cảnh báo</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterTag tone="neutral" active={!showResolved} onClick={() => setShowResolved(false)}>Đang mở{counts.open ? ` (${counts.open})` : ''}</FilterTag>
        <FilterTag tone="neutral" active={showResolved} onClick={() => setShowResolved(true)}>Tất cả</FilterTag>
        <span className="mx-1 h-4 w-px bg-[rgb(var(--border-line))]" />
        {(['critical', 'warning', 'info'] as Severity[]).map((s) => (
          <FilterTag key={s} tone={s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'info'} active={severity === s} onClick={() => setSeverity(severity === s ? null : s)}>
            {s === 'critical' ? 'Nghiêm trọng' : s === 'warning' ? 'Cảnh báo' : 'Thông tin'}
          </FilterTag>
        ))}
        <span className="mx-1 h-4 w-px bg-[rgb(var(--border-line))]" />
        {PILLARS.map((p) => (
          <FilterTag key={p} tone="neutral" active={pillar === p} onClick={() => setPillar(pillar === p ? null : p)}>{PILLAR_LABEL[p]}</FilterTag>
        ))}
      </div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : incidents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center">
          <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-success" />
          <h3 className="mb-1 text-small font-strong text-text-primary">{showResolved ? 'Chưa có sự cố nào' : 'Không có sự cố đang mở'}</h3>
          <p className="text-caption text-text-tertiary">Mọi monitor đều đang khoẻ. Sự cố mới sẽ xuất hiện ở đây.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <ul className="divide-y divide-[rgb(var(--border-line))]">
            {incidents.map((inc) => {
              const isOpen = expanded.has(inc.id);
              const resolved = inc.status === 'resolved';
              return (
                <li key={inc.id}>
                  <div className={cn('flex items-start gap-3 px-4 py-3 hover:bg-surface-2', resolved && 'opacity-60')}>
                    <button onClick={() => toggleExpand(inc.id)} className="mt-0.5 text-text-quaternary">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <span className={cn('mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
                      inc.severity === 'critical' ? 'bg-danger/10 text-danger' : inc.severity === 'warning' ? 'bg-warning/10 text-warning' : 'bg-info/10 text-info')}>
                      <AlertTriangle className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1 cursor-pointer" onClick={() => toggleExpand(inc.id)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-caption font-emphasis text-text-primary">{inc.title}</span>
                        <PillarBadge pillar={inc.pillar} />
                        <SeverityBadge severity={inc.severity} />
                        <StatusPill status={inc.status} />
                      </div>
                      <div className="mt-0.5 text-tiny text-text-quaternary">
                        {inc.dataset ?? `Dataset #${inc.datasetId}`} · phát hiện {relativeTime(inc.firstSeenAt)}
                        {resolved && inc.mttrHours != null && <> · xử lý trong <span className="text-success">{fmtDuration(inc.mttrHours)}</span></>}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      {!resolved && inc.status === 'open' && (
                        <Button size="sm" variant="ghost" disabled={busyId === inc.id} onClick={() => act(inc, 'acknowledge')} leadingIcon={<Check className="h-3.5 w-3.5" />}>Nhận</Button>
                      )}
                      {!resolved && (
                        <Button size="sm" variant="secondary" disabled={busyId === inc.id} onClick={() => act(inc, 'resolve')} leadingIcon={<CheckCircle2 className="h-3.5 w-3.5" />}>Xử lý</Button>
                      )}
                      {resolved && (
                        <Button size="sm" variant="ghost" disabled={busyId === inc.id} onClick={() => act(inc, 'reopen')} leadingIcon={<RotateCcw className="h-3.5 w-3.5" />}>Mở lại</Button>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div className="border-t border-[rgb(var(--border-line))] bg-surface-2 px-12 py-3">
                      <IncidentDetail incident={inc} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {channelsOpen && <AlertChannelsModal onClose={() => setChannelsOpen(false)} />}
    </div>
  );
}

function IncidentDetail({ incident }: { incident: Incident }) {
  const d = incident.detail ?? {};
  const rows: { k: string; v: string }[] = [];
  const push = (k: string, v: any) => { if (v != null && v !== '') rows.push({ k, v: typeof v === 'object' ? JSON.stringify(v) : String(v) }); };

  push('Nguồn', incident.source);
  if (incident.pillar === 'freshness') { push('Trễ (giờ)', d.lag_hours); push('Ngưỡng (giờ)', d.max_lag_hours); push('Load gần nhất', d.last_loaded_at); }
  if (incident.pillar === 'volume') { push('Số dòng', d.row_count); push('Kỳ vọng', d.expected); push('z-score', d.z_score); push('Thay đổi %', d.change_pct); push('Lý do', d.reason); }
  if (incident.pillar === 'schema') { push('Cột thêm', (d.added || []).join(', ')); push('Cột xoá', (d.removed || []).join(', ')); push('Đổi kiểu', (d.retyped || []).map((r: any) => `${r.column}: ${r.from}→${r.to}`).join(', ')); }
  if (incident.pillar === 'distribution') { push('Hiện tại', d.current); push('Kỳ vọng', d.expected); push('z-score', d.z_score); push('Thay đổi %', d.change_pct); push('Giải thích', d.explanation); }
  if (incident.pillar === 'quality') { push('Chiều', d.dimension); push('Loại quy tắc', d.rule_type); push('Cột', d.column); push('Dòng lỗi', d.rows_failed); }

  if (rows.length === 0) return <pre className="overflow-x-auto text-tiny text-text-tertiary">{JSON.stringify(d, null, 2)}</pre>;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 text-tiny">
          <dt className="min-w-[110px] text-text-quaternary">{r.k}</dt>
          <dd className="text-text-secondary">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}
