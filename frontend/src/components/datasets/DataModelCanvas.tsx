/**
 * DataModelCanvas — Visual ERD editor for a dataset.
 *
 * Features:
 * - Table cards with absolute positioning (draggable by header)
 * - SVG overlay with relationship lines (crow-foot cardinality labels)
 * - Add / delete relationships via dialog
 * - Auto-layout on first load (3-column grid)
 */
'use client';

import React, {
  useState,
  useEffect,
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
  Eye,
  EyeOff,
  Pencil,
  Sigma,
  Plus,
  Trash2,
  GripVertical,
  Link2,
} from 'lucide-react';
import {
  useDatasetModel,
  useGenerateModel,
  useAddJoin,
  useRemoveJoin,
  type AddJoinParams,
  type DatasetModelView,
} from '@/hooks/use-dataset-model';
import { RelationshipDialog } from './RelationshipDialog';
import { toast } from 'sonner';

// ─── Layout constants ────────────────────────────────────────────────────────

const CARD_WIDTH = 272;
const HEADER_H = 44; // px — header height for connection point calc
const COLS = 3;
const GAP_X = 56;
const GAP_Y = 48;
const PAD = 40;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeInitialLayout(views: DatasetModelView[]): Record<number, { x: number; y: number }> {
  const out: Record<number, { x: number; y: number }> = {};
  views.forEach((v, i) => {
    out[v.id] = {
      x: PAD + (i % COLS) * (CARD_WIDTH + GAP_X),
      y: PAD + Math.floor(i / COLS) * (300 + GAP_Y),
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

function makePath(
  sx: number, sy: number, tx: number, ty: number
): string {
  const dx = Math.abs(tx - sx) * 0.55 + 10;
  if (sx <= tx) {
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }
  return `M ${sx} ${sy} C ${sx - dx} ${sy}, ${tx + dx} ${ty}, ${tx} ${ty}`;
}

/** Parse "${TABLE}.fromCol = ${viewName}.toCol" from sql_on */
function parseSqlOn(sqlOn: string): { fromCol: string; toCol: string } | null {
  const m = sqlOn?.match(/\}\.(\w+)\s*=\s*\$\{[^}]+\}\.(\w+)/);
  if (!m) return null;
  return { fromCol: m[1], toCol: m[2] };
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
  onDragStart: (e: React.MouseEvent) => void;
  onEdit?: () => void;
  /** Column names that are part of a join — rendered with a visual indicator */
  highlightedCols?: Set<string>;
}

function ViewCard({ view, onDragStart, onEdit, highlightedCols }: ViewCardProps) {
  const [dimsOpen, setDimsOpen] = useState(true);
  const [msrOpen, setMsrOpen] = useState(false);

  const vis   = view.dimensions.filter((d) => !d.hidden);
  const hid   = view.dimensions.filter((d) => d.hidden);
  const visM  = view.measures.filter((m) => !m.hidden);

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm select-none" style={{ width: CARD_WIDTH }}>
      {/* Header — drag handle */}
      <div
        onMouseDown={onDragStart}
        className="px-3 py-2.5 border-b bg-gradient-to-r from-blue-50 to-indigo-50
          rounded-t-lg flex items-center justify-between cursor-grab active:cursor-grabbing"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripVertical className="w-3.5 h-3.5 text-gray-400 shrink-0" />
          <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
          <span className="font-semibold text-sm text-gray-800 truncate">
            {view.table_display_name || view.name}
          </span>
        </div>
        {onEdit && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
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
          <div className="px-1.5 pb-1.5 space-y-0.5 max-h-40 overflow-y-auto">
            {vis.map((d) => {
              const isJoin = highlightedCols?.has(d.name);
              return (
                <div
                  key={d.name}
                  data-col-name={d.name}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] hover:bg-blue-50${
                    isJoin ? ' bg-indigo-50 border-l-2 border-indigo-400 pl-1.5' : ''
                  }`}
                  title={d.sql || d.name}
                >
                  <DimIcon type={d.type} />
                  <span className="text-gray-700 truncate">{d.label || d.name}</span>
                  {isJoin && (
                    <Link2 className="w-2.5 h-2.5 text-indigo-400 shrink-0 ml-auto" />
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

// ─── Relationship line (rendered inside SVG) ─────────────────────────────────

interface RelLineProps {
  fromPos:   { x: number; y: number };
  toPos:     { x: number; y: number };
  /** Absolute canvas Y for the from-column row; omit to use header centre */
  fromColY?: number;
  /** Absolute canvas Y for the to-column row; omit to use header centre */
  toColY?:   number;
  relationship?: string;
  joinType:  string;
  isSelected: boolean;
  onClick:   () => void;
}

function RelLine({
  fromPos, toPos,
  fromColY, toColY,
  relationship, joinType,
  isSelected, onClick,
}: RelLineProps) {
  const [hovered, setHovered] = useState(false);

  // Use column-specific row Y when available, else fall back to header centre
  const fromMidY = fromColY ?? (fromPos.y + HEADER_H / 2);
  const toMidY   = toColY   ?? (toPos.y   + HEADER_H / 2);

  // Choose left or right edge based on relative horizontal position
  let sx: number, tx: number;
  if (fromPos.x + CARD_WIDTH / 2 <= toPos.x + CARD_WIDTH / 2) {
    sx = fromPos.x + CARD_WIDTH;  // → right edge of source
    tx = toPos.x;                  // ← left edge of target
  } else {
    sx = fromPos.x;                // ← left edge of source
    tx = toPos.x + CARD_WIDTH;    // → right edge of target
  }

  const path  = makePath(sx, fromMidY, tx, toMidY);
  const { src, tgt } = cardinalityLabels(relationship);
  const active = isSelected || hovered;
  const stroke = active ? '#6366f1' : '#94a3b8';

  // Midpoint of path for join-type label
  const mx = (sx + tx) / 2;
  const my = (fromMidY + toMidY) / 2;

  return (
    <g>
      {/* Wide invisible hit area — owns all pointer events */}
      <path
        d={path}
        stroke="transparent"
        strokeWidth={12}
        fill="none"
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      />

      {/* Visible path */}
      <path
        d={path}
        stroke={stroke}
        strokeWidth={active ? 2 : 1.5}
        fill="none"
        strokeDasharray={isSelected ? '6 3' : undefined}
        style={{ pointerEvents: 'none', transition: 'stroke 0.15s' }}
      />

      {/* Source cardinality badge */}
      <g transform={`translate(${sx <= tx ? sx + 6 : sx - 6}, ${fromMidY})`}>
        <circle
          r={8}
          fill={active ? '#eef2ff' : '#f8fafc'}
          stroke={stroke}
          strokeWidth={active ? 1.5 : 1}
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={8}
          fontWeight="700"
          fill={active ? '#6366f1' : '#64748b'}
        >
          {src}
        </text>
      </g>

      {/* Target cardinality badge */}
      <g transform={`translate(${sx <= tx ? tx - 6 : tx + 6}, ${toMidY})`}>
        <circle
          r={8}
          fill={active ? '#eef2ff' : '#f8fafc'}
          stroke={stroke}
          strokeWidth={active ? 1.5 : 1}
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={8}
          fontWeight="700"
          fill={active ? '#6366f1' : '#64748b'}
        >
          {tgt}
        </text>
      </g>

      {/* Join type chip in the middle */}
      {active && (
        <g transform={`translate(${mx}, ${my})`}>
          <rect x={-20} y={-9} width={40} height={18} rx={9} fill="#6366f1" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={7}
            fontWeight="700"
            fill="white"
            letterSpacing={0.3}
          >
            {joinType.toUpperCase()}
          </text>
        </g>
      )}
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

  // Card positions — keyed by view ID
  const [positions, setPositions] = useState<Record<number, { x: number; y: number }>>({});

  // Card heights (measured via ref callbacks)
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [cardHeights, setCardHeights] = useState<Record<number, number>>({});
  // Y-offset of each column within its card (for drawing lines from column rows)
  const [colOffsets, setColOffsets] = useState<Record<number, Record<string, number>>>({});

  // Drag state
  const drag = useRef<{
    id: number;
    startMX: number;
    startMY: number;
    origX:   number;
    origY:   number;
  } | null>(null);

  // Selected relationship line {fromViewId, toViewName}
  const [selectedRel, setSelectedRel] = useState<{ fromViewId: number; toViewName: string } | null>(null);

  // Add-relationship dialog
  const [dialogOpen, setDialogOpen] = useState(false);

  // Init positions when model loads
  useEffect(() => {
    if (!model?.views?.length) return;
    setPositions((prev) => {
      // Only init views that don't have positions yet
      const next = { ...prev };
      const initial = computeInitialLayout(model.views);
      for (const v of model.views) {
        if (!(v.id in next)) next[v.id] = initial[v.id];
      }
      return next;
    });
  }, [model?.model_id]);

  // ResizeObserver to track actual card heights
  useEffect(() => {
    const observers: ResizeObserver[] = [];
    for (const [idStr, el] of Object.entries(cardRefs.current)) {
      if (!el) continue;
      const id = Number(idStr);
      const obs = new ResizeObserver(([entry]) => {
        setCardHeights((prev) => ({
          ...prev,
          [id]: entry.contentRect.height,
        }));
      });
      obs.observe(el);
      observers.push(obs);
    }
    return () => observers.forEach((o) => o.disconnect());
  });

  // Measure Y-offset of each [data-col-name] row within its card
  useEffect(() => {
    const next: Record<number, Record<string, number>> = {};
    for (const [idStr, cardEl] of Object.entries(cardRefs.current)) {
      if (!cardEl) continue;
      const viewId = Number(idStr);
      next[viewId] = {};
      const cardRect = cardEl.getBoundingClientRect();
      cardEl.querySelectorAll<HTMLElement>('[data-col-name]').forEach((colEl) => {
        const name = colEl.dataset.colName!;
        const rect = colEl.getBoundingClientRect();
        next[viewId][name] = rect.top - cardRect.top + rect.height / 2;
      });
    }
    setColOffsets(next);
  }, [cardHeights]);

  // Drag mouse move / up
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const { id, startMX, startMY, origX, origY } = drag.current;
      setPositions((prev) => ({
        ...prev,
        [id]: {
          x: Math.max(0, origX + (e.clientX - startMX)),
          y: Math.max(0, origY + (e.clientY - startMY)),
        },
      }));
    };
    const onUp = () => { drag.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleDragStart = useCallback(
    (viewId: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = positions[viewId] ?? { x: 0, y: 0 };
      drag.current = {
        id: viewId,
        startMX: e.clientX,
        startMY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      };
    },
    [positions]
  );

  // Flatten all relationships for line rendering
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
          fromCol:      cols?.fromCol,
          toCol:        cols?.toCol,
          key:          `${ex.base_view_id}→${j.view}`,
        };
      })
    );
  }, [model?.explores]);

  // Build viewName → viewId map for line rendering
  const viewByName = useMemo(() => {
    const m: Record<string, DatasetModelView> = {};
    (model?.views ?? []).forEach((v) => { m[v.name] = v; });
    return m;
  }, [model?.views]);

  // Columns participating in at least one join (for visual highlight in cards)
  const viewHighlights = useMemo<Record<number, Set<string>>>(() => {
    const h: Record<number, Set<string>> = {};
    for (const rel of relationships) {
      if (rel.fromCol) {
        (h[rel.fromViewId] ??= new Set()).add(rel.fromCol);
      }
      const tv = viewByName[rel.toViewName];
      if (tv && rel.toCol) {
        (h[tv.id] ??= new Set()).add(rel.toCol);
      }
    }
    return h;
  }, [relationships, viewByName]);

  // Canvas dimensions
  const canvasSize = useMemo(() => {
    let w = 600, h = 400;
    (model?.views ?? []).forEach((v) => {
      const pos = positions[v.id];
      if (!pos) return;
      const ch = cardHeights[v.id] ?? 280;
      w = Math.max(w, pos.x + CARD_WIDTH + PAD);
      h = Math.max(h, pos.y + ch + PAD);
    });
    return { width: w, height: h };
  }, [positions, cardHeights, model?.views]);

  // Handlers
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
    if (!selectedRel) return;
    try {
      await removeJoin.mutateAsync({
        datasetId,
        fromViewId:  selectedRel.fromViewId,
        toViewName: selectedRel.toViewName,
      });
      setSelectedRel(null);
      toast.success('Relationship removed');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Failed to remove relationship');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

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
            Auto-generate a semantic model from your dataset tables. This creates
            dimensions, measures, and auto-detects relationships between tables.
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

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b bg-white flex items-center justify-between shrink-0 gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-gray-900">Data Model</h3>
          <span className="text-xs text-gray-400">
            {model.views.length} table{model.views.length !== 1 ? 's' : ''} ·{' '}
            {totalRels} relationship{totalRels !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Delete selected relationship */}
          {selectedRel && canEdit && (
            <button
              onClick={handleDeleteRel}
              disabled={removeJoin.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600
                border border-red-300 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              {removeJoin.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2 className="w-3.5 h-3.5" />}
              Delete Relationship
            </button>
          )}

          {/* Add relationship */}
          {canEdit && (
            <button
              onClick={() => { setSelectedRel(null); setDialogOpen(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700
                border border-blue-300 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Relationship
            </button>
          )}

          {/* Regenerate */}
          {canEdit && (
            <button
              onClick={() => handleGenerate(true)}
              disabled={generateModel.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600
                border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="Regenerate model (overwrite existing)"
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
        onClick={() => setSelectedRel(null)}
        style={{
          backgroundImage:
            'radial-gradient(circle, #cdd0d8 1px, transparent 1px)',
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
          {/* SVG relationship lines — rendered below cards */}
          <svg
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            {relationships.map((rel) => {
              const fromPos = positions[rel.fromViewId];
              const toView  = viewByName[rel.toViewName];
              if (!fromPos || !toView) return null;
              const toPos = positions[toView.id];
              if (!toPos) return null;

              const isSelected =
                selectedRel?.fromViewId  === rel.fromViewId &&
                selectedRel?.toViewName  === rel.toViewName;

              // Compute canvas-absolute Y for each joined column
              const fromOffY = rel.fromCol != null
                ? colOffsets[rel.fromViewId]?.[rel.fromCol]
                : undefined;
              const toOffY = rel.toCol != null
                ? colOffsets[toView.id]?.[rel.toCol]
                : undefined;

              return (
                <RelLine
                  key={rel.key}
                  fromPos={fromPos}
                  toPos={toPos}
                  fromColY={fromOffY != null ? fromPos.y + fromOffY : undefined}
                  toColY={toOffY   != null ? toPos.y   + toOffY   : undefined}
                  relationship={rel.relationship}
                  joinType={rel.joinType}
                  isSelected={isSelected}
                  onClick={() => {
                    setSelectedRel(
                      isSelected
                        ? null
                        : { fromViewId: rel.fromViewId, toViewName: rel.toViewName }
                    );
                  }}
                />
              );
            })}
          </svg>

          {/* Table cards */}
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
                  zIndex: drag.current?.id === view.id ? 10 : 1,
                }}
              >
                <ViewCard
                  view={view}
                  onDragStart={handleDragStart(view.id)}
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
