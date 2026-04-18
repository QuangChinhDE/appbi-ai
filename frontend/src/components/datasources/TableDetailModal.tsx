'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, Loader2, AlertCircle, Table2, ChevronDown } from 'lucide-react';
import { useTableDetail } from '@/hooks/use-datasources';
import type { TableColumn } from '@/types/api';

// ── Type inference ─────────────────────────────────────────────────────────

type InferredType = 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'text';

const TYPE_COLORS: Record<InferredType, string> = {
  integer:  'bg-brand/10 text-brand border-brand/30',
  decimal:  'bg-cyan-50 text-cyan-700 border-cyan-200',
  boolean:  'bg-brand/10 text-brand border-brand/30',
  date:     'bg-success/10 text-success border-success/30',
  datetime: 'bg-teal-50 text-teal-700 border-teal-200',
  text:     'bg-surface-2 text-text-secondary border-[rgb(var(--border-line))]',
};

function isInteger(v: string): boolean {
  return /^-?\d+$/.test(v.trim());
}
function isDecimal(v: string): boolean {
  return /^-?\d+\.\d+$/.test(v.trim());
}
function isBoolean(v: string): boolean {
  return /^(true|false|yes|no|0|1)$/i.test(v.trim());
}
const DATE_RE   = /^\d{2,4}[-/]\d{1,2}[-/]\d{2,4}$/;
const DT_RE     = /^\d{2,4}[-/T:]\d{1,2}[-/T:]\d{2,4}[T ]\d{1,2}:/;

function inferTypeFromSamples(samples: string[]): InferredType {
  const valid = samples.filter((s) => s !== '' && s !== 'null');
  if (valid.length === 0) return 'text';
  const n = valid.length;
  if (valid.every(isBoolean))  return 'boolean';
  if (valid.every((v) => DT_RE.test(v)))   return 'datetime';
  if (valid.every((v) => DATE_RE.test(v))) return 'date';
  if (valid.every(isInteger))  return 'integer';
  const dec = valid.filter((v) => isInteger(v) || isDecimal(v));
  if (dec.length >= n * 0.9)   return 'decimal';
  return 'text';
}

function inferColumnTypes(preview: Record<string, unknown>[]): Record<string, InferredType> {
  if (preview.length === 0) return {};
  const cols = Object.keys(preview[0]);
  const result: Record<string, InferredType> = {};
  for (const col of cols) {
    const samples = preview.slice(0, 20).map((r) => String(r[col] ?? ''));
    result[col] = inferTypeFromSamples(samples);
  }
  return result;
}

// ── Badge helpers ──────────────────────────────────────────────────────────

function PkBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-warning/15 text-warning border border-warning/40">
      PK
    </span>
  );
}
function FkBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-brand/15 text-brand border border-brand/40">
      FK
    </span>
  );
}
function IdxBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-brand/15 text-brand border border-brand/30">
      IDX
    </span>
  );
}

function TypeBadge({ type }: { type: InferredType }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${TYPE_COLORS[type]}`}>
      {type}
    </span>
  );
}

function formatRows(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
function formatBytes(b: number | null): string {
  if (b === null || b === undefined) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  datasourceId: number;
  schema: string;
  table: string;
  onClose: () => void;
}

export default function TableDetailModal({ datasourceId, schema, table, onClose }: Props) {
  const [previewLimit, setPreviewLimit] = useState(10);

  const { data: detail, isLoading, error, refetch } = useTableDetail(
    datasourceId,
    schema,
    table,
    previewLimit,
  );

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Infer types from preview data
  const inferredTypes: Record<string, InferredType> =
    detail?.preview ? inferColumnTypes(detail.preview) : {};

  const previewCols =
    detail?.preview && detail.preview.length > 0
      ? Object.keys(detail.preview[0])
      : detail?.columns.map((c: TableColumn) => c.name) ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-overlay/84 backdrop-blur-[3px]" />

      {/* Modal */}
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[rgb(var(--border-line))] flex-shrink-0">
          <div className="flex items-center gap-3">
            <Table2 className="w-5 h-5 text-brand" />
            <div>
              <h2 className="font-semibold text-text-primary text-base">{table}</h2>
              <p className="text-xs text-text-quaternary mt-0.5">
                schema: <span className="font-mono">{schema}</span>
                {detail?.row_count !== null && detail?.row_count !== undefined && (
                  <span className="ml-3">{formatRows(detail.row_count)} rows</span>
                )}
                {detail?.size_bytes ? (
                  <span className="ml-3">{formatBytes(detail.size_bytes)}</span>
                ) : null}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetch()}
              className="p-1.5 hover:bg-surface-2 rounded text-text-tertiary hover:text-text-secondary"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-surface-2 rounded text-text-tertiary hover:text-text-secondary"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-text-quaternary">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading…
            </div>
          ) : error || !detail ? (
            <div className="flex items-center gap-2 text-danger p-6">
              <AlertCircle className="w-4 h-4" />
              <span className="text-sm">Failed to load table details.</span>
            </div>
          ) : (
            <div className="divide-y divide-[rgb(var(--border-line))]">

              {/* ── Columns ─────────────────────────────────── */}
              <section className="px-5 py-4">
                <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wide mb-3">
                  Columns ({detail.columns.length})
                </h3>
                <div className="overflow-x-auto rounded border border-[rgb(var(--border-line))]">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-2">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs font-medium text-text-tertiary uppercase tracking-wide">Column</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-text-tertiary uppercase tracking-wide">DB type</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-text-tertiary uppercase tracking-wide">Inferred type</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-text-tertiary uppercase tracking-wide">Nullable</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-text-tertiary uppercase tracking-wide">Keys</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgb(var(--border-line))]">
                      {detail.columns.map((col: TableColumn) => (
                        <tr key={col.name} className="hover:bg-surface-2">
                          <td className="px-3 py-2 font-mono text-sm text-text-primary">{col.name}</td>
                          <td className="px-3 py-2 text-xs text-text-tertiary">{col.type}</td>
                          <td className="px-3 py-2">
                            {inferredTypes[col.name] ? (
                              <TypeBadge type={inferredTypes[col.name]} />
                            ) : (
                              <span className="text-text-quaternary text-xs">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-text-quaternary">
                            {col.nullable
                              ? <span>nullable</span>
                              : <span className="font-medium text-text-secondary">NOT NULL</span>}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1">
                              {col.is_primary_key && <PkBadge />}
                              {col.is_foreign_key && <FkBadge />}
                              {col.has_index && !col.is_primary_key && <IdxBadge />}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* ── Preview ─────────────────────────────────── */}
              <section className="px-5 py-4 pb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
                    Preview — {detail.preview.length} rows
                  </h3>
                  {detail.preview.length >= previewLimit && (
                    <button
                      onClick={() => setPreviewLimit((n) => n + 20)}
                      className="flex items-center gap-1 text-xs text-brand hover:underline"
                    >
                      <ChevronDown className="w-3 h-3" />
                      Load more
                    </button>
                  )}
                </div>
                {detail.preview.length === 0 ? (
                  <p className="text-xs text-text-quaternary italic">No data</p>
                ) : (
                  <div className="overflow-x-auto rounded border border-[rgb(var(--border-line))]">
                    <table className="text-xs w-full">
                      <thead className="bg-surface-2 sticky top-0">
                        <tr>
                          {previewCols.map((c) => (
                            <th key={c} className="px-2.5 py-2 text-left font-medium text-text-tertiary whitespace-nowrap border-b border-[rgb(var(--border-line))]">
                              <div>{c}</div>
                              {inferredTypes[c] && (
                                <div className="mt-0.5">
                                  <TypeBadge type={inferredTypes[c]} />
                                </div>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[rgb(var(--border-line))]">
                        {detail.preview.map((row: Record<string, unknown>, i: number) => (
                          <tr key={i} className="hover:bg-surface-2">
                            {previewCols.map((c) => (
                              <td key={c} className="px-2.5 py-1.5 text-text-secondary whitespace-nowrap max-w-[200px] truncate">
                                {row[c] === null || row[c] === undefined
                                  ? <span className="text-text-quaternary italic">null</span>
                                  : String(row[c])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
