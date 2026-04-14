'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, Trash2, Database, Merge, Bold, AlignLeft, AlignCenter, AlignRight, GripVertical } from 'lucide-react';
import type { TableConfig, TableRowDef, TableCellDef, CellValue, DataFieldBinding } from '@/types/template';
import { isDataField, isFormula, cellDisplayText } from '@/types/template';
import { DataFieldPicker } from './DataFieldPicker';

/* ── Helpers ───────────────────────────────────────────────── */

function emptyCell(value: CellValue = ''): TableCellDef {
  return { value, align: 'left' };
}

function emptyRow(cols: number, isHeader = false): TableRowDef {
  return { cells: Array.from({ length: cols }, () => emptyCell()), isHeader };
}

function defaultTable(): TableConfig {
  return {
    showBorder: true,
    columns: 4,
    rows: [
      emptyRow(4, true),
      emptyRow(4),
      emptyRow(4),
    ],
  };
}

/* ── Component ─────────────────────────────────────────────── */

interface TableEditorProps {
  config: TableConfig;
  onChange: (config: TableConfig) => void;
}

export function TableEditor({ config, onChange }: TableEditorProps) {
  const tbl = config.rows ? config : defaultTable();
  const cols = tbl.columns;
  const rows = tbl.rows;

  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ r: number; c: number } | null>(null);
  const [showFieldPicker, setShowFieldPicker] = useState(false);
  const [mergeStart, setMergeStart] = useState<{ r: number; c: number } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCell && editRef.current) editRef.current.focus();
  }, [editingCell]);

  /* ── Cell operations ─────────────────────────────────────── */

  const updateCell = useCallback(
    (r: number, c: number, patch: Partial<TableCellDef>) => {
      const newRows = rows.map((row, ri) =>
        ri === r
          ? { ...row, cells: row.cells.map((cell, ci) => (ci === c ? { ...cell, ...patch } : cell)) }
          : row,
      );
      onChange({ ...tbl, rows: newRows });
    },
    [tbl, rows, onChange],
  );

  const setCellValue = useCallback(
    (r: number, c: number, value: CellValue) => updateCell(r, c, { value }),
    [updateCell],
  );

  const handleDoubleClick = (r: number, c: number) => {
    const cell = rows[r]?.cells[c];
    if (!cell) return;
    setEditingCell({ r, c });
  };

  const handleInputKey = (e: React.KeyboardEvent, r: number, c: number) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      setEditingCell(null);
      // move to next cell
      if (e.key === 'Tab') {
        const nc = c + 1 < cols ? c + 1 : 0;
        const nr = nc === 0 ? (r + 1 < rows.length ? r + 1 : 0) : r;
        setSelectedCell({ r: nr, c: nc });
      }
    } else if (e.key === 'Escape') {
      setEditingCell(null);
    }
  };

  const handleCellClick = (e: React.MouseEvent, r: number, c: number) => {
    e.stopPropagation();
    setSelectedCell({ r, c });
    setEditingCell(null);
  };

  /* ── Row/Column operations ───────────────────────────────── */

  const addRow = (insertAt?: number) => {
    const idx = insertAt ?? rows.length;
    const newRows = [...rows];
    newRows.splice(idx, 0, emptyRow(cols));
    onChange({ ...tbl, rows: newRows });
  };

  const deleteRow = (r: number) => {
    if (rows.length <= 1) return;
    onChange({ ...tbl, rows: rows.filter((_, i) => i !== r) });
  };

  const addColumn = () => {
    const newCols = cols + 1;
    const newRows = rows.map((row) => ({
      ...row,
      cells: [...row.cells, emptyCell()],
    }));
    onChange({ ...tbl, columns: newCols, rows: newRows });
  };

  const deleteColumn = (c: number) => {
    if (cols <= 1) return;
    const newRows = rows.map((row) => ({
      ...row,
      cells: row.cells.filter((_, ci) => ci !== c),
    }));
    onChange({ ...tbl, columns: cols - 1, rows: newRows });
  };

  /* ── Merge cells (horizontal in same row) ────────────────── */

  const mergeCells = (r: number, fromC: number, toC: number) => {
    if (fromC >= toC) return;
    const newRows = rows.map((row, ri) => {
      if (ri !== r) return row;
      const cells = [...row.cells];
      cells[fromC] = { ...cells[fromC], colSpan: toC - fromC + 1 };
      // clear merged-away cells
      for (let i = fromC + 1; i <= toC && i < cells.length; i++) {
        cells[i] = { ...cells[i], value: '', colSpan: undefined };
      }
      return { ...row, cells };
    });
    onChange({ ...tbl, rows: newRows });
    setMergeStart(null);
  };

  const unmergeCell = (r: number, c: number) => {
    const newRows = rows.map((row, ri) => {
      if (ri !== r) return row;
      const cells = [...row.cells];
      cells[c] = { ...cells[c], colSpan: undefined };
      return { ...row, cells };
    });
    onChange({ ...tbl, rows: newRows });
  };

  /* ── Toggle header row ───────────────────────────────────── */

  const toggleHeaderRow = (r: number) => {
    const newRows = rows.map((row, ri) =>
      ri === r ? { ...row, isHeader: !row.isHeader } : row,
    );
    onChange({ ...tbl, rows: newRows });
  };

  /* ── Data field binding ──────────────────────────────────── */

  const insertFieldBinding = (binding: DataFieldBinding) => {
    if (selectedCell) {
      setCellValue(selectedCell.r, selectedCell.c, binding);
    }
    setShowFieldPicker(false);
  };

  /* ── Rendering ───────────────────────────────────────────── */

  const sel = selectedCell;
  const selCell = sel ? rows[sel.r]?.cells[sel.c] : null;

  return (
    <div className="space-y-2" onClick={() => { setSelectedCell(null); setEditingCell(null); }}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 flex-wrap text-xs">
        <button
          onClick={(e) => { e.stopPropagation(); addRow(); }}
          className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
          title="Add row"
        >
          <Plus className="h-3 w-3" /> Row
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); addColumn(); }}
          className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
          title="Add column"
        >
          <Plus className="h-3 w-3" /> Col
        </button>

        <div className="mx-1 h-4 w-px bg-gray-200" />

        {sel && selCell && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); updateCell(sel.r, sel.c, { bold: !selCell.bold }); }}
              className={`rounded border px-2 py-1 ${selCell.bold ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              title="Bold"
            >
              <Bold className="h-3 w-3" />
            </button>
            {(['left', 'center', 'right'] as const).map((a) => {
              const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
              return (
                <button
                  key={a}
                  onClick={(e) => { e.stopPropagation(); updateCell(sel.r, sel.c, { align: a }); }}
                  className={`rounded border px-2 py-1 ${selCell.align === a ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                  title={a}
                >
                  <Icon className="h-3 w-3" />
                </button>
              );
            })}

            <div className="mx-1 h-4 w-px bg-gray-200" />

            {/* Merge */}
            {selCell.colSpan && selCell.colSpan > 1 ? (
              <button
                onClick={(e) => { e.stopPropagation(); unmergeCell(sel.r, sel.c); }}
                className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 px-2 py-1 text-orange-700"
                title="Unmerge"
              >
                <Merge className="h-3 w-3" /> Unmerge
              </button>
            ) : mergeStart && mergeStart.r === sel.r && mergeStart.c !== sel.c ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const from = Math.min(mergeStart.c, sel.c);
                  const to = Math.max(mergeStart.c, sel.c);
                  mergeCells(sel.r, from, to);
                }}
                className="inline-flex items-center gap-1 rounded border border-green-300 bg-green-50 px-2 py-1 text-green-700"
              >
                <Merge className="h-3 w-3" /> Merge {Math.abs(mergeStart.c - sel.c) + 1} cells
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setMergeStart(sel); }}
                className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
                title="Start merge (then click another cell)"
              >
                <Merge className="h-3 w-3" /> Merge
              </button>
            )}

            <div className="mx-1 h-4 w-px bg-gray-200" />

            {/* Data field */}
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setShowFieldPicker(!showFieldPicker); }}
                className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
                title="Insert data field from dataset"
              >
                <Database className="h-3 w-3" /> Data
              </button>
              {showFieldPicker && (
                <div className="absolute top-full left-0 z-50 mt-1" onClick={(e) => e.stopPropagation()}>
                  <DataFieldPicker
                    onSelect={insertFieldBinding}
                    onCancel={() => setShowFieldPicker(false)}
                  />
                </div>
              )}
            </div>

            <div className="mx-1 h-4 w-px bg-gray-200" />

            {/* Delete row / col */}
            <button
              onClick={(e) => { e.stopPropagation(); deleteRow(sel.r); }}
              className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-red-500 hover:bg-red-50"
              title="Delete row"
            >
              <Trash2 className="h-3 w-3" /> Row
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); deleteColumn(sel.c); }}
              className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-red-500 hover:bg-red-50"
              title="Delete column"
            >
              <Trash2 className="h-3 w-3" /> Col
            </button>

            {/* Toggle header */}
            <button
              onClick={(e) => { e.stopPropagation(); toggleHeaderRow(sel.r); }}
              className={`rounded border px-2 py-1 ${rows[sel.r]?.isHeader ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              title="Toggle header row"
            >
              H
            </button>
          </>
        )}
      </div>

      {/* Table grid */}
      <div className="overflow-auto rounded border border-gray-300">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={row.isHeader ? 'bg-gray-100' : ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                {/* Row grip */}
                <td className="w-5 border border-gray-200 bg-gray-50 text-center text-gray-300 select-none">
                  <GripVertical className="h-3 w-3 mx-auto" />
                </td>
                {row.cells.map((cell, ci) => {
                  if (cell.hidden) return null;

                  // Skip cells that are "merged away"
                  if (ci > 0) {
                    // Check if a previous cell in this row spans over this one
                    let skip = false;
                    for (let prev = 0; prev < ci; prev++) {
                      if (row.cells[prev].hidden) continue;
                      const prevSpan = row.cells[prev].colSpan ?? 1;
                      if (prev + prevSpan > ci) { skip = true; break; }
                    }
                    if (skip) return null;
                  }

                  const isEditing = editingCell?.r === ri && editingCell?.c === ci;
                  const isSel = sel?.r === ri && sel?.c === ci;
                  const isMergeTarget = mergeStart && mergeStart.r === ri && mergeStart.c === ci;
                  const span = cell.colSpan ?? 1;

                  return (
                    <td
                      key={ci}
                      colSpan={span > 1 ? span : undefined}
                      onClick={(e) => handleCellClick(e, ri, ci)}
                      onDoubleClick={() => handleDoubleClick(ri, ci)}
                      className={`border border-gray-200 px-2 py-1.5 min-w-[60px] transition-colors cursor-cell
                        ${cell.bold ? 'font-semibold' : ''}
                        ${cell.align === 'center' ? 'text-center' : cell.align === 'right' ? 'text-right' : 'text-left'}
                        ${isSel ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/30' : ''}
                        ${isMergeTarget ? 'ring-2 ring-inset ring-orange-400' : ''}
                        ${row.isHeader ? 'font-semibold text-gray-700' : 'text-gray-800'}
                      `}
                      style={{ backgroundColor: cell.bg || undefined }}
                    >
                      {isEditing && typeof cell.value === 'string' ? (
                        <input
                          ref={editRef}
                          type="text"
                          value={cell.value}
                          onChange={(e) => setCellValue(ri, ci, e.target.value)}
                          onKeyDown={(e) => handleInputKey(e, ri, ci)}
                          onBlur={() => setEditingCell(null)}
                          className="w-full bg-transparent outline-none"
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <CellDisplay value={cell.value} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Cell display sub-component ────────────────────────────── */

function CellDisplay({ value }: { value: CellValue }) {
  if (typeof value === 'string') {
    return <span className="whitespace-pre-wrap">{value || '\u00A0'}</span>;
  }
  if (isDataField(value)) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
        <Database className="h-2.5 w-2.5" />
        {value.label ?? value.column}
      </span>
    );
  }
  if (isFormula(value)) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
        ƒ {value.expression}
      </span>
    );
  }
  return <span>&nbsp;</span>;
}
