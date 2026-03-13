'use client';

import React, { useCallback } from 'react';
import { X } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────
export type ExploreChartType =
  | 'TABLE' | 'BAR' | 'GROUPED_BAR' | 'STACKED_BAR'
  | 'LINE' | 'AREA' | 'TIME_SERIES'
  | 'PIE' | 'SCATTER' | 'KPI';

export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

export interface MetricConfig {
  field: string;
  agg: AggFn;
}

export interface ChartRoleConfig {
  dimension?: string;
  metrics: MetricConfig[];
  breakdown?: string;
  timeField?: string;
  scatterX?: string;
  scatterY?: string;
  /** For TABLE type: which columns to show. undefined = show all */
  selectedColumns?: string[];
}

export const EMPTY_ROLE_CONFIG: ChartRoleConfig = { metrics: [] };

/** Display label e.g. "SUM of revenue" */
export function metricLabel(m: MetricConfig): string {
  const aggName = m.agg === 'count_distinct' ? 'COUNT DISTINCT' : m.agg.toUpperCase();
  return `${aggName} of ${m.field}`;
}

/** recharts dataKey for a MetricConfig */
export function metricKey(m: MetricConfig): string {
  return `${m.agg}__${m.field}`;
}

// ── Chart type list ───────────────────────────────────────────────────────────
const CHART_TYPE_GRID: { value: ExploreChartType; label: string }[] = [
  { value: 'TABLE',       label: 'Table' },
  { value: 'BAR',         label: 'Bar' },
  { value: 'GROUPED_BAR', label: 'Grouped Bar' },
  { value: 'STACKED_BAR', label: 'Stacked Bar' },
  { value: 'LINE',        label: 'Line' },
  { value: 'AREA',        label: 'Area' },
  { value: 'TIME_SERIES', label: 'Time Series' },
  { value: 'PIE',         label: 'Pie' },
  { value: 'SCATTER',     label: 'Scatter' },
  { value: 'KPI',         label: 'KPI' },
];

const AGG_OPTIONS: { value: AggFn; label: string }[] = [
  { value: 'sum',            label: 'SUM' },
  { value: 'avg',            label: 'AVG' },
  { value: 'count',          label: 'COUNT' },
  { value: 'min',            label: 'MIN' },
  { value: 'max',            label: 'MAX' },
  { value: 'count_distinct', label: 'COUNT DISTINCT' },
];

// ── Column helpers ────────────────────────────────────────────────────────────
type Col = { name: string; type: string };

function isNumeric(c: Col): boolean {
  return ['number', 'integer', 'float', 'double', 'decimal', 'bigint'].includes(
    (c.type ?? '').toLowerCase()
  );
}

function isTimelike(c: Col): boolean {
  const n = c.name.toLowerCase();
  return (
    ['date', 'datetime', 'timestamp', 'time'].includes((c.type ?? '').toLowerCase()) ||
    /(date|time|_at|created|updated|day|month|year|start|end|deadline)/.test(n)
  );
}

// ── SelectSlot ────────────────────────────────────────────────────────────────
function SelectSlot({
  label, required, hint, value, options, placeholder = '— none —', onChange,
}: {
  label: string; required?: boolean; hint?: string; value: string;
  options: Col[]; placeholder?: string; onChange: (v: string) => void;
}) {
  const missing = required && !value;
  return (
    <div>
      <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1">
        {label}
        {required && <span className="text-red-400">*</span>}
        {hint && <span className="text-gray-400 font-normal">— {hint}</span>}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`w-full px-2 py-1.5 text-xs border rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 ${
          missing ? 'border-red-300 bg-red-50' : 'border-gray-300'
        }`}
      >
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
      </select>
    </div>
  );
}

// ── MetricSlot — PowerBI-style pill with per-field aggregation ────────────────
function MetricSlot({
  label, required, hint, single, value, options, onChange,
}: {
  label: string; required?: boolean; hint?: string;
  single?: boolean;
  value: MetricConfig[]; options: Col[];
  onChange: (v: MetricConfig[]) => void;
}) {
  const missing = required && value.length === 0;

  const addField = (fieldName: string) => {
    if (!fieldName) return;
    if (value.find(m => m.field === fieldName)) return;
    const next: MetricConfig = { field: fieldName, agg: 'sum' };
    onChange(single ? [next] : [...value, next]);
  };

  const removeField = (fieldName: string) => onChange(value.filter(m => m.field !== fieldName));

  const changeAgg = (fieldName: string, agg: AggFn) =>
    onChange(value.map(m => m.field === fieldName ? { ...m, agg } : m));

  const available = options.filter(o => !value.find(m => m.field === o.name));

  return (
    <div>
      <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1.5">
        {label}
        {required && <span className="text-red-400">*</span>}
        {hint && <span className="text-gray-400 font-normal">— {hint}</span>}
      </label>

      {/* Metric pills */}
      {value.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {value.map(m => (
            <div key={m.field}
              className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md border border-blue-200 bg-blue-50"
            >
              <select
                value={m.agg}
                onChange={e => changeAgg(m.field, e.target.value as AggFn)}
                className="text-xs font-bold text-blue-700 bg-transparent border-none outline-none cursor-pointer"
              >
                {AGG_OPTIONS.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
              <span className="flex-1 text-xs text-blue-800 truncate" title={m.field}>{m.field}</span>
              <button onClick={() => removeField(m.field)}
                className="p-0.5 rounded hover:bg-blue-200 text-blue-500 flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add field */}
      {(!single || value.length === 0) && (
        <select
          value=""
          onChange={e => addField(e.target.value)}
          className={`w-full px-2 py-1.5 text-xs border rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 ${
            missing ? 'border-red-300 bg-red-50 text-red-400' : 'border-dashed border-gray-300 text-gray-400'
          }`}
        >
          <option value="">{available.length === 0 ? '— all fields added —' : '+ add field...'}</option>
          {available.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
interface ExploreChartConfigProps {
  chartType: ExploreChartType;
  roleConfig: ChartRoleConfig;
  availableColumns: Col[];
  onChartTypeChange: (t: ExploreChartType) => void;
  onRoleConfigChange: (c: ChartRoleConfig) => void;
}

export function ExploreChartConfig({
  chartType, roleConfig, availableColumns, onChartTypeChange, onRoleConfigChange,
}: ExploreChartConfigProps) {
  const upd = useCallback(
    (patch: Partial<ChartRoleConfig>) => onRoleConfigChange({ ...roleConfig, ...patch }),
    [roleConfig, onRoleConfigChange]
  );

  const allCols  = availableColumns;
  const numCols  = allCols.filter(isNumeric);
  const dimCols  = allCols.filter(c => !isNumeric(c));
  const timeCols = allCols.filter(isTimelike);

  const dimOrAll  = dimCols.length  > 0 ? dimCols  : allCols;
  const numOrAll  = numCols.length  > 0 ? numCols  : allCols;
  const timeOrAll = timeCols.length > 0 ? timeCols : allCols;

  const dim = roleConfig.dimension || '';
  const brk = roleConfig.breakdown || '';
  const tf  = roleConfig.timeField || '';
  const sx  = roleConfig.scatterX  || '';
  const sy  = roleConfig.scatterY  || '';

  return (
    <div className="p-4 space-y-4">

      {/* Chart type dropdown */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Chart Type</p>
        <select
          value={chartType}
          onChange={e => onChartTypeChange(e.target.value as ExploreChartType)}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          {CHART_TYPE_GRID.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {/* TABLE: column visibility picker */}
      {chartType === 'TABLE' && availableColumns.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Columns</p>
            <button
              onClick={() => {
                const allSelected = !roleConfig.selectedColumns || roleConfig.selectedColumns.length === availableColumns.length;
                upd({ selectedColumns: allSelected ? [] : availableColumns.map(c => c.name) });
              }}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              {!roleConfig.selectedColumns || roleConfig.selectedColumns.length === availableColumns.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {availableColumns.map(col => {
              const checked = !roleConfig.selectedColumns || roleConfig.selectedColumns.includes(col.name);
              return (
                <label key={col.name} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-gray-50 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const current = roleConfig.selectedColumns ?? availableColumns.map(c => c.name);
                      const next = checked ? current.filter(n => n !== col.name) : [...current, col.name];
                      upd({ selectedColumns: next });
                    }}
                    className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-xs text-gray-700 truncate flex-1">{col.name}</span>
                  <span className="text-xs text-gray-400 opacity-0 group-hover:opacity-100">{col.type}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Field mapping */}
      {chartType !== 'TABLE' && (
        <div className="space-y-3 pt-2 border-t border-gray-100">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Field Mapping</p>

          {chartType === 'BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="— none —"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'GROUPED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" hint="each = one bar group" required value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'STACKED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value (Y)" required single value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Stack by" required value={brk} options={dimOrAll}
              placeholder="— select field —"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'LINE' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="— none —"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'AREA' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="— none —"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'TIME_SERIES' && <>
            <SelectSlot label="Time Field (X)" required value={tf} options={timeOrAll}
              placeholder="— select time field —"
              onChange={v => upd({ timeField: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="— none —"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'PIE' && <>
            <SelectSlot label="Legend" hint="slice label" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" hint="slice size" required single value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'SCATTER' && <>
            <SelectSlot label="X Axis" hint="numeric" required value={sx} options={numOrAll}
              placeholder="— select X —"
              onChange={v => upd({ scatterX: v || undefined })} />
            <SelectSlot label="Y Axis" hint="numeric" required value={sy} options={numOrAll}
              placeholder="— select Y —"
              onChange={v => upd({ scatterY: v || undefined })} />
            <SelectSlot label="Label" hint="optional" value={dim} options={dimOrAll}
              placeholder="— none —"
              onChange={v => upd({ dimension: v || undefined })} />
          </>}

          {chartType === 'KPI' && <>
            <MetricSlot label="Value" required single value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
          </>}

        </div>
      )}
    </div>
  );
}
