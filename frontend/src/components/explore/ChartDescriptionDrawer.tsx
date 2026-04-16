'use client';

/**
 * ChartDescriptionDrawer — slide-over panel for AI Description.
 *
 * Opened from the MODE bar "AI Description" button. Three fields:
 *   auto_description   → AI Chat vector search, chart search snippet, tooltip
 *   insight_keywords   → vector embedding enrichment, fuzzy search
 *   common_questions   → AI Chat suggestions seed list
 *
 * AI Generate flow:
 *   1. User clicks "Generate with AI" → queues regeneration (POST …/regenerate)
 *   2. Component polls until status = "succeeded"
 *   3. A diff preview modal opens showing old vs new — user can edit before applying
 *   4. "Apply" writes the (possibly edited) content into the editable fields
 *   5. User reviews and hits "Save" to persist
 *
 * User can also edit any field freely at any time without touching AI.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
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
import type { DescriptionGenerationStatus, ChartDescription } from '@/hooks/useDescription';
import { toast } from '@/lib/toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  chartId: number;
  canEdit: boolean;
  open: boolean;
  onClose: () => void;
}

// ─── Diff preview modal ───────────────────────────────────────────────────────

interface DiffPreviewProps {
  oldData: ChartDescription;
  newData: ChartDescription;
  onApply: (desc: string, keywords: string[], questions: string[]) => void;
  onClose: () => void;
}

function DiffPreviewModal({ oldData, newData, onApply, onClose }: DiffPreviewProps) {
  const [desc,      setDesc]      = useState(newData.auto_description ?? '');
  const [keywords,  setKeywords]  = useState<string[]>(newData.insight_keywords ?? []);
  const [questions, setQuestions] = useState<string[]>(newData.common_questions ?? []);
  const [kwInput,   setKwInput]   = useState('');
  const [qInput,    setQInput]    = useState('');

  const addKeyword = () => {
    const v = kwInput.trim();
    if (v && !keywords.includes(v)) setKeywords((p) => [...p, v]);
    setKwInput('');
  };
  const addQuestion = () => {
    const v = qInput.trim();
    if (v) setQuestions((p) => [...p, v]);
    setQInput('');
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
      <div className="flex w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-slate-800">AI Description Preview</h2>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600">
              Review &amp; edit before applying
            </span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Description */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Description</label>
              {(oldData.auto_description ?? '') !== desc && (
                <span className="text-[10px] text-amber-600 font-medium">edited</span>
              )}
            </div>
            {/* Old value */}
            {oldData.auto_description && (
              <div className="mb-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500 line-through decoration-red-300">
                {oldData.auto_description}
              </div>
            )}
            {/* New (editable) */}
            <textarea
              rows={4}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="w-full resize-none rounded-lg border border-blue-200 bg-blue-50/30 px-3 py-2 text-xs leading-relaxed text-slate-700 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="AI-generated description…"
            />
          </div>

          {/* Keywords */}
          <div>
            <label className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <Tag className="h-3 w-3" />
              Search Keywords
            </label>
            <div className="mb-2 flex flex-wrap gap-1.5 min-h-[28px]">
              {keywords.map((kw, i) => (
                <span key={`${kw}-${i}`} className="inline-flex items-center gap-0.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                  {kw}
                  <button onClick={() => setKeywords((p) => p.filter((_, j) => j !== i))} className="ml-0.5 text-blue-300 hover:text-blue-700">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              {keywords.length === 0 && <span className="text-[10px] italic text-slate-300">None</span>}
            </div>
            <div className="flex gap-1.5">
              <input
                value={kwInput}
                onChange={(e) => setKwInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                placeholder="Add keyword, Enter…"
                className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
              />
              <button onClick={addKeyword} className="rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700">Add</button>
            </div>
          </div>

          {/* Suggested Questions */}
          <div>
            <label className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <HelpCircle className="h-3 w-3" />
              Suggested Questions
            </label>
            <div className="mb-2 space-y-1.5">
              {questions.map((q, i) => (
                <div key={i} className="flex items-start gap-2 rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5">
                  <span className="mt-0.5 shrink-0 text-[10px] font-bold text-slate-300">{i + 1}.</span>
                  <input
                    value={q}
                    onChange={(e) => setQuestions((p) => p.map((v, j) => j === i ? e.target.value : v))}
                    className="flex-1 bg-transparent text-[11px] leading-snug text-slate-700 focus:outline-none"
                  />
                  <button onClick={() => setQuestions((p) => p.filter((_, j) => j !== i))} className="shrink-0 text-slate-300 hover:text-red-400">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {questions.length === 0 && <p className="text-[10px] italic text-slate-300 px-1">None</p>}
            </div>
            <div className="flex gap-1.5">
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addQuestion())}
                placeholder="Add question, Enter…"
                className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
              />
              <button onClick={addQuestion} className="rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700">Add</button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
            Discard
          </button>
          <button
            onClick={() => onApply(desc, keywords, questions)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Check className="h-3.5 w-3.5" />
            Apply to editor
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null;
  const cfg: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    auto:     { label: 'AI',     icon: <Bot className="h-2.5 w-2.5" />,           cls: 'bg-blue-50 text-blue-600 border-blue-200' },
    user:     { label: 'Edited', icon: <User className="h-2.5 w-2.5" />,          cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
    feedback: { label: 'Tuned',  icon: <MessageSquare className="h-2.5 w-2.5" />, cls: 'bg-gray-100 text-gray-500 border-gray-200' },
  };
  const item = cfg[source] ?? { label: source, icon: null, cls: 'bg-gray-100 text-gray-500 border-gray-200' };
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${item.cls}`}>
      {item.icon}{item.label}
    </span>
  );
}

// ─── Status dot map ───────────────────────────────────────────────────────────

const STATUS_DOT: Record<DescriptionGenerationStatus, string> = {
  idle:       'bg-slate-300',
  queued:     'bg-amber-400 animate-pulse',
  processing: 'bg-blue-500 animate-pulse',
  succeeded:  'bg-emerald-400',
  failed:     'bg-red-400',
  stale:      'bg-amber-400',
};

// ─── Trigger button (rendered in MODE bar) ───────────────────────────────────

export function ChartDescriptionTrigger({
  chartId,
  canEdit,
  onClick,
}: {
  chartId: number;
  canEdit: boolean;
  onClick: () => void;
}) {
  const { data } = useChartDescription(chartId);
  const status = data?.generation_status ?? 'idle';
  const isGenerating = status === 'queued' || status === 'processing';
  const hasContent = !!(data?.auto_description);
  const dotCls = STATUS_DOT[status] ?? STATUS_DOT.idle;

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
      title="AI Description"
    >
      {isGenerating
        ? <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
        : <Bot className="h-3 w-3" />
      }
      <span>AI Description</span>
      <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
      {data?.description_source && !isGenerating && (
        <SourceBadge source={data.description_source} />
      )}
      <ChevronRight className="h-3 w-3 text-slate-400" />
    </button>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

export function ChartDescriptionDrawer({ chartId, canEdit, open, onClose }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useChartDescription(chartId);
  const updateMut = useUpdateChartDescription(chartId);
  const regenMut  = useRegenerateChartDescription(chartId);

  // Editable draft state
  const [descDraft,    setDescDraft]    = useState('');
  const [keywords,     setKeywords]     = useState<string[]>([]);
  const [kwInput,      setKwInput]      = useState('');
  const [questions,    setQuestions]    = useState<string[]>([]);
  const [qInput,       setQInput]       = useState('');
  const [isDirty,      setIsDirty]      = useState(false);

  // Diff preview modal
  const [diffData,     setDiffData]     = useState<ChartDescription | null>(null);
  const [showDiff,     setShowDiff]     = useState(false);

  const lastStatusRef = useRef<DescriptionGenerationStatus | null>(null);
  const wasGeneratingRef = useRef(false);

  const status       = data?.generation_status ?? 'idle';
  const isGenerating = regenMut.isPending || status === 'queued' || status === 'processing';

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
      delay = Math.min(delay * 1.5, 8_000);
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    return () => clearTimeout(timer);
  }, [isGenerating, chartId, queryClient]);

  // When generation finishes, open diff preview modal
  useEffect(() => {
    if (!data) return;
    const prev = lastStatusRef.current;
    const next = data.generation_status ?? 'idle';
    const wasBusy = prev === 'queued' || prev === 'processing';

    if (wasBusy && next === 'succeeded') {
      // Show diff preview
      setDiffData({ ...data });
      setShowDiff(true);
    }
    if (wasBusy && next === 'failed') {
      toast.error(data.generation_error || 'AI generation failed.');
    }
    if (wasBusy && next === 'stale') {
      toast.warning('Chart changed — AI description may be outdated.');
    }
    lastStatusRef.current = next;
  }, [data]);

  // ── Handlers ────────────────────────────────────────────────────────────────

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
    // Track that we're starting a generation so the effect can open diff
    lastStatusRef.current = 'queued';
    wasGeneratingRef.current = true;
    try {
      await regenMut.mutateAsync();
    } catch {
      toast.error('Could not start AI generation.');
    }
  };

  const handleApplyDiff = (desc: string, kws: string[], qs: string[]) => {
    setDescDraft(desc);
    setKeywords(kws);
    setQuestions(qs);
    setIsDirty(true);
    setShowDiff(false);
    setDiffData(null);
    toast.success('AI content applied — review and save when ready.');
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

  const dotCls = STATUS_DOT[status] ?? STATUS_DOT.idle;
  const hasContent = !!(data?.auto_description || (data?.insight_keywords?.length ?? 0) > 0);

  // Render nothing when closed (keep state alive for polling)
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-slate-800">AI Description</h2>
            <span className={`h-2 w-2 rounded-full ${dotCls}`} title={status} />
            {data?.description_source && !isGenerating && (
              <SourceBadge source={data.description_source} />
            )}
            {isGenerating && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />}
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Generate bar */}
        {canEdit && (
          <div className="border-b bg-slate-50 px-5 py-3">
            {isGenerating ? (
              <div className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                <span>
                  {status === 'queued' ? 'Queued — waiting for AI...' : 'AI is analysing this chart...'}
                  <span className="ml-1 text-blue-400">Preview will open when ready.</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-slate-500">
                  Let AI write a description from chart structure &amp; data context.
                  <br />
                  <span className="text-slate-400">You can review &amp; edit before applying.</span>
                </p>
                <button
                  onClick={handleRegen}
                  disabled={regenMut.isPending}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {hasContent ? 'Regenerate' : 'Generate with AI'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Error / stale banners */}
        {status === 'failed' && !isGenerating && (
          <div className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">
            <span className="font-medium">Generation failed — </span>
            {data?.generation_error || 'Unknown error.'}
          </div>
        )}
        {status === 'stale' && !isGenerating && (
          <div className="flex items-center gap-1.5 border-b border-amber-100 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            {data?.stale_reason || 'Chart changed since last AI description.'}
          </div>
        )}

        {/* Editable fields — scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {isLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-3 w-1/3 rounded bg-slate-100" />
              <div className="h-20 rounded bg-slate-100" />
              <div className="h-3 w-1/4 rounded bg-slate-100" />
              <div className="h-8 rounded bg-slate-100" />
            </div>
          ) : (
            <>
              {/* Description */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <Bot className="h-3 w-3" />
                  Description
                  <span className="ml-1 font-normal normal-case text-slate-300">— AI Chat search · tooltip</span>
                </label>
                <textarea
                  rows={5}
                  value={descDraft}
                  onChange={(e) => { setDescDraft(e.target.value); setIsDirty(true); }}
                  disabled={!canEdit}
                  placeholder={canEdit ? 'Describe what this chart shows and why it matters...' : 'No description yet.'}
                  className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700 placeholder-slate-300 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>

              {/* Keywords */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <Tag className="h-3 w-3" />
                  Search Keywords
                  <span className="ml-1 font-normal normal-case text-slate-300">— vector index enrichment</span>
                </label>
                <div className="mb-2 flex min-h-[28px] flex-wrap gap-1">
                  {keywords.map((kw, i) => (
                    <span key={`${kw}-${i}`} className="inline-flex items-center gap-0.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                      {kw}
                      {canEdit && (
                        <button onClick={() => { setKeywords((p) => p.filter((_, j) => j !== i)); setIsDirty(true); }} className="ml-0.5 text-blue-300 hover:text-blue-700">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      )}
                    </span>
                  ))}
                  {keywords.length === 0 && <span className="text-[10px] italic text-slate-300">None yet.</span>}
                </div>
                {canEdit && (
                  <div className="flex gap-1.5">
                    <input
                      value={kwInput}
                      onChange={(e) => setKwInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                      placeholder="Add keyword, press Enter…"
                      className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
                    />
                    <button onClick={addKeyword} className="rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700">Add</button>
                  </div>
                )}
              </div>

              {/* Suggested Questions */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <HelpCircle className="h-3 w-3" />
                  Suggested Questions
                  <span className="ml-1 font-normal normal-case text-slate-300">— AI Chat suggestions</span>
                </label>
                <div className="mb-2 space-y-1.5">
                  {questions.map((q, i) => (
                    <div key={i} className="flex items-start gap-1.5 rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5">
                      <span className="mt-0.5 shrink-0 text-[10px] font-bold text-slate-300">{i + 1}.</span>
                      {canEdit ? (
                        <input
                          value={q}
                          onChange={(e) => {
                            const v = e.target.value;
                            setQuestions((p) => p.map((item, j) => j === i ? v : item));
                            setIsDirty(true);
                          }}
                          className="flex-1 bg-transparent text-[11px] leading-snug text-slate-700 focus:outline-none"
                        />
                      ) : (
                        <span className="flex-1 text-[11px] leading-snug text-slate-700">{q}</span>
                      )}
                      {canEdit && (
                        <button onClick={() => { setQuestions((p) => p.filter((_, j) => j !== i)); setIsDirty(true); }} className="shrink-0 text-slate-300 hover:text-red-400">
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {questions.length === 0 && <p className="text-[10px] italic text-slate-300 px-1">None yet.</p>}
                </div>
                {canEdit && (
                  <div className="flex gap-1.5">
                    <input
                      value={qInput}
                      onChange={(e) => setQInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addQuestion())}
                      placeholder="Add question, press Enter…"
                      className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
                    />
                    <button onClick={addQuestion} className="rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700">Add</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer save bar */}
        {canEdit && (
          <div className="flex items-center justify-between gap-2 border-t bg-white px-5 py-3">
            {isDirty ? (
              <span className="text-[10px] font-medium text-amber-600">Unsaved changes</span>
            ) : (
              <span className="text-[10px] text-slate-400">All changes saved</span>
            )}
            <div className="flex gap-2">
              {isDirty && (
                <button
                  onClick={() => {
                    setDescDraft(data?.auto_description ?? '');
                    setKeywords(data?.insight_keywords ?? []);
                    setQuestions(data?.common_questions ?? []);
                    setIsDirty(false);
                  }}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
                >
                  Discard
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={updateMut.isPending || !isDirty}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="h-3 w-3" />
                {updateMut.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Diff preview modal — shown when AI generation completes */}
      {showDiff && diffData && data && (
        <DiffPreviewModal
          oldData={data}
          newData={diffData}
          onApply={handleApplyDiff}
          onClose={() => { setShowDiff(false); setDiffData(null); }}
        />
      )}
    </>
  );
}
