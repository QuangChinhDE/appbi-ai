'use client';

// Bản đồ Filter — a read-only, at-a-glance overview of EVERY filter acting on a
// dashboard, grouped by field. It exists because a DA otherwise has to hunt
// across 5 scattered surfaces (chart base / slicer / page filter / dashboard
// filter / public link) to answer "why is this chart filtered?" — and some of
// those surfaces are invisible on the dashboard (chart-base lives in Explore,
// page filters render no control). One table = the whole picture, and it
// surfaces the empty-lock footgun (a Khoá/Ẩn with no value enforces nothing)
// with a visible warning. Pure visualization — it changes no filter behavior.

import { useMemo } from 'react';
import {
  X, SlidersHorizontal, LayoutGrid, FileText, Settings2,
  Eye, Lock, EyeOff, AlertTriangle, Info,
} from 'lucide-react';
import { getFilterDisplayLabel } from '@/lib/filters';

interface FilterMapModalProps {
  dashboard: any;
  onClose: () => void;
}

type SourceKind = 'chart_base' | 'slicer' | 'dashboard_filter' | 'page_filter';
type PublicState = 'visible' | 'locked' | 'hidden' | 'apply' | 'always';

interface FilterRow {
  fieldLabel: string;
  kind: SourceKind;
  sourceLabel: string;
  scope: string;
  valueText: string;
  publicState: PublicState;
  editableBy: string;
  emptyWarn: boolean;
}

function isEmptyVal(v: any): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return v === null || v === undefined || String(v).trim() === '';
}

function formatValue(v: any, op?: string): string {
  if (isEmptyVal(v)) return '—';
  if (Array.isArray(v)) {
    if (op === 'between' && v.length === 2) return `${v[0]} → ${v[1]}`;
    return v.map((x) => String(x)).join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const KIND_META: Record<SourceKind, { label: string; Icon: any; cls: string }> = {
  chart_base:       { label: 'Filter gốc chart', Icon: Settings2,          cls: 'text-amber-300' },
  slicer:           { label: 'Slicer',           Icon: SlidersHorizontal,  cls: 'text-sky-300' },
  dashboard_filter: { label: 'Filter dashboard', Icon: LayoutGrid,         cls: 'text-indigo-300' },
  page_filter:      { label: 'Filter trang',     Icon: FileText,           cls: 'text-teal-300' },
};

function PublicBadge({ state }: { state: PublicState }) {
  const map: Record<PublicState, { txt: string; Icon: any; cls: string }> = {
    visible: { txt: 'Hiện',     Icon: Eye,      cls: 'bg-success/15 text-success' },
    locked:  { txt: 'Khoá',     Icon: Lock,     cls: 'bg-warning/15 text-warning' },
    hidden:  { txt: 'Ẩn',       Icon: EyeOff,   cls: 'bg-[rgba(255,255,255,0.08)] text-text-secondary' },
    apply:   { txt: 'Áp ngầm',  Icon: FileText, cls: 'bg-[rgba(255,255,255,0.06)] text-text-tertiary' },
    always:  { txt: 'Luôn áp',  Icon: Settings2, cls: 'bg-[rgba(255,255,255,0.06)] text-text-tertiary' },
  };
  const m = map[state];
  const Icon = m.Icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-[510] ${m.cls}`}>
      <Icon className="h-3 w-3" />
      {m.txt}
    </span>
  );
}

export default function FilterMapModal({ dashboard, onClose }: FilterMapModalProps) {
  const rows = useMemo<FilterRow[]>(() => {
    const out: FilterRow[] = [];
    const d = dashboard || {};
    const pages: any[] = Array.isArray(d.pages_config) ? d.pages_config : [];
    const pageName = (p: any) => p?.name || p?.title || p?.id || 'trang';

    const push = (e: any, base: Omit<FilterRow, 'fieldLabel' | 'valueText' | 'emptyWarn'> & { warnIfEmpty?: boolean }) => {
      if (!e || typeof e !== 'object') return;
      if (String(e.type || '').toLowerCase() === 'image') return; // slicer-cluster decoration
      if (!e.field && !e.semanticField) return;
      const { warnIfEmpty, ...rest } = base;
      out.push({
        ...rest,
        fieldLabel: getFilterDisplayLabel(e),
        valueText: formatValue(e.value, e.operator),
        emptyWarn: !!warnIfEmpty && isEmptyVal(e.value),
      });
    };

    // 1) Dashboard filter pane (all-pages) — publicMode drives the public state.
    for (const f of (d.filters_config || [])) {
      const mode = (f?.publicMode || 'visible') as PublicState;
      push(f, {
        kind: 'dashboard_filter',
        sourceLabel: 'Filter dashboard',
        scope: 'Tất cả trang',
        publicState: mode === 'locked' || mode === 'hidden' ? mode : 'visible',
        editableBy: mode === 'visible' ? 'Người xem' : 'Tác giả',
        // empty value + locked/hidden = enforces nothing (no-op) → warn
        warnIfEmpty: mode === 'locked' || mode === 'hidden',
      });
    }

    // 2) Slicers (canvas, interactive).
    for (const s of (d.slicers_config || [])) {
      const sc = s?.scope || 'all';
      push(s, {
        kind: 'slicer',
        sourceLabel: 'Slicer',
        scope: sc === 'custom' ? 'Tùy chọn theo trang' : sc === 'page' ? 'Trang này' : 'Tất cả trang',
        publicState: 'visible',
        editableBy: 'Người xem',
      });
    }

    // 3) Per-page filters + per-page slicers.
    for (const p of pages) {
      for (const f of (p?.filters || [])) {
        push(f, {
          kind: 'page_filter',
          sourceLabel: `Filter trang · ${pageName(p)}`,
          scope: `Trang: ${pageName(p)}`,
          publicState: 'apply',
          editableBy: 'Tác giả',
        });
      }
      for (const s of (p?.slicers || [])) {
        push(s, {
          kind: 'slicer',
          sourceLabel: `Slicer trang · ${pageName(p)}`,
          scope: `Trang: ${pageName(p)}`,
          publicState: 'visible',
          editableBy: 'Người xem',
        });
      }
    }

    // 4) Chart base filters — invisible on the dashboard (set in Explore).
    for (const dc of (d.dashboard_charts || [])) {
      const cfg = dc?.chart?.config || {};
      const baseF = cfg.baseFilters ?? cfg.filters ?? [];
      const chartName = dc?.layout?.custom_title || dc?.chart?.name || `Chart ${dc?.chart_id ?? ''}`;
      for (const f of (Array.isArray(baseF) ? baseF : [])) {
        push(f, {
          kind: 'chart_base',
          sourceLabel: `Chart · ${chartName}`,
          scope: 'Chỉ chart này',
          publicState: 'always',
          editableBy: 'Cố định (sửa ở Explore)',
        });
      }
    }

    out.sort((a, b) => a.fieldLabel.localeCompare(b.fieldLabel) || a.kind.localeCompare(b.kind));
    return out;
  }, [dashboard]);

  // group rows by field for at-a-glance scanning
  const groups = useMemo(() => {
    const m = new Map<string, FilterRow[]>();
    for (const r of rows) {
      const arr = m.get(r.fieldLabel) || [];
      arr.push(r);
      m.set(r.fieldLabel, arr);
    }
    return [...m.entries()];
  }, [rows]);

  const warnCount = rows.filter((r) => r.emptyWarn).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-[3px] p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[rgb(var(--border-line))] px-5 py-4">
          <div className="flex items-start gap-2.5">
            <SlidersHorizontal className="mt-0.5 h-5 w-5 text-text-tertiary" />
            <div>
              <h2 className="text-base font-semibold text-text-primary">Bản đồ Filter</h2>
              <p className="mt-0.5 text-caption text-text-tertiary">
                {rows.length === 0
                  ? 'Toàn bộ filter đang tác động lên dashboard này'
                  : `${groups.length} trường · ${rows.length} filter từ mọi nguồn`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[rgb(var(--border-line))] px-5 py-2.5 text-[11px] text-text-tertiary">
          {(Object.keys(KIND_META) as SourceKind[]).map((k) => {
            const Icon = KIND_META[k].Icon;
            return (
              <span key={k} className="inline-flex items-center gap-1">
                <Icon className={`h-3 w-3 ${KIND_META[k].cls}`} />
                {KIND_META[k].label}
              </span>
            );
          })}
          {warnCount > 0 && (
            <span className="inline-flex items-center gap-1 text-warning">
              <AlertTriangle className="h-3 w-3" />
              {warnCount} khoá chưa có giá trị
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-text-tertiary">
              Dashboard chưa có filter nào. Thêm Slicer hoặc Filter để giới hạn dữ liệu.
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map(([field, frows]) => (
                <div key={field} className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))]">
                  <div className="bg-[rgba(255,255,255,0.03)] px-3 py-1.5 text-[13px] font-semibold text-text-primary">
                    {field}
                  </div>
                  <table className="w-full text-[12px]">
                    <tbody>
                      {frows.map((r, i) => {
                        const Icon = KIND_META[r.kind].Icon;
                        return (
                          <tr key={i} className="border-t border-[rgb(var(--border-line))] align-top">
                            <td className="px-3 py-2 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1.5 text-text-secondary">
                                <Icon className={`h-3.5 w-3.5 ${KIND_META[r.kind].cls}`} />
                                {r.sourceLabel}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-text-primary">
                              {r.emptyWarn ? (
                                <span className="inline-flex items-center gap-1 text-warning">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  Chưa có giá trị → không lọc
                                </span>
                              ) : (
                                <span className="break-words">{r.valueText}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-text-tertiary">{r.scope}</td>
                            <td className="px-3 py-2 whitespace-nowrap"><PublicBadge state={r.publicState} /></td>
                            <td className="px-3 py-2 whitespace-nowrap text-text-tertiary">{r.editableBy}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-start gap-2 border-t border-[rgb(var(--border-line))] px-5 py-3 text-[11px] text-text-tertiary">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Thứ tự áp filter: <span className="text-text-secondary">🔒 Khoá link → Filter trang → Slicer người xem</span>.
            Filter Khoá/Ẩn riêng cho từng link công khai cấu hình ở <span className="text-text-secondary">Public links</span>.
          </span>
        </div>
      </div>
    </div>
  );
}
