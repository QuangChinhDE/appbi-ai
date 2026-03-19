'use client';

import { useState } from 'react';
import {
  RefreshCw,
  Eye,
  Table2,
  LayoutList,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useDataSourceSchema, useTableDetail } from '@/hooks/use-datasources';
import type { SchemaEntry, SchemaTableEntry, TableColumn } from '@/types/api';

interface Props {
  datasourceId: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRows(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── Column Badges ──────────────────────────────────────────────────────────

function PkBadge() {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-300 ml-1">
      PK
    </span>
  );
}

function FkBadge() {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700 border border-blue-300 ml-1">
      FK
    </span>
  );
}

function IdxBadge() {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-700 border border-purple-300 ml-1">
      IDX
    </span>
  );
}

// ── Schema Tree Item ───────────────────────────────────────────────────────

interface SchemaNodeProps {
  entry: SchemaEntry;
  selected: { schema: string; table: string } | null;
  onSelect: (schema: string, table: string) => void;
}

function SchemaNode({ entry, selected, onSelect }: SchemaNodeProps) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      {/* Schema header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center w-full px-2 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 rounded"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 mr-1 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 mr-1 flex-shrink-0" />
        )}
        <span className="truncate">{entry.schema}</span>
        <span className="ml-auto text-xs text-gray-400 font-normal">
          {entry.tables.length} tables
        </span>
      </button>

      {/* Tables list */}
      {open && (
        <div className="ml-3 border-l border-gray-100 pl-2 my-0.5">
          {entry.tables.map((t) => {
            const isSelected =
              selected?.schema === entry.schema && selected?.table === t.name;
            return (
              <button
                key={t.name}
                onClick={() => onSelect(entry.schema, t.name)}
                className={`flex items-center w-full px-2 py-1 text-sm rounded group ${
                  isSelected
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {t.type === 'view' || t.type === 'materialized_view' ? (
                  <LayoutList
                    className={`w-3.5 h-3.5 mr-1.5 flex-shrink-0 ${
                      isSelected ? 'text-blue-500' : 'text-gray-400'
                    }`}
                  />
                ) : (
                  <Table2
                    className={`w-3.5 h-3.5 mr-1.5 flex-shrink-0 ${
                      isSelected ? 'text-blue-500' : 'text-gray-400'
                    }`}
                  />
                )}
                <span className="truncate flex-1 text-left">{t.name}</span>
                <span className="ml-1 text-xs text-gray-400 flex-shrink-0">
                  {t.type !== 'table' ? (
                    <span className="px-1 py-0.5 bg-gray-100 rounded text-[10px]">view</span>
                  ) : (
                    formatRows(t.row_count)
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Table Detail Panel ─────────────────────────────────────────────────────

interface TableDetailPanelProps {
  datasourceId: number;
  schemaName: string;
  tableName: string;
  onRefreshSchema: () => void;
}

function TableDetailPanel({
  datasourceId,
  schemaName,
  tableName,
  onRefreshSchema,
}: TableDetailPanelProps) {
  const [showFullPreview, setShowFullPreview] = useState(false);

  const { data: detail, isLoading, error, refetch } = useTableDetail(
    datasourceId,
    schemaName,
    tableName,
    5,
  );

  const { data: fullDetail, isLoading: fullLoading, refetch: refetchFull } =
    useTableDetail(datasourceId, schemaName, tableName, 100);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading table details…
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex items-center gap-2 text-red-500 p-4">
        <AlertCircle className="w-4 h-4" />
        <span className="text-sm">Failed to load table details.</span>
      </div>
    );
  }

  const previewData = showFullPreview ? (fullDetail?.preview ?? detail.preview) : detail.preview;
  const previewCols = previewData.length > 0 ? Object.keys(previewData[0]) : [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-800">{tableName}</h3>
            <span className="text-xs text-gray-400">{schemaName} schema</span>
            {detail.type !== 'table' && (
              <span className="px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-500 rounded border">
                {detail.type.replace('_', ' ')}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            {detail.row_count !== null && (
              <span>{formatRows(detail.row_count)} rows</span>
            )}
            {detail.size_bytes !== null && (
              <span className="ml-2">~ {formatBytes(detail.size_bytes)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { refetch(); refetchFull(); }}
            className="p-1.5 hover:bg-gray-100 rounded text-gray-500 hover:text-gray-700"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 z-10">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs uppercase tracking-wide">
                Column
              </th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs uppercase tracking-wide">
                Type
              </th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs uppercase tracking-wide">
                Nullable
              </th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs uppercase tracking-wide">
                Key
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {detail.columns.map((col: TableColumn) => (
              <tr key={col.name} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-mono text-sm text-gray-800">
                  {col.name}
                </td>
                <td className="px-4 py-2 text-gray-500 text-xs">{col.type}</td>
                <td className="px-4 py-2 text-xs text-gray-400">
                  {col.nullable ? (
                    <span>nullable</span>
                  ) : (
                    <span className="font-medium text-gray-600">NOT NULL</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {col.is_primary_key && <PkBadge />}
                  {col.is_foreign_key && <FkBadge />}
                  {col.has_index && !col.is_primary_key && <IdxBadge />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Preview */}
        <div className="mt-4 px-4 pb-2">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Preview — first {previewData.length} rows
          </h4>
          {previewData.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No data</p>
          ) : (
            <div className="overflow-x-auto rounded border border-gray-100">
              <table className="text-xs w-full">
                <thead className="bg-gray-50">
                  <tr>
                    {previewCols.map((c) => (
                      <th
                        key={c}
                        className="px-2.5 py-1.5 text-left font-medium text-gray-500 whitespace-nowrap"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {previewData.map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      {previewCols.map((c) => (
                        <td
                          key={c}
                          className="px-2.5 py-1 text-gray-700 whitespace-nowrap max-w-[200px] truncate"
                        >
                          {row[c] === null || row[c] === undefined
                            ? <span className="text-gray-300 italic">null</span>
                            : String(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 flex-shrink-0 bg-white">
        <button
          onClick={onRefreshSchema}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-md hover:bg-gray-50 text-gray-600"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh schema
        </button>
        <button
          onClick={() => {
            setShowFullPreview(true);
            refetchFull();
          }}
          disabled={fullLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-md hover:bg-gray-50 text-gray-600 disabled:opacity-50"
        >
          {fullLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
          Preview 100 rows
        </button>
      </div>
    </div>
  );
}

// ── Main TablesTab ─────────────────────────────────────────────────────────

export default function TablesTab({ datasourceId }: Props) {
  const [selected, setSelected] = useState<{ schema: string; table: string } | null>(null);

  const { data, isLoading, error, refetch } = useDataSourceSchema(datasourceId);

  const handleRefreshSchema = () => refetch();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading schema…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-500">
        <AlertCircle className="w-8 h-8 text-red-400" />
        <p className="text-sm">Failed to load schema. Check connection settings.</p>
        <button
          onClick={() => refetch()}
          className="text-sm text-blue-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const schemas = data?.schemas ?? [];

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel: Schema browser */}
      <div className="w-64 flex-shrink-0 border-r border-gray-100 bg-gray-50 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Schema browser
          </span>
          <button
            onClick={handleRefreshSchema}
            className="p-1 hover:bg-gray-200 rounded text-gray-400 hover:text-gray-600"
            title="Refresh schema"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {schemas.length === 0 ? (
            <p className="text-xs text-gray-400 text-center mt-8 px-4">
              No tables found
            </p>
          ) : (
            schemas.map((entry) => (
              <SchemaNode
                key={entry.schema}
                entry={entry}
                selected={selected}
                onSelect={(schema, table) => setSelected({ schema, table })}
              />
            ))
          )}
        </div>
      </div>

      {/* Right panel: Table detail */}
      <div className="flex-1 overflow-hidden">
        {selected ? (
          <TableDetailPanel
            datasourceId={datasourceId}
            schemaName={selected.schema}
            tableName={selected.table}
            onRefreshSchema={handleRefreshSchema}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
            <Table2 className="w-10 h-10 text-gray-200" />
            <p className="text-sm">Select a table to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}
