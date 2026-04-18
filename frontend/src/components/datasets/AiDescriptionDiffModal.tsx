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

import { AppModalShell } from '@/components/common/AppModalShell';
import { Button } from '@/components/ui/Button';
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
    return <span className="text-text-secondary">{after}</span>;
  }
  return (
    <span>
      {before && (
        <span className="mr-1 rounded bg-danger/10 px-0.5 text-xs text-danger line-through">
          {before}
        </span>
      )}
      <span className="rounded bg-success/10 px-0.5 text-success">{after}</span>
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
    <AppModalShell
      onClose={onClose}
      title="AI generated description"
      description={`${tableName} — review and edit before applying`}
      icon={<Sparkles className="h-5 w-5" />}
      maxWidthClass="max-w-4xl"
      panelClassName="max-h-[90vh]"
      bodyClassName="space-y-6 p-6"
      footer={(
        <>
          <p className="mr-auto max-w-xl text-caption text-text-quaternary">
            All fields are editable. Only the fields you apply will overwrite the current dictionary entry.
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            leadingIcon={<Check className="h-4 w-4" />}
          >
            Apply to Dictionary
          </Button>
        </>
      )}
    >

          {/* ── Table Description ── */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Bot className="h-4 w-4 text-brand" />
              <span className="text-sm font-semibold text-text-primary">Table Description</span>
              {current.description !== aiDraft.description && (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                  changed
                </span>
              )}
            </div>

            {/* Side-by-side diff */}
            <div className="mb-3 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">
                  Current
                </p>
                <p className="text-sm leading-relaxed text-text-secondary whitespace-pre-wrap min-h-[3rem]">
                  {current.description || <span className="italic text-text-quaternary">Empty</span>}
                </p>
              </div>
              <div className="rounded-xl border border-brand/20 bg-brand/10/40 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
                  AI Draft — editable
                </p>
                <textarea
                  value={editedDesc}
                  onChange={(e) => setEditedDesc(e.target.value)}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-brand/30 bg-surface-1 p-2.5 text-sm leading-relaxed text-text-secondary focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
            </div>
          </section>

          {/* ── Common Questions ── */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary">Suggested Questions</span>
              {JSON.stringify(current.common_questions) !== JSON.stringify(aiDraft.common_questions) && (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                  changed
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {/* Current */}
              <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">Current</p>
                {current.common_questions.length > 0 ? (
                  <ol className="space-y-1 text-sm text-text-secondary">
                    {current.common_questions.map((q, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-text-quaternary shrink-0">{i + 1}.</span>
                        <span>{q}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs italic text-text-quaternary">None</p>
                )}
              </div>
              {/* AI draft — editable list */}
              <div className="rounded-xl border border-brand/20 bg-brand/10/40 p-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
                  AI Draft — editable
                </p>
                <ol className="space-y-1.5">
                  {editedQuestions.map((q, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-2 text-xs text-text-quaternary shrink-0">{i + 1}.</span>
                      <input
                        value={q}
                        onChange={(e) => {
                          const next = [...editedQuestions];
                          next[i] = e.target.value;
                          setEditedQuestions(next);
                        }}
                        className="flex-1 rounded-md border border-brand/30 bg-surface-1 px-2 py-1 text-sm text-text-secondary focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                      />
                      <button
                        onClick={() => setEditedQuestions((prev) => prev.filter((_, j) => j !== i))}
                        className="mt-1.5 shrink-0 text-text-quaternary hover:text-danger"
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
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-surface-2"
              >
                {colsExpanded ? (
                  <ChevronUp className="h-4 w-4 text-text-quaternary" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-text-quaternary" />
                )}
                <span className="text-sm font-semibold text-text-primary">
                  Column Descriptions
                  <span className="ml-1.5 text-sm font-normal text-text-quaternary">({colEntries.length})</span>
                </span>
                {!colsExpanded && (
                  <span className="ml-auto text-xs text-text-quaternary">Click to review</span>
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
                        className={`rounded-xl border p-3 ${changed ? 'border-brand/20 bg-brand/10/30' : 'border-[rgb(var(--border-line))] bg-surface-2'}`}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="font-mono text-xs font-semibold text-brand">{colName}</span>
                          {changed && (
                            <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                              changed
                            </span>
                          )}
                          <button
                            onClick={() => setEditingCol(isEditing ? null : colName)}
                            className="ml-auto text-text-quaternary hover:text-brand"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {/* Before / After inline */}
                        {changed && !isEditing && (
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <p className="text-text-tertiary">
                              <span className="font-medium text-text-quaternary">Before: </span>
                              {currentDesc || <span className="italic">empty</span>}
                            </p>
                            <p className="text-text-secondary">
                              <span className="font-medium text-brand">After: </span>
                              {aiDesc}
                            </p>
                          </div>
                        )}
                        {!changed && !isEditing && (
                          <p className="text-xs text-text-secondary">{aiDesc}</p>
                        )}

                        {isEditing && (
                          <input
                            autoFocus
                            value={editedColDescs[colName] ?? ''}
                            onChange={(e) =>
                              setEditedColDescs((prev) => ({ ...prev, [colName]: e.target.value }))
                            }
                            onBlur={() => setEditingCol(null)}
                            className="w-full rounded-md border border-brand/40 bg-surface-1 px-2 py-1 text-sm text-text-secondary focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
    </AppModalShell>
  );
}
