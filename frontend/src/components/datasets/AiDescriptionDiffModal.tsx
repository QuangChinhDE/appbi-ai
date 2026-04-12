'use client';

/**
 * AiDescriptionDiffModal
 *
 * Shows the AI-generated table description alongside the current (saved) values
 * so users can review the diff, edit the AI output, and decide which fields to apply.
 *
 * Opened from the Dictionary "Table notes" section via the "Generate with AI" button.
 */

import React, { useEffect, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronUp, Pencil, Sparkles, X } from 'lucide-react';
import type { TableDescriptionPreview } from '@/hooks/useDescription';

interface CurrentValues {
  /** business_role / auto_description already in the dictionary note */
  description: string;
  column_descriptions: Record<string, string>;
  common_questions: string[];
}

interface Props {
  tableName: string;
  current: CurrentValues;
  aiDraft: TableDescriptionPreview;
  onApply: (edited: TableDescriptionPreview) => void;
  onClose: () => void;
}

// Simple inline diff highlight — marks words that changed
function DiffText({ before, after }: { before: string; after: string }) {
  if (before === after) {
    return <span className="text-gray-700">{after}</span>;
  }
  return (
    <span>
      {before && (
        <span className="mr-1 rounded bg-red-50 px-0.5 text-xs text-red-500 line-through">
          {before}
        </span>
      )}
      <span className="rounded bg-green-50 px-0.5 text-green-700">{after}</span>
    </span>
  );
}

export function AiDescriptionDiffModal({ tableName, current, aiDraft, onApply, onClose }: Props) {
  // Editable draft — user can tweak AI output before applying
  const [editedDesc, setEditedDesc] = useState(aiDraft.description);
  const [editedColDescs, setEditedColDescs] = useState<Record<string, string>>({
    ...aiDraft.column_descriptions,
  });
  const [editedQuestions, setEditedQuestions] = useState<string[]>([...aiDraft.common_questions]);
  const [colsExpanded, setColsExpanded] = useState(false);
  const [editingCol, setEditingCol] = useState<string | null>(null);

  // Reset when a new aiDraft arrives (e.g. user re-generates)
  useEffect(() => {
    setEditedDesc(aiDraft.description);
    setEditedColDescs({ ...aiDraft.column_descriptions });
    setEditedQuestions([...aiDraft.common_questions]);
  }, [aiDraft]);

  const handleApply = () => {
    onApply({
      description: editedDesc,
      column_descriptions: editedColDescs,
      common_questions: editedQuestions,
    });
  };

  const colEntries = Object.entries(editedColDescs);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl"
           style={{ maxHeight: '90vh' }}>

        {/* ── Header ── */}
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50">
            <Sparkles className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-gray-900">AI Generated Description</h2>
            <p className="text-xs text-gray-500 truncate">{tableName} — review and edit before applying</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* ── Table Description ── */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Bot className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-semibold text-gray-800">Table Description</span>
              {current.description !== aiDraft.description && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                  changed
                </span>
              )}
            </div>

            {/* Side-by-side diff */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Current
                </p>
                <p className="text-sm leading-relaxed text-gray-600 whitespace-pre-wrap min-h-[3rem]">
                  {current.description || <span className="italic text-gray-400">Empty</span>}
                </p>
              </div>
              <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-400">
                  AI Draft — editable
                </p>
                <textarea
                  value={editedDesc}
                  onChange={(e) => setEditedDesc(e.target.value)}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-blue-200 bg-white p-2.5 text-sm leading-relaxed text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
            </div>
          </section>

          {/* ── Common Questions ── */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-800">Suggested Questions</span>
              {JSON.stringify(current.common_questions) !== JSON.stringify(aiDraft.common_questions) && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                  changed
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {/* Current */}
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Current</p>
                {current.common_questions.length > 0 ? (
                  <ol className="space-y-1 text-sm text-gray-600">
                    {current.common_questions.map((q, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-gray-400 shrink-0">{i + 1}.</span>
                        <span>{q}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs italic text-gray-400">None</p>
                )}
              </div>
              {/* AI draft — editable list */}
              <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-400">
                  AI Draft — editable
                </p>
                <ol className="space-y-1.5">
                  {editedQuestions.map((q, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-2 text-xs text-gray-400 shrink-0">{i + 1}.</span>
                      <input
                        value={q}
                        onChange={(e) => {
                          const next = [...editedQuestions];
                          next[i] = e.target.value;
                          setEditedQuestions(next);
                        }}
                        className="flex-1 rounded-md border border-blue-200 bg-white px-2 py-1 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-400"
                      />
                      <button
                        onClick={() => setEditedQuestions((prev) => prev.filter((_, j) => j !== i))}
                        className="mt-1.5 shrink-0 text-gray-300 hover:text-red-500"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>

          {/* ── Column Descriptions (collapsible) ── */}
          {colEntries.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setColsExpanded((v) => !v)}
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-gray-50"
              >
                {colsExpanded ? (
                  <ChevronUp className="h-4 w-4 text-gray-400" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-gray-400" />
                )}
                <span className="text-sm font-semibold text-gray-800">
                  Column Descriptions
                  <span className="ml-1.5 text-sm font-normal text-gray-400">({colEntries.length})</span>
                </span>
                {!colsExpanded && (
                  <span className="ml-auto text-xs text-gray-400">Click to review</span>
                )}
              </button>

              {colsExpanded && (
                <div className="mt-3 space-y-2 max-h-80 overflow-y-auto pr-1">
                  {colEntries.map(([colName, aiDesc]) => {
                    const currentDesc = current.column_descriptions[colName] ?? '';
                    const isEditing = editingCol === colName;
                    const changed = currentDesc !== aiDesc;
                    return (
                      <div
                        key={colName}
                        className={`rounded-xl border p-3 ${changed ? 'border-blue-100 bg-blue-50/30' : 'border-gray-100 bg-gray-50'}`}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="font-mono text-xs font-semibold text-blue-600">{colName}</span>
                          {changed && (
                            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                              changed
                            </span>
                          )}
                          <button
                            onClick={() => setEditingCol(isEditing ? null : colName)}
                            className="ml-auto text-gray-300 hover:text-blue-500"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {/* Before / After inline */}
                        {changed && !isEditing && (
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <p className="text-gray-500">
                              <span className="font-medium text-gray-400">Before: </span>
                              {currentDesc || <span className="italic">empty</span>}
                            </p>
                            <p className="text-gray-700">
                              <span className="font-medium text-blue-400">After: </span>
                              {aiDesc}
                            </p>
                          </div>
                        )}
                        {!changed && !isEditing && (
                          <p className="text-xs text-gray-600">{aiDesc}</p>
                        )}

                        {isEditing && (
                          <input
                            autoFocus
                            value={editedColDescs[colName] ?? ''}
                            onChange={(e) =>
                              setEditedColDescs((prev) => ({ ...prev, [colName]: e.target.value }))
                            }
                            onBlur={() => setEditingCol(null)}
                            className="w-full rounded-md border border-blue-300 bg-white px-2 py-1 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          <p className="text-xs text-gray-400">
            All fields are editable. Only the fields you apply will overwrite the current dictionary entry.
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Check className="h-4 w-4" />
              Apply to Dictionary
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
