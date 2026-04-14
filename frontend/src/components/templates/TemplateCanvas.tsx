'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Trash2, ZoomIn, ZoomOut, Maximize, Copy } from 'lucide-react';
import type { TemplateBlock, TemplateBlockLayout } from '@/types/template';
import { BlockRenderer } from './BlockRenderer';

/* ── Constants ─────────────────────────────────────────────── */

const SNAP = 8;                 // optional snap grid (px)
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.08;
const MIN_BLOCK_W = 60;
const MIN_BLOCK_H = 30;

const CONTENT_PADDING = 120;     // px padding around content for fit-to-view

/* ── Types ─────────────────────────────────────────────────── */

type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

interface DragState {
  mode: 'move' | 'resize' | 'pan';
  blockId?: string;
  handle?: ResizeHandle;
  /** pointer start (screen px) */
  sx: number;
  sy: number;
  /** block geometry snapshot */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** pan snapshot */
  px: number;
  py: number;
}

/* ── Helpers ───────────────────────────────────────────────── */

function snap(v: number) {
  return Math.round(v / SNAP) * SNAP;
}

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  nw: 'nwse-resize', se: 'nwse-resize',
};

/* ── Component ─────────────────────────────────────────────── */

interface TemplateCanvasProps {
  blocks: TemplateBlock[];
  selectedBlockId: string | null;
  onSelectBlock: (id: string | null) => void;
  onBlocksChange: (blocks: TemplateBlock[]) => void;
  onRemoveBlock: (id: string) => void;
  onDuplicateBlock?: (id: string) => void;
  editable?: boolean;
}

export function TemplateCanvas({
  blocks,
  selectedBlockId,
  onSelectBlock,
  onBlocksChange,
  onRemoveBlock,
  onDuplicateBlock,
  editable = true,
}: TemplateCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.75);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [initialFit, setInitialFit] = useState(false);

  /* content bounding box (auto-computed from blocks) */
  const contentBounds = React.useMemo(() => {
    if (blocks.length === 0) return { x: 0, y: 0, w: 1200, h: 800 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of blocks) {
      minX = Math.min(minX, b.layout.x);
      minY = Math.min(minY, b.layout.y);
      maxX = Math.max(maxX, b.layout.x + b.layout.width);
      maxY = Math.max(maxY, b.layout.y + b.layout.height);
    }
    return {
      x: minX - CONTENT_PADDING,
      y: minY - CONTENT_PADDING,
      w: maxX - minX + 2 * CONTENT_PADDING,
      h: maxY - minY + 2 * CONTENT_PADDING,
    };
  }, [blocks]);

  /* ── Fit to viewport on mount ───────────────────────────── */
  useEffect(() => {
    if (initialFit || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cb = contentBounds;
    const scaleX = (rect.width - 40) / cb.w;
    const scaleY = (rect.height - 40) / cb.h;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
    setZoom(z);
    setPan({
      x: (rect.width - cb.w * z) / 2 - cb.x * z,
      y: (rect.height - cb.h * z) / 2 - cb.y * z,
    });
    setInitialFit(true);
  }, [initialFit, contentBounds]);

  /* ── Zoom (Ctrl+wheel or pinch) ─────────────────────────── */
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = containerRef.current!.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
        setZoom((prev) => {
          const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev * factor));
          // keep point under cursor fixed
          setPan((p) => ({
            x: mx - (mx - p.x) * (nz / prev),
            y: my - (my - p.y) * (nz / prev),
          }));
          return nz;
        });
      } else {
        // normal scroll → pan
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    },
    [],
  );

  /* ── Space key for pan mode ─────────────────────────────── */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /* ── Pointer move / up (drag in progress) ───────────────── */
  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;

      if (drag.mode === 'pan') {
        setPan({ x: drag.px + dx, y: drag.py + dy });
        return;
      }

      // delta in canvas coords
      const cdx = dx / zoom;
      const cdy = dy / zoom;

      if (drag.mode === 'move' && drag.blockId) {
        const nx = snap(drag.bx + cdx);
        const ny = snap(drag.by + cdy);
        onBlocksChange(
          blocks.map((b) =>
            b.id === drag.blockId
              ? { ...b, layout: { ...b.layout, x: nx, y: ny } }
              : b,
          ),
        );
      }

      if (drag.mode === 'resize' && drag.blockId && drag.handle) {
        const h = drag.handle;
        let nx = drag.bx;
        let ny = drag.by;
        let nw = drag.bw;
        let nh = drag.bh;

        if (h.includes('e')) nw = Math.max(MIN_BLOCK_W, snap(drag.bw + cdx));
        if (h.includes('s')) nh = Math.max(MIN_BLOCK_H, snap(drag.bh + cdy));
        if (h.includes('w')) {
          const newW = Math.max(MIN_BLOCK_W, snap(drag.bw - cdx));
          nx = snap(drag.bx + (drag.bw - newW));
          nw = newW;
        }
        if (h.includes('n')) {
          const newH = Math.max(MIN_BLOCK_H, snap(drag.bh - cdy));
          ny = snap(drag.by + (drag.bh - newH));
          nh = newH;
        }

        onBlocksChange(
          blocks.map((b) =>
            b.id === drag.blockId
              ? { ...b, layout: { x: nx, y: ny, width: nw, height: nh } }
              : b,
          ),
        );
      }
    };

    const onUp = () => setDrag(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, zoom, blocks, onBlocksChange]);

  /* ── Event starters ─────────────────────────────────────── */

  const startPan = (e: React.PointerEvent) => {
    setDrag({ mode: 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, bx: 0, by: 0, bw: 0, bh: 0 });
  };

  const startMove = (e: React.PointerEvent, block: TemplateBlock) => {
    e.stopPropagation();
    if (spaceHeld) { startPan(e); return; }
    onSelectBlock(block.id);
    setDrag({
      mode: 'move',
      blockId: block.id,
      sx: e.clientX,
      sy: e.clientY,
      bx: block.layout.x,
      by: block.layout.y,
      bw: block.layout.width,
      bh: block.layout.height,
      px: 0, py: 0,
    });
  };

  const startResize = (e: React.PointerEvent, block: TemplateBlock, handle: ResizeHandle) => {
    e.stopPropagation();
    setDrag({
      mode: 'resize',
      blockId: block.id,
      handle,
      sx: e.clientX,
      sy: e.clientY,
      bx: block.layout.x,
      by: block.layout.y,
      bw: block.layout.width,
      bh: block.layout.height,
      px: 0, py: 0,
    });
  };

  const handleCanvasPointerDown = (e: React.PointerEvent) => {
    // click on empty area
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasBg) {
      onSelectBlock(null);
      if (spaceHeld || e.button === 1) {
        startPan(e);
      }
    }
  };

  /* ── Zoom toolbar helpers ───────────────────────────────── */
  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, z * 1.2));
  const zoomOut = () => setZoom((z) => Math.max(MIN_ZOOM, z / 1.2));
  const fitToPage = () => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cb = contentBounds;
    const scaleX = (rect.width - 40) / cb.w;
    const scaleY = (rect.height - 40) / cb.h;
    const fitZ = Math.min(scaleX, scaleY, 1);
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZ));
    setZoom(z);
    setPan({
      x: (rect.width - cb.w * z) / 2 - cb.x * z,
      y: (rect.height - cb.h * z) / 2 - cb.y * z,
    });
  };

  /* ── Render ─────────────────────────────────────────────── */

  const cursorClass = drag?.mode === 'pan'
    ? 'cursor-grabbing'
    : spaceHeld
      ? 'cursor-grab'
      : 'cursor-default';

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden select-none ${cursorClass}`}
      style={{ background: '#f0f0f0' }}
      onWheel={handleWheel}
      onPointerDown={handleCanvasPointerDown}
    >
      {/* Dot grid background */}
      <div
        data-canvas-bg="1"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle, #c0c0c0 1px, transparent 1px)`,
          backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
          backgroundPosition: `${pan.x % (20 * zoom)}px ${pan.y % (20 * zoom)}px`,
        }}
      />

      {/* Transformed layer */}
      <div
        data-canvas-bg="1"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          willChange: 'transform',
        }}
      >
          {/* Blocks */}
          {blocks.map((block) => {
            const isSelected = selectedBlockId === block.id;
            const l = block.layout;

            return (
              <div
                key={block.id}
                className={`absolute group bg-white rounded-sm shadow-sm ${
                  editable ? 'cursor-move' : ''
                }`}
                style={{
                  left: l.x,
                  top: l.y,
                  width: l.width,
                  height: l.height,
                }}
                onPointerDown={(e) => editable && startMove(e, block)}
                onClick={(e) => { e.stopPropagation(); onSelectBlock(block.id); }}
              >
                {/* Selection border */}
                <div
                  className={`absolute inset-0 rounded-sm pointer-events-none transition-all ${
                    isSelected
                      ? 'border-2 border-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.2)]'
                      : 'border border-transparent group-hover:border-gray-300'
                  }`}
                />

                {/* Block content */}
                <div className="w-full h-full overflow-hidden">
                  <BlockRenderer block={block} />
                </div>

                {/* Resize handles (only when selected and editable) */}
                {isSelected && editable && (
                  <>
                    {(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeHandle[]).map((h) => (
                      <div
                        key={h}
                        className="absolute z-20"
                        style={{
                          cursor: HANDLE_CURSORS[h],
                          ...handlePosition(h),
                        }}
                        onPointerDown={(e) => startResize(e, block, h)}
                      >
                          <div className="w-2.5 h-2.5 rounded-sm border-2 border-blue-500 bg-white" />
                      </div>
                    ))}

                    {/* Block toolbar */}
                    <div
                      className="absolute flex items-center gap-0.5 rounded bg-white shadow-md border border-gray-200 px-1 py-0.5"
                      style={{ top: -36, left: 0 }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <span className="px-1.5 text-[10px] font-medium text-gray-400 uppercase tracking-wide">
                        {block.type}
                      </span>
                      {onDuplicateBlock && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDuplicateBlock(block.id); }}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                          title="Duplicate"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemoveBlock(block.id); }}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        title="Remove"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {/* Empty state */}
          {blocks.length === 0 && (
            <div className="absolute pointer-events-none" style={{ left: 0, top: 200, width: 400, textAlign: 'center' }}>
              <p className="text-gray-400 text-sm">No blocks yet</p>
              <p className="text-gray-300 text-xs mt-1">Add blocks from the palette or import an Excel file</p>
            </div>
          )}
      </div>

      {/* Zoom toolbar (bottom-right) */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-lg bg-white shadow-md border border-gray-200 px-2 py-1.5 z-30">
        <button onClick={zoomOut} className="rounded p-1 text-gray-500 hover:bg-gray-100" title="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="min-w-[3rem] text-center text-xs font-medium text-gray-500 select-none">
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={zoomIn} className="rounded p-1 text-gray-500 hover:bg-gray-100" title="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-gray-200" />
        <button onClick={fitToPage} className="rounded p-1 text-gray-500 hover:bg-gray-100" title="Fit to content">
          <Maximize className="h-4 w-4" />
        </button>
      </div>

      {/* Keyboard hint */}
      <div className="absolute bottom-4 left-4 text-[10px] text-gray-400 z-30 select-none">
        Scroll to pan · Ctrl+Scroll to zoom · Space+drag to pan
      </div>
    </div>
  );
}

/* ── Resize handle positioning ────────────────────────────── */

function handlePosition(h: ResizeHandle): React.CSSProperties {
  const half = -5; // offset to center the 10px handle
  const base: React.CSSProperties = {};

  switch (h) {
    case 'n':  return { top: half, left: '50%', marginLeft: half };
    case 'ne': return { top: half, right: half };
    case 'e':  return { top: '50%', right: half, marginTop: half };
    case 'se': return { bottom: half, right: half };
    case 's':  return { bottom: half, left: '50%', marginLeft: half };
    case 'sw': return { bottom: half, left: half };
    case 'w':  return { top: '50%', left: half, marginTop: half };
    case 'nw': return { top: half, left: half };
    default:   return base;
  }
}
