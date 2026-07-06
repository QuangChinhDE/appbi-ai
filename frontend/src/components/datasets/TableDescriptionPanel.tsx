'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Clock3,
  HelpCircle,
  MessageSquare,
  Plus,
  Sparkles,
  Table2,
  User,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useRegenerateTableDescription,
  useTableDescription,
  useUpdateTableDescription,
} from '@/hooks/useDescription';
import type { DescriptionGenerationStatus } from '@/hooks/useDescription';
import { toast } from '@/lib/toast';
import { AiButton } from '@/components/ui/AiButton';

interface Props {
  datasetId: number;
  tableId: number;
  canEdit: boolean;
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null;
  const cfg: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
    auto: { label: 'AI generated', icon: <Bot className="w-3 h-3" />, className: 'bg-brand/10 text-brand border border-brand/30' },
    user: { label: 'User edited', icon: <User className="w-3 h-3" />, className: 'bg-success/10 text-success border border-success/30' },
    feedback: { label: 'Feedback tuned', icon: <MessageSquare className="w-3 h-3" />, className: 'bg-surface-2 text-text-secondary border border-[rgb(var(--border-line))]' },
  };
  const item = cfg[source] ?? { label: source, icon: null, className: 'bg-surface-2 text-text-secondary border border-[rgb(var(--border-line))]' };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${item.className}`}>
      {item.icon}
      {item.label}
    </span>
  );
}

function StatusBadge({ status }: { status: DescriptionGenerationStatus | null }) {
  const current = status ?? 'idle';
  const cfg: Record<DescriptionGenerationStatus, { label: string; className: string }> = {
    idle: { label: 'Idle', className: 'bg-surface-2 text-text-secondary border border-[rgb(var(--border-line))]' },
    queued: { label: 'Queued', className: 'bg-warning/10 text-warning border border-warning/30' },
    processing: { label: 'Processing', className: 'bg-brand/10 text-brand border border-brand/30' },
    succeeded: { label: 'Up to date', className: 'bg-success/10 text-success border border-success/30' },
    failed: { label: 'Failed', className: 'bg-danger/10 text-danger border border-danger/30' },
    stale: { label: 'Needs review', className: 'bg-warning/10 text-warning border border-warning/30' },
  };
  const item = cfg[current];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${item.className}`}>
      <Clock3 className="w-3 h-3" />
      {item.label}
    </span>
  );
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

export function TableDescriptionPanel({ datasetId, tableId, canEdit }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useTableDescription(datasetId, tableId);
  const updateMut = useUpdateTableDescription(datasetId, tableId);
  const regenMut = useRegenerateTableDescription(datasetId, tableId);

  const [descDraft, setDescDraft] = useState('');
  const [commonQsDraft, setCommonQsDraft] = useState<string[]>([]);
  const [qInput, setQInput] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const lastStatusRef = useRef<DescriptionGenerationStatus | null>(null);

  const generationStatus = data?.generation_status ?? 'idle';
  const isProcessing =
    regenMut.isPending ||
    generationStatus === 'queued' ||
    generationStatus === 'processing';
  const disabled = isProcessing || !canEdit;

  useEffect(() => {
    if (data && !isDirty && !isProcessing) {
      setDescDraft(data.auto_description ?? '');
      setCommonQsDraft(data.common_questions ?? []);
    }
  }, [data, isDirty, isProcessing]);

  useEffect(() => {
    if (!isProcessing) return;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      queryClient.invalidateQueries({ queryKey: ['table-description', datasetId, tableId] });
      delay = Math.min(delay * 1.5, 10000);
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    return () => clearTimeout(timer);
  }, [isProcessing, queryClient, tableId, datasetId]);

  useEffect(() => {
    if (!data) return;
    const previous = lastStatusRef.current;
    const next = data.generation_status ?? 'idle';

    if (previous && previous !== next) {
      const wasBusy = previous === 'queued' || previous === 'processing';
      if (wasBusy && next === 'succeeded') {
        toast.success('AI description for this table is ready.');
      }
      if (wasBusy && next === 'failed') {
        toast.error(data.generation_error || 'AI description generation failed.');
      }
      if (wasBusy && next === 'stale') {
        toast.warning('Table description needs review after recent changes.');
      }
    }

    lastStatusRef.current = next;
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex animate-pulse flex-col gap-4 p-2">
        <div className="h-4 w-1/3 rounded bg-surface-2" />
        <div className="h-24 rounded bg-surface-2" />
        <div className="h-4 w-1/2 rounded bg-surface-2" />
      </div>
    );
  }

  if (!data) return null;

  const handleSave = async () => {
    try {
      await updateMut.mutateAsync({
        auto_description: descDraft,
        common_questions: commonQsDraft,
      });
      setIsDirty(false);
      toast.success('Saved table AI description.');
    } catch {
      toast.error('Failed to save table AI description.');
    }
  };

  const handleRegen = async () => {
    try {
      await regenMut.mutateAsync();
      toast.info('Queued AI regeneration for this table.');
    } catch {
      toast.error('Could not queue table regeneration.');
    }
  };

  const addQuestion = () => {
    const next = qInput.trim();
    if (!next) {
      setQInput('');
      return;
    }
    setCommonQsDraft((previous) => [...previous, next]);
    setIsDirty(true);
    setQInput('');
  };

  const columnEntries = data.column_descriptions ? Object.entries(data.column_descriptions) : [];
  const updatedAt = formatTimestamp(data.description_updated_at);
  const requestedAt = formatTimestamp(data.generation_requested_at);
  const finishedAt = formatTimestamp(data.generation_finished_at);

  return (
    <div className="relative flex flex-col gap-6">
      {isProcessing && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 rounded-xl bg-surface-1/95 backdrop-blur-sm">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-brand/30 border-t-blue-600" />
          <div className="text-center">
            <p className="font-semibold text-text-primary">
              {generationStatus === 'queued' ? 'AI request is queued...' : 'AI is analyzing this table...'}
            </p>
            <p className="mt-1 text-xs text-text-tertiary">The panel will refresh automatically when the result is ready.</p>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge source={data.description_source} />
          <StatusBadge status={data.generation_status} />
        </div>
        {canEdit && (
          <AiButton size="md" onClick={handleRegen} loading={isProcessing}>
            Regenerate with AI
          </AiButton>
        )}
      </div>

      {(requestedAt || finishedAt || updatedAt) && (
        <div className="text-xs text-text-tertiary">
          {requestedAt && <p>Requested: {requestedAt}</p>}
          {finishedAt && <p>Finished: {finishedAt}</p>}
          {updatedAt && <p>Content updated: {updatedAt}</p>}
        </div>
      )}

      {data.generation_status === 'failed' && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-3.5 text-sm text-danger">
          <p className="font-medium">AI generation failed</p>
          <p className="mt-1 text-xs text-danger">
            {data.generation_error || 'The backend could not generate an AI description for this table.'}
          </p>
        </div>
      )}

      {(data.generation_status === 'stale' || data.schema_change_pending) && !isProcessing && (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 p-3.5 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
          <span>
            {data.stale_reason || 'This table changed after the last reviewed AI description. Please review or regenerate it.'}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-5">
          <div>
            <label className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              <Bot className="h-3.5 w-3.5" /> AI Description
            </label>
            <textarea
              className="w-full resize-none rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-3.5 text-sm leading-relaxed text-text-secondary transition-colors focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
              rows={6}
              value={descDraft}
              onChange={(event) => {
                setDescDraft(event.target.value);
                setIsDirty(true);
              }}
              placeholder="Describe what this table contains and how people should use it..."
              disabled={disabled}
            />
          </div>

          <div>
            <label className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              <HelpCircle className="h-3.5 w-3.5" /> Suggested Questions ({commonQsDraft.length})
            </label>
            <div className="mb-2 space-y-1.5">
              {commonQsDraft.map((question, index) => (
                <div key={`${question}-${index}`} className="flex items-start gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <span className="mt-0.5 flex-shrink-0 text-xs font-bold text-text-quaternary">{index + 1}.</span>
                  <span className="flex-1 text-sm leading-snug text-text-secondary">{question}</span>
                  {canEdit && !isProcessing && (
                    <button
                      onClick={() => {
                        setCommonQsDraft((previous) => previous.filter((_, current) => current !== index));
                        setIsDirty(true);
                      }}
                      className="flex-shrink-0 text-text-quaternary transition-colors hover:text-danger"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {commonQsDraft.length === 0 && (
                <p className="px-1 text-xs italic text-text-quaternary">No suggested business questions yet.</p>
              )}
            </div>
            {canEdit && !isProcessing && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={qInput}
                  onChange={(event) => setQInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addQuestion();
                    }
                  }}
                  placeholder="Add a suggested question and press Enter..."
                  className="flex-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-xs focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                />
                <button
                  onClick={addQuestion}
                  className="rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        <div>
          {columnEntries.length > 0 ? (
            <div>
              <label className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                <Table2 className="h-3.5 w-3.5" /> Column Descriptions ({columnEntries.length})
              </label>
              <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                {columnEntries.map(([column, description]) => (
                  <div key={column} className="flex flex-col gap-0.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                    <span className="font-mono text-xs font-semibold text-brand">{column}</span>
                    <span className="text-xs leading-relaxed text-text-secondary">{description as string}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex min-h-[160px] flex-col items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 p-6 text-center">
              <Table2 className="mb-2 h-8 w-8 text-text-quaternary" />
              <p className="text-sm font-medium text-text-quaternary">No column descriptions yet</p>
              <p className="mt-1 text-xs text-text-quaternary">Run AI generation to create per-column guidance.</p>
            </div>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex items-center justify-end gap-3 border-t border-[rgb(var(--border-line))] pt-2">
          {isDirty && <span className="text-xs font-medium text-warning">Unsaved changes</span>}
          <button
            onClick={handleSave}
            disabled={updateMut.isPending || !isDirty || isProcessing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
            {updateMut.isPending ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
