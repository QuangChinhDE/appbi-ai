'use client';

/**
 * ChartDescriptionDrawer — slide-over panel for AI Description.
 *
 * Opened from the MODE bar "AI Description" button. Three fields:
 *   auto_description   → chart search snippet and tooltip
 *   insight_keywords   → vector embedding enrichment, fuzzy search
 *   common_questions   → suggested questions seed list
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
import { useI18n } from '@/providers/LanguageProvider';
import { AiButton } from '@/components/ui/AiButton';

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
  const { t } = useI18n();
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay/84 px-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold text-text-primary">{t('explore.aiDescription.previewTitle')}</h2>
            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
              {t('explore.aiDescription.previewBadge')}
            </span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Description */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">{t('explore.aiDescription.descriptionLabel')}</label>
              {(oldData.auto_description ?? '') !== desc && (
                <span className="text-[10px] text-warning font-medium">{t('explore.aiDescription.descriptionEdited')}</span>
              )}
            </div>
            {/* Old value */}
            {oldData.auto_description && (
              <div className="mb-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs text-text-tertiary line-through decoration-red-300">
                {oldData.auto_description}
              </div>
            )}
            {/* New (editable) */}
            <textarea
              rows={4}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="w-full resize-none rounded-lg border border-brand/30 bg-brand/10/30 px-3 py-2 text-xs leading-relaxed text-text-secondary focus:border-brand/50 focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder={t('explore.aiDescription.aiDescriptionPlaceholder')}
            />
          </div>

          {/* Keywords */}
          <div>
            <label className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
              <Tag className="h-3 w-3" />
              {t('explore.aiDescription.keywordsLabel')}
            </label>
            <div className="mb-2 flex flex-wrap gap-1.5 min-h-[28px]">
              {keywords.map((kw, i) => (
                <span key={`${kw}-${i}`} className="inline-flex items-center gap-0.5 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                  {kw}
                  <button onClick={() => setKeywords((p) => p.filter((_, j) => j !== i))} className="ml-0.5 text-brand hover:text-brand">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              {keywords.length === 0 && <span className="text-[10px] italic text-text-quaternary">{t('explore.aiDescription.none')}</span>}
            </div>
            <div className="flex gap-1.5">
              <input
                value={kwInput}
                onChange={(e) => setKwInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                placeholder={t('explore.aiDescription.addKeywordPlaceholder')}
                className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-[11px] focus:border-brand/50 focus:outline-none"
              />
              <button onClick={addKeyword} className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-hover">{t('explore.aiDescription.add')}</button>
            </div>
          </div>

          {/* Suggested Questions */}
          <div>
            <label className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
              <HelpCircle className="h-3 w-3" />
              {t('explore.aiDescription.questionsLabel')}
            </label>
            <div className="mb-2 space-y-1.5">
              {questions.map((q, i) => (
                <div key={i} className="flex items-start gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5">
                  <span className="mt-0.5 shrink-0 text-[10px] font-bold text-text-quaternary">{i + 1}.</span>
                  <input
                    value={q}
                    onChange={(e) => setQuestions((p) => p.map((v, j) => j === i ? e.target.value : v))}
                    className="flex-1 bg-transparent text-[11px] leading-snug text-text-secondary focus:outline-none"
                  />
                  <button onClick={() => setQuestions((p) => p.filter((_, j) => j !== i))} className="shrink-0 text-text-quaternary hover:text-danger">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {questions.length === 0 && <p className="text-[10px] italic text-text-quaternary px-1">{t('explore.aiDescription.none')}</p>}
            </div>
            <div className="flex gap-1.5">
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addQuestion())}
                placeholder={t('explore.aiDescription.addQuestionPlaceholder')}
                className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-[11px] focus:border-brand/50 focus:outline-none"
              />
              <button onClick={addQuestion} className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-hover">{t('explore.aiDescription.add')}</button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-[rgb(var(--border-line))] px-4 py-1.5 text-xs text-text-secondary hover:bg-surface-2">
            {t('explore.aiDescription.discard')}
          </button>
          <button
            onClick={() => onApply(desc, keywords, questions)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-hover"
          >
            <Check className="h-3.5 w-3.5" />
            {t('explore.aiDescription.applyToEditor')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string | null }) {
  const { t } = useI18n();

  if (!source) return null;
  const cfg: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    auto:     { label: t('explore.aiDescription.badgeAI'),     icon: <Bot className="h-2.5 w-2.5" />,           cls: 'bg-brand/10 text-brand border-brand/30' },
    user:     { label: t('explore.aiDescription.badgeEdited'), icon: <User className="h-2.5 w-2.5" />,          cls: 'bg-success/10 text-success border-success/30' },
    feedback: { label: t('explore.aiDescription.badgeTuned'),  icon: <MessageSquare className="h-2.5 w-2.5" />, cls: 'bg-surface-2 text-text-tertiary border-[rgb(var(--border-line))]' },
  };
  const item = cfg[source] ?? { label: source, icon: null, cls: 'bg-surface-2 text-text-tertiary border-[rgb(var(--border-line))]' };
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${item.cls}`}>
      {item.icon}{item.label}
    </span>
  );
}

// ─── Status dot map ───────────────────────────────────────────────────────────

const STATUS_DOT: Record<DescriptionGenerationStatus, string> = {
  idle:       'bg-surface-3',
  queued:     'bg-warning/60 animate-pulse',
  processing: 'bg-brand animate-pulse',
  succeeded:  'bg-success/60',
  failed:     'bg-danger/60',
  stale:      'bg-warning/60',
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
  const { t } = useI18n();
  const { data } = useChartDescription(chartId);
  const status = data?.generation_status ?? 'idle';
  const isGenerating = status === 'queued' || status === 'processing';
  const hasContent = !!(data?.auto_description);
  const dotCls = STATUS_DOT[status] ?? STATUS_DOT.idle;

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-xs font-medium text-text-secondary hover:border-brand/40 hover:bg-brand/15 hover:text-brand transition-colors"
      title={t('explore.aiDescription.title')}
    >
      {isGenerating
        ? <Loader2 className="h-3 w-3 animate-spin text-brand" />
        : <Bot className="h-3 w-3" />
      }
      <span>{t('explore.aiDescription.title')}</span>
      <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
      {data?.description_source && !isGenerating && (
        <SourceBadge source={data.description_source} />
      )}
      <ChevronRight className="h-3 w-3 text-text-quaternary" />
    </button>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

export function ChartDescriptionDrawer({ chartId, canEdit, open, onClose }: Props) {
  const { t } = useI18n();
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
      toast.error(data.generation_error || t('explore.aiDescription.generationFailedToast'));
    }
    if (wasBusy && next === 'stale') {
      toast.warning(t('explore.aiDescription.outdatedToast'));
    }
    lastStatusRef.current = next;
  }, [data, t]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    try {
      await updateMut.mutateAsync({
        auto_description: descDraft,
        insight_keywords: keywords,
        common_questions: questions,
      });
      setIsDirty(false);
      toast.success(t('explore.aiDescription.savedToast'));
    } catch {
      toast.error(t('explore.aiDescription.saveFailedToast'));
    }
  };

  const handleRegen = async () => {
    // Track that we're starting a generation so the effect can open diff
    lastStatusRef.current = 'queued';
    wasGeneratingRef.current = true;
    try {
      await regenMut.mutateAsync();
    } catch {
      toast.error(t('explore.aiDescription.startFailedToast'));
    }
  };

  const handleApplyDiff = (desc: string, kws: string[], qs: string[]) => {
    setDescDraft(desc);
    setKeywords(kws);
    setQuestions(qs);
    setIsDirty(true);
    setShowDiff(false);
    setDiffData(null);
    toast.success(t('explore.aiDescription.appliedToast'));
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
        className="fixed inset-0 z-40 bg-overlay/84 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col border-l border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold text-text-primary">{t('explore.aiDescription.title')}</h2>
            <span className={`h-2 w-2 rounded-full ${dotCls}`} title={status} />
            {data?.description_source && !isGenerating && (
              <SourceBadge source={data.description_source} />
            )}
            {isGenerating && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />}
          </div>
          <button onClick={onClose} className="rounded p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Generate bar */}
        {canEdit && (
          <div className="border-b bg-surface-2 px-5 py-3">
            {isGenerating ? (
              <div className="flex items-center gap-2 rounded-lg bg-brand/10 px-3 py-2 text-xs text-brand">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                <span>
                  {status === 'queued' ? t('explore.aiDescription.queued') : t('explore.aiDescription.analyzing')}
                  <span className="ml-1 text-brand">{t('explore.aiDescription.previewWhenReady')}</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-text-tertiary">
                  {t('explore.aiDescription.generateHelper')}
                  <br />
                  <span className="text-text-quaternary">{t('explore.aiDescription.reviewHelper')}</span>
                </p>
                <AiButton
                  size="md"
                  className="shrink-0"
                  onClick={handleRegen}
                  loading={regenMut.isPending}
                >
                  {hasContent ? t('explore.aiDescription.regenerate') : t('explore.aiDescription.generateTitle')}
                </AiButton>
              </div>
            )}
          </div>
        )}

        {/* Error / stale banners */}
        {status === 'failed' && !isGenerating && (
          <div className="border-b border-danger/30 bg-danger/10 px-5 py-2 text-xs text-danger">
            <span className="font-medium">{t('explore.aiDescription.generationFailedInline')}</span>
            {data?.generation_error || t('explore.aiDescription.unknownError')}
          </div>
        )}
        {status === 'stale' && !isGenerating && (
          <div className="flex items-center gap-1.5 border-b border-warning/20 bg-warning/10 px-5 py-2 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
            {data?.stale_reason || t('explore.aiDescription.staleShortFallback')}
          </div>
        )}

        {/* Editable fields — scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {isLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-3 w-1/3 rounded bg-surface-2" />
              <div className="h-20 rounded bg-surface-2" />
              <div className="h-3 w-1/4 rounded bg-surface-2" />
              <div className="h-8 rounded bg-surface-2" />
            </div>
          ) : (
            <>
              {/* Description */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  <Bot className="h-3 w-3" />
                  {t('explore.aiDescription.descriptionLabel')}
                  <span className="ml-1 font-normal normal-case text-text-quaternary">{t('explore.aiDescription.descriptionTooltipHint')}</span>
                </label>
                <textarea
                  rows={5}
                  value={descDraft}
                  onChange={(e) => { setDescDraft(e.target.value); setIsDirty(true); }}
                  disabled={!canEdit}
                  placeholder={canEdit ? t('explore.aiDescription.descriptionPlaceholder') : t('explore.aiDescription.noDescription')}
                  className="w-full resize-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs leading-relaxed text-text-secondary placeholder-slate-300 focus:border-brand/50 focus:outline-none focus:ring-1 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>

              {/* Keywords */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  <Tag className="h-3 w-3" />
                  {t('explore.aiDescription.keywordsLabel')}
                  <span className="ml-1 font-normal normal-case text-text-quaternary">{t('explore.aiDescription.keywordsDrawerHint')}</span>
                </label>
                <div className="mb-2 flex min-h-[28px] flex-wrap gap-1">
                  {keywords.map((kw, i) => (
                    <span key={`${kw}-${i}`} className="inline-flex items-center gap-0.5 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                      {kw}
                      {canEdit && (
                        <button onClick={() => { setKeywords((p) => p.filter((_, j) => j !== i)); setIsDirty(true); }} className="ml-0.5 text-brand hover:text-brand">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      )}
                    </span>
                  ))}
                  {keywords.length === 0 && <span className="text-[10px] italic text-text-quaternary">{t('explore.aiDescription.noneYet')}</span>}
                </div>
                {canEdit && (
                  <div className="flex gap-1.5">
                    <input
                      value={kwInput}
                      onChange={(e) => setKwInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                      placeholder={t('explore.aiDescription.addKeywordPlaceholder')}
                      className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-[11px] focus:border-brand/50 focus:outline-none"
                    />
                    <button onClick={addKeyword} className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-hover">{t('explore.aiDescription.add')}</button>
                  </div>
                )}
              </div>

              {/* Suggested Questions */}
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">
                  <HelpCircle className="h-3 w-3" />
                  {t('explore.aiDescription.questionsLabel')}
                  <span className="ml-1 font-normal normal-case text-text-quaternary">{t('explore.aiDescription.questionsHint')}</span>
                </label>
                <div className="mb-2 space-y-1.5">
                  {questions.map((q, i) => (
                    <div key={i} className="flex items-start gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5">
                      <span className="mt-0.5 shrink-0 text-[10px] font-bold text-text-quaternary">{i + 1}.</span>
                      {canEdit ? (
                        <input
                          value={q}
                          onChange={(e) => {
                            const v = e.target.value;
                            setQuestions((p) => p.map((item, j) => j === i ? v : item));
                            setIsDirty(true);
                          }}
                          className="flex-1 bg-transparent text-[11px] leading-snug text-text-secondary focus:outline-none"
                        />
                      ) : (
                        <span className="flex-1 text-[11px] leading-snug text-text-secondary">{q}</span>
                      )}
                      {canEdit && (
                        <button onClick={() => { setQuestions((p) => p.filter((_, j) => j !== i)); setIsDirty(true); }} className="shrink-0 text-text-quaternary hover:text-danger">
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {questions.length === 0 && <p className="text-[10px] italic text-text-quaternary px-1">{t('explore.aiDescription.noneYet')}</p>}
                </div>
                {canEdit && (
                  <div className="flex gap-1.5">
                    <input
                      value={qInput}
                      onChange={(e) => setQInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addQuestion())}
                      placeholder={t('explore.aiDescription.addQuestionPlaceholder')}
                      className="flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-[11px] focus:border-brand/50 focus:outline-none"
                    />
                    <button onClick={addQuestion} className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-hover">{t('explore.aiDescription.add')}</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer save bar */}
        {canEdit && (
          <div className="flex items-center justify-between gap-2 border-t bg-surface-1 px-5 py-3">
            {isDirty ? (
              <span className="text-[10px] font-medium text-warning">{t('explore.aiDescription.unsavedChanges')}</span>
            ) : (
              <span className="text-[10px] text-text-quaternary">{t('explore.aiDescription.allChangesSaved')}</span>
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
                  className="rounded-lg border border-[rgb(var(--border-line))] px-3 py-1.5 text-xs text-text-tertiary hover:bg-surface-2"
                >
                  {t('explore.aiDescription.discard')}
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={updateMut.isPending || !isDirty}
                className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="h-3 w-3" />
                {updateMut.isPending ? t('explore.aiDescription.saving') : t('explore.aiDescription.save')}
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
