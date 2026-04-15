'use client';

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  Bold, Italic, AlignLeft, AlignCenter, AlignRight,
  Merge, Plus, Trash2, Database, ChevronDown, Paintbrush,
  Pencil, RefreshCw, Copy, ClipboardPaste,
} from 'lucide-react';
import type { SheetData, SpreadsheetCell, SpreadsheetBorders, MergeRange, CellValue, DataFieldBinding } from '@/types/template';
import { hasSpreadsheetBorders, isDataField, cellDisplayText } from '@/types/template';
import { DataFieldPicker } from './DataFieldPicker';

/* ── Constants ─────────────────────────────────────────────── */

const ROW_HEADER_W = 40;
const COL_HEADER_H = 24;
const DEFAULT_ROW_H = 28;
const MIN_COL_W = 30;
const MIN_ROW_H = 16;
const AUTO_GROW_ROWS = 50;
const AUTO_GROW_THRESHOLD = 5;
const EXPLICIT_BORDER_COLOR = '#111827';

const BG_PRESETS = ['', '#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3', '#f3e8ff', '#fed7aa', '#e5e7eb'];
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;

/* ── Helpers ────────────────────────────────────────────────── */

function colLabel(idx: number): string {
  let s = '';
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function ck(r: number, c: number) {
  return `${r},${c}`;
}

function getCell(cells: Record<string, SpreadsheetCell>, r: number, c: number): SpreadsheetCell {
  return cells[ck(r, c)] ?? { value: '' };
}

function setCell(
  cells: Record<string, SpreadsheetCell>,
  r: number,
  c: number,
  cell: SpreadsheetCell,
): Record<string, SpreadsheetCell> {
  const next = { ...cells };
  const v = cell.value;
  const hasContent = (typeof v === 'string' && v !== '') || (typeof v === 'object' && v !== null);
  const hasFormat = cell.bold || cell.italic || cell.align || cell.bg || cell.fontSize || hasSpreadsheetBorders(cell.borders);
  if (!hasContent && !hasFormat) {
    delete next[ck(r, c)];
  } else {
    next[ck(r, c)] = cell;
  }
  return next;
}

function getMergeInfo(
  merges: MergeRange[],
  r: number,
  c: number,
): { origin: boolean; hidden: boolean; colSpan?: number; rowSpan?: number; merge?: MergeRange } {
  for (const m of merges) {
    if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) {
      if (r === m.r1 && c === m.c1) {
        return { origin: true, hidden: false, colSpan: m.c2 - m.c1 + 1, rowSpan: m.r2 - m.r1 + 1, merge: m };
      }
      return { origin: false, hidden: true, merge: m };
    }
  }
  return { origin: true, hidden: false };
}

function isRepeatingRow(cells: Record<string, SpreadsheetCell>, row: number, colCount: number): string | null {
  const sources: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const cell = cells[ck(row, c)];
    if (!cell?.value) continue;
    if (typeof cell.value === 'string') continue;
    if (isDataField(cell.value)) {
      const b = cell.value;
      if (b.agg) return null;
      sources.push(`${b.datasetId}:${b.tableId}`);
    }
  }
  if (sources.length === 0) return null;
  const unique = new Set(sources);
  return unique.size === 1 ? sources[0] : null;
}

function getExplicitBorderStyle(borders?: SpreadsheetBorders): React.CSSProperties {
  return {
    borderTop: borders?.top ? `1px solid ${EXPLICIT_BORDER_COLOR}` : undefined,
    borderRight: borders?.right ? `1px solid ${EXPLICIT_BORDER_COLOR}` : undefined,
    borderBottom: borders?.bottom ? `1px solid ${EXPLICIT_BORDER_COLOR}` : undefined,
    borderLeft: borders?.left ? `1px solid ${EXPLICIT_BORDER_COLOR}` : undefined,
  };
}

function shiftCells(
  cells: Record<string, SpreadsheetCell>,
  axis: 'row' | 'col',
  idx: number,
  delta: 1 | -1,
): Record<string, SpreadsheetCell> {
  const next: Record<string, SpreadsheetCell> = {};
  for (const [key, cell] of Object.entries(cells)) {
    const [r, c] = key.split(',').map(Number);
    if (axis === 'row') {
      if (delta === -1 && r === idx) continue;
      const nr = delta === 1 ? (r >= idx ? r + 1 : r) : (r > idx ? r - 1 : r);
      next[ck(nr, c)] = cell;
    } else {
      if (delta === -1 && c === idx) continue;
      const nc = delta === 1 ? (c >= idx ? c + 1 : c) : (c > idx ? c - 1 : c);
      next[ck(r, nc)] = cell;
    }
  }
  return next;
}

function shiftMerges(
  merges: MergeRange[],
  axis: 'row' | 'col',
  idx: number,
  delta: 1 | -1,
): MergeRange[] {
  return merges
    .map((m) => {
      if (axis === 'row') {
        if (delta === -1 && idx >= m.r1 && idx <= m.r2) return null;
        return {
          ...m,
          r1: delta === 1 ? (m.r1 >= idx ? m.r1 + 1 : m.r1) : (m.r1 > idx ? m.r1 - 1 : m.r1),
          r2: delta === 1 ? (m.r2 >= idx ? m.r2 + 1 : m.r2) : (m.r2 > idx ? m.r2 - 1 : m.r2),
        };
      } else {
        if (delta === -1 && idx >= m.c1 && idx <= m.c2) return null;
        return {
          ...m,
          c1: delta === 1 ? (m.c1 >= idx ? m.c1 + 1 : m.c1) : (m.c1 > idx ? m.c1 - 1 : m.c1),
          c2: delta === 1 ? (m.c2 >= idx ? m.c2 + 1 : m.c2) : (m.c2 > idx ? m.c2 - 1 : m.c2),
        };
      }
    })
    .filter(Boolean) as MergeRange[];
}

/* ── Types ─────────────────────────────────────────────────── */

interface Sel {
  row: number;
  col: number;
}

interface CtxMenu {
  x: number;
  y: number;
  row: number;
  col: number;
}

/* ── Component ─────────────────────────────────────────────── */

interface SpreadsheetEditorProps {
  data: SheetData;
  onChange: (data: SheetData) => void;
  readOnly?: boolean;
}

export function SpreadsheetEditor({ data, onChange, readOnly = false }: SpreadsheetEditorProps) {
  /* ── Selection state ── */
  const [selStart, setSelStart] = useState<Sel | null>(null);
  const [selEnd, setSelEnd] = useState<Sel | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  /* ── Pickers ── */
  const [showFieldPicker, setShowFieldPicker] = useState(false);
  const [showBgPicker, setShowBgPicker] = useState(false);

  /* ── Column resize ── */
  const [resizingCol, setResizingCol] = useState<number | null>(null);
  const [resizeStartX, setResizeStartX] = useState(0);
  const [resizeStartW, setResizeStartW] = useState(0);

  /* ── Row resize ── */
  const [resizingRow, setResizingRow] = useState<number | null>(null);
  const [resizeRowStartY, setResizeRowStartY] = useState(0);
  const [resizeRowStartH, setResizeRowStartH] = useState(0);

  /* ── Context menu ── */
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  /* ── Merge col count fallback ── */
  const [mergeColCount, setMergeColCount] = useState(2);

  const gridRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const { colCount, rowCount, colWidths, rowHeights, cells, merges } = data;

  /* ── Derived: primary cell = selStart ── */
  const sel = selStart;

  const selRange = useMemo(() => {
    if (!selStart) return null;
    const end = selEnd || selStart;
    return {
      r1: Math.min(selStart.row, end.row),
      c1: Math.min(selStart.col, end.col),
      r2: Math.max(selStart.row, end.row),
      c2: Math.max(selStart.col, end.col),
    };
  }, [selStart, selEnd]);

  const isSelRange = !!(selRange && (selRange.r1 !== selRange.r2 || selRange.c1 !== selRange.c2));

  const isCellInRange = useCallback(
    (r: number, c: number) => {
      if (!selRange) return false;
      return r >= selRange.r1 && r <= selRange.r2 && c >= selRange.c1 && c <= selRange.c2;
    },
    [selRange],
  );

  useEffect(() => {
    if (editing && editRef.current) editRef.current.focus();
  }, [editing]);

  /* ── Data mutation helpers ── */

  const updateData = useCallback(
    (patch: Partial<SheetData>) => {
      onChange({ ...data, ...patch });
    },
    [data, onChange],
  );

  const updateCell = useCallback(
    (r: number, c: number, patch: Partial<SpreadsheetCell>) => {
      const cur = getCell(cells, r, c);
      const updated = { ...cur, ...patch };
      updateData({ cells: setCell(cells, r, c, updated) });
    },
    [cells, updateData],
  );

  const commitEdit = useCallback(() => {
    if (editing && sel) {
      updateCell(sel.row, sel.col, { value: editValue });
    }
    setEditing(false);
  }, [editing, sel, editValue, updateCell]);

  /* ── Auto-grow rows ── */

  const ensureRow = useCallback(
    (targetRow: number) => {
      if (targetRow < rowCount) return;
      const needed = targetRow - rowCount + 1 + AUTO_GROW_ROWS;
      updateData({
        rowCount: rowCount + needed,
        rowHeights: [...rowHeights, ...Array(needed).fill(DEFAULT_ROW_H)],
      });
    },
    [rowCount, rowHeights, updateData],
  );

  /* ── Navigation ── */

  const moveSel = useCallback(
    (dr: number, dc: number) => {
      if (!sel) return;
      const nr = Math.max(0, sel.row + dr);
      const nc = Math.max(0, Math.min(colCount - 1, sel.col + dc));
      if (nr >= rowCount - AUTO_GROW_THRESHOLD) ensureRow(nr);
      setSelStart({ row: nr, col: nc });
      setSelEnd(null);
    },
    [sel, colCount, rowCount, ensureRow],
  );

  const extendSel = useCallback(
    (dr: number, dc: number) => {
      const anchor = selEnd || sel;
      if (!anchor) return;
      const nr = Math.max(0, anchor.row + dr);
      const nc = Math.max(0, Math.min(colCount - 1, anchor.col + dc));
      if (nr >= rowCount - AUTO_GROW_THRESHOLD) ensureRow(nr);
      setSelEnd({ row: nr, col: nc });
    },
    [sel, selEnd, colCount, rowCount, ensureRow],
  );

  /* ── Copy / Paste ── */

  const handleCopy = useCallback(() => {
    if (!selRange) return;
    const lines: string[] = [];
    for (let r = selRange.r1; r <= selRange.r2; r++) {
      const cols: string[] = [];
      for (let c = selRange.c1; c <= selRange.c2; c++) {
        cols.push(cellDisplayText(getCell(cells, r, c).value));
      }
      lines.push(cols.join('\t'));
    }
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
  }, [selRange, cells]);

  const handlePaste = useCallback(() => {
    if (!sel) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (!text) return;
        const lines = text.split(/\r?\n/);
        const newCells = { ...cells };
        let maxR = sel.row;
        let maxC = sel.col;
        lines.forEach((line, ri) => {
          const parts = line.split('\t');
          parts.forEach((val, ci) => {
            const tr = sel.row + ri;
            const tc = sel.col + ci;
            if (tc < colCount) {
              const cur = getCell(newCells, tr, tc);
              newCells[ck(tr, tc)] = { ...cur, value: val };
              if (tr > maxR) maxR = tr;
              if (tc > maxC) maxC = tc;
            }
          });
        });
        const newRowCount = Math.max(rowCount, maxR + 1 + AUTO_GROW_THRESHOLD);
        const newRowHeights =
          newRowCount > rowCount
            ? [...rowHeights, ...Array(newRowCount - rowCount).fill(DEFAULT_ROW_H)]
            : rowHeights;
        updateData({ cells: newCells, rowCount: newRowCount, rowHeights: newRowHeights });
      })
      .catch(() => {});
  }, [sel, cells, colCount, rowCount, rowHeights, updateData]);

  /* ── Formatting (range-aware) ── */

  const applyToRange = useCallback(
    (fn: (cur: SpreadsheetCell, r: number, c: number) => Partial<SpreadsheetCell>) => {
      if (!sel) return;
      if (selRange && isSelRange) {
        const newCells = { ...cells };
        for (let r = selRange.r1; r <= selRange.r2; r++) {
          for (let c = selRange.c1; c <= selRange.c2; c++) {
            const cur = getCell(newCells, r, c);
            const patch = fn(cur, r, c);
            const updated = { ...cur, ...patch };
            const v = updated.value;
            const hasContent = (typeof v === 'string' && v !== '') || (typeof v === 'object' && v !== null);
            const hasFormat = updated.bold || updated.italic || updated.align || updated.bg || updated.fontSize || hasSpreadsheetBorders(updated.borders);
            if (!hasContent && !hasFormat) {
              delete newCells[ck(r, c)];
            } else {
              newCells[ck(r, c)] = updated;
            }
          }
        }
        updateData({ cells: newCells });
      } else {
        const cur = getCell(cells, sel.row, sel.col);
        updateCell(sel.row, sel.col, fn(cur, sel.row, sel.col));
      }
    },
    [sel, selRange, isSelRange, cells, updateCell, updateData],
  );

  const handleBorderAction = useCallback(
    (mode: 'all' | 'clear' | (typeof BORDER_SIDES)[number]) => {
      if (!sel || !selRange) return;

      const anchorBorders = getCell(cells, sel.row, sel.col).borders;
      const enableAll = !BORDER_SIDES.every((side) => !!anchorBorders?.[side]);
      const enableSide = mode === 'clear' ? false : !anchorBorders?.[mode as keyof SpreadsheetBorders];

      applyToRange((cur, r, c) => {
        if (mode === 'clear') {
          return { borders: undefined };
        }

        if (mode === 'all') {
          return {
            borders: enableAll ? { top: true, right: true, bottom: true, left: true } : undefined,
          };
        }

        const nextBorders: SpreadsheetBorders = { ...(cur.borders ?? {}) };
        const shouldApply =
          (mode === 'top' && r === selRange.r1) ||
          (mode === 'right' && c === selRange.c2) ||
          (mode === 'bottom' && r === selRange.r2) ||
          (mode === 'left' && c === selRange.c1);

        if (shouldApply) {
          if (enableSide) {
            nextBorders[mode] = true;
          } else {
            delete nextBorders[mode];
          }
        }

        return { borders: hasSpreadsheetBorders(nextBorders) ? nextBorders : undefined };
      });
    },
    [sel, selRange, cells, applyToRange],
  );

  const toggleBoldRange = useCallback(() => {
    if (!sel) return;
    const anchor = getCell(cells, sel.row, sel.col);
    const newVal = !anchor.bold;
    applyToRange(() => ({ bold: newVal || undefined }));
  }, [sel, cells, applyToRange]);

  const toggleItalicRange = useCallback(() => {
    if (!sel) return;
    const anchor = getCell(cells, sel.row, sel.col);
    const newVal = !anchor.italic;
    applyToRange(() => ({ italic: newVal || undefined }));
  }, [sel, cells, applyToRange]);

  const handleSetAlign = useCallback(
    (align: 'left' | 'center' | 'right') => {
      applyToRange(() => ({ align }));
    },
    [applyToRange],
  );

  const handleSetBg = useCallback(
    (bg: string) => {
      applyToRange(() => ({ bg: bg || undefined }));
      setShowBgPicker(false);
    },
    [applyToRange],
  );

  /* ── Data binding ── */

  const handleFieldSelect = useCallback(
    (binding: DataFieldBinding) => {
      if (!sel) return;
      updateCell(sel.row, sel.col, { value: binding });
      setShowFieldPicker(false);
    },
    [sel, updateCell],
  );

  /* ── Keyboard ── */

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!sel || readOnly) return;

      /* ── While editing ── */
      if (editing) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitEdit();
          moveSel(1, 0);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commitEdit();
          moveSel(0, e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          setEditing(false);
        }
        return;
      }

      /* ── Ctrl shortcuts ── */
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'c':
            e.preventDefault();
            handleCopy();
            return;
          case 'v':
            e.preventDefault();
            handlePaste();
            return;
          case 'b':
            e.preventDefault();
            toggleBoldRange();
            return;
          case 'i':
            e.preventDefault();
            toggleItalicRange();
            return;
          case 'a':
            e.preventDefault();
            setSelStart({ row: 0, col: 0 });
            setSelEnd({ row: rowCount - 1, col: colCount - 1 });
            return;
        }
      }

      /* ── Shift+Arrow extends selection ── */
      if (e.shiftKey) {
        switch (e.key) {
          case 'ArrowUp': e.preventDefault(); extendSel(-1, 0); return;
          case 'ArrowDown': e.preventDefault(); extendSel(1, 0); return;
          case 'ArrowLeft': e.preventDefault(); extendSel(0, -1); return;
          case 'ArrowRight': e.preventDefault(); extendSel(0, 1); return;
        }
      }

      switch (e.key) {
        case 'ArrowUp': e.preventDefault(); moveSel(-1, 0); break;
        case 'ArrowDown': e.preventDefault(); moveSel(1, 0); break;
        case 'ArrowLeft': e.preventDefault(); moveSel(0, -1); break;
        case 'ArrowRight': e.preventDefault(); moveSel(0, 1); break;
        case 'Tab':
          e.preventDefault();
          moveSel(0, e.shiftKey ? -1 : 1);
          break;
        case 'Enter':
        case 'F2':
          e.preventDefault();
          setEditing(true);
          {
            const cell = getCell(cells, sel.row, sel.col);
            setEditValue(typeof cell.value === 'string' ? cell.value : '');
          }
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (selRange && isSelRange) {
            const newCells = { ...cells };
            for (let r = selRange.r1; r <= selRange.r2; r++) {
              for (let c = selRange.c1; c <= selRange.c2; c++) {
                const cur = getCell(newCells, r, c);
                newCells[ck(r, c)] = { ...cur, value: '' };
              }
            }
            updateData({ cells: newCells });
          } else {
            updateCell(sel.row, sel.col, { value: '' });
          }
          break;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            setEditing(true);
            setEditValue(e.key);
          }
      }
    },
    [sel, editing, readOnly, cells, selRange, isSelRange, rowCount, colCount, commitEdit, moveSel, extendSel, updateCell, updateData, handleCopy, handlePaste, toggleBoldRange, toggleItalicRange],
  );

  /* ── Cell interactions ── */

  const handleCellClick = useCallback(
    (r: number, c: number, e: React.MouseEvent) => {
      if (editing) commitEdit();
      if (ctxMenu) setCtxMenu(null);
      if (e.shiftKey && selStart) {
        setSelEnd({ row: r, col: c });
      } else {
        setSelStart({ row: r, col: c });
        setSelEnd(null);
      }
    },
    [editing, commitEdit, selStart, ctxMenu],
  );

  const handleCellDblClick = useCallback(
    (r: number, c: number) => {
      if (readOnly) return;
      setSelStart({ row: r, col: c });
      setSelEnd(null);
      const cell = getCell(cells, r, c);
      if (isDataField(cell.value)) {
        setShowFieldPicker(true);
      } else {
        setEditing(true);
        setEditValue(typeof cell.value === 'string' ? cell.value : '');
      }
    },
    [readOnly, cells],
  );

  /* ── Context menu ── */

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, r: number, c: number) => {
      e.preventDefault();
      if (editing) commitEdit();
      if (!selStart || !isCellInRange(r, c)) {
        setSelStart({ row: r, col: c });
        setSelEnd(null);
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, row: r, col: c });
    },
    [editing, commitEdit, selStart, isCellInRange],
  );

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [ctxMenu]);

  /* ── Column resize ── */

  const handleColResizeStart = useCallback(
    (e: React.MouseEvent, colIdx: number) => {
      e.preventDefault();
      e.stopPropagation();
      setResizingCol(colIdx);
      setResizeStartX(e.clientX);
      setResizeStartW(colWidths[colIdx] ?? 100);
    },
    [colWidths],
  );

  useEffect(() => {
    if (resizingCol === null) return;
    const handleMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartX;
      const newW = Math.max(MIN_COL_W, resizeStartW + delta);
      const newWidths = [...colWidths];
      newWidths[resizingCol] = newW;
      updateData({ colWidths: newWidths });
    };
    const handleUp = () => setResizingCol(null);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [resizingCol, resizeStartX, resizeStartW, colWidths, updateData]);

  /* ── Row resize ── */

  const handleRowResizeStart = useCallback(
    (e: React.MouseEvent, rowIdx: number) => {
      e.preventDefault();
      e.stopPropagation();
      setResizingRow(rowIdx);
      setResizeRowStartY(e.clientY);
      setResizeRowStartH(rowHeights[rowIdx] ?? DEFAULT_ROW_H);
    },
    [rowHeights],
  );

  useEffect(() => {
    if (resizingRow === null) return;
    const handleMove = (e: MouseEvent) => {
      const delta = e.clientY - resizeRowStartY;
      const newH = Math.max(MIN_ROW_H, resizeRowStartH + delta);
      const newHeights = [...rowHeights];
      newHeights[resizingRow] = newH;
      updateData({ rowHeights: newHeights });
    };
    const handleUp = () => setResizingRow(null);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [resizingRow, resizeRowStartY, resizeRowStartH, rowHeights, updateData]);

  /* ── Row / Column ops ── */

  const addRow = useCallback(
    (atIdx?: number) => {
      const idx = atIdx ?? rowCount;
      const newRowHeights = [...rowHeights];
      newRowHeights.splice(idx, 0, DEFAULT_ROW_H);
      updateData({
        rowCount: rowCount + 1,
        rowHeights: newRowHeights,
        cells: shiftCells(cells, 'row', idx, 1),
        merges: shiftMerges(merges, 'row', idx, 1),
      });
    },
    [rowCount, rowHeights, cells, merges, updateData],
  );

  const removeRow = useCallback(
    (idx: number) => {
      if (rowCount <= 1) return;
      const newRowHeights = rowHeights.filter((_, i) => i !== idx);
      if (sel?.row === idx) { setSelStart(null); setSelEnd(null); }
      updateData({
        rowCount: rowCount - 1,
        rowHeights: newRowHeights,
        cells: shiftCells(cells, 'row', idx, -1),
        merges: shiftMerges(merges, 'row', idx, -1),
      });
    },
    [rowCount, rowHeights, cells, merges, sel, updateData],
  );

  const addColAt = useCallback(
    (idx: number) => {
      const newWidths = [...colWidths];
      newWidths.splice(idx, 0, 100);
      updateData({
        colCount: colCount + 1,
        colWidths: newWidths,
        cells: shiftCells(cells, 'col', idx, 1),
        merges: shiftMerges(merges, 'col', idx, 1),
      });
    },
    [colCount, colWidths, cells, merges, updateData],
  );

  const addCol = useCallback(() => addColAt(colCount), [addColAt, colCount]);

  const removeCol = useCallback(
    (idx: number) => {
      if (colCount <= 1) return;
      const newWidths = colWidths.filter((_, i) => i !== idx);
      if (sel?.col === idx) { setSelStart(null); setSelEnd(null); }
      updateData({
        colCount: colCount - 1,
        colWidths: newWidths,
        cells: shiftCells(cells, 'col', idx, -1),
        merges: shiftMerges(merges, 'col', idx, -1),
      });
    },
    [colCount, colWidths, cells, merges, sel, updateData],
  );

  /* ── Merge / Unmerge ── */

  const handleMerge = useCallback(() => {
    if (!sel) return;
    let r1: number, c1: number, r2: number, c2: number;
    if (isSelRange && selRange) {
      r1 = selRange.r1;
      c1 = selRange.c1;
      r2 = selRange.r2;
      c2 = selRange.c2;
    } else {
      r1 = sel.row;
      c1 = sel.col;
      r2 = sel.row;
      c2 = Math.min(sel.col + mergeColCount - 1, colCount - 1);
    }
    if (r1 === r2 && c1 === c2) return;
    const overlaps = merges.some(
      (m) => !(r2 < m.r1 || r1 > m.r2 || c2 < m.c1 || c1 > m.c2),
    );
    if (overlaps) return;
    updateData({ merges: [...merges, { r1, c1, r2, c2 }] });
  }, [sel, isSelRange, selRange, mergeColCount, colCount, merges, updateData]);

  const handleUnmerge = useCallback(() => {
    if (!sel) return;
    updateData({
      merges: merges.filter(
        (m) => !(sel.row >= m.r1 && sel.row <= m.r2 && sel.col >= m.c1 && sel.col <= m.c2),
      ),
    });
  }, [sel, merges, updateData]);

  /* ── Derived ── */

  const selCell = sel ? getCell(cells, sel.row, sel.col) : null;
  const selMerge = sel ? getMergeInfo(merges, sel.row, sel.col) : null;
  const totalWidth = colWidths.reduce((s, w) => s + w, 0);

  /* ── Render ── */

  return (
    <div
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      ref={gridRef}
    >
      {/* ── Toolbar ── */}
      {!readOnly && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200 bg-gray-50 text-xs flex-wrap shrink-0">
          {/* Cell reference */}
          {sel && (
            <span className="inline-flex items-center justify-center min-w-[3.5rem] rounded border border-gray-300 bg-white px-1.5 py-1 text-[11px] font-mono text-gray-600 shadow-sm">
              {colLabel(sel.col)}{sel.row + 1}
              {isSelRange && selRange && (
                <span className="text-gray-400 ml-0.5">:{colLabel(selRange.c2)}{selRange.r2 + 1}</span>
              )}
            </span>
          )}

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Bold / Italic */}
          <button
            onClick={toggleBoldRange}
            disabled={!sel}
            className={`rounded p-1.5 disabled:opacity-30 ${selCell?.bold ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'}`}
            title="Bold (Ctrl+B)"
          >
            <Bold className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={toggleItalicRange}
            disabled={!sel}
            className={`rounded p-1.5 disabled:opacity-30 ${selCell?.italic ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'}`}
            title="Italic (Ctrl+I)"
          >
            <Italic className="h-3.5 w-3.5" />
          </button>

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Alignment */}
          {(['left', 'center', 'right'] as const).map((a) => {
            const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
            return (
              <button
                key={a}
                onClick={() => handleSetAlign(a)}
                disabled={!sel}
                className={`rounded p-1.5 disabled:opacity-30 ${selCell?.align === a ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'}`}
                title={a}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Background color */}
          <div className="relative">
            <button
              onClick={() => sel && setShowBgPicker(!showBgPicker)}
              disabled={!sel}
              className="rounded p-1.5 text-gray-600 hover:bg-gray-100 disabled:opacity-30 inline-flex items-center gap-0.5"
              title="Background color"
            >
              <Paintbrush className="h-3.5 w-3.5" />
              <ChevronDown className="h-2.5 w-2.5" />
            </button>
            {showBgPicker && (
              <div className="absolute top-full left-0 z-50 flex gap-0.5 mt-1 p-1.5 bg-white rounded-lg border border-gray-200 shadow-lg">
                {BG_PRESETS.map((color) => (
                  <button
                    key={color || 'none'}
                    onClick={() => handleSetBg(color)}
                    className={`w-5 h-5 rounded border border-gray-300 ${!color ? 'bg-white relative' : ''}`}
                    style={color ? { backgroundColor: color } : undefined}
                    title={color || 'No fill'}
                  >
                    {!color && <span className="absolute inset-0 flex items-center justify-center text-[8px] text-gray-400">✕</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Borders */}
          <div className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white p-1">
            <button
              onClick={() => handleBorderAction('all')}
              disabled={!sel}
              className={`rounded px-2 py-1 text-[11px] disabled:opacity-30 ${BORDER_SIDES.every((side) => !!selCell?.borders?.[side]) ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'}`}
              title="Toggle all borders for selection"
            >
              All
            </button>
            {BORDER_SIDES.map((side) => (
              <button
                key={side}
                onClick={() => handleBorderAction(side)}
                disabled={!sel}
                className={`rounded px-2 py-1 text-[11px] capitalize disabled:opacity-30 ${selCell?.borders?.[side] ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'}`}
                title={`Toggle ${side} border for selection`}
              >
                {side}
              </button>
            ))}
            <button
              onClick={() => handleBorderAction('clear')}
              disabled={!sel}
              className="rounded px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 disabled:opacity-30"
              title="Clear borders in selection"
            >
              Clear
            </button>
          </div>

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Merge */}
          {sel && selMerge?.origin && selMerge.merge ? (
            <button
              onClick={handleUnmerge}
              className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 px-2 py-1 text-orange-700 text-[11px]"
              title="Unmerge cells"
            >
              <Merge className="h-3 w-3" /> Unmerge
            </button>
          ) : (
            <div className="inline-flex items-center gap-1">
              <button
                onClick={handleMerge}
                disabled={!sel}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30 text-[11px]"
                title={isSelRange ? 'Merge selected range' : 'Merge cells horizontally'}
              >
                <Merge className="h-3 w-3" /> Merge{isSelRange && ' selection'}
              </button>
              {!isSelRange && (
                <select
                  value={mergeColCount}
                  onChange={(e) => setMergeColCount(Number(e.target.value))}
                  className="rounded border border-gray-200 px-1 py-0.5 text-[11px] text-gray-600"
                  title="Number of columns to merge"
                >
                  {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <option key={n} value={n}>{n} cols</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Copy / Paste */}
          <button
            onClick={handleCopy}
            disabled={!sel}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30 text-[11px]"
            title="Copy (Ctrl+C)"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            onClick={handlePaste}
            disabled={!sel}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30 text-[11px]"
            title="Paste (Ctrl+V)"
          >
            <ClipboardPaste className="h-3 w-3" />
          </button>

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Data binding */}
          <div className="relative">
            <button
              onClick={() => sel && setShowFieldPicker(!showFieldPicker)}
              disabled={!sel}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-30 text-[11px] ${
                sel && selCell && isDataField(selCell.value)
                  ? 'border border-blue-300 bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="Bind cell to data field"
            >
              {sel && selCell && isDataField(selCell.value) ? (
                <><Pencil className="h-3 w-3" /> Edit binding</>
              ) : (
                <><Database className="h-3 w-3" /> Data</>
              )}
            </button>
            {showFieldPicker && (
              <div className="absolute top-full left-0 z-50 mt-1" onClick={(e) => e.stopPropagation()}>
                <DataFieldPicker onSelect={handleFieldSelect} onCancel={() => setShowFieldPicker(false)} />
              </div>
            )}
          </div>

          <div className="mx-1 h-4 w-px bg-gray-300" />

          {/* Row / Col operations */}
          <button
            onClick={() => addRow(sel ? sel.row + 1 : undefined)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-gray-600 hover:bg-gray-100 text-[11px]"
            title="Insert row below"
          >
            <Plus className="h-3 w-3" /> Row
          </button>
          <button
            onClick={addCol}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-gray-600 hover:bg-gray-100 text-[11px]"
            title="Add column at end"
          >
            <Plus className="h-3 w-3" /> Col
          </button>
          {sel && (
            <>
              <button
                onClick={() => removeRow(sel.row)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-red-500 hover:bg-red-50 text-[11px]"
                title="Delete selected row"
              >
                <Trash2 className="h-3 w-3" /> Row
              </button>
              <button
                onClick={() => removeCol(sel.col)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-red-500 hover:bg-red-50 text-[11px]"
                title="Delete selected column"
              >
                <Trash2 className="h-3 w-3" /> Col
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Formula bar ── */}
      {!readOnly && sel && (
        <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-200 bg-white text-xs shrink-0">
          <span className="text-gray-500 font-mono text-[11px] w-12 shrink-0 font-medium">
            {colLabel(sel.col)}{sel.row + 1}
          </span>
          <div className="h-3.5 w-px bg-gray-300" />
          <span className="text-gray-700 truncate flex-1">
            {selCell ? (
              isDataField(selCell.value)
                ? `📊 ${(selCell.value as DataFieldBinding).column}${(selCell.value as DataFieldBinding).agg ? ` (${(selCell.value as DataFieldBinding).agg})` : ''}`
                : cellDisplayText(selCell.value)
            ) : ''}
          </span>
        </div>
      )}

      {/* ── Grid ── */}
      <div
        className="flex-1 overflow-auto"
        style={{ backgroundColor: '#f8f9fa' }}
        onClick={() => {
          if (showBgPicker) setShowBgPicker(false);
          if (showFieldPicker) setShowFieldPicker(false);
        }}
      >
        <table
          className="border-collapse select-none"
          style={{ width: totalWidth + ROW_HEADER_W }}
        >
          {/* Column headers */}
          <thead>
            <tr>
              <th
                className="sticky top-0 left-0 z-20 border-r border-b border-gray-300"
                style={{
                  width: ROW_HEADER_W,
                  minWidth: ROW_HEADER_W,
                  height: COL_HEADER_H,
                  backgroundColor: '#f0f0f0',
                }}
              />
              {Array.from({ length: colCount }, (_, ci) => {
                const isColInRange = selRange && ci >= selRange.c1 && ci <= selRange.c2;
                const isColActive = sel?.col === ci;
                return (
                  <th
                    key={ci}
                    className={`sticky top-0 z-10 border-r border-b border-gray-300 text-[11px] font-medium relative select-none ${
                      isColActive || isColInRange
                        ? 'bg-blue-200 text-blue-800'
                        : 'text-gray-500'
                    }`}
                    style={{
                      width: colWidths[ci],
                      minWidth: colWidths[ci],
                      height: COL_HEADER_H,
                      backgroundColor: (isColActive || isColInRange) ? undefined : '#f0f0f0',
                    }}
                  >
                    {colLabel(ci)}
                    {/* Resize handle */}
                    {!readOnly && (
                      <div
                        className="absolute right-0 top-0 h-full w-[3px] cursor-col-resize hover:bg-blue-500 transition-colors"
                        onMouseDown={(e) => handleColResizeStart(e, ci)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {Array.from({ length: rowCount }, (_, ri) => {
              const repeating = isRepeatingRow(cells, ri, colCount);
              const isRowInRange = selRange && ri >= selRange.r1 && ri <= selRange.r2;
              const isRowActive = sel?.row === ri;
              return (
                <tr key={ri}>
                  {/* Row header */}
                  <td
                    className={`sticky left-0 z-10 border-r border-b border-gray-300 text-center text-[11px] font-medium relative select-none ${
                      isRowActive || isRowInRange
                        ? 'bg-blue-200 text-blue-800'
                        : 'text-gray-500'
                    }`}
                    style={{
                      width: ROW_HEADER_W,
                      minWidth: ROW_HEADER_W,
                      height: rowHeights[ri] ?? DEFAULT_ROW_H,
                      backgroundColor: (isRowActive || isRowInRange) ? undefined : '#f0f0f0',
                    }}
                    title={repeating ? `Repeating data row (source: ${repeating})` : `Row ${ri + 1}`}
                  >
                    <div className="flex items-center justify-center gap-0.5">
                      {repeating && <RefreshCw className="h-2.5 w-2.5 text-emerald-600 shrink-0" />}
                      <span>{ri + 1}</span>
                    </div>
                    {/* Row resize handle */}
                    {!readOnly && (
                      <div
                        className="absolute left-0 bottom-0 w-full h-[3px] cursor-row-resize hover:bg-blue-500 transition-colors"
                        onMouseDown={(e) => handleRowResizeStart(e, ri)}
                      />
                    )}
                  </td>

                  {/* Data cells */}
                  {Array.from({ length: colCount }, (_, ci) => {
                    const merge = getMergeInfo(merges, ri, ci);
                    if (merge.hidden) return null;

                    const cell = getCell(cells, ri, ci);
                    const isSel = sel?.row === ri && sel?.col === ci;
                    const isEd = isSel && editing;
                    const hasData = isDataField(cell.value);
                    const inRange = !isSel && isCellInRange(ri, ci);

                    return (
                      <td
                        key={ci}
                        colSpan={merge.colSpan}
                        rowSpan={merge.rowSpan}
                        onClick={(e) => handleCellClick(ri, ci, e)}
                        onDoubleClick={() => handleCellDblClick(ri, ci)}
                        onContextMenu={(e) => handleContextMenu(e, ri, ci)}
                        className={[
                          'border border-gray-200 px-1.5 text-xs cursor-cell overflow-hidden whitespace-nowrap',
                          isSel ? 'outline outline-2 outline-blue-600 z-10 relative' : '',
                          inRange ? 'bg-blue-50/70' : '',
                          cell.bold ? 'font-bold' : '',
                          cell.italic ? 'italic' : '',
                          cell.align === 'center' ? 'text-center' : cell.align === 'right' ? 'text-right' : 'text-left',
                          hasData ? 'text-blue-600' : 'text-gray-800',
                          repeating ? 'bg-emerald-50/60' : '',
                        ].join(' ')}
                        style={{
                          height: rowHeights[ri] ?? DEFAULT_ROW_H,
                          backgroundColor: inRange
                            ? undefined
                            : (cell.bg || (repeating ? undefined : 'white')),
                          minWidth: colWidths[ci],
                          maxWidth: merge.colSpan
                            ? colWidths.slice(ci, ci + (merge.colSpan ?? 1)).reduce((s, w) => s + w, 0)
                            : colWidths[ci],
                          ...getExplicitBorderStyle(cell.borders),
                        }}
                      >
                        {isEd ? (
                          <input
                            ref={editRef}
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            className="w-full h-full border-none outline-none bg-transparent text-xs"
                            style={{ textAlign: cell.align || 'left' }}
                          />
                        ) : (
                          <span className="block truncate">
                            {hasData ? (
                              <span className="inline-flex items-center gap-0.5">
                                <Database className="h-2.5 w-2.5 shrink-0 opacity-60" />
                                {cellDisplayText(cell.value)}
                              </span>
                            ) : (
                              cellDisplayText(cell.value)
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Context menu ── */}
      {ctxMenu && !readOnly && (
        <div
          className="fixed z-[100] bg-white border border-gray-200 rounded-lg shadow-xl py-1 text-xs min-w-[180px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
            onClick={() => { addRow(ctxMenu.row); setCtxMenu(null); }}
          >
            <Plus className="h-3 w-3 text-gray-400" /> Insert row above
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
            onClick={() => { addRow(ctxMenu.row + 1); setCtxMenu(null); }}
          >
            <Plus className="h-3 w-3 text-gray-400" /> Insert row below
          </button>
          <div className="my-1 h-px bg-gray-100" />
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
            onClick={() => { addColAt(ctxMenu.col); setCtxMenu(null); }}
          >
            <Plus className="h-3 w-3 text-gray-400" /> Insert column left
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
            onClick={() => { addColAt(ctxMenu.col + 1); setCtxMenu(null); }}
          >
            <Plus className="h-3 w-3 text-gray-400" /> Insert column right
          </button>
          <div className="my-1 h-px bg-gray-100" />
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2 text-red-600"
            onClick={() => { removeRow(ctxMenu.row); setCtxMenu(null); }}
          >
            <Trash2 className="h-3 w-3" /> Delete row {ctxMenu.row + 1}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2 text-red-600"
            onClick={() => { removeCol(ctxMenu.col); setCtxMenu(null); }}
          >
            <Trash2 className="h-3 w-3" /> Delete column {colLabel(ctxMenu.col)}
          </button>
          {isSelRange && (
            <>
              <div className="my-1 h-px bg-gray-100" />
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
                onClick={() => { handleMerge(); setCtxMenu(null); }}
              >
                <Merge className="h-3 w-3 text-gray-400" /> Merge cells
              </button>
            </>
          )}
          <div className="my-1 h-px bg-gray-100" />
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
            onClick={() => { handleCopy(); setCtxMenu(null); }}
          >
            <Copy className="h-3 w-3 text-gray-400" /> Copy
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
            onClick={() => { handlePaste(); setCtxMenu(null); }}
          >
            <ClipboardPaste className="h-3 w-3 text-gray-400" /> Paste
          </button>
        </div>
      )}
    </div>
  );
}
