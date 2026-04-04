/**
 * QueryTableTab - Visual Query Builder + Advanced SQL fallback
 */
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, AlertCircle, X, Plus, ChevronDown, Code } from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import { useDatasourceTables, useDatasourceTableColumns } from '@/hooks/use-datasets';
import type { AddTableInput } from '@/hooks/use-datasets';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JoinSpec {
  id: string;
  joinType: 'LEFT' | 'INNER' | 'RIGHT';
  joinTable: string;
  leftKey: string;
  rightKey: string;
}

interface QueryTableTabProps {
  onAddTable?: (input: AddTableInput) => Promise<void>;
  isLoading: boolean;
  // Edit / locked-datasource mode
  lockDatasource?: boolean;
  lockedDatasourceName?: string;
  initialDatasourceId?: number;
  initialDisplayName?: string;
  initialQuery?: string;
  onSave?: (displayName: string, query: string) => void;
  saveError?: string | null;
}

// ─── FK suggestion helpers ────────────────────────────────────────────────────

function singularize(name: string): string {
  const base = name.split('.').pop() ?? name;
  if (base.endsWith('ies')) return base.slice(0, -3) + 'y';
  if (base.endsWith('s') && !base.endsWith('ss')) return base.slice(0, -1);
  return base;
}

function suggestJoinKeys(baseTable: string, joinTable: string): { left: string; right: string } {
  const joinSingular = singularize(joinTable);
  return { left: `${joinSingular}_id`, right: 'id' };
}

function scoreJoinCandidate(baseTable: string, candidate: string): number {
  const singular = singularize(candidate);
  const base = baseTable.split('.').pop() ?? baseTable;
  const cand = candidate.split('.').pop() ?? candidate;
  if (base.includes(singular) || singular.includes(base)) return 0; // same table
  // Heuristic: common FK patterns
  const patterns = [
    `${singularize(base)}_id`, // base has FK to candidate
    `${singular}_id`,          // base has FK named {candidate_singular}_id
  ];
  // Score by how likely a FK exists (higher = better match)
  return patterns.some(p => p.length > 3) ? 2 : 1;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ColumnTagAutocomplete({
  columns,
  selected,
  onChange,
  loading,
  disabled,
}: {
  columns: { name: string; type: string }[];
  selected: string[];
  onChange: (cols: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const suggestions = columns.filter(
    c => !selected.includes(c.name) && c.name.toLowerCase().includes(input.toLowerCase())
  );

  const addCol = (name: string) => {
    if (!selected.includes(name)) onChange([...selected, name]);
    setInput('');
    setOpen(false);
  };

  const removeCol = (name: string) => onChange(selected.filter(c => c !== name));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length === 1) { addCol(suggestions[0].name); return; }
      // exact match
      const exact = columns.find(c => c.name.toLowerCase() === input.toLowerCase());
      if (exact) addCol(exact.name);
    }
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="space-y-2">
      {/* Tags */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map(col => (
            <span key={col} className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded-full">
              {col}
              <button type="button" onClick={() => removeCol(col)} disabled={disabled} className="hover:text-blue-600">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input + dropdown */}
      <div className="relative">
        <input
          type="text"
          value={input}
          onChange={e => { setInput(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={loading ? 'Đang tải cột...' : columns.length ? 'Tìm và chọn cột...' : 'Chọn bảng trước'}
          disabled={disabled || loading}
          className="w-full px-3 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
        />
        {loading && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-gray-400" />}

        {/* Suggestion dropdown */}
        {open && suggestions.length > 0 && (
          <div className="absolute z-20 top-full left-0 right-0 mt-0.5 bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
            {suggestions.map(c => (
              <button
                key={c.name}
                type="button"
                onMouseDown={e => { e.preventDefault(); addCol(c.name); }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-blue-50"
              >
                <span className="text-xs text-gray-800">{c.name}</span>
                <span className="text-xs text-gray-400 font-mono ml-2">{c.type}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected.length === 0 && !loading && (
        <p className="text-xs text-gray-400">Để trống = lấy tất cả cột (*)</p>
      )}
    </div>
  );
}

function ColSelect({
  value, onChange, columns, placeholder, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  columns: { name: string; type: string }[];
  placeholder: string;
  disabled?: boolean;
}) {
  if (columns.length === 0) {
    // Fallback text input when columns not loaded
    return (
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
        disabled={disabled}
      />
    );
  }
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
      disabled={disabled}
    >
      <option value="">{placeholder}</option>
      {columns.map(c => (
        <option key={c.name} value={c.name}>{c.name} <span className="text-gray-400">({c.type})</span></option>
      ))}
    </select>
  );
}

function JoinRow({
  join, tables, baseTable, leftTableColumns, rightTableColumns, onChange, onRemove, disabled,
}: {
  join: JoinSpec;
  tables: string[];
  baseTable: string;
  leftTableColumns: { name: string; type: string }[];
  rightTableColumns: { name: string; type: string }[];
  onChange: (j: JoinSpec) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const handleTableChange = (tbl: string) => {
    const sugg = suggestJoinKeys(baseTable, tbl);
    onChange({ ...join, joinTable: tbl, leftKey: sugg.left, rightKey: sugg.right });
  };

  const candidates = tables
    .filter(t => t !== baseTable)
    .map(t => ({ name: t, score: scoreJoinCandidate(baseTable, t) }))
    .sort((a, b) => b.score - a.score);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 mb-2 space-y-2">
      {/* Row 1: JOIN type + table + remove */}
      <div className="flex items-center gap-2">
        <select
          value={join.joinType}
          onChange={e => onChange({ ...join, joinType: e.target.value as JoinSpec['joinType'] })}
          className="border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 shrink-0"
          disabled={disabled}
        >
          <option value="LEFT">LEFT JOIN</option>
          <option value="INNER">INNER JOIN</option>
          <option value="RIGHT">RIGHT JOIN</option>
        </select>
        <select
          value={join.joinTable}
          onChange={e => handleTableChange(e.target.value)}
          className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={disabled}
        >
          <option value="">Chọn bảng JOIN...</option>
          {candidates.map(c => (
            <option key={c.name} value={c.name}>
              {c.score >= 2 ? '⭐ ' : ''}{c.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={onRemove} className="text-red-400 hover:text-red-600 shrink-0" disabled={disabled}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Row 2: ON condition — only show once join table selected */}
      {join.joinTable && (
        <div className="flex items-center gap-2 pl-3 border-l-2 border-blue-200">
          <span className="text-xs font-mono text-blue-500 shrink-0">ON</span>
          <ColSelect
            value={join.leftKey}
            onChange={v => onChange({ ...join, leftKey: v })}
            columns={leftTableColumns}
            placeholder={`cột của ${baseTable}`}
            disabled={disabled}
          />
          <span className="text-xs text-gray-400 shrink-0">=</span>
          <ColSelect
            value={join.rightKey}
            onChange={v => onChange({ ...join, rightKey: v })}
            columns={rightTableColumns}
            placeholder={`cột của ${join.joinTable}`}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

/** Wrapper that fetches right-table columns via hook (hooks can't be called conditionally) */
function JoinRowWithColumns({
  join, tables, baseTable, baseColumns, datasourceId, onChange, onRemove, disabled,
}: {
  join: JoinSpec;
  tables: string[];
  baseTable: string;
  baseColumns: { name: string; type: string }[];
  datasourceId: number | null;
  onChange: (j: JoinSpec) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const { data: rightCols } = useDatasourceTableColumns(datasourceId, join.joinTable || null);
  return (
    <JoinRow
      join={join}
      tables={tables}
      baseTable={baseTable}
      leftTableColumns={baseColumns}
      rightTableColumns={rightCols ?? []}
      onChange={onChange}
      onRemove={onRemove}
      disabled={disabled}
    />
  );
}

// ─── Visual SQL parser ────────────────────────────────────────────────────────
// Detects whether stored SQL was generated by the visual builder and restores state.
// Visual builder SQL has a very specific format:
//   SELECT "col1", "col2"\nFROM "table"\nLEFT JOIN ...\nORDER BY ...\nLIMIT N
// Manual SQL won't match → falls back to advanced mode.

interface ParsedVisualState {
  baseTable: string;
  columns: string[];
  joins: Omit<JoinSpec, 'id'>[];
  sortField: string;
  sortDir: 'ASC' | 'DESC';
  limit: string;
}

function parseVisualSql(sql: string): ParsedVisualState | null {
  const s = sql.trim();
  if (!s) return null;
  // Must start with SELECT … \nFROM "table"
  const sfm = /^SELECT\s+([\s\S]+?)\nFROM\s+"((?:[^"]|"")*)"/i.exec(s);
  if (!sfm) return null;

  const colsPart = sfm[1].trim();
  const baseTable = sfm[2].replace(/""/g, '"');

  // Columns: either * or "col1", "col2", …
  let columns: string[] = [];
  if (colsPart !== '*') {
    const parts = colsPart.split(',').map(p => p.trim());
    for (const p of parts) {
      if (!p.startsWith('"') || !p.endsWith('"')) return null; // not visual builder format
      columns.push(p.slice(1, -1).replace(/""/g, '"'));
    }
  }

  // JOINs: \n(LEFT|INNER|RIGHT) JOIN "table" ON "base"."leftKey" = "join"."rightKey"
  const joins: Omit<JoinSpec, 'id'>[] = [];
  const joinRx = /\n(LEFT|INNER|RIGHT)\s+JOIN\s+"((?:[^"]|"")*)"\s+ON\s+"(?:[^"]|"")*"\."((?:[^"]|"")*)"\s*=\s*"(?:[^"]|"")*"\."((?:[^"]|"")*)"/gi;
  let jm: RegExpExecArray | null;
  while ((jm = joinRx.exec(s)) !== null) {
    joins.push({
      joinType: jm[1].toUpperCase() as 'LEFT' | 'INNER' | 'RIGHT',
      joinTable: jm[2].replace(/""/g, '"'),
      leftKey: jm[3].replace(/""/g, '"'),
      rightKey: jm[4].replace(/""/g, '"'),
    });
  }

  // ORDER BY: \nORDER BY "col" ASC|DESC
  let sortField = '';
  let sortDir: 'ASC' | 'DESC' = 'ASC';
  const obm = /\nORDER BY\s+"((?:[^"]|"")*)"\s+(ASC|DESC)/i.exec(s);
  if (obm) { sortField = obm[1].replace(/""/g, '"'); sortDir = obm[2].toUpperCase() as 'ASC' | 'DESC'; }

  // LIMIT: \nLIMIT N
  const lm = /\nLIMIT\s+(\d+)/i.exec(s);

  return { baseTable, columns, joins, sortField, sortDir, limit: lm ? lm[1] : '' };
}

// ─── Main component ───────────────────────────────────────────────────────────

export function QueryTableTab({
  onAddTable,
  isLoading,
  lockDatasource = false,
  lockedDatasourceName = '',
  initialDatasourceId,
  initialDisplayName = '',
  initialQuery = '',
  onSave,
  saveError,
}: QueryTableTabProps) {
  // Common
  const [selectedDatasourceId, setSelectedDatasourceId] = useState<number | null>(
    initialDatasourceId ?? null,
  );
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [query, setQuery] = useState(initialQuery);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Parse existing SQL once at mount to restore visual builder state.
  // If SQL was built by the visual builder, default to 'visual'; otherwise 'advanced'.
  const [vInit] = useState(() => {
    const v = parseVisualSql(initialQuery);
    return {
      mode: (v ? 'visual' : initialQuery ? 'advanced' : 'visual') as 'visual' | 'advanced',
      baseTable: v?.baseTable ?? '',
      columns: v?.columns ?? [],
      joins: (v?.joins ?? []).map(j => ({ ...j, id: Math.random().toString(36).slice(2) })) as JoinSpec[],
      sortField: v?.sortField ?? '',
      sortDir: (v?.sortDir ?? 'ASC') as 'ASC' | 'DESC',
      limit: v?.limit ?? '',
    };
  });

  const [mode, setMode] = useState<'visual' | 'advanced'>(vInit.mode);
  const [vBaseTable, setVBaseTable] = useState<string>(vInit.baseTable);
  const [vColumns, setVColumns] = useState<string[]>(vInit.columns);
  const [vJoins, setVJoins] = useState<JoinSpec[]>(vInit.joins);
  const [vSortField, setVSortField] = useState(vInit.sortField);
  const [vSortDir, setVSortDir] = useState<'ASC' | 'DESC'>(vInit.sortDir);
  const [vLimit, setVLimit] = useState<string>(vInit.limit);

  const { data: datasources, isLoading: loadingDatasources } = useDataSources();
  const { data: schemaTables, isLoading: loadingTables } = useDatasourceTables(selectedDatasourceId);
  const { data: tableColumns, isLoading: loadingColumns } = useDatasourceTableColumns(
    selectedDatasourceId,
    vBaseTable || null,
  );

  const tableNames: string[] = (schemaTables ?? []).map((t: any) => t.name ?? t.table_name ?? String(t));
  const availableColumns: { name: string; type: string }[] = tableColumns ?? [];

  // Wrap an identifier in double-quotes, escaping any embedded double-quotes.
  // Required so table names that contain spaces or special characters
  // (e.g. "Data Warehouse", "Sales - Q1") produce valid SQL identifiers.
  const quoteSqlId = (name: string) => `"${name.replace(/"/g, '""')}"`;

  // Generate SQL from visual builder state
  const generateSql = useCallback((): string => {
    if (!vBaseTable) return '';
    const colList = vColumns.length > 0 ? vColumns.map(c => `"${c}"`).join(', ') : '*';
    const qBase = quoteSqlId(vBaseTable);
    let sql = `SELECT ${colList}\nFROM ${qBase}`;
    for (const j of vJoins) {
      if (j.joinTable && j.leftKey && j.rightKey) {
        const qJoin = quoteSqlId(j.joinTable);
        sql += `\n${j.joinType} JOIN ${qJoin} ON ${qBase}."${j.leftKey}" = ${qJoin}."${j.rightKey}"`;
      }
    }
    if (vSortField.trim()) sql += `\nORDER BY "${vSortField.trim()}" ${vSortDir}`;
    const lim = parseInt(vLimit);
    if (!isNaN(lim) && lim > 0) sql += `\nLIMIT ${lim}`;
    return sql;
  }, [vBaseTable, vColumns, vJoins, vSortField, vSortDir, vLimit]);

  // Sync visual → query state
  useEffect(() => {
    if (mode === 'visual') {
      const generated = generateSql();
      if (generated) setQuery(generated);
    }
  }, [mode, generateSql]);

  const validateQuery = (sql: string): string | null => {
    const trimmed = sql.trim();
    if (!trimmed) return 'Query không được để trống';
    if (!trimmed.toLowerCase().startsWith('select')) return 'Query phải bắt đầu bằng SELECT';
    const dangerous = ['delete', 'drop', 'truncate', 'alter', 'create', 'insert', 'update'];
    for (const kw of dangerous) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(trimmed)) return `Từ khóa không được phép: ${kw.toUpperCase()}`;
    }
    if (trimmed.includes(';')) return 'Không được dùng nhiều câu lệnh (dấu ;)';
    if (trimmed.includes('--') || trimmed.includes('/*')) return 'Không được dùng comment SQL';
    return null;
  };

  const handleAdd = async () => {
    if (!selectedDatasourceId || !displayName.trim()) return;
    const finalQuery = mode === 'visual' ? generateSql() : query;
    const err = validateQuery(finalQuery);
    if (err) { setValidationError(err); return; }
    setValidationError(null);
    if (lockDatasource && onSave) {
      onSave(displayName.trim(), finalQuery.trim());
    } else if (onAddTable) {
      await onAddTable({
        datasource_id: selectedDatasourceId,
        source_kind: 'sql_query',
        source_query: finalQuery.trim(),
        display_name: displayName.trim(),
        enabled: true,
      });
    }
  };

  const canAdd = selectedDatasourceId && displayName.trim() &&
    (mode === 'advanced' ? query.trim() : vBaseTable) && !isLoading;

  return (
    <div className="p-6 space-y-5">
      {/* Datasource */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Datasource *</label>
        {lockDatasource ? (
          <input
            type="text"
            value={lockedDatasourceName}
            readOnly
            className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
          />
        ) : (
          <select
            value={selectedDatasourceId ?? ''}
            onChange={e => {
              setSelectedDatasourceId(Number(e.target.value) || null);
              setVBaseTable(''); setVColumns([]); setVJoins([]);
            }}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loadingDatasources || isLoading}
          >
            <option value="">Chọn datasource...</option>
            {datasources?.map(ds => (
              <option key={ds.id} value={ds.id}>{ds.name} ({ds.type})</option>
            ))}
          </select>
        )}
      </div>

      {/* Display name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Tên hiển thị *</label>
        <input
          type="text"
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder="vd: Doanh thu tháng"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
        />
      </div>

      {/* Visual Builder / Advanced toggle */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-700">
            {mode === 'visual' ? 'Visual Query Builder' : 'SQL Query *'}
          </label>
          <button
            type="button"
            onClick={() => setMode(m => m === 'visual' ? 'advanced' : 'visual')}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
          >
            <Code className="w-3.5 h-3.5" />
            {mode === 'visual' ? 'Chuyển sang SQL nâng cao' : 'Dùng Visual Builder'}
          </button>
        </div>

        {mode === 'visual' ? (
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-4">
            {/* Base table */}
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Bảng nguồn *</label>
              {!selectedDatasourceId ? (
                <p className="text-xs text-gray-400 italic">Chọn datasource trước</p>
              ) : loadingTables ? (
                <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Đang tải danh sách bảng...</div>
              ) : (
                <select
                  value={vBaseTable}
                  onChange={e => { setVBaseTable(e.target.value); setVColumns([]); setVJoins([]); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isLoading}
                >
                  <option value="">Chọn bảng...</option>
                  {tableNames.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
            </div>

            {vBaseTable && (
              <>
                {/* Column picker */}
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Cột cần lấy
                  </label>
                  <ColumnTagAutocomplete
                    columns={availableColumns}
                    selected={vColumns}
                    onChange={setVColumns}
                    loading={loadingColumns}
                    disabled={isLoading}
                  />
                </div>

                {/* JOIN */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-gray-600">JOIN (tuỳ chọn)</label>
                    <button
                      type="button"
                      disabled={isLoading || tableNames.length < 2}
                      onClick={() => {
                        const sugg = suggestJoinKeys(vBaseTable, '');
                        setVJoins(js => [...js, {
                          id: Math.random().toString(36).slice(2),
                          joinType: 'LEFT',
                          joinTable: '',
                          leftKey: sugg.left,
                          rightKey: sugg.right,
                        }]);
                      }}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40"
                    >
                      <Plus className="w-3.5 h-3.5" /> Thêm JOIN
                    </button>
                  </div>
                  {vJoins.map((j, idx) => (
                    <JoinRowWithColumns
                      key={j.id}
                      join={j}
                      tables={tableNames}
                      baseTable={vBaseTable}
                      baseColumns={availableColumns}
                      datasourceId={selectedDatasourceId}
                      onChange={updated => setVJoins(js => js.map((x, i) => i === idx ? updated : x))}
                      onRemove={() => setVJoins(js => js.filter((_, i) => i !== idx))}
                      disabled={isLoading}
                    />
                  ))}
                </div>

                {/* Sort + Limit */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Sắp xếp theo</label>
                    <input
                      type="text"
                      value={vSortField}
                      onChange={e => setVSortField(e.target.value)}
                      placeholder="tên cột (tuỳ chọn)"
                      className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      disabled={isLoading}
                    />
                  </div>
                  {vSortField && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1">Thứ tự</label>
                      <select
                        value={vSortDir}
                        onChange={e => setVSortDir(e.target.value as 'ASC' | 'DESC')}
                        className="px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                        disabled={isLoading}
                      >
                        <option value="ASC">ASC ↑</option>
                        <option value="DESC">DESC ↓</option>
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">
                      Giới hạn dòng
                    </label>
                    <input
                      type="number"
                      value={vLimit}
                      onChange={e => setVLimit(e.target.value)}
                      placeholder="không giới hạn"
                      min={1}
                      className="w-32 px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      disabled={isLoading}
                    />
                  </div>
                </div>

                {/* Generated SQL preview */}
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">SQL được tạo tự động</label>
                  <pre className="bg-white border border-gray-200 rounded-md p-3 text-xs font-mono text-gray-700 overflow-x-auto whitespace-pre-wrap max-h-32">
                    {generateSql() || '— Chưa đủ thông tin —'}
                  </pre>
                </div>
              </>
            )}
          </div>
        ) : (
          /* Advanced SQL textarea */
          <div>
            <textarea
              value={query}
              onChange={e => { setQuery(e.target.value); setValidationError(null); }}
              placeholder={`SELECT\n  order_id,\n  customer_name,\n  total_amount\nFROM orders\nWHERE order_date >= '2024-01-01'`}
              className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 font-mono text-sm h-56 resize-y ${
                validationError ? 'border-red-300 focus:ring-red-500' : 'border-gray-300 focus:ring-blue-500'
              }`}
              disabled={isLoading}
            />
            {validationError && (
              <div className="mt-2 flex items-start gap-2 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{validationError}</span>
              </div>
            )}
            <div className="mt-2 space-y-0.5">
              <p className="text-xs text-gray-500">• Chỉ cho phép câu lệnh SELECT</p>
              <p className="text-xs text-gray-500">• Không dùng dấu ; hoặc comment SQL</p>
            </div>
          </div>
        )}
      </div>

      {/* Action */}
      <div className="flex justify-end pt-2 border-t">
        {saveError && (
          <div className="flex-1 flex items-start gap-2 text-red-600 text-sm mr-4">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{saveError}</span>
          </div>
        )}
        <button
          onClick={handleAdd}
          disabled={!canAdd}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          {lockDatasource ? 'Lưu thay đổi' : 'Thêm bảng'}
        </button>
      </div>
    </div>
  );
}
