/**
 * DataModelCanvas — Visual ERD viewer for a dataset.
 *
 * Cards are laid out in a fixed grid (no drag). Lines are anchored
 * to the exact column row elements via useLayoutEffect measurement.
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
  Loader2,
  RefreshCw,
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
  type AddJoinParams,
  type DatasetModelView,
  type DatasetModelExplore,
} from '@/hooks/use-dataset-model';
import { RelationshipDialog } from './RelationshipDialog';
import { toast } from 'sonner';

// ─── Layout constants ────────────────────────────────────────────────────────

const CARD_WIDTH    = 272;
const COLS          = 2;
const GAP_X         = 240;   // horizontal gap between the two columns
const GAP_Y         = 80;    // vertical gap between rows
const PAD           = 48;
const ROW_HEIGHT    = 360;   // generous row height estimate

// Derived routing geometry — the vertical "highway" in the gap between columns.
// ALL relationship lines travel through this channel; no card ever occupies it.
const COL0_RIGHT    = PAD + CARD_WIDTH;                   // 320  right edge of col 0
const COL1_LEFT     = PAD + CARD_WIDTH + GAP_X;           // 560  left  edge of col 1
const CHAN_X        = Math.round((COL0_RIGHT + COL1_LEFT) / 2); // 440  routing channel

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Topology-aware layout:
 *  - Sort views by outgoing join count (fact → dim ordering).
 *  - Arrange in a strict 2-column left-aligned grid (no centering).
 *    Left-alignment guarantees the routing channel (CHAN_X) is always clear.
 */
function computeLayout(
  views: DatasetModelView[],
  explores: DatasetModelExplore[],
): Record<number, { x: number; y: number }> {
  const outgoing: Record<number, number> = {};
  views.forEach((v) => { outgoing[v.id] = 0; });
  explores.forEach((ex) => {
    outgoing[ex.base_view_id] = (outgoing[ex.base_view_id] ?? 0) + ex.joins.length;
  });

  const sorted = [...views].sort(
    (a, b) => (outgoing[b.id] ?? 0) - (outgoing[a.id] ?? 0),
  );

  const out: Record<number, { x: number; y: number }> = {};
  sorted.forEach((v, i) => {
    out[v.id] = {
      x: PAD + (i % COLS) * (CARD_WIDTH + GAP_X),
      y: PAD + Math.floor(i / COLS) * (ROW_HEIGHT + GAP_Y),
    };
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
 * Orthogonal (Manhattan) path with rounded corners (r=8px).
 * All paths route through the fixed vertical channel at CHAN_X so they
 * never pass behind a card.
 *
 * Segments: H(sx→CHAN_X) → V(sy→ty) → H(CHAN_X→tx)
 * Same-level shortcut: straight H when |sy-ty| < 2.
 */
function makeOrthogonalPath(sx: number, sy: number, tx: number, ty: number): string {
  if (Math.abs(sy - ty) < 2) {
    return `M ${sx} ${sy} H ${tx}`;
  }
  const r  = 8;
  const s1 = CHAN_X > sx ? 1 : -1;   // exit direction from source  (→ or ←)
  const s2 = ty > sy    ? 1 : -1;   // vertical direction           (↓ or ↑)
  const s3 = tx > CHAN_X ? 1 : -1;  // entry direction to target   (→ or ←)
  return [
    `M ${sx} ${sy}`,
    `H ${CHAN_X - s1 * r}`,
    `Q ${CHAN_X} ${sy} ${CHAN_X} ${sy + s2 * r}`,
    `V ${ty - s2 * r}`,
    `Q ${CHAN_X} ${ty} ${CHAN_X + s3 * r} ${ty}`,
    `H ${tx}`,
  ].join(' ');
}

/** Parse "${TABLE}.col = ${view}.col" from sql_on string. */
function parseSqlOn(sqlOn: string): { fromCol: string; toCol: string } | null {
  const m = sqlOn?.match(/\$\{TABLE\}\.([^\s=]+)\s*=\s*\$\{[^}]+\}\.([^\s=]+)/);
  if (!m) return null;
  const clean = (s: string) => s.replace(/["`[\]]/g, '');
  return { fromCol: clean(m[1]), toCol: clean(m[2]) };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function DimIcon({ type }: { type: string }) {
  switch (type) {
    case 'number':   return <Hash className="w-3 h-3 text-blue-500 shrink-0" />;
    case 'date':
    case 'datetime': return <Calendar className="w-3 h-3 text-green-600 shrink-0" />;
    case 'yesno':    return <ToggleLeft className="w-3 h-3 text-purple-500 shrink-0" />;
    default:         return <Type className="w-3 h-3 text-gray-400 shrink-0" />;
  }
}

interface ViewCardProps {
  view: DatasetModelView;
  onEdit?: () => void;
  highlightedCols?: Set<string>;
}

function ViewCard({ view, onEdit, highlightedCols }: ViewCardProps) {
  const [dimsOpen, setDimsOpen] = useState(true);
  const [msrOpen,  setMsrOpen]  = useState(false);

  // Join columns always appear FIRST so they're visible at scroll=0
  // (avoids measuring a clipped/off-screen element when the list is long)
  const joinDims  = view.dimensions.filter((d) =>  highlightedCols?.has(d.name));
  const otherVis  = view.dimensions.filter((d) => !highlightedCols?.has(d.name) && !d.hidden);
  const vis       = [...joinDims, ...otherVis];
  const hid       = view.dimensions.filter((d) =>  d.hidden && !highlightedCols?.has(d.name));
  const visM = view.measures.filter((m) => !m.hidden);

  return (
    <div
      className="bg-white rounded-lg border border-gray-200 shadow-sm select-none"
      style={{ width: CARD_WIDTH }}
    >
      {/* Header */}
      <div className="px-3 py-2.5 border-b bg-gradient-to-r from-blue-50 to-indigo-50 rounded-t-lg flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
          <span className="font-semibold text-sm text-gray-800 truncate">
            {view.table_display_name || view.name}
          </span>
        </div>
        {onEdit && (
          <button
            onClick={onEdit}
            className="p-1 rounded hover:bg-white/60 text-gray-400 hover:text-gray-600 transition-colors shrink-0"
            title="Edit view"
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
            text-gray-400 uppercase tracking-wider hover:bg-gray-50"
        >
          <span>Dimensions ({vis.length})</span>
          {dimsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {dimsOpen && (
          <div className="px-1.5 pb-1.5 space-y-0.5 max-h-48 overflow-y-auto">
            {vis.map((d) => {
              const isJoin = highlightedCols?.has(d.name);
              return (
                <div
                  key={d.name}
                  data-col-name={d.name}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px]${
                    isJoin
                      ? ' bg-indigo-50 border-l-2 border-indigo-400 pl-1.5 font-medium'
                      : ' hover:bg-gray-50'
                  }`}
                  title={d.sql || d.name}
                >
                  <DimIcon type={d.type} />
                  <span className={`truncate ${isJoin ? 'text-indigo-700' : 'text-gray-700'}`}>
                    {d.label || d.name}
                  </span>
                  {d.hidden && !isJoin && (
                    <span className="ml-auto text-[9px] uppercase tracking-wide text-amber-600">hidden</span>
                  )}
                  {isJoin && (
                    <Link2 className="w-2.5 h-2.5 text-indigo-400 ml-auto shrink-0" />
                  )}
                </div>
              );
            })}
            {hid.length > 0 && (
              <div className="px-2 py-0.5 text-[11px] text-gray-400 flex items-center gap-1">
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
            text-gray-400 uppercase tracking-wider hover:bg-gray-50"
        >
          <span>Measures ({visM.length})</span>
          {msrOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {msrOpen && (
          <div className="px-1.5 pb-1.5 space-y-0.5 max-h-32 overflow-y-auto">
            {visM.map((m) => (
              <div
                key={m.name}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] hover:bg-orange-50"
              >
                <Sigma className="w-3 h-3 text-orange-500 shrink-0" />
                <span className="text-gray-700 truncate">{m.label || m.name}</span>
                <span className="text-gray-400 ml-auto text-[9px] uppercase">{m.type}</span>
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
  fromCol?: string;
  toCol?: string;
  relationship?: string;
  joinType: string;
  isSelected: boolean;
  onClick: () => void;
}

function RelLine({
  sx, sy, tx, ty,
  fromCol, toCol,
  relationship, joinType,
  isSelected, onClick,
}: RelLineProps) {
  const [hovered, setHovered] = useState(false);

  const path = makeOrthogonalPath(sx, sy, tx, ty);
  const { src, tgt } = cardinalityLabels(relationship);
  const active = isSelected || hovered;
  const stroke = active ? '#6366f1' : '#94a3b8';

  // Column label pill width (proportional to text length, max 90)
  const fromLW = Math.min(90, (fromCol?.length ?? 0) * 5.8 + 14);
  const toLW   = Math.min(90, (toCol?.length   ?? 0) * 5.8 + 14);

  // Source exits rightward when sx is left of the channel (col 0 right edge).
  // Source exits leftward when sx is right of or at the channel (col 1 left edge).
  const sxExitsRight   = sx < CHAN_X;
  // Target is approached from the right when tx is right of channel (col 1 left edge).
  // Target is approached from the left when tx is left of channel (col 0 right edge).
  const txFromRight    = tx > CHAN_X;

  // Badge offsets: sit just outside the card edge where the line starts/ends
  const srcBadgeX  = sxExitsRight ? sx + 9   : sx - 9;
  const tgtBadgeX  = txFromRight  ? tx - 9   : tx + 9;

  // Label offsets: further out from the card edge
  const srcLabelX  = sxExitsRight ? sx + fromLW / 2 + 14 : sx - fromLW / 2 - 14;
  const tgtLabelX  = txFromRight  ? tx - toLW  / 2 - 14  : tx + toLW  / 2 + 14;

  // JOIN-type chip sits at the routing channel midpoint — always clear of cards
  const chipX = CHAN_X;
  const chipY = (sy + ty) / 2;

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

      {/* Visible line */}
      <path
        d={path}
        stroke={stroke}
        strokeWidth={active ? 2 : 1.5}
        fill="none"
        strokeDasharray={isSelected ? '6 3' : undefined}
        style={{ pointerEvents: 'none', transition: 'stroke 0.15s, stroke-width 0.15s' }}
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

      {/* ── Channel join-type chip — always in the routing gap, never behind a card ── */}
      <g transform={`translate(${chipX}, ${chipY})`} style={{ pointerEvents: 'none' }}>
        <rect x={-22} y={-9} width={44} height={18} rx={9} fill={active ? '#6366f1' : '#94a3b8'} />
        <text
          textAnchor="middle" dominantBaseline="central"
          fontSize={7} fontWeight="700" fill="white" letterSpacing={0.3}
        >
          {joinType.toUpperCase()}
        </text>
      </g>
    </g>
  );
}

// ─── Main Canvas ─────────────────────────────────────────────────────────────

interface DataModelCanvasProps {
  datasetId: number;
  canEdit?: boolean;
  onEditView?: (view: DatasetModelView) => void;
}

export function DataModelCanvas({
  datasetId,
  canEdit = true,
  onEditView,
}: DataModelCanvasProps) {
  const { data: model, isLoading, error, refetch } = useDatasetModel(datasetId);
  const generateModel = useGenerateModel();
  const addJoin       = useAddJoin();
  const removeJoin    = useRemoveJoin();

  // Fixed card positions — topology-aware, computed once per model
  const positions = useMemo<Record<number, { x: number; y: number }>>(() => {
    if (!model?.views?.length) return {};
    return computeLayout(model.views, model.explores ?? []);
  }, [model?.model_id, model?.views, model?.explores]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refs to card DOM elements
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});

  /**
   * columnAnchorY[viewId][colName] = Y offset from card-wrapper top to the column row's centre,
   * measured via el.offsetTop (layout-based, unaffected by overflow-scroll inside the card).
   */
  const [columnAnchorY, setColumnAnchorY] = useState<Record<number, Record<string, number>>>({});

  const [selectedRelKey, setSelectedRelKey] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // ── Relationships ─────────────────────────────────────────────────────────

  const relationships = useMemo(() => {
    return (model?.explores ?? []).flatMap((ex) =>
      (ex.joins ?? []).map((j) => {
        const cols = parseSqlOn(j.sql_on ?? '');
        return {
          fromViewId:   ex.base_view_id,
          fromViewName: ex.base_view_name,
          toViewName:   j.view,
          joinType:     j.type ?? 'left',
          relationship: j.relationship,
          fromCol:      j.from_column ?? cols?.fromCol,
          toCol:        j.to_column   ?? cols?.toCol,
          key: `${ex.base_view_id}->${j.view}->${j.from_column ?? cols?.fromCol ?? ''}->${j.to_column ?? cols?.toCol ?? ''}`,
        };
      })
    );
  }, [model?.explores]);

  const viewByName = useMemo(() => {
    const m: Record<string, DatasetModelView> = {};
    (model?.views ?? []).forEach((v) => { m[v.name] = v; });
    return m;
  }, [model?.views]);

  // Columns that are part of at least one join (highlighted in cards)
  const viewHighlights = useMemo<Record<number, Set<string>>>(() => {
    const h: Record<number, Set<string>> = {};
    for (const rel of relationships) {
      if (rel.fromCol) (h[rel.fromViewId] ??= new Set()).add(rel.fromCol);
      const tv = viewByName[rel.toViewName];
      if (tv && rel.toCol) (h[tv.id] ??= new Set()).add(rel.toCol);
    }
    return h;
  }, [relationships, viewByName]);

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

  // Measure after initial render (useLayoutEffect = sync, after DOM paint)
  useLayoutEffect(() => {
    if (Object.keys(positions).length > 0) measureColumns();
  }, [positions, measureColumns]);

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
    (model?.views ?? []).forEach((v) => {
      const pos = positions[v.id];
      if (!pos) return;
      w = Math.max(w, pos.x + CARD_WIDTH + PAD);
      h = Math.max(h, pos.y + ROW_HEIGHT + PAD);
    });
    return { width: w, height: h };
  }, [positions, model?.views]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const selectedRelationship = useMemo(
    () => relationships.find((r) => r.key === selectedRelKey) ?? null,
    [relationships, selectedRelKey]
  );

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
    try {
      await removeJoin.mutateAsync({
        datasetId,
        fromViewId: selectedRelationship.fromViewId,
        toViewName: selectedRelationship.toViewName,
        fromColumn: selectedRelationship.fromCol,
        toColumn:   selectedRelationship.toCol,
      });
      setSelectedRelKey(null);
      toast.success('Relationship removed');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Failed to remove relationship');
    }
  };

  // ── Build SVG line endpoints (must be before early returns — Rules of Hooks) ──

  /**
   * For each relationship, compute the exact (sx,sy) → (tx,ty) in canvas space.
   *
   * X: right edge for col-0 cards, left edge for col-1 cards — both route through CHAN_X.
   * Y: positions[viewId].y + columnAnchorY[viewId][colName]
   *    columnAnchorY = offsetTop from card-wrapper to column row centre (layout Y,
   *    unaffected by overflow scroll). Join cols are sorted to the top so this
   *    value is always within the card's visible bounds.
   */
  const lineEndpoints = useMemo(() => {
    return relationships.flatMap((rel) => {
      const fromPos = positions[rel.fromViewId];
      const toView  = viewByName[rel.toViewName];
      if (!fromPos || !toView) return [];
      const toPos = positions[toView.id];
      if (!toPos) return [];

      // Determine which card edge to use for each endpoint.
      // Cards in col 0 (x < CHAN_X) route through their right edge.
      // Cards in col 1 (x >= CHAN_X) route through their left edge.
      // This ensures all paths go through CHAN_X and never pass behind a card.
      const fromInCol0 = fromPos.x < CHAN_X;
      const toInCol0   = toPos.x   < CHAN_X;
      const sx = fromInCol0 ? fromPos.x + CARD_WIDTH : fromPos.x;
      const tx = toInCol0   ? toPos.x   + CARD_WIDTH : toPos.x;

      // columnAnchorY[id][col] = offsetTop from card-wrapper top to the column row centre.
      // Add the card's canvas Y to get the absolute canvas coordinate.
      // Join columns are sorted to the top of the list, so offsetTop is always small
      // and within the card's visible area — never clipped by the overflow scroll area.
      const HEADER_CY = 22; // fallback: approx header centre offset
      const fromOff = columnAnchorY[rel.fromViewId]?.[rel.fromCol ?? ''];
      const toOff   = columnAnchorY[toView.id]?.[rel.toCol   ?? ''];
      const sy = fromPos.y + (fromOff != null ? fromOff : HEADER_CY);
      const ty = toPos.y   + (toOff   != null ? toOff   : HEADER_CY);

      return [{ rel, sx, sy, tx, ty }];
    });
  }, [relationships, positions, viewByName, columnAnchorY]);

  // ── Render guards (after all hooks) ──────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-red-600">
        <span>Failed to load model</span>
        <button onClick={() => refetch()} className="text-sm underline text-blue-600">Retry</button>
      </div>
    );
  }

  if (!model?.model_id || !model.views.length) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-center">
          <h3 className="text-lg font-medium text-gray-900 mb-1">No Data Model</h3>
          <p className="text-sm text-gray-500 max-w-md">
            Auto-generate a semantic model from your dataset tables. This creates dimensions,
            measures, and auto-detects relationships between tables.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => handleGenerate(false)}
            disabled={generateModel.isPending}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md
              hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
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

  const totalRels = relationships.length;

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b bg-white flex items-center justify-between shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-sm font-medium text-gray-900 shrink-0">Data Model</h3>
          <span className="text-xs text-gray-400 shrink-0">
            {model.views.length} table{model.views.length !== 1 ? 's' : ''} |{' '}
            {totalRels} relationship{totalRels !== 1 ? 's' : ''}
          </span>
          {selectedRelationship && (
            <span className="text-xs text-indigo-600 truncate">
              <span className="font-medium">{selectedRelationship.fromViewName}</span>
              <span className="text-indigo-300">.</span>
              <span className="font-semibold">{selectedRelationship.fromCol ?? '?'}</span>
              {' → '}
              <span className="font-medium">{selectedRelationship.toViewName}</span>
              <span className="text-indigo-300">.</span>
              <span className="font-semibold">{selectedRelationship.toCol ?? '?'}</span>
              {' · '}
              {selectedRelationship.relationship?.replace(/_/g, ':') ?? 'N:1'}
              {' · '}
              {selectedRelationship.joinType.toUpperCase()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {selectedRelationship && canEdit && (
            <button
              onClick={handleDeleteRel}
              disabled={removeJoin.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600
                border border-red-300 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              {removeJoin.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2 className="w-3.5 h-3.5" />}
              Delete
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => { setSelectedRelKey(null); setDialogOpen(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700
                border border-blue-300 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Relationship
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => handleGenerate(true)}
              disabled={generateModel.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600
                border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors"
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

      {/* Canvas */}
      <div
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
            width: canvasSize.width,
            height: canvasSize.height,
            minWidth: '100%',
            minHeight: '100%',
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
            {lineEndpoints.map(({ rel, sx, sy, tx, ty }) => (
              <RelLine
                key={rel.key}
                sx={sx} sy={sy}
                tx={tx} ty={ty}
                fromCol={rel.fromCol}
                toCol={rel.toCol}
                relationship={rel.relationship}
                joinType={rel.joinType}
                isSelected={selectedRelKey === rel.key}
                onClick={() => setSelectedRelKey(selectedRelKey === rel.key ? null : rel.key)}
              />
            ))}
          </svg>

          {/* Table cards — fixed positions, no drag */}
          {model.views.map((view) => {
            const pos = positions[view.id];
            if (!pos) return null;
            return (
              <div
                key={view.id}
                ref={(el) => { cardRefs.current[view.id] = el; }}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: CARD_WIDTH,
                  zIndex: 1,
                }}
              >
                <ViewCard
                  view={view}
                  onEdit={canEdit && onEditView ? () => onEditView(view) : undefined}
                  highlightedCols={viewHighlights[view.id]}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Add Relationship Dialog */}
      <RelationshipDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleAddJoin}
        views={model.views}
        isSaving={addJoin.isPending}
      />
    </div>
  );
}
