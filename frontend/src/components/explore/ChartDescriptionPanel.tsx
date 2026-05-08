'use client';

/**
 * ChartDescriptionPanel — inline collapsible section for the Explore sidebar.
 *
 * Replaces the old modal-based design. Lives inside the right config panel,
 * following the same collapsible-section pattern as Parameters and Metadata.
 *
 * Three fields stored in ChartMetadata are surfaced and editable here:
 *
 *   auto_description  — 2-3 sentence plain-text description used by:
 *                        • AI-assisted chart search
 *                        • Chart search results snippet
 *                        • Dashboard card hover tooltip
 *
 *   insight_keywords  — short phrases used by:
 *                        • Vector embedding enrichment (joined into embedding text)
 *                        • Fuzzy fallback matching
 *                        • Explore global search
 *
 *   common_questions  — suggested follow-up questions used by:
 *                        • Suggested question seed list
 *                        • "Starter questions" on the Chat landing page
 *
 * Generation flow (background, non-blocking):
 *   POST /charts/{id}/description/regenerate  →  status = "queued"
 *   Frontend polls until status = "succeeded" | "failed" | "stale"
 *
 * User can edit any field and save manually. Saves set description_source = "user".
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Loader2,
  MessageSquare,
  Sparkles,
  Tag,
  User,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useChartDescription,
  useRegenerateChartDescription,
  useUpdateChartDescription,
} from '@/hooks/useDescription';
import type { DescriptionGenerationStatus } from '@/hooks/useDescription';
import { toast } from '@/lib/toast';

interface Props {
  chartId: number;
  canEdit: boolean;
  /** Controlled from parent — allows parent to toggle panel open */
  defaultOpen?: boolean;
}

// ─── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null;
  const cfg: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    auto:     { label: 'AI',      icon: <Bot className="h-2.5 w-2.5" />,         cls: 'bg-brand/10 text-brand border-brand/30' },
    user:     { label: 'Edited',  icon: <User className="h-2.5 w-2.5" />,        cls: 'bg-success/10 text-success border-success/30' },
    feedback: { label: 'Tuned',   icon: <MessageSquare className="h-2.5 w-2.5" />, cls: 'bg-surface-2 text-text-tertiary border-[rgb(var(--border-line))]' },
  };
  const item = cfg[source] ?? { label: source, icon: null, cls: 'bg-surface-2 text-text-tertiary border-[rgb(var(--border-line))]' };
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${item.cls}`}>
      {item.icon}{item.label}
    </span>
  );
}

// ─── Status dot ───────────────────────────────────────────────────────────────

const STATUS_DOT: Record<DescriptionGenerationStatus, string> = {
  idle:       'bg-surface-3',
  queued:     'bg-warning/60 animate-pulse',
  processing: 'bg-brand animate-pulse',
  succeeded:  'bg-success/60',
  failed:     'bg-danger/60',
  stale:      'bg-warning/60',
};

// ─── Main component ───────────────────────────────────────────────────────────

export function ChartDescriptionPanel({ chartId, canEdit, defaultOpen = false }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useChartDescription(chartId);
  const updateMut = useUpdateChartDescription(chartId);
  const regenMut  = useRegenerateChartDescription(chartId);

  const [isOpen,       setIsOpen]       = useState(defaultOpen);
  const [descDraft,    setDescDraft]    = useState('');
  const [keywords,     setKeywords]     = useState<string[]>([]);
  const [kwInput,      setKwInput]      = useState('');
  const [questions,    setQuestions]    = useState<string[]>([]);
  const [qInput,       setQInput]       = useState('');
  const [isDirty,      setIsDirty]      = useState(false);
  const lastStatusRef = useRef<DescriptionGenerationStatus | null>(null);

  const status      = data?.generation_status ?? 'idle';
  const isGenerating = regenMut.isPending || status === 'queued' || status === 'processing';
  const disabled    = isGenerating || !canEdit;

  // Sync draft from server when not dirty and not generating
  useEffect(() => {
    if (data && !isDirty && !isGenerating) {
      setDescDraft(data.auto_description   ?? '');
      setKeywords(data.insight_keywords    ?? []);
      setQuestions(data.common_questions   ?? []);
    }
  }, [data, isDirty, isGenerating]);

  // Poll while generating
  useEffect(() => {
    if (!isGenerating) return;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      queryClient.invalidateQueries({ queryKey: ['chart-description', chartId] });
      delay = Math.min(delay * 1.5, 10_000);
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    return () => clearTimeout(timer);
  }, [isGenerating, chartId, queryClient]);

  // Toast on status transitions
  useEffect(() => {
    if (!data) return;
    const prev = lastStatusRef.current;
    const next = data.generation_status ?? 'idle';
    if (prev && prev !== next) {
      const wasBusy = prev === 'queued' || prev === 'processing';
      if (wasBusy && next === 'succeeded') toast.success('AI description ready.');
      if (wasBusy && next === 'failed')    toast.error(data.generation_error || 'AI generation failed.');
      if (wasBusy && next === 'stale')     toast.warning('Chart changed — review AI description.');
    }
    lastStatusRef.current = next;
  }, [data]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSave = async () => {
    try {
      await updateMut.mutateAsync({
        auto_description: descDraft,
        insight_keywords: keywords,
        common_questions: questions,
      });
      setIsDirty(false);
      toast.success('AI description saved.');
    } catch {
      toast.error('Failed to save AI description.');
    }
  };

  const handleRegen = async () => {
    try {
      await regenMut.mutateAsync();
      setIsOpen(true); // auto-open so user sees progress
    } catch {
      toast.error('Could not queue AI regeneration.');
    }
  };

  const addKeyword = () => {
    const v = kwInput.trim();
    if (!v || keywords.includes(v)) { setKwInput(''); return; }
    setKeywords((p) => [...p, v]);
    setIsDirty(true);
    setKwInput('');
  };

  const addQuestion = () => {
    const v = qInput.trim();
    if (!v) { setQInput(''); return; }
    setQuestions((p) => [...p, v]);
    setIsDirty(true);
    setQInput('');
  };

  // ── Section header (always visible) ───────────────────────────────────────

  const headerStatusDot = STATUS_DOT[status] ?? STATUS_DOT.idle;
  const hasContent = !!(data?.auto_description || (data?.insight_keywords?.length ?? 0) > 0);

  return (
    <div className="border-t border-[rgb(var(--border-line))]">
      {/* ── Collapsible header ── */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-2 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-text-quaternary" />
          <span className="text-xs font-semibold text-text-secondary">AI Description</span>

          {/* Status dot */}
          <span className={`h-1.5 w-1.5 rounded-full ${headerStatusDot}`} title={status} />

          {/* Source badge (compact) */}
          {data?.description_source && !isGenerating && (
            <SourceBadge source={data.description_source} />
          )}

          {/* Generating spinner */}
          {isGenerating && (
            <Loader2 className="h-3 w-3 animate-spin text-brand" />
          )}

          {/* Stale / failed warning */}
          {(status === 'stale' || status === 'failed') && !isGenerating && (
            <AlertTriangle className="h-3 w-3 text-warning" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Quick-regen button — visible in header so user doesn't need to open panel */}
          {canEdit && !isGenerating && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); handleRegen(); }}
              onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), handleRegen())}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/15"
              title="Generate with AI"
            >
              <Sparkles className="h-3 w-3" />
              {!hasContent ? 'Generate' : 'Regen'}
            </span>
          )}
          {isOpen
            ? <ChevronDown className="h-3.5 w-3.5 text-text-quaternary" />
            : <ChevronRight className="h-3.5 w-3.5 text-text-quaternary" />
          }
        </div>
      </button>

      {/* ── Expanded body ── */}
      {isOpen && (
        <div className="px-4 pb-4 space-y-4">

          {/* Generating overlay message */}
          {isGenerating && (
            <div className="flex items-center gap-2 rounded-lg bg-brand/10 px-3 py-2.5 text-xs text-brand">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>
                {status === 'queued' ? 'Queued — waiting for AI...' : 'AI is analysing this chart...'}
                <span className="ml-1 text-brand">Panel refreshes automatically.</span>
              </span>
            </div>
          )}

          {/* Error banner */}
          {status === 'failed' && !isGenerating && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              <p className="font-medium">Generation failed</p>
              <p className="text-danger">{data?.generation_error || 'Unknown error.'}</p>
            </div>
          )}

          {/* Stale warning */}
          {status === 'stale' && !isGenerating && (
            <div className="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>{data?.stale_reason || 'Chart changed since last AI description. Regenerate to update.'}</span>
            </div>
          )}

          {isLoading ? (
            <div className="space-y-2 animate-pulse">
              <div className="h-3 w-2/3 rounded bg-surface-2" />
              <div className="h-12 rounded bg-surface-2" />
              <div className="h-3 w-1/2 rounded bg-surface-2" />
            </div>
          ) : (
            <>
              {/* ── Description ── */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  <Bot className="h-3 w-3" />
                  Description
                  <span className="ml-1 font-normal normal-case text-text-quaternary">— used in chart search</span>
                </label>
                <textarea
                  rows={4}
                  value={descDraft}
                  onChange={(e) => { setDescDraft(e.target.value); setIsDirty(true); }}
                  disabled={disabled}
                  placeholder={canEdit ? 'Describe what this chart shows and why it matters...' : 'No description yet.'}
                  className="w-full resize-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs leading-relaxed text-text-secondary placeholder-gray-300 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>

              {/* ── Keywords ── */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  <Tag className="h-3 w-3" />
                  Search Keywords
                  <span className="ml-1 font-normal normal-case text-text-quaternary">— enriches vector index</span>
                </label>
                <div className="mb-1.5 flex min-h-[28px] flex-wrap gap-1">
                  {keywords.map((kw, i) => (
                    <span key={`${kw}-${i}`} className="inline-flex items-center gap-0.5 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                      {kw}
                      {canEdit && !isGenerating && (
                        <button onClick={() => { setKeywords((p) => p.filter((_, j) => j !== i)); setIsDirty(true); }} className="ml-0.5 text-brand hover:text-brand">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      )}
                    </span>
                  ))}
                  {keywords.length === 0 && <span className="text-[10px] italic text-text-quaternary">None yet.</span>}
                </div>
                {canEdit && !isGenerating && (
                  <div className="flex gap-1.5">
                    <input
                      value={kwInput}
                      onChange={(e) => setKwInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                      placeholder="Add keyword, press Enter…"
                      className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-[11px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                    <button onClick={addKeyword} className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-hover">Add</button>
                  </div>
                )}
              </div>

              {/* ── Suggested Questions ── */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  <HelpCircle className="h-3 w-3" />
                  Suggested Questions
                  <span className="ml-1 font-normal normal-case text-text-quaternary">— suggested questions</span>
                </label>
                <div className="mb-1.5 space-y-1">
                  {questions.map((q, i) => (
                    <div key={i} className="flex items-start gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5">
                      <span className="mt-0.5 text-[10px] font-bold text-text-quaternary shrink-0">{i + 1}.</span>
                      <span className="flex-1 text-[11px] leading-snug text-text-secondary">{q}</span>
                      {canEdit && !isGenerating && (
                        <button onClick={() => { setQuestions((p) => p.filter((_, j) => j !== i)); setIsDirty(true); }} className="shrink-0 text-text-quaternary hover:text-danger">
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {questions.length === 0 && <p className="text-[10px] italic text-text-quaternary px-1">None yet.</p>}
                </div>
                {canEdit && !isGenerating && (
                  <div className="flex gap-1.5">
                    <input
                      value={qInput}
                      onChange={(e) => setQInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addQuestion())}
                      placeholder="Add question, press Enter…"
                      className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-[11px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                    <button onClick={addQuestion} className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-hover">Add</button>
                  </div>
                )}
              </div>

              {/* ── Save bar ── */}
              {canEdit && (
                <div className="flex items-center justify-between gap-2 border-t border-[rgb(var(--border-line))] pt-2">
                  {isDirty && <span className="text-[10px] font-medium text-warning">Unsaved changes</span>}
                  <div className="ml-auto flex gap-2">
                    {isDirty && (
                      <button
                        onClick={() => {
                          setDescDraft(data?.auto_description ?? '');
                          setKeywords(data?.insight_keywords ?? []);
                          setQuestions(data?.common_questions ?? []);
                          setIsDirty(false);
                        }}
                        className="rounded-md border border-[rgb(var(--border-line))] px-3 py-1.5 text-xs text-text-tertiary hover:bg-surface-2"
                      >
                        Discard
                      </button>
                    )}
                    <button
                      onClick={handleSave}
                      disabled={updateMut.isPending || !isDirty}
                      className="inline-flex items-center gap-1 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Check className="h-3 w-3" />
                      {updateMut.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
