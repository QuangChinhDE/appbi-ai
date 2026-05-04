'use client';

/**
 * Kaggle-style column summary tooltip.
 *
 * Why a separate component: the dataset grid already lives behind a complex
 * pile of state (formats, computed columns, type overrides). The summary is
 * a self-contained data fetch keyed by (datasetId, tableId, columnName), so
 * it owns its own loading/error/cache state and renders in the Linear dark
 * surface idiom — translucent panel, ultra-subtle borders, weight 510 labels.
 */
import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

interface TopValue {
  value: string | null;
  count: number;
}

interface HistogramBin {
  bin_start: number;
  bin_end: number;
  count: number;
}

interface ColumnSummary {
  column: string;
  detected_kind: 'numeric' | 'categorical' | 'date' | 'boolean' | 'empty';
  total_rows: number;
  null_count: number;
  distinct_count: number | null;
  top_values: TopValue[];
  min_value: any;
  max_value: any;
  avg_value: any;
  histogram: HistogramBin[];
}

interface Props {
  datasetId: number | string;
  tableId: number | string;
  columnName: string;
  columnType?: string;
  onClose: () => void;
}

const formatNumber = (v: any): string => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return String(Math.round(n * 100) / 100);
};

export function ColumnSummaryPopover({ datasetId, tableId, columnName, columnType, onClose }: Props) {
  const [data, setData] = useState<ColumnSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    const url = `/datasets/${datasetId}/tables/${tableId}/columns/${encodeURIComponent(columnName)}/summary?top_limit=10`;
    apiClient
      .get(url)
      .then((res) => {
        if (!alive) return;
        setData(res.data as ColumnSummary);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || 'Không tải được summary');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [datasetId, tableId, columnName]);

  return (
    <div
      className="absolute z-50 top-full right-0 mt-1 w-80 rounded-lg shadow-2xl"
      style={{
        background: '#191a1b',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow:
          '0 8px 2px rgba(0,0,0,0), 0 5px 2px rgba(0,0,0,0.01), 0 3px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.07), 0 0 1px rgba(0,0,0,0.08)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.05)' }}
      >
        <div className="flex flex-col min-w-0">
          <span
            className="text-[13px] font-medium truncate"
            style={{ color: '#f7f8f8', fontWeight: 510 }}
          >
            {columnName}
          </span>
          {columnType && (
            <span className="text-[11px]" style={{ color: '#62666d' }}>
              {columnType}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/5"
          style={{ color: '#8a8f98' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-3 max-h-96 overflow-y-auto">
        {loading && (
          <div className="text-[12px]" style={{ color: '#8a8f98' }}>
            Đang tổng hợp dữ liệu cột…
          </div>
        )}
        {error && !loading && (
          <div className="text-[12px]" style={{ color: '#e57373' }}>
            {error}
          </div>
        )}
        {data && !loading && (
          <>
            <Row label="Tổng dòng" value={data.total_rows.toLocaleString('en-US')} />
            <Row label="Giá trị NULL" value={`${data.null_count.toLocaleString('en-US')} (${data.total_rows ? ((data.null_count / data.total_rows) * 100).toFixed(1) : '0'}%)`} />
            <Row label="Giá trị duy nhất" value={data.distinct_count?.toLocaleString('en-US') ?? '—'} />

            {data.detected_kind === 'numeric' && (
              <>
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <Stat label="Min" value={formatNumber(data.min_value)} />
                  <Stat label="Avg" value={formatNumber(data.avg_value)} />
                  <Stat label="Max" value={formatNumber(data.max_value)} />
                </div>
                {data.histogram.length > 0 && <Histogram bins={data.histogram} />}
              </>
            )}

            {(data.detected_kind === 'categorical' ||
              data.detected_kind === 'boolean' ||
              data.detected_kind === 'date') &&
              data.top_values.length > 0 && (
                <TopValuesList values={data.top_values} totalRows={data.total_rows - data.null_count} />
              )}

            {data.detected_kind === 'empty' && (
              <div className="text-[12px] italic" style={{ color: '#62666d' }}>
                Cột không có dữ liệu.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px]" style={{ color: '#8a8f98', fontWeight: 510 }}>
        {label}
      </span>
      <span className="text-[12px]" style={{ color: '#d0d6e0', fontWeight: 510 }}>
        {value}
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center px-2 py-1.5 rounded"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <span className="text-[10px] uppercase tracking-wider" style={{ color: '#62666d' }}>
        {label}
      </span>
      <span className="text-[12px] mt-0.5" style={{ color: '#f7f8f8', fontWeight: 510 }}>
        {value}
      </span>
    </div>
  );
}

function Histogram({ bins }: { bins: HistogramBin[] }) {
  const max = Math.max(...bins.map((b) => b.count), 1);
  return (
    <div>
      <div className="text-[10px] mb-1 uppercase tracking-wider" style={{ color: '#62666d' }}>
        Phân bố
      </div>
      <div className="flex items-end gap-[2px] h-16">
        {bins.map((b, i) => {
          const h = (b.count / max) * 100;
          return (
            <div
              key={i}
              className="flex-1 rounded-sm transition-colors"
              style={{
                height: `${Math.max(h, 4)}%`,
                background: '#7170ff',
                opacity: 0.85,
              }}
              title={`${formatNumber(b.bin_start)} – ${formatNumber(b.bin_end)}: ${b.count.toLocaleString('en-US')}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between mt-1 text-[10px]" style={{ color: '#62666d' }}>
        <span>{formatNumber(bins[0]?.bin_start)}</span>
        <span>{formatNumber(bins[bins.length - 1]?.bin_end)}</span>
      </div>
    </div>
  );
}

function TopValuesList({ values, totalRows }: { values: TopValue[]; totalRows: number }) {
  return (
    <div>
      <div className="text-[10px] mb-1 uppercase tracking-wider" style={{ color: '#62666d' }}>
        Top giá trị
      </div>
      <div className="space-y-1">
        {values.map((v, i) => {
          const pct = totalRows > 0 ? (v.count / totalRows) * 100 : 0;
          return (
            <div key={i} className="relative">
              <div
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{
                  width: `${pct}%`,
                  background: 'rgba(113,112,255,0.18)',
                }}
              />
              <div className="relative flex items-center justify-between px-1.5 py-0.5">
                <span className="text-[12px] truncate pr-2" style={{ color: '#d0d6e0', fontWeight: 510 }}>
                  {v.value === null || v.value === '' ? <em style={{ color: '#62666d' }}>(empty)</em> : v.value}
                </span>
                <span className="text-[11px] tabular-nums" style={{ color: '#8a8f98' }}>
                  {pct.toFixed(0)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
