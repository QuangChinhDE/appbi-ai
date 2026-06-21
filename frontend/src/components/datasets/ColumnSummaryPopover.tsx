'use client';

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useI18n } from '@/providers/LanguageProvider';

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

const NUMERIC_TYPES = new Set(['integer', 'float', 'bigint', 'double', 'decimal', 'numeric']);
const DATE_TYPES = new Set(['date', 'datetime', 'timestamp']);

const formatNumber = (v: any): string => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return String(Math.round(n * 100) / 100);
};

const isTypeKnown = (columnType?: string): boolean => {
  if (!columnType) return false;
  const t = columnType.toLowerCase();
  return NUMERIC_TYPES.has(t) || DATE_TYPES.has(t) || t === 'boolean' || t === 'string' || t === 'text';
};

export function ColumnSummaryPopover({ datasetId, tableId, columnName, columnType, onClose }: Props) {
  const { t } = useI18n();
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
        setError(err?.message || t('datasets.columnSummary.loadError'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [datasetId, tableId, columnName]);

  const typeKnown = isTypeKnown(columnType);

  return (
    <div
      className="absolute z-50 top-full right-0 mt-1 w-80 rounded-lg shadow-linear-popover"
      style={{
        background: 'rgb(var(--surface-1))',
        border: '1px solid rgb(var(--border-subtle) / 0.08)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: 'rgb(var(--border-subtle) / 0.06)' }}
      >
        <div className="flex flex-col min-w-0">
          <span
            className="text-[13px] font-emphasis truncate"
            style={{ color: 'rgb(var(--text-primary))' }}
          >
            {columnName}
          </span>
          <span className="text-[11px]" style={{ color: 'rgb(var(--text-tertiary))' }}>
            {columnType || t('datasets.columnSummary.unknownType')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-black/5"
          style={{ color: 'rgb(var(--text-tertiary))' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-3 max-h-96 overflow-y-auto">
        {loading && (
          <div className="text-[12px]" style={{ color: 'rgb(var(--text-tertiary))' }}>
            {t('datasets.columnSummary.aggregating')}
          </div>
        )}
        {error && !loading && (
          <div className="text-[12px]" style={{ color: 'rgb(var(--danger))' }}>
            {error}
          </div>
        )}
        {data && !loading && <Body data={data} typeKnown={typeKnown} />}
      </div>
    </div>
  );
}

function Body({ data, typeKnown }: { data: ColumnSummary; typeKnown: boolean }) {
  const { t } = useI18n();
  const { detected_kind, total_rows, null_count } = data;

  if (total_rows === 0 || detected_kind === 'empty') {
    return (
      <>
        <QualityBar valid={0} empty={0} total={0} />
        <div className="text-[12px] italic" style={{ color: 'rgb(var(--text-tertiary))' }}>
          {t('datasets.columnSummary.noData')}
        </div>
      </>
    );
  }

  const valid = total_rows - null_count;

  return (
    <>
      <QualityBar valid={valid} empty={null_count} total={total_rows} />

      {/* Type-known: render type-specific visualization. Type-unknown: fall back to
          categorical view (top values + distinct + min/max as string) — same pattern
          Power BI uses for "Any" type and Kaggle uses for mixed columns. */}
      {typeKnown && detected_kind === 'numeric' ? (
        <NumericBody data={data} />
      ) : typeKnown && detected_kind === 'date' ? (
        <DateBody data={data} />
      ) : typeKnown && detected_kind === 'boolean' ? (
        <BooleanBody data={data} />
      ) : (
        <CategoricalBody data={data} unknownType={!typeKnown} />
      )}
    </>
  );
}

function QualityBar({ valid, empty, total }: { valid: number; empty: number; total: number }) {
  const { t } = useI18n();
  const validPct = total > 0 ? (valid / total) * 100 : 0;
  const emptyPct = total > 0 ? (empty / total) * 100 : 100;

  return (
    <div>
      <div
        className="flex w-full h-1.5 rounded-sm overflow-hidden"
        style={{ background: 'rgb(var(--surface-3))' }}
      >
        {validPct > 0 && (
          <div
            style={{ width: `${validPct}%`, background: 'rgb(var(--success))' }}
            title={`${t('datasets.columnSummary.valid')}: ${valid.toLocaleString('en-US')} (${validPct.toFixed(1)}%)`}
          />
        )}
        {emptyPct > 0 && (
          <div
            style={{ width: `${emptyPct}%`, background: 'rgb(var(--text-quaternary) / 0.4)' }}
            title={`${t('datasets.columnSummary.empty')}: ${empty.toLocaleString('en-US')} (${emptyPct.toFixed(1)}%)`}
          />
        )}
      </div>
      <div
        className="flex justify-between mt-1.5 text-[11px] tabular-nums"
        style={{ color: 'rgb(var(--text-tertiary))' }}
      >
        <span>
          <span style={{ color: 'rgb(var(--success))' }}>●</span> {t('datasets.columnSummary.valid')} {validPct.toFixed(1)}%
        </span>
        <span>
          <span style={{ color: 'rgb(var(--text-quaternary))' }}>●</span> {t('datasets.columnSummary.empty')} {emptyPct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function NumericBody({ data }: { data: ColumnSummary }) {
  const { t } = useI18n();
  return (
    <>
      {data.histogram.length > 0 && <Histogram bins={data.histogram} />}
      <div className="grid grid-cols-3 gap-2">
        <Stat label={t('datasets.columnSummary.min')} value={formatNumber(data.min_value)} />
        <Stat label={t('datasets.columnSummary.avg')} value={formatNumber(data.avg_value)} />
        <Stat label={t('datasets.columnSummary.max')} value={formatNumber(data.max_value)} />
      </div>
      <Row label={t('datasets.columnSummary.distinct')} value={data.distinct_count?.toLocaleString('en-US') ?? '—'} />
    </>
  );
}

function DateBody({ data }: { data: ColumnSummary }) {
  const { t } = useI18n();
  return (
    <>
      {data.top_values.length > 0 && (
        <TopValuesList values={data.top_values} totalRows={data.total_rows - data.null_count} />
      )}
      <Row label={t('datasets.columnSummary.distinct')} value={data.distinct_count?.toLocaleString('en-US') ?? '—'} />
    </>
  );
}

function BooleanBody({ data }: { data: ColumnSummary }) {
  const totalNonNull = data.total_rows - data.null_count;
  return (
    <>
      {data.top_values.length > 0 ? (
        <div className="space-y-1.5">
          {data.top_values.map((v, i) => {
            const pct = totalNonNull > 0 ? (v.count / totalNonNull) * 100 : 0;
            const label = v.value === null ? '(null)' : String(v.value);
            return (
              <div key={i} className="flex items-center gap-2">
                <span
                  className="text-[12px] w-12 font-emphasis"
                  style={{ color: 'rgb(var(--text-secondary))' }}
                >
                  {label}
                </span>
                <div
                  className="flex-1 h-1.5 rounded-sm overflow-hidden"
                  style={{ background: 'rgb(var(--surface-3))' }}
                >
                  <div
                    style={{ width: `${pct}%`, background: 'rgb(var(--brand))' }}
                  />
                </div>
                <span
                  className="text-[11px] tabular-nums w-12 text-right"
                  style={{ color: 'rgb(var(--text-tertiary))' }}
                >
                  {pct.toFixed(0)}%
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function CategoricalBody({ data, unknownType }: { data: ColumnSummary; unknownType: boolean }) {
  const { t } = useI18n();
  const totalNonNull = data.total_rows - data.null_count;
  const topValue = data.top_values[0];
  return (
    <>
      {data.top_values.length > 0 ? (
        <TopValuesList values={data.top_values} totalRows={totalNonNull} />
      ) : (
        <div className="text-[12px] italic" style={{ color: 'rgb(var(--text-tertiary))' }}>
          {t('datasets.columnSummary.noValues')}
        </div>
      )}
      <div className="space-y-1.5 pt-1">
        <Row label={t('datasets.columnSummary.distinct')} value={data.distinct_count?.toLocaleString('en-US') ?? '—'} />
        {topValue && (
          <Row
            label={t('datasets.columnSummary.mostCommon')}
            value={`${topValue.value === null || topValue.value === '' ? t('datasets.columnSummary.emptyValue') : topValue.value} · ${topValue.count.toLocaleString('en-US')}`}
          />
        )}
        {unknownType && (data.min_value !== null || data.max_value !== null) && (
          <>
            <Row label={t('datasets.columnSummary.min')} value={data.min_value !== null ? String(data.min_value) : '—'} />
            <Row label={t('datasets.columnSummary.max')} value={data.max_value !== null ? String(data.max_value) : '—'} />
          </>
        )}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className="text-[12px] font-emphasis"
        style={{ color: 'rgb(var(--text-tertiary))' }}
      >
        {label}
      </span>
      <span
        className="text-[12px] font-emphasis truncate"
        style={{ color: 'rgb(var(--text-secondary))' }}
      >
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
        background: 'rgb(var(--surface-2))',
        border: '1px solid rgb(var(--border-subtle) / 0.05)',
      }}
    >
      <span
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'rgb(var(--text-tertiary))' }}
      >
        {label}
      </span>
      <span
        className="text-[12px] mt-0.5 font-emphasis"
        style={{ color: 'rgb(var(--text-primary))' }}
      >
        {value}
      </span>
    </div>
  );
}

function Histogram({ bins }: { bins: HistogramBin[] }) {
  const { t } = useI18n();
  const max = Math.max(...bins.map((b) => b.count), 1);
  return (
    <div>
      <div
        className="text-[10px] mb-1 uppercase tracking-wider"
        style={{ color: 'rgb(var(--text-tertiary))' }}
      >
        {t('datasets.columnSummary.distribution')}
      </div>
      <div className="flex items-end gap-[2px] h-16">
        {bins.map((b, i) => {
          const h = (b.count / max) * 100;
          return (
            <div
              key={i}
              className="flex-1 rounded-sm"
              style={{
                height: `${Math.max(h, 4)}%`,
                background: 'rgb(var(--brand))',
                opacity: 0.85,
              }}
              title={`${formatNumber(b.bin_start)} – ${formatNumber(b.bin_end)}: ${b.count.toLocaleString('en-US')}`}
            />
          );
        })}
      </div>
      <div
        className="flex justify-between mt-1 text-[10px] tabular-nums"
        style={{ color: 'rgb(var(--text-tertiary))' }}
      >
        <span>{formatNumber(bins[0]?.bin_start)}</span>
        <span>{formatNumber(bins[bins.length - 1]?.bin_end)}</span>
      </div>
    </div>
  );
}

function TopValuesList({ values, totalRows }: { values: TopValue[]; totalRows: number }) {
  const { t } = useI18n();
  return (
    <div>
      <div
        className="text-[10px] mb-1 uppercase tracking-wider"
        style={{ color: 'rgb(var(--text-tertiary))' }}
      >
        {t('datasets.columnSummary.topValues')}
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
                  background: 'rgb(var(--brand) / 0.14)',
                }}
              />
              <div className="relative flex items-center justify-between px-1.5 py-0.5">
                <span
                  className="text-[12px] truncate pr-2 font-emphasis"
                  style={{ color: 'rgb(var(--text-secondary))' }}
                >
                  {v.value === null || v.value === '' ? (
                    <em style={{ color: 'rgb(var(--text-tertiary))' }}>{t('datasets.columnSummary.emptyValue')}</em>
                  ) : (
                    v.value
                  )}
                </span>
                <span
                  className="text-[11px] tabular-nums"
                  style={{ color: 'rgb(var(--text-tertiary))' }}
                >
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
