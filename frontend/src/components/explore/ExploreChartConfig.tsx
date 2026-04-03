'use client';

import React, { useCallback, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { CHART_PALETTES, type ChartPaletteName } from '@/lib/chartColors';

// ── Types ─────────────────────────────────────────────────────────────────────
export type ExploreChartType =
  | 'TABLE' | 'BAR' | 'HORIZONTAL_BAR' | 'GROUPED_BAR' | 'STACKED_BAR'
  | 'LINE' | 'AREA' | 'TIME_SERIES' | 'BAR_LINE'
  | 'PIE' | 'SCATTER' | 'KPI';

export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

export type NumberFormat = 'auto' | 'number' | 'compact' | 'percent' | 'currency';
export type LegendPosition = 'top' | 'bottom' | 'left' | 'right' | 'none';

export interface MetricConfig {
  field: string;
  agg: AggFn;
}

export interface ChartStyleConfig {
  // Data labels
  showDataLabels?: boolean;
  dataLabelPosition?: 'top' | 'center' | 'inside' | 'outside';
  // Number formatting
  numberFormat?: NumberFormat;
  currencySymbol?: string;
  decimalPlaces?: number;
  // Axis
  xAxisLabel?: string;
  yAxisLabel?: string;
  yAxisMin?: number | '';
  yAxisMax?: number | '';
  // Legend
  legendPosition?: LegendPosition;
  // Grid
  showGrid?: boolean;
  // Palette
  palette?: ChartPaletteName;
  // Font
  fontSize?: number;
  // Bar
  barRadius?: number;
  // Line
  showDots?: boolean;
  lineStyle?: 'solid' | 'dashed';
}

export const DEFAULT_STYLE_CONFIG: ChartStyleConfig = {
  showDataLabels: false,
  dataLabelPosition: 'top',
  numberFormat: 'compact',
  currencySymbol: '$',
  decimalPlaces: 1,
  xAxisLabel: '',
  yAxisLabel: '',
  yAxisMin: '',
  yAxisMax: '',
  legendPosition: 'bottom',
  showGrid: true,
  palette: 'default',
  fontSize: 12,
  barRadius: 4,
  showDots: true,
  lineStyle: 'solid',
};

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
const CHART_TYPE_GRID: { value: ExploreChartType; label: string; icon: string }[] = [
  { value: 'TABLE',          label: 'Table',          icon: '📋' },
  { value: 'BAR',            label: 'Bar',            icon: '📊' },
  { value: 'HORIZONTAL_BAR', label: 'Horizontal Bar', icon: '📊' },
  { value: 'GROUPED_BAR',    label: 'Grouped Bar',    icon: '📊' },
  { value: 'STACKED_BAR',    label: 'Stacked Bar',    icon: '📊' },
  { value: 'BAR_LINE',       label: 'Bar + Line',     icon: '📈' },
  { value: 'LINE',           label: 'Line',           icon: '📈' },
  { value: 'AREA',           label: 'Area',           icon: '📈' },
  { value: 'TIME_SERIES',    label: 'Time Series',    icon: '📈' },
  { value: 'PIE',            label: 'Pie',            icon: '🍩' },
  { value: 'SCATTER',        label: 'Scatter',        icon: '⊙' },
  { value: 'KPI',            label: 'KPI',            icon: '🔢' },
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

// ── Disclosure (collapsible section) ──────────────────────────────────────────
function Disclosure({ title, defaultOpen = false, children }: {
  title: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-gray-100 pt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-1 group"
      >
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-2 space-y-3">{children}</div>}
    </div>
  );
}

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-xs font-semibold text-gray-600">{label}</label>
      <button onClick={() => onChange(!checked)}
        className={`relative w-8 h-4.5 rounded-full transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
    </div>
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
  styleConfig: ChartStyleConfig;
  availableColumns: Col[];
  onChartTypeChange: (t: ExploreChartType) => void;
  onRoleConfigChange: (c: ChartRoleConfig) => void;
  onStyleConfigChange: (c: ChartStyleConfig) => void;
}

export function ExploreChartConfig({
  chartType, roleConfig, styleConfig, availableColumns, onChartTypeChange, onRoleConfigChange, onStyleConfigChange,
}: ExploreChartConfigProps) {
  const upd = useCallback(
    (patch: Partial<ChartRoleConfig>) => onRoleConfigChange({ ...roleConfig, ...patch }),
    [roleConfig, onRoleConfigChange]
  );
  const updStyle = useCallback(
    (patch: Partial<ChartStyleConfig>) => onStyleConfigChange({ ...styleConfig, ...patch }),
    [styleConfig, onStyleConfigChange]
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

  const isBarType = ['BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'BAR_LINE'].includes(chartType);
  const isLineType = ['LINE', 'TIME_SERIES', 'AREA', 'BAR_LINE'].includes(chartType);
  const hasAxis = !['PIE', 'KPI', 'TABLE'].includes(chartType);

  return (
    <div className="p-4 space-y-3">

      {/* ── Chart Type ── visual grid ── */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Chart Type</p>
        <div className="grid grid-cols-4 gap-1">
          {CHART_TYPE_GRID.map(({ value, label, icon }) => (
            <button key={value} onClick={() => onChartTypeChange(value)}
              className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-md text-[10px] leading-tight transition-colors border
                ${chartType === value
                  ? 'border-blue-400 bg-blue-50 text-blue-700 font-semibold'
                  : 'border-transparent hover:bg-gray-50 text-gray-600'
                }`}
              title={label}
            >
              <span className="text-sm">{icon}</span>
              <span className="truncate w-full text-center">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── TABLE: column picker ── */}
      {chartType === 'TABLE' && availableColumns.length > 0 && (
        <Disclosure title="Columns" defaultOpen>
          <div className="flex items-center justify-between mb-1">
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
        </Disclosure>
      )}

      {/* ── Field Mapping ── */}
      {chartType !== 'TABLE' && (
        <Disclosure title="Field Mapping" defaultOpen>

          {(chartType === 'BAR' || chartType === 'HORIZONTAL_BAR') && <>
            <SelectSlot label={chartType === 'HORIZONTAL_BAR' ? 'Y Axis' : 'X Axis'} hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label={chartType === 'HORIZONTAL_BAR' ? 'Values (X)' : 'Values (Y)'} required value={roleConfig.metrics} options={numOrAll}
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

          {chartType === 'BAR_LINE' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Bar Values" hint="shown as bars" required value={roleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Line Value" hint="shown as line" required value={brk} options={numOrAll.map(c => ({ ...c }))}
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

        </Disclosure>
      )}

      {/* ── Appearance: General ── */}
      {chartType !== 'TABLE' && (
        <Disclosure title="General" defaultOpen>
          {/* Color palette — compact horizontal row */}
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1.5 block">Color Palette</label>
            <div className="space-y-1">
              {CHART_PALETTES.map(p => (
                <button key={p.name} onClick={() => updStyle({ palette: p.name })}
                  className={`w-full flex items-center gap-2 px-2 py-1 rounded-md border text-xs transition-colors ${
                    (styleConfig.palette || 'default') === p.name
                      ? 'border-blue-400 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className="flex gap-0.5">
                    {p.colors.slice(0, 6).map((c, i) => (
                      <div key={i} className="w-3 h-3 rounded-sm" style={{ backgroundColor: c }} />
                    ))}
                  </div>
                  <span className="text-gray-700">{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Data labels */}
          {chartType !== 'KPI' && chartType !== 'SCATTER' && (
            <Toggle label="Data Labels" checked={styleConfig.showDataLabels ?? false}
              onChange={v => updStyle({ showDataLabels: v })} />
          )}

          {/* Number format */}
          {chartType !== 'KPI' && (
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Number Format</label>
              <select value={styleConfig.numberFormat || 'compact'}
                onChange={e => updStyle({ numberFormat: e.target.value as NumberFormat })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white">
                <option value="auto">Auto (raw)</option>
                <option value="compact">Compact (1.2K, 3.4M)</option>
                <option value="number">Full Number (1,234)</option>
                <option value="percent">Percent (%)</option>
                <option value="currency">Currency ($)</option>
              </select>
            </div>
          )}

          {/* Legend position */}
          {chartType !== 'KPI' && (
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Legend</label>
              <select value={styleConfig.legendPosition || 'bottom'}
                onChange={e => updStyle({ legendPosition: e.target.value as LegendPosition })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white">
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
                <option value="none">Hidden</option>
              </select>
            </div>
          )}

          <Toggle label="Grid Lines" checked={styleConfig.showGrid ?? true}
            onChange={v => updStyle({ showGrid: v })} />
        </Disclosure>
      )}

      {/* ── Appearance: Axis ── */}
      {hasAxis && (
        <Disclosure title="Axis">
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">X Axis Label</label>
            <input type="text" value={styleConfig.xAxisLabel || ''} placeholder="auto"
              onChange={e => updStyle({ xAxisLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Y Axis Label</label>
            <input type="text" value={styleConfig.yAxisLabel || ''} placeholder="auto"
              onChange={e => updStyle({ yAxisLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Y Min</label>
              <input type="number" value={styleConfig.yAxisMin ?? ''} placeholder="auto"
                onChange={e => updStyle({ yAxisMin: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Y Max</label>
              <input type="number" value={styleConfig.yAxisMax ?? ''} placeholder="auto"
                onChange={e => updStyle({ yAxisMax: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Font Size: {styleConfig.fontSize || 12}px</label>
            <input type="range" min={9} max={18} step={1} value={styleConfig.fontSize || 12}
              onChange={e => updStyle({ fontSize: Number(e.target.value) })}
              className="w-full h-1.5 bg-gray-200 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
        </Disclosure>
      )}

      {/* ── Appearance: Bar options ── */}
      {isBarType && (
        <Disclosure title="Bar Options">
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Bar Radius: {styleConfig.barRadius ?? 4}px</label>
            <input type="range" min={0} max={12} step={1} value={styleConfig.barRadius ?? 4}
              onChange={e => updStyle({ barRadius: Number(e.target.value) })}
              className="w-full h-1.5 bg-gray-200 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
        </Disclosure>
      )}

      {/* ── Appearance: Line options ── */}
      {isLineType && (
        <Disclosure title="Line Options">
          <Toggle label="Show Dots" checked={styleConfig.showDots ?? true}
            onChange={v => updStyle({ showDots: v })} />
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Line Style</label>
            <select value={styleConfig.lineStyle || 'solid'}
              onChange={e => updStyle({ lineStyle: e.target.value as 'solid' | 'dashed' })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white">
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
            </select>
          </div>
        </Disclosure>
      )}
    </div>
  );
}
