/**
 * DataModelCanvas — Visual ERD viewer for a dataset.
 *
 * Cards start in an auto-computed topology-aware layout (rank by outgoing
 * joins) and can be freely dragged. User drag positions are persisted per
 * model in localStorage. Edges are smooth cubic beziers whose endpoints
 * automatically choose the closest card edge (left/right) — so lines stay
 * clean at any card arrangement.
 */
'use client';

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import {
  BookOpen,
  Loader2,
  RefreshCw,
  Minus,
  ChevronDown,
  ChevronRight,
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  EyeOff,
  Pencil,
  Sigma,
  Plus,
  Trash2,
  Link2,
} from 'lucide-react';
import {
  useDatasetModel,
  useGenerateModel,
  useAddJoin,
  useRemoveJoin,
  useModelLayout,
  useSaveModelLayout,
  type AddJoinParams,
  type DatasetModelView,
  type DatasetModelExplore,
  type MeasureDefinition,
} from '@/hooks/use-dataset-model';
import { RelationshipDialog, type RelationshipDialogValue } from './RelationshipDialog';
import { DatasetDictionaryPanel } from './DatasetDictionaryPanel';
import { AppModalShell } from '@/components/common/AppModalShell';
import { toast } from '@/lib/toast';

// ─── Measure folder grouping ──────────────────────────────────────────────────

function groupMeasuresByFolder(
  measures: MeasureDefinition[],
): { folder: string; items: MeasureDefinition[] }[] {
  const map = new Map<string, MeasureDefinition[]>();
  measures.forEach((m) => {
    const key = m.folder?.trim() || '';
    map.set(key, [...(map.get(key) ?? []), m]);
  });
  const result: { folder: string; items: MeasureDefinition[] }[] = [];
  const ungrouped = map.get('');
  if (ungrouped?.length) result.push({ folder: '', items: ungrouped });
  Array.from(map.entries())
    .filter(([k]) => k !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([folder, items]) => result.push({ folder, items }));
  return result;
}

// ─── Layout constants ────────────────────────────────────────────────────────

const CARD_WIDTH   = 272;
const CARD_GAP_X   = 220;   // horizontal breathing between columns
const CARD_GAP_Y   = 56;    // vertical breathing between rows
const CANVAS_PAD   = 56;
const ROW_HEIGHT   = 360;   // initial card height estimate for auto-layout
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Rank-based auto layout:
 *   - rank 0: views with many outgoing joins (fact-like)   — leftmost column
 *   - rank 1: views with some outgoing joins                — middle column
 *   - rank 2: views with no outgoing joins (leaf dimensions) — rightmost column
 *
 * Ranks are mapped to successive columns with comfortable spacing. When all
 * views fall in the same rank (e.g. no edges yet) we split them into two
 * columns so the canvas doesn't collapse into one.
 */
function computeLayout(
  views: DatasetModelView[],
  explores: DatasetModelExplore[],
): Record<number, { x: number; y: number }> {
  if (!views.length) return {};

  const outgoing: Record<number, number> = {};
  views.forEach((v) => { outgoing[v.id] = 0; });
  explores.forEach((ex) => {
    outgoing[ex.base_view_id] = (outgoing[ex.base_view_id] ?? 0) + ex.joins.length;
  });

  const maxOut = Math.max(0, ...Object.values(outgoing));
  const rankOf = (id: number): number => {
    const o = outgoing[id] ?? 0;
    if (maxOut > 0 && o >= maxOut) return 0;
    if (o > 0) return 1;
    return maxOut > 0 ? 2 : 0;
  };

  const buckets: Record<number, DatasetModelView[]> = {};
  views.forEach((v) => {
    const r = rankOf(v.id);
    (buckets[r] ??= []).push(v);
  });

  let rankKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);

  // No edges at all → spread into two columns for visual balance.
  if (rankKeys.length === 1 && views.length > 1) {
    const all = buckets[rankKeys[0]].slice().sort((a, b) =>
      (a.table_display_name || a.name).localeCompare(b.table_display_name || b.name),
    );
    const half = Math.ceil(all.length / 2);
    buckets[0] = all.slice(0, half);
    buckets[1] = all.slice(half);
    rankKeys = [0, 1];
  }

  const out: Record<number, { x: number; y: number }> = {};
  rankKeys.forEach((r, colIdx) => {
    const col = buckets[r].slice().sort((a, b) =>
      (a.table_display_name || a.name).localeCompare(b.table_display_name || b.name),
    );
    col.forEach((v, i) => {
      out[v.id] = {
        x: CANVAS_PAD + colIdx * (CARD_WIDTH + CARD_GAP_X),
        y: CANVAS_PAD + i * (ROW_HEIGHT + CARD_GAP_Y),
      };
    });
  });
  return out;
}

function cardinalityLabels(rel?: string): { src: string; tgt: string } {
  switch (rel) {
    case 'one_to_one':   return { src: '1', tgt: '1' };
    case 'one_to_many':  return { src: '1', tgt: 'N' };
    case 'many_to_one':  return { src: 'N', tgt: '1' };
    case 'many_to_many': return { src: 'N', tgt: 'N' };
    default:             return { src: 'N', tgt: '1' };
  }
}

/**
 * Cubic bezier path from (sx,sy) exiting in direction sDir (+1 right / −1 left)
 * to (tx,ty) entered in direction tDir. Control-point pull is adaptive to
 * horizontal distance so curves stay gentle at any card arrangement and never
 * "crook" even when endpoints are close together or on the same side.
 */
function bezierControlDistance(sx: number, tx: number): number {
  return Math.max(48, Math.min(180, Math.abs(tx - sx) / 2 + 40));
}

function makeBezierPath(
  sx: number, sy: number, sDir: 1 | -1,
  tx: number, ty: number, tDir: 1 | -1,
): string {
  const d = bezierControlDistance(sx, tx);
  const c1x = sx + sDir * d;
  const c2x = tx + tDir * d;
  return `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`;
}

/** Midpoint of the same bezier at t = 0.5 → (P0 + 3P1 + 3P2 + P3) / 8. */
function bezierMidpoint(
  sx: number, sy: number, sDir: 1 | -1,
  tx: number, ty: number, tDir: 1 | -1,
): { mx: number; my: number } {
  const d = bezierControlDistance(sx, tx);
  const c1x = sx + sDir * d;
  const c2x = tx + tDir * d;
  const mx = (sx + 3 * c1x + 3 * c2x + tx) / 8;
  const my = (sy + 3 * sy + 3 * ty + ty) / 8;
  return { mx, my };
}

function cleanJoinIdentifier(value: string): string {
  return value.replace(/["`[\]]/g, '').trim();
}

/** Parse "${TABLE}.col = ${view}.col" pairs from sql_on string. */
function parseSqlOnPairs(sqlOn: string): { fromCol: string; toCol: string }[] {
  const pairs: { fromCol: string; toCol: string }[] = [];
  const regex = /\$\{TABLE\}\.([^\s=()]+)\s*=\s*\$\{[^}]+\}\.([^\s=()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sqlOn || '')) !== null) {
    pairs.push({
      fromCol: cleanJoinIdentifier(match[1]),
      toCol: cleanJoinIdentifier(match[2]),
    });
  }
  return pairs;
}

function normalizeJoinColumns(join: {
  from_column?: string;
  to_column?: string;
  from_columns?: string[];
  to_columns?: string[];
  sql_on?: string;
}): { fromColumns: string[]; toColumns: string[] } {
  const fromColumns = (join.from_columns ?? [])
    .map((value) => cleanJoinIdentifier(String(value || '')))
    .filter(Boolean);
  const toColumns = (join.to_columns ?? [])
    .map((value) => cleanJoinIdentifier(String(value || '')))
    .filter(Boolean);

  if (fromColumns.length > 0 && fromColumns.length === toColumns.length) {
    return { fromColumns, toColumns };
  }

  const parsedPairs = parseSqlOnPairs(join.sql_on ?? '');
  if (parsedPairs.length > 0) {
    return {
      fromColumns: parsedPairs.map((pair) => pair.fromCol),
      toColumns: parsedPairs.map((pair) => pair.toCol),
    };
  }

  const fallbackFrom = cleanJoinIdentifier(String(join.from_column || ''));
  const fallbackTo = cleanJoinIdentifier(String(join.to_column || ''));
  return {
    fromColumns: fallbackFrom ? [fallbackFrom] : [],
    toColumns: fallbackTo ? [fallbackTo] : [],
  };
}

function summarizeJoinColumns(columns: string[]): string | undefined {
  if (!columns.length) return undefined;
  if (columns.length === 1) return columns[0];
  return `${columns[0]} +${columns.length - 1}`;
}

function getViewLabel(view: Pick<DatasetModelView, 'name' | 'table_display_name'> | null | undefined): string {
  return view?.table_display_name || view?.name || 'Unknown';
}

function isManualRelationshipView(view: DatasetModelView): boolean {
  return view.view_role !== 'calendar_role' && !view.hidden_in_canvas;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function DimIcon({ type }: { type: string }) {
  switch (type) {
    case 'number':   return <Hash className="w-3 h-3 text-brand shrink-0" />;
    case 'date':
    case 'datetime': return <Calendar className="w-3 h-3 text-success shrink-0" />;
    case 'yesno':    return <ToggleLeft className="w-3 h-3 text-brand shrink-0" />;
    default:         return <Type className="w-3 h-3 text-text-quaternary shrink-0" />;
  }
}

interface ViewCardProps {
  view: DatasetModelView;
  onEdit?: () => void;
  isSelected?: boolean;
  relationshipCols?: Set<string>;
  calendarCols?: Set<string>;
  relationDraftTarget?: string | null;
  onStartRelationshipDrag?: (columnName: string, event: React.PointerEvent<HTMLButtonElement>) => void;
}

function ViewCard({
  view,
  onEdit,
  isSelected,
  relationshipCols,
  calendarCols,
  relationDraftTarget,
  onStartRelationshipDrag,
}: ViewCardProps) {
  const [dimsOpen, setDimsOpen] = useState(true);
  const [msrOpen,  setMsrOpen]  = useState(false);
  const emphasizedCols = useMemo(
    () => new Set([...(relationshipCols ?? []), ...(calendarCols ?? [])]),
    [relationshipCols, calendarCols],
  );

  // Join columns always appear FIRST so they're visible at scroll=0
  // (avoids measuring a clipped/off-screen element when the list is long)
  const joinDims  = view.dimensions.filter((d) => emphasizedCols.has(d.name));
  const otherVis  = view.dimensions.filter((d) => !emphasizedCols.has(d.name) && !d.hidden);
  const vis       = [...joinDims, ...otherVis];
  const hid       = view.dimensions.filter((d) =>  d.hidden && !emphasizedCols.has(d.name));
  const visM = view.measures.filter((m) => !m.hidden);

  return (
    <div
      className={`select-none rounded-lg border bg-surface-1 shadow-linear-sm transition-all ${
        isSelected ? 'border-brand/50 ring-2 ring-brand/50 shadow-linear' : 'border-[rgb(var(--border-line))]'
      }`}
      style={{ width: CARD_WIDTH }}
    >
      {/* Header */}
      <div className={`px-3 py-2.5 border-b rounded-t-lg flex items-center justify-between bg-gradient-to-r ${
        isSelected ? 'from-blue-100 to-indigo-100' : 'from-blue-50 to-indigo-50'
      }`}>
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${isSelected ? 'bg-brand' : 'bg-brand'}`} />
          <span className="font-semibold text-sm text-text-primary truncate">
            {getViewLabel(view)}
          </span>
        </div>
        {onEdit && (
          <button
            onClick={onEdit}
            className={`p-1 rounded transition-colors shrink-0 ${
              isSelected
                ? 'bg-brand text-white hover:bg-brand'
                : 'hover:bg-surface-1 text-text-quaternary hover:text-text-secondary'
            }`}
            title={isSelected ? 'Editing this view' : 'Edit this view'}
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Dimensions */}
      <div className="border-b">
        <button
          onClick={() => setDimsOpen(!dimsOpen)}
          className="w-full px-3 py-1.5 flex items-center justify-between text-[10px] font-semibold
            text-text-quaternary uppercase tracking-wider hover:bg-surface-2"
        >
          <span>Dimensions ({vis.length})</span>
          {dimsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {dimsOpen && (
          <div className="px-1.5 pb-1.5 space-y-0.5 max-h-64 overflow-y-auto">
            {vis.map((d) => {
              const isRelationship = relationshipCols?.has(d.name) ?? false;
              const isCalendarJoin = calendarCols?.has(d.name) ?? false;
              const isDropTarget = relationDraftTarget === d.name;
              const canCreateRelationship = isManualRelationshipView(view) && !isCalendarJoin;
              return (
                <div
                  key={d.name}
                  data-view-id={view.id}
                  data-col-name={d.name}
                  className={`group flex items-center gap-1.5 px-2 py-1 rounded text-[11px]${
                    isRelationship
                      ? ' bg-brand/10 border-l-2 border-brand/30 pl-1.5 font-medium'
                      : isCalendarJoin
                        ? ' bg-success/10 border-l-2 border-success/60 pl-1.5'
                      : isDropTarget
                        ? ' bg-brand/10 ring-1 ring-brand/40'
                      : ' hover:bg-surface-2'
                  }`}
                  title={d.sql || d.name}
                >
                  <DimIcon type={d.type} />
                  <span className={`truncate ${
                    isRelationship
                      ? 'text-brand'
                      : isCalendarJoin
                        ? 'text-success'
                        : 'text-text-secondary'
                  }`}>
                    {d.label || d.name}
                  </span>
                  {d.hidden && !isRelationship && !isCalendarJoin && (
                    <span className="ml-auto text-[9px] uppercase tracking-wide text-warning">hidden</span>
                  )}
                  {canCreateRelationship && (
                    <button
                      type="button"
                      data-nodrag
                      onPointerDown={(event) => onStartRelationshipDrag?.(d.name, event)}
                      className={`ml-auto rounded p-0.5 text-brand transition-opacity hover:bg-brand/10 ${
                        isRelationship || isDropTarget ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                      title={`Drag from ${d.name} to create a relationship`}
                    >
                      <Link2 className="h-2.5 w-2.5 shrink-0" />
                    </button>
                  )}
                  {!isRelationship && isCalendarJoin && (
                    <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success">
                      <Calendar className="h-2.5 w-2.5" />
                      Date
                    </span>
                  )}
                </div>
              );
            })}
            {hid.length > 0 && (
              <div className="px-2 py-0.5 text-[11px] text-text-quaternary flex items-center gap-1">
                <EyeOff className="w-2.5 h-2.5" />
                {hid.length} hidden
              </div>
            )}
          </div>
        )}
      </div>

      {/* Measures */}
      <div>
        <button
          onClick={() => setMsrOpen(!msrOpen)}
          className="w-full px-3 py-1.5 flex items-center justify-between text-[10px] font-semibold
            text-text-quaternary uppercase tracking-wider hover:bg-surface-2"
        >
          <span>Measures ({visM.length})</span>
          {msrOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {msrOpen && (
          <div className="px-1.5 pb-1.5 max-h-40 overflow-y-auto">
            {groupMeasuresByFolder(visM).map(({ folder, items }) => (
              <div key={folder || '__ungrouped__'}>
                {folder && (
                  <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-text-quaternary">
                    {folder}
                  </div>
                )}
                <div className="space-y-0.5">
                  {items.map((m) => (
                    <div
                      key={m.name}
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] hover:bg-warning/10"
                    >
                      <Sigma className="w-3 h-3 text-warning shrink-0" />
                      <span className="text-text-secondary truncate">{m.label || m.name}</span>
                      <span className="text-text-quaternary ml-auto text-[9px] uppercase">{m.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Relationship line (SVG) ──────────────────────────────────────────────────

interface RelLineProps {
  /** Absolute canvas coordinates of the connection endpoints */
  sx: number; sy: number;
  tx: number; ty: number;
  /** Exit direction at source (+1 = right, −1 = left) */
  sDir: 1 | -1;
  /** Exit direction at target (+1 = right, −1 = left); points AWAY from card */
  tDir: 1 | -1;
  fromCol?: string;
  toCol?: string;
  relationship?: string;
  joinType: string;
  // Phase-3b: edge controls. `isActive=false` renders dashed + dimmed so the
  // user sees at-a-glance the join is stored but ignored by the engine.
  // `crossFilter='both'` adds a small "↔" badge near the joinType chip.
  isActive?: boolean;
  crossFilter?: 'single' | 'both';
  isSelected: boolean;
  onClick: () => void;
}

function RelLine({
  sx, sy, tx, ty,
  sDir, tDir,
  fromCol, toCol,
  relationship, joinType,
  isActive = true,
  crossFilter = 'single',
  isSelected, onClick,
}: RelLineProps) {
  const [hovered, setHovered] = useState(false);

  const path = makeBezierPath(sx, sy, sDir, tx, ty, tDir);
  const { mx: chipX, my: chipY } = bezierMidpoint(sx, sy, sDir, tx, ty, tDir);
  const { src, tgt } = cardinalityLabels(relationship);
  const active = isSelected || hovered;
  // Phase-3b: dim inactive edges so they're visually muted. Selected /
  // hovered still take precedence so the user can interact with them.
  const stroke = active ? '#6366f1' : (isActive ? '#94a3b8' : '#cbd5e1');

  // Column label pill width (proportional to text length, max 90)
  const fromLW = Math.min(90, (fromCol?.length ?? 0) * 5.8 + 14);
  const toLW   = Math.min(90, (toCol?.length   ?? 0) * 5.8 + 14);

  // Badges sit just outside the card edge in the exit direction
  const srcBadgeX  = sx + sDir * 9;
  const tgtBadgeX  = tx + tDir * 9;

  // Column name pills sit a bit further out
  const srcLabelX  = sx + sDir * (fromLW / 2 + 14);
  const tgtLabelX  = tx + tDir * (toLW  / 2 + 14);

  return (
    <g>
      {/* Hit area (wide transparent stroke) */}
      <path
        d={path}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      />

      {/* Visible line — dashed when inactive OR when selected */}
      <path
        d={path}
        stroke={stroke}
        strokeWidth={active ? 2 : 1.5}
        fill="none"
        strokeDasharray={isSelected ? '6 3' : (!isActive ? '4 4' : undefined)}
        opacity={isActive ? 1 : 0.55}
        style={{ pointerEvents: 'none', transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.15s' }}
      />

      {/* ── Source side ─────────────────────────────── */}

      {/* Column name label — next to source card edge */}
      {fromCol && (
        <g
          transform={`translate(${srcLabelX}, ${sy})`}
          style={{ pointerEvents: 'none' }}
        >
          <rect
            x={-fromLW / 2} y={-8}
            width={fromLW} height={16}
            rx={4}
            fill={active ? '#eef2ff' : '#f8fafc'}
            stroke={active ? '#a5b4fc' : '#e2e8f0'}
            strokeWidth={1}
          />
          <text
            textAnchor="middle" dominantBaseline="central"
            fontSize={7} fontWeight={active ? '700' : '600'}
            fill={active ? '#4338ca' : '#475569'}
          >
            {fromCol.length > 16 ? fromCol.slice(0, 15) + '…' : fromCol}
          </text>
        </g>
      )}

      {/* Cardinality badge — at the source endpoint */}
      <g transform={`translate(${srcBadgeX}, ${sy})`} style={{ pointerEvents: 'none' }}>
        <circle r={9} fill={active ? '#eef2ff' : '#f1f5f9'} stroke={stroke} strokeWidth={active ? 1.5 : 1} />
        <text textAnchor="middle" dominantBaseline="central" fontSize={8} fontWeight="700" fill={active ? '#6366f1' : '#64748b'}>
          {src}
        </text>
      </g>

      {/* ── Target side ─────────────────────────────── */}

      {/* Column name label — next to target card edge */}
      {toCol && (
        <g
          transform={`translate(${tgtLabelX}, ${ty})`}
          style={{ pointerEvents: 'none' }}
        >
          <rect
            x={-toLW / 2} y={-8}
            width={toLW} height={16}
            rx={4}
            fill={active ? '#eef2ff' : '#f8fafc'}
            stroke={active ? '#a5b4fc' : '#e2e8f0'}
            strokeWidth={1}
          />
          <text
            textAnchor="middle" dominantBaseline="central"
            fontSize={7} fontWeight={active ? '700' : '600'}
            fill={active ? '#4338ca' : '#475569'}
          >
            {toCol.length > 16 ? toCol.slice(0, 15) + '…' : toCol}
          </text>
        </g>
      )}

      {/* Cardinality badge — at the target endpoint */}
      <g transform={`translate(${tgtBadgeX}, ${ty})`} style={{ pointerEvents: 'none' }}>
        <circle r={9} fill={active ? '#eef2ff' : '#f1f5f9'} stroke={stroke} strokeWidth={active ? 1.5 : 1} />
        <text textAnchor="middle" dominantBaseline="central" fontSize={8} fontWeight="700" fill={active ? '#6366f1' : '#64748b'}>
          {tgt}
        </text>
      </g>

      {/* ── Join-type chip — rides the bezier midpoint so it tracks the line cleanly ── */}
      <g transform={`translate(${chipX}, ${chipY})`} style={{ pointerEvents: 'none' }}>
        <rect
          x={-22} y={-9} width={44} height={18} rx={9}
          fill={active ? '#6366f1' : (isActive ? '#94a3b8' : '#cbd5e1')}
          opacity={isActive ? 1 : 0.75}
        />
        <text
          textAnchor="middle" dominantBaseline="central"
          fontSize={7} fontWeight="700" fill="white" letterSpacing={0.3}
        >
          {joinType.toUpperCase()}
        </text>
      </g>

      {/* Phase-3b: small badges hugging the join-type chip.
          Inactive → "OFF" pill (left). Bidirectional → "↔" pill (right). */}
      {!isActive && (
        <g transform={`translate(${chipX - 32}, ${chipY})`} style={{ pointerEvents: 'none' }}>
          <rect x={-12} y={-7} width={24} height={14} rx={7} fill="#fde68a" stroke="#f59e0b" strokeWidth={0.6} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={6.5} fontWeight="700" fill="#92400e">
            OFF
          </text>
        </g>
      )}
      {crossFilter === 'both' && (
        <g transform={`translate(${chipX + 32}, ${chipY})`} style={{ pointerEvents: 'none' }}>
          <rect x={-9} y={-7} width={18} height={14} rx={7} fill="#dbeafe" stroke="#3b82f6" strokeWidth={0.6} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight="700" fill="#1d4ed8">
            ↔
          </text>
        </g>
      )}
    </g>
  );
}

// ─── Main Canvas ─────────────────────────────────────────────────────────────

interface DataModelCanvasProps {
  datasetId: number;
  datasetName?: string;
  tables?: { id: number; display_name?: string; source_table_name?: string }[];
  canEdit?: boolean;
  selectedViewId?: number | null;
  onSelectView?: (view: DatasetModelView) => void;
}

interface ModelRelationship {
  fromViewId: number;
  fromViewName: string;
  toViewName: string;
  presentationViewName: string;
  alias?: string;
  joinType: string;
  relationship?: string;
  fromCol?: string;
  toCol?: string;
  fromCols: string[];
  toCols: string[];
  origin?: string;
  managed: boolean;
  // Phase-3b: expose the engine-side controls so the edit dialog can
  // pre-fill them and the canvas can render an "inactive" affordance.
  isActive: boolean;
  crossFilter: 'single' | 'both';
  key: string;
}

interface CalendarLayerBannerProps {
  calendarView: DatasetModelView | null;
  bindings: ModelRelationship[];
  viewsByName: Record<string, DatasetModelView>;
  showCalendarLayer: boolean;
  onToggleCalendarLayer: () => void;
}

function CalendarLayerBanner({
  calendarView,
  bindings,
  viewsByName,
  showCalendarLayer,
  onToggleCalendarLayer,
}: CalendarLayerBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const groupedBindings = useMemo(() => {
    const grouped = new Map<string, { id: number; label: string; fields: string[] }>();

    bindings.forEach((binding) => {
      if (!binding.fromCols.length) return;
      const view = viewsByName[binding.fromViewName];
      const key = String(view?.id ?? binding.fromViewName);
      const current = grouped.get(key) ?? {
        id: view?.id ?? -1,
        label: getViewLabel(view) || binding.fromViewName,
        fields: [],
      };
      current.fields.push(...binding.fromCols);
      grouped.set(key, current);
    });

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        fields: Array.from(new Set(group.fields)).sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => {
        if (b.fields.length !== a.fields.length) return b.fields.length - a.fields.length;
        return a.label.localeCompare(b.label);
      });
  }, [bindings, viewsByName]);

  const previewChips = useMemo(() => {
    const chips: string[] = [];
    groupedBindings.forEach((group) => {
      group.fields.forEach((field) => {
        chips.push(`${group.label}.${field}`);
      });
    });
    return chips.slice(0, 6);
  }, [groupedBindings]);

  if (!calendarView) return null;

  const tableCount = groupedBindings.length;
  const bindingCount = bindings.length;

  return (
    <div className="border-b border-success/20 bg-gradient-to-r from-emerald-50 via-white to-teal-50 px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-success/15 p-2 text-success">
              <Calendar className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-success">
                {getViewLabel(calendarView)} layer {showCalendarLayer ? 'is visible on the canvas' : 'is hidden from the canvas'}
              </div>
              <p className="mt-0.5 text-xs leading-5 text-success/90">
                {bindingCount > 0
                  ? `${bindingCount} temporal column${bindingCount !== 1 ? 's are' : ' is'} auto-linked across ${tableCount} table${tableCount !== 1 ? 's' : ''}. The semantic joins still work behind the scenes; the canvas stays cleaner by default.`
                  : 'The standard date dimension is ready and can be shown on the canvas when you need to inspect it.'}
              </p>
              {previewChips.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {previewChips.map((chip) => (
                    <span
                      key={chip}
                      className="rounded-full border border-success/30 bg-surface-1 px-2 py-0.5 text-[11px] font-medium text-success"
                    >
                      {chip}
                    </span>
                  ))}
                  {bindingCount > previewChips.length && (
                    <span className="rounded-full border border-success/30 bg-surface-1 px-2 py-0.5 text-[11px] font-medium text-success">
                      +{bindingCount - previewChips.length} more
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {groupedBindings.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="rounded-md border border-success/30 bg-surface-1 px-3 py-1.5 text-xs font-medium text-success transition-colors hover:bg-success/10"
            >
              {expanded ? 'Hide mappings' : 'View mappings'}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleCalendarLayer}
            className="rounded-md border border-success/40 bg-success px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-success/90"
          >
            {showCalendarLayer ? 'Hide date layer' : 'Show date layer'}
          </button>
        </div>
      </div>

      {expanded && groupedBindings.length > 0 && (
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {groupedBindings.map((group) => (
            <div
              key={`${group.id}-${group.label}`}
              className="rounded-lg border border-success/30/80 bg-surface-1 px-3 py-2"
            >
              <div className="text-xs font-semibold text-text-primary">{group.label}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {group.fields.map((field) => (
                  <span
                    key={`${group.label}-${field}`}
                    className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
                  >
                    {field}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DataModelCanvas({
  datasetId,
  datasetName = 'Dataset',
  tables = [],
  canEdit = true,
  selectedViewId,
  onSelectView,
}: DataModelCanvasProps) {
  const { data: model, isLoading, error, refetch } = useDatasetModel(datasetId);
  const generateModel = useGenerateModel();
  const addJoin       = useAddJoin();
  const removeJoin    = useRemoveJoin();
  const [showCalendarLayer, setShowCalendarLayer] = useState(false);
  const [dictModalOpen, setDictModalOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [dialogInitialValue, setDialogInitialValue] = useState<Partial<RelationshipDialogValue> | undefined>(undefined);
  const [relationshipDrag, setRelationshipDrag] = useState<{
    fromViewId: number;
    fromColumn: string;
    pointerX: number;
    pointerY: number;
    hoverTarget: { viewId: number; columnName: string } | null;
  } | null>(null);
  const relationshipDragRef = useRef(relationshipDrag);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { relationshipDragRef.current = relationshipDrag; }, [relationshipDrag]);
  const calendarPresentationView = useMemo(
    () => (model?.views ?? []).find((view) => view.view_role === 'calendar_dimension') ?? null,
    [model?.views],
  );
  const hasManualCalendarRelationship = useMemo(() => {
    const calendarViewName = calendarPresentationView?.name;
    if (!calendarViewName) return false;
    return (model?.explores ?? []).some((explore) => {
      const manualJoins = (explore.joins ?? []).filter((join) => join.origin !== 'auto_calendar');
      if (explore.base_view_name === calendarViewName && manualJoins.length > 0) return true;
      return manualJoins.some((join) =>
        join.view === calendarViewName
        || join.presentation_view === calendarViewName
      );
    });
  }, [calendarPresentationView?.name, model?.explores]);
  const visibleViews = useMemo(
    () => (model?.views ?? []).filter((view) => {
      if (view.hidden_in_canvas) return false;
      if (
        !showCalendarLayer
        && view.view_role === 'calendar_dimension'
        && !hasManualCalendarRelationship
      ) {
        return false;
      }
      return true;
    }),
    [hasManualCalendarRelationship, model?.views, showCalendarLayer],
  );
  const layoutExplores = useMemo(
    () => (model?.explores ?? []).map((explore) => ({
      ...explore,
      joins: (explore.joins ?? []).filter((join) => showCalendarLayer || join.origin !== 'auto_calendar'),
    })),
    [model?.explores, showCalendarLayer],
  );

  // Fixed card positions — topology-aware, computed once per model
  const positions = useMemo<Record<number, { x: number; y: number }>>(() => {
    if (!visibleViews.length) return {};
    return computeLayout(visibleViews, layoutExplores);
  }, [model?.model_id, visibleViews, layoutExplores]); // eslint-disable-line react-hooks/exhaustive-deps

  // Phase-4: User-overridden card positions. Persisted SERVER-SIDE via
  // /api/v1/datasets/{id}/model/layout so the layout follows the dataset
  // (not the browser) and stays shared across users. A localStorage write
  // is still kept as a transient fallback while the server save is in
  // flight — purely for snappy UI feedback.
  const { data: serverPositions } = useModelLayout(datasetId);
  const saveLayout = useSaveModelLayout();
  const [userPositions, setUserPositions] = useState<Record<number, { x: number; y: number }>>({});
  const userPositionsRef = useRef(userPositions);
  useEffect(() => { userPositionsRef.current = userPositions; }, [userPositions]);

  // Hydrate userPositions from the server response when it arrives.
  useEffect(() => {
    if (!serverPositions) return;
    const numericKeyed: Record<number, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(serverPositions)) {
      const id = Number(k);
      if (!Number.isFinite(id) || !v) continue;
      numericKeyed[id] = v;
    }
    setUserPositions(numericKeyed);
  }, [serverPositions]);

  const persistPositions = useCallback((next: Record<number, { x: number; y: number }>) => {
    if (!datasetId) return;
    // Stringify keys for transport — server schema uses {view_id: {x, y}}
    const payload: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of Object.entries(next)) {
      payload[String(id)] = pos;
    }
    saveLayout.mutate({ datasetId, positions: payload });
  }, [datasetId, saveLayout]);

  const effectivePositions = useMemo<Record<number, { x: number; y: number }>>(() => {
    const merged = { ...positions };
    Object.entries(userPositions).forEach(([id, pos]) => {
      const key = Number(id);
      if (merged[key]) merged[key] = pos;   // only honor overrides for views still visible
    });
    return merged;
  }, [positions, userPositions]);

  // Drag handling (pointer events → works for mouse, touch, pen).
  const dragRef = useRef<{
    id: number;
    originX: number;
    originY: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const startCardDrag = useCallback((viewId: number, e: React.PointerEvent<HTMLDivElement>) => {
    // Allow interaction with inner buttons / inputs without hijacking the click.
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [data-nodrag]')) return;
    const pos = userPositionsRef.current[viewId] ?? positions[viewId];
    if (!pos) return;
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      id: viewId,
      originX: pos.x,
      originY: pos.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
    setDraggingId(viewId);
  }, [positions]);

  const onCardDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startClientX) / zoom;
    const dy = (e.clientY - d.startClientY) / zoom;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;   // click threshold
    d.moved = true;
    const nx = Math.max(0, Math.round(d.originX + dx));
    const ny = Math.max(0, Math.round(d.originY + dy));
    setUserPositions((prev) => {
      const curr = prev[d.id];
      if (curr && curr.x === nx && curr.y === ny) return prev;
      return { ...prev, [d.id]: { x: nx, y: ny } };
    });
  }, [zoom]);

  const endCardDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const moved = d.moved;
    dragRef.current = null;
    setDraggingId(null);
    if (moved) persistPositions(userPositionsRef.current);
  }, [persistPositions]);

  const handleResetLayout = useCallback(() => {
    setUserPositions({});
    // Phase-4: reset = push empty positions to the server. The auto-layout
    // becomes the effective layout until the user drags again.
    if (datasetId) {
      saveLayout.mutate({ datasetId, positions: {} });
    }
  }, [datasetId, saveLayout]);

  const handleZoomOut = useCallback(() => {
    setZoom((current) => Math.max(ZOOM_MIN, Number((current - ZOOM_STEP).toFixed(2))));
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoom((current) => Math.min(ZOOM_MAX, Number((current + ZOOM_STEP).toFixed(2))));
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoom(1);
  }, []);

  const hasUserLayout = Object.keys(userPositions).length > 0;

  // Refs to card DOM elements
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});

  /**
   * columnAnchorY[viewId][colName] = Y offset from card-wrapper top to the column row's centre,
   * measured via el.offsetTop (layout-based, unaffected by overflow-scroll inside the card).
   */
  const [columnAnchorY, setColumnAnchorY] = useState<Record<number, Record<string, number>>>({});

  const [selectedRelKey, setSelectedRelKey] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const allViewsByName = useMemo(() => {
    const m: Record<string, DatasetModelView> = {};
    (model?.views ?? []).forEach((v) => { m[v.name] = v; });
    return m;
  }, [model?.views]);

  // ── Relationships ─────────────────────────────────────────────────────────

  const allRelationships = useMemo<ModelRelationship[]>(() => {
    return (model?.explores ?? []).flatMap((ex) =>
      (ex.joins ?? []).map((j) => {
        const { fromColumns, toColumns } = normalizeJoinColumns(j);
        // Phase-3b: default the new fields to legacy-equivalent values when
        // the join JSON predates the schema change.
        const isActive = j.is_active === undefined ? true : Boolean(j.is_active);
        const crossFilter = j.cross_filter === 'both' ? 'both' : 'single';
        return {
          fromViewId:   ex.base_view_id,
          fromViewName: ex.base_view_name,
          toViewName:   j.view,
          presentationViewName:
            j.presentation_view
            ?? (j.origin === 'auto_calendar' ? calendarPresentationView?.name ?? j.view : j.view),
          alias:        j.alias,
          joinType:     j.type ?? 'left',
          relationship: j.relationship,
          fromCol:      fromColumns[0],
          toCol:        toColumns[0],
          fromCols:     fromColumns,
          toCols:       toColumns,
          origin:       j.origin,
          managed:      Boolean(j.managed),
          isActive,
          crossFilter,
          key: `${ex.base_view_id}->${j.view}->${j.alias ?? ''}->${fromColumns.join('|')}=>${toColumns.join('|')}`,
        };
      })
    );
  }, [model?.explores, calendarPresentationView?.name]);

  const calendarRelationships = useMemo(
    () => allRelationships.filter((rel) => rel.origin === 'auto_calendar'),
    [allRelationships],
  );
  const relationships = useMemo(
    () => allRelationships.filter((rel) => showCalendarLayer || rel.origin !== 'auto_calendar'),
    [allRelationships, showCalendarLayer],
  );

  const viewByName = useMemo(() => {
    const m: Record<string, DatasetModelView> = {};
    visibleViews.forEach((v) => { m[v.name] = v; });
    return m;
  }, [visibleViews]);
  const joinableViews = useMemo(
    () => (model?.views ?? []).filter(isManualRelationshipView),
    [model?.views],
  );

  // Columns that are part of at least one join (highlighted in cards)
  const relationshipHighlights = useMemo<Record<number, Set<string>>>(() => {
    const h: Record<number, Set<string>> = {};
    for (const rel of relationships) {
      for (const fromCol of rel.fromCols) {
        if (fromCol) (h[rel.fromViewId] ??= new Set()).add(fromCol);
      }
      const tv = viewByName[rel.presentationViewName] ?? allViewsByName[rel.presentationViewName];
      if (tv) {
        for (const toCol of rel.toCols) {
          if (toCol) (h[tv.id] ??= new Set()).add(toCol);
        }
      }
    }
    return h;
  }, [relationships, viewByName, allViewsByName]);
  const calendarHighlights = useMemo<Record<number, Set<string>>>(() => {
    const h: Record<number, Set<string>> = {};
    for (const rel of calendarRelationships) {
      for (const fromCol of rel.fromCols) {
        if (fromCol) (h[rel.fromViewId] ??= new Set()).add(fromCol);
      }
    }
    return h;
  }, [calendarRelationships]);

  // ── Column anchor measurement ─────────────────────────────────────────────

  /**
   * Walk each card's [data-col-name] rows and record their Y centre
   * relative to the card top. Combined with the fixed card position,
   * this gives the exact SVG canvas coordinate for each column row.
   *
   * Called via useLayoutEffect (fires sync after DOM paint) so measurements
   * are always up-to-date before the SVG renders.
   */
  const measureColumns = useCallback(() => {
    const next: Record<number, Record<string, number>> = {};
    for (const [idStr, cardEl] of Object.entries(cardRefs.current)) {
      if (!cardEl) continue;
      const id = Number(idStr);
      const colEls = cardEl.querySelectorAll<HTMLElement>('[data-col-name]');
      if (!colEls.length) continue;
      next[id] = {};
      colEls.forEach((el) => {
        const name = el.getAttribute('data-col-name')!;
        // offsetTop traverses up through all position:static intermediates to the
        // card wrapper (position:absolute), giving the element's layout Y from the
        // card top. This is unaffected by overflow-scroll inside the card.
        next[id][name] = el.offsetTop + el.offsetHeight / 2;
      });
    }
    setColumnAnchorY(next);
  }, []);

  // Measure after initial render (useLayoutEffect = sync, after DOM paint).
  // Column offsetTop inside a card is independent of the card's canvas
  // position, so we only remeasure when the underlying model/view set changes.
  useLayoutEffect(() => {
    if (visibleViews.length > 0) measureColumns();
  }, [visibleViews, measureColumns]);

  // Re-measure when card content changes height (section open/close)
  useEffect(() => {
    const observers: ResizeObserver[] = [];
    for (const [, cardEl] of Object.entries(cardRefs.current)) {
      if (!cardEl) continue;
      const obs = new ResizeObserver(() => measureColumns());
      obs.observe(cardEl);
      observers.push(obs);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, [model?.views, measureColumns]);

  // ── Canvas size ───────────────────────────────────────────────────────────

  const canvasSize = useMemo(() => {
    let w = 800, h = 500;
    visibleViews.forEach((v) => {
      const pos = effectivePositions[v.id];
      if (!pos) return;
      w = Math.max(w, pos.x + CARD_WIDTH + CANVAS_PAD);
      h = Math.max(h, pos.y + ROW_HEIGHT + CANVAS_PAD);
    });
    return { width: w, height: h };
  }, [effectivePositions, visibleViews]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const selectedRelationship = useMemo(
    () => relationships.find((r) => r.key === selectedRelKey) ?? null,
    [relationships, selectedRelKey]
  );
  const selectedFromView = selectedRelationship
    ? allViewsByName[selectedRelationship.fromViewName]
    : null;
  const selectedToView = selectedRelationship
    ? (viewByName[selectedRelationship.presentationViewName]
        ?? allViewsByName[selectedRelationship.presentationViewName])
    : null;
  const canDeleteSelectedRelationship = Boolean(selectedRelationship && canEdit);

  const handleGenerate = async (force = false) => {
    try {
      const r = await generateModel.mutateAsync({ datasetId, force });
      toast.success(`Model generated: ${r.views_created} views, ${r.explores_created} explores`);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Failed to generate model');
    }
  };

  const handleAddJoin = async (params: Omit<AddJoinParams, 'datasetId'>) => {
    await addJoin.mutateAsync({ datasetId, ...params });
    toast.success('Relationship saved');
  };

  const handleDeleteRel = async () => {
    if (!selectedRelationship) return;
    const relationship = selectedRelationship;
    const removingDateLink = relationship.origin === 'auto_calendar';
    try {
      await removeJoin.mutateAsync({
        datasetId,
        fromViewId: relationship.fromViewId,
        toViewName: relationship.toViewName,
        fromColumn: relationship.fromCol,
        toColumn: relationship.toCol,
        fromColumns: relationship.fromCols,
        toColumns: relationship.toCols,
      });
      setSelectedRelKey(null);
      toast.success(removingDateLink ? 'Date link removed' : 'Relationship removed');
    } catch (e: any) {
      toast.error(
        e?.response?.data?.detail
          || (removingDateLink ? 'Failed to remove date link' : 'Failed to remove relationship')
      );
    }
  };

  const clientPointToCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: (clientX - rect.left) / zoom,
      y: (clientY - rect.top) / zoom,
    };
  }, [zoom]);

  const findColumnDropTarget = useCallback((clientX: number, clientY: number) => {
    if (typeof document === 'undefined') return null;
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-col-name][data-view-id]');
    if (!target) return null;
    const viewId = Number(target.dataset.viewId);
    const columnName = target.dataset.colName ?? '';
    if (!viewId || !columnName) return null;
    const targetView = visibleViews.find((view) => view.id === viewId);
    if (!targetView || !isManualRelationshipView(targetView)) return null;
    return { viewId, columnName };
  }, [visibleViews]);

  const startRelationshipDrag = useCallback((fromViewId: number, fromColumn: string, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const point = clientPointToCanvas(event.clientX, event.clientY);
    if (!point) return;
    setRelationshipDrag({
      fromViewId,
      fromColumn,
      pointerX: point.x,
      pointerY: point.y,
      hoverTarget: null,
    });
  }, [clientPointToCanvas]);

  useEffect(() => {
    if (!relationshipDrag) return;

    const updateRelationshipDrag = (clientX: number, clientY: number) => {
      const point = clientPointToCanvas(clientX, clientY);
      const target = findColumnDropTarget(clientX, clientY);
      setRelationshipDrag((current) => {
        if (!current || !point) return current;
        const nextTarget = target && !(target.viewId === current.fromViewId && target.columnName === current.fromColumn)
          ? target
          : null;
        return {
          ...current,
          pointerX: point.x,
          pointerY: point.y,
          hoverTarget: nextTarget,
        };
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      updateRelationshipDrag(event.clientX, event.clientY);
    };

    const finalizeRelationshipDrag = (event: PointerEvent) => {
      const current = relationshipDragRef.current;
      if (!current) return;
      const target = findColumnDropTarget(event.clientX, event.clientY);
      setRelationshipDrag(null);
      if (!target || (target.viewId === current.fromViewId && target.columnName === current.fromColumn)) return;
      setSelectedRelKey(null);
      setDialogInitialValue({
        fromViewId: current.fromViewId,
        toViewId: target.viewId,
        fromColumn: current.fromColumn,
        toColumn: target.columnName,
      });
      setDialogOpen(true);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finalizeRelationshipDrag);
    window.addEventListener('pointercancel', finalizeRelationshipDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finalizeRelationshipDrag);
      window.removeEventListener('pointercancel', finalizeRelationshipDrag);
    };
  }, [clientPointToCanvas, findColumnDropTarget, relationshipDrag]);

  // ── Build SVG line endpoints (must be before early returns — Rules of Hooks) ──

  /**
   * For each relationship, compute bezier endpoints (sx,sy) → (tx,ty) and
   * the exit direction at each end.
   *
   * Edge side selection: whichever horizontal edge (left/right) of each card
   * is closer to the other card's centre. This keeps beziers short and
   * prevents the line from ducking behind its own card — regardless of how
   * the user has arranged the cards via drag.
   *
   * Y anchor: card.y + columnAnchorY[viewId][colName] (layout-based offset
   * from card top, robust to in-card scroll). Join columns are pinned to the
   * top of the column list so the value is always inside the visible area.
   */
  const lineEndpoints = useMemo(() => {
    return relationships.flatMap((rel) => {
      const fromPos = effectivePositions[rel.fromViewId];
      const toView  = viewByName[rel.presentationViewName];
      if (!fromPos || !toView) return [];
      const toPos = effectivePositions[toView.id];
      if (!toPos) return [];

      const fromCenterX = fromPos.x + CARD_WIDTH / 2;
      const toCenterX   = toPos.x   + CARD_WIDTH / 2;

      // Source exits on the side closer to the target; target is entered on
      // the side closer to the source. For non-overlapping cards these are
      // always opposite sides (classic L→R case).
      const sDir: 1 | -1 = toCenterX >= fromCenterX ? 1 : -1;
      const tDir: 1 | -1 = toCenterX >= fromCenterX ? -1 : 1;

      const sx = sDir > 0 ? fromPos.x + CARD_WIDTH : fromPos.x;
      const tx = tDir > 0 ? toPos.x   + CARD_WIDTH : toPos.x;

      // columnAnchorY[id][col] = offsetTop from card top to the column row centre.
      const HEADER_CY = 22; // fallback ~ header centre
      const fromOff = columnAnchorY[rel.fromViewId]?.[rel.fromCol ?? ''];
      const toOff   = columnAnchorY[toView.id]?.[rel.toCol   ?? ''];
      const sy = fromPos.y + (fromOff != null ? fromOff : HEADER_CY);
      const ty = toPos.y   + (toOff   != null ? toOff   : HEADER_CY);

      return [{ rel, sx, sy, sDir, tx, ty, tDir }];
    });
  }, [relationships, effectivePositions, viewByName, columnAnchorY]);

  const relationshipDraftLine = useMemo(() => {
    if (!relationshipDrag) return null;
    const fromPos = effectivePositions[relationshipDrag.fromViewId];
    if (!fromPos) return null;

    const HEADER_CY = 22;
    const fromOff = columnAnchorY[relationshipDrag.fromViewId]?.[relationshipDrag.fromColumn];
    const sourceCenterX = fromPos.x + CARD_WIDTH / 2;

    const targetView = relationshipDrag.hoverTarget
      ? visibleViews.find((view) => view.id === relationshipDrag.hoverTarget!.viewId)
      : null;
    const targetPos = targetView ? effectivePositions[targetView.id] : null;
    const targetCenterX = targetPos ? targetPos.x + CARD_WIDTH / 2 : relationshipDrag.pointerX;

    const sDir: 1 | -1 = targetCenterX >= sourceCenterX ? 1 : -1;
    const tDir: 1 | -1 = targetCenterX >= sourceCenterX ? -1 : 1;

    const sx = sDir > 0 ? fromPos.x + CARD_WIDTH : fromPos.x;
    const sy = fromPos.y + (fromOff != null ? fromOff : HEADER_CY);

    if (targetPos && relationshipDrag.hoverTarget) {
      const toOff = columnAnchorY[targetView!.id]?.[relationshipDrag.hoverTarget.columnName];
      return {
        sx,
        sy,
        sDir,
        tx: tDir > 0 ? targetPos.x + CARD_WIDTH : targetPos.x,
        ty: targetPos.y + (toOff != null ? toOff : HEADER_CY),
        tDir,
      };
    }

    return {
      sx,
      sy,
      sDir,
      tx: relationshipDrag.pointerX,
      ty: relationshipDrag.pointerY,
      tDir,
    };
  }, [columnAnchorY, effectivePositions, relationshipDrag, visibleViews]);

  // ── Render guards (after all hooks) ──────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-brand" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-danger">
        <span>Failed to load model</span>
        <button onClick={() => refetch()} className="text-sm underline text-brand">Retry</button>
      </div>
    );
  }

  if (!model?.model_id || (!visibleViews.length && !calendarRelationships.length)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-center">
          <h3 className="text-lg font-medium text-text-primary mb-1">No Data Model</h3>
          <p className="text-sm text-text-tertiary max-w-md">
            Auto-generate a semantic model from your dataset tables. This creates dimensions,
            measures, and auto-detects relationships between tables.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => handleGenerate(false)}
            disabled={generateModel.isPending}
            className="px-4 py-2 bg-brand text-white text-sm font-medium rounded-md
              hover:bg-brand-hover disabled:opacity-50 flex items-center gap-2 transition-colors"
          >
            {generateModel.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Sigma className="w-4 h-4" />}
            Generate Model
          </button>
        )}
      </div>
    );
  }

  const totalRels = allRelationships.filter((rel) => rel.origin !== 'auto_calendar').length;
  const totalCalendarRels = calendarRelationships.length;

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-sm font-medium text-text-primary shrink-0">Data Model</h3>
          <span className="text-xs text-text-quaternary shrink-0">
            {visibleViews.length} table{visibleViews.length !== 1 ? 's' : ''} |{' '}
            {totalRels} relationship{totalRels !== 1 ? 's' : ''}
            {totalCalendarRels > 0 ? ` | ${totalCalendarRels} date link${totalCalendarRels !== 1 ? 's' : ''}` : ''}
          </span>
          {selectedRelationship && (
            <span className="text-xs text-brand truncate">
              <span className="font-medium">{getViewLabel(selectedFromView)}</span>
              <span className="text-brand">.</span>
              <span className="font-semibold">{summarizeJoinColumns(selectedRelationship.fromCols) ?? '?'}</span>
              {' → '}
              <span className="font-medium">{getViewLabel(selectedToView)}</span>
              <span className="text-brand">.</span>
              <span className="font-semibold">{summarizeJoinColumns(selectedRelationship.toCols) ?? '?'}</span>
              {' · '}
              {selectedRelationship.relationship?.replace(/_/g, ':') ?? 'N:1'}
              {' · '}
              {selectedRelationship.joinType.toUpperCase()}
              {selectedRelationship.origin === 'auto_calendar'
                ? ' | Auto date link'
                : selectedRelationship.managed
                  ? ' | Auto-generated'
                  : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Phase-3b: edit existing relationship so the user can toggle
              is_active / cross_filter without having to delete + recreate. */}
          {canDeleteSelectedRelationship && selectedRelationship && selectedRelationship.origin !== 'auto_calendar' && (
            <button
              onClick={() => {
                const toView = selectedToView ?? allViewsByName[selectedRelationship.toViewName];
                if (!toView) return;
                setDialogInitialValue({
                  fromViewId: selectedRelationship.fromViewId,
                  toViewId: toView.id,
                  fromColumn: selectedRelationship.fromCol ?? selectedRelationship.fromCols[0] ?? '',
                  toColumn: selectedRelationship.toCol ?? selectedRelationship.toCols[0] ?? '',
                  fromColumns: selectedRelationship.fromCols,
                  toColumns: selectedRelationship.toCols,
                  joinType: (selectedRelationship.joinType as 'left' | 'inner' | 'right' | 'full') ?? 'left',
                  relationship: (selectedRelationship.relationship as 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many' | undefined) ?? 'many_to_one',
                  alias: selectedRelationship.alias ?? null,
                  isActive: selectedRelationship.isActive,
                  crossFilter: selectedRelationship.crossFilter,
                });
                setDialogOpen(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-brand
                border border-brand/40 rounded-md hover:bg-brand/10 transition-colors"
              title="Edit relationship — change cardinality, active status, cross-filter direction"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          )}
          {canDeleteSelectedRelationship && (
            <button
              onClick={handleDeleteRel}
              disabled={removeJoin.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger
                border border-danger/40 rounded-md hover:bg-danger/10 disabled:opacity-50 transition-colors"
            >
              {removeJoin.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2 className="w-3.5 h-3.5" />}
              {selectedRelationship?.origin === 'auto_calendar' ? 'Remove date link' : 'Delete'}
            </button>
          )}
          <div className="flex items-center gap-1 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-1 py-1">
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= ZOOM_MIN}
              className="rounded p-1 text-text-secondary hover:bg-surface-2 disabled:opacity-40"
              title="Zoom out"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              className="min-w-[52px] rounded px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-2"
              title="Reset zoom"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= ZOOM_MAX}
              className="rounded p-1 text-text-secondary hover:bg-surface-2 disabled:opacity-40"
              title="Zoom in"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Dictionary modal button */}
          <button
            onClick={() => setDictModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary
              border border-[rgb(var(--border-strong))] rounded-md hover:bg-surface-2 transition-colors"
            title="View & edit dataset dictionary"
          >
            <BookOpen className="w-3.5 h-3.5" />
            Dictionary
          </button>
          {hasUserLayout && (
            <button
              onClick={handleResetLayout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary
                border border-[rgb(var(--border-strong))] rounded-md hover:bg-surface-2 transition-colors"
              title="Reset card positions to the auto layout"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reset layout
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => {
                setSelectedRelKey(null);
                setDialogInitialValue(undefined);
                setDialogOpen(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-brand
                border border-brand/40 bg-brand/10 rounded-md hover:bg-brand/15 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Relationship
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => handleGenerate(true)}
              disabled={generateModel.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary
                border border-[rgb(var(--border-strong))] rounded-md hover:bg-surface-2 disabled:opacity-50 transition-colors"
              title="Regenerate model (overwrite)"
            >
              {generateModel.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5" />}
              Regenerate
            </button>
          )}
        </div>
      </div>

      <CalendarLayerBanner
        calendarView={calendarPresentationView}
        bindings={calendarRelationships}
        viewsByName={allViewsByName}
        showCalendarLayer={showCalendarLayer}
        onToggleCalendarLayer={() => setShowCalendarLayer((value) => !value)}
      />

      {/* Canvas */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-auto bg-[#f8f9fc]"
        onClick={() => setSelectedRelKey(null)}
        style={{
          backgroundImage: 'radial-gradient(circle, #cdd0d8 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: canvasSize.width * zoom,
            height: canvasSize.height * zoom,
            minWidth: '100%',
            minHeight: '100%',
          }}
        >
          <div
            ref={canvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              width: canvasSize.width,
              height: canvasSize.height,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
            }}
          >
            {/* SVG lines — below cards */}
            <svg
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                overflow: 'visible',
              }}
            >
              {lineEndpoints.map(({ rel, sx, sy, sDir, tx, ty, tDir }) => (
                <RelLine
                  key={rel.key}
                  sx={sx} sy={sy}
                  tx={tx} ty={ty}
                  sDir={sDir} tDir={tDir}
                  fromCol={rel.fromCol}
                  toCol={rel.toCol}
                  relationship={rel.relationship}
                  joinType={rel.joinType}
                  isActive={rel.isActive}
                  crossFilter={rel.crossFilter}
                  isSelected={selectedRelKey === rel.key}
                  onClick={() => setSelectedRelKey(selectedRelKey === rel.key ? null : rel.key)}
                />
              ))}
              {relationshipDraftLine && (
                <path
                  d={makeBezierPath(
                    relationshipDraftLine.sx,
                    relationshipDraftLine.sy,
                    relationshipDraftLine.sDir,
                    relationshipDraftLine.tx,
                    relationshipDraftLine.ty,
                    relationshipDraftLine.tDir,
                  )}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={2}
                  strokeDasharray="7 5"
                  opacity={0.9}
                  style={{ pointerEvents: 'none' }}
                />
              )}
            </svg>

            {/* Table cards — draggable; auto layout with per-view overrides */}
            {visibleViews.map((view) => {
              const pos = effectivePositions[view.id];
              if (!pos) return null;
              const isDragging = draggingId === view.id;
              return (
                <div
                  key={view.id}
                  ref={(el) => { cardRefs.current[view.id] = el; }}
                  onPointerDown={(e) => startCardDrag(view.id, e)}
                  onPointerMove={onCardDragMove}
                  onPointerUp={endCardDrag}
                  onPointerCancel={endCardDrag}
                  style={{
                    position: 'absolute',
                    left: pos.x,
                    top: pos.y,
                    width: CARD_WIDTH,
                    zIndex: isDragging ? 10 : 1,
                    cursor: isDragging ? 'grabbing' : 'grab',
                    touchAction: 'none',
                    transition: isDragging ? 'none' : 'box-shadow 0.15s',
                    boxShadow: isDragging ? '0 8px 24px rgba(15, 23, 42, 0.18)' : undefined,
                  }}
                >
                  <ViewCard
                    view={view}
                    onEdit={
                      onSelectView && !view.system_managed
                        ? () => onSelectView(view)
                        : undefined
                    }
                    isSelected={selectedViewId === view.id}
                    relationshipCols={relationshipHighlights[view.id]}
                    calendarCols={calendarHighlights[view.id]}
                    relationDraftTarget={relationshipDrag?.hoverTarget?.viewId === view.id ? relationshipDrag.hoverTarget.columnName : null}
                    onStartRelationshipDrag={(columnName, event) => startRelationshipDrag(view.id, columnName, event)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Add Relationship Dialog */}
      <RelationshipDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleAddJoin}
        datasetId={datasetId}
        views={joinableViews}
        initialValue={dialogInitialValue}
        isSaving={addJoin.isPending}
      />

      {/* Dataset Dictionary Modal */}
      {dictModalOpen && (
        <AppModalShell
          onClose={() => setDictModalOpen(false)}
          title={`${datasetName} Dictionary`}
          description="Review and edit dictionary coverage across all dataset tables from one workspace."
          icon={<BookOpen className="h-5 w-5" />}
          maxWidthClass="max-w-6xl"
          panelClassName="h-[88vh] max-h-[88vh] rounded-[28px]"
          bodyClassName="p-0"
        >
          <DatasetDictionaryPanel
            datasetId={datasetId}
            datasetName={datasetName}
            tables={tables as any}
            canEdit={canEdit}
          />
        </AppModalShell>
      )}
    </div>
  );
}
