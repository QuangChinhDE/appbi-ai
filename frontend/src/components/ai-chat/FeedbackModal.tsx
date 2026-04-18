'use client';

/**
 * FeedbackModal — user corrects an AI response by selecting the right resource.
 * Submits to POST /api/v1/ai/feedback which triggers the knowledge loop.
 */
import React, { useState } from 'react';
import { Check, Search } from 'lucide-react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Textarea } from '@/components/ui/Input';
import apiClient from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

interface Props {
  sessionId: string;
  messageId?: string;
  userQuery: string;
  aiMatchedResourceType?: string;
  aiMatchedResourceId?: number;
  onClose: () => void;
}

const FEEDBACK_TYPES = [
  {
    value: 'wrong_table',
    label: 'Used wrong table',
    hint: 'The answer referenced the wrong dataset table.',
  },
  {
    value: 'wrong_chart',
    label: 'Used wrong chart',
    hint: 'The answer should have grounded itself on another chart.',
  },
  {
    value: 'unclear',
    label: 'Answer was unclear',
    hint: 'The response was vague or not actionable enough.',
  },
  {
    value: 'other',
    label: 'Other',
    hint: 'Use notes to explain the issue in your own words.',
  },
] as const;

type FeedbackType = (typeof FEEDBACK_TYPES)[number]['value'];

interface ResourceOption {
  id: number;
  label: string;
  type: 'chart' | 'dataset_table';
}

export function FeedbackModal({
  sessionId,
  messageId,
  userQuery,
  aiMatchedResourceType,
  aiMatchedResourceId,
  onClose,
}: Props) {
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('wrong_table');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<ResourceOption[]>([]);
  const [selectedResource, setSelectedResource] = useState<ResourceOption | null>(null);
  const [notes, setNotes] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const needsReplacement = feedbackType === 'wrong_table' || feedbackType === 'wrong_chart';
  const replacementLabel = feedbackType === 'wrong_chart' ? 'chart' : 'table';

  const handleSearch = async () => {
    if (!search.trim()) return;
    setIsSearching(true);
    try {
      const resourceType = feedbackType === 'wrong_chart' ? 'chart' : 'dataset_table';
      if (resourceType === 'chart') {
        const res = await apiClient.get(`/charts/search?q=${encodeURIComponent(search)}&limit=8`);
        setSearchResults(
          (res.data ?? []).map((c: any) => ({
            id: c.id,
            label: c.name,
            type: 'chart' as const,
          }))
        );
      } else {
        const res = await apiClient.get(
          `/datasets/tables/search?q=${encodeURIComponent(search)}&limit=8`
        );
        setSearchResults(
          (res.data ?? []).map((t: any) => ({
            id: t.id,
            label: t.display_name || t.source_table_name,
            type: 'dataset_table' as const,
          }))
        );
      }
    } catch {
      toast.error('Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await apiClient.post('/ai/feedback', {
        session_id: sessionId,
        message_id: messageId,
        user_query: userQuery,
        feedback_type: feedbackType,
        correct_resource_type: selectedResource?.type ?? null,
        correct_resource_id: selectedResource?.id ?? null,
        ai_matched_resource_type: aiMatchedResourceType ?? null,
        ai_matched_resource_id: aiMatchedResourceId ?? null,
        notes: notes.trim() || null,
        is_positive: false,
      });
      toast.success('Feedback submitted — AI will learn from this');
      onClose();
    } catch {
      toast.error('Failed to submit feedback');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title="Correct AI response"
      description="Point the assistant to the right resource so the next answer stays in the correct scope."
      maxWidthClass="max-w-2xl"
      bodyClassName="space-y-5 p-5"
      footer={(
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={isSubmitting}>
            Submit feedback
          </Button>
        </>
      )}
    >
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
        <p className="text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
          Your question
        </p>
        <p className="mt-2 text-small text-text-secondary">{userQuery}</p>
      </div>

      <FieldGroup
        label="What was wrong?"
        description="Choose the mismatch type first, then optionally attach the right resource."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {FEEDBACK_TYPES.map((option) => {
            const selected = feedbackType === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setFeedbackType(option.value);
                  setSearchResults([]);
                  setSelectedResource(null);
                }}
                className={cn(
                  'rounded-xl border px-4 py-3 text-left transition-colors',
                  selected
                    ? 'border-brand/40 bg-brand/10 text-text-primary shadow-linear-sm'
                    : 'border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary hover:bg-surface-2',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-caption font-emphasis text-current">{option.label}</p>
                    <p className="mt-1 text-tiny leading-5 text-text-tertiary">{option.hint}</p>
                  </div>
                  {selected && <Check className="mt-0.5 h-4 w-4 text-brand" />}
                </div>
              </button>
            );
          })}
        </div>
      </FieldGroup>

      {needsReplacement && (
        <div className="rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 p-4 shadow-linear-sm">
          <FieldGroup
            label={`Select the correct ${replacementLabel}`}
            description={`Search the ${replacementLabel} that should have been used in this answer.`}
          >
            <div className="flex gap-2">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && handleSearch()}
                placeholder={`Search ${replacementLabel}s...`}
                leadingIcon={<Search />}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSearch}
                disabled={isSearching || !search.trim()}
                loading={isSearching}
              >
                Search
              </Button>
            </div>
          </FieldGroup>

          <div className="mt-3 space-y-2">
            {searchResults.length > 0 ? (
              <div className="max-h-48 overflow-y-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-0/60 p-1.5">
                {searchResults.map((resource) => {
                  const selected = selectedResource?.id === resource.id && selectedResource?.type === resource.type;
                  return (
                    <button
                      key={`${resource.type}:${resource.id}`}
                      type="button"
                      onClick={() => setSelectedResource(resource)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-caption transition-colors',
                        selected
                          ? 'bg-brand/10 text-brand'
                          : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-emphasis text-current">{resource.label}</p>
                        <p className="mt-0.5 text-tiny uppercase tracking-[0.14em] text-text-quaternary">
                          {resource.type === 'chart' ? 'Chart' : 'Dataset table'}
                        </p>
                      </div>
                      {selected && <Check className="h-4 w-4 flex-shrink-0 text-brand" />}
                    </button>
                  );
                })}
              </div>
            ) : search.trim() && !isSearching ? (
              <p className="text-caption text-text-tertiary">
                No matching {replacementLabel} found for the current search.
              </p>
            ) : null}

            {selectedResource && (
              <p className="text-caption text-success">
                Selected resource:{' '}
                <span className="font-emphasis text-success">{selectedResource.label}</span>
              </p>
            )}
          </div>
        </div>
      )}

      <FieldGroup
        label="Notes"
        description="Optional context that can help the assistant understand why this answer missed the mark."
      >
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add the correction in your own words..."
          rows={3}
        />
      </FieldGroup>
    </AppModalShell>
  );
}
