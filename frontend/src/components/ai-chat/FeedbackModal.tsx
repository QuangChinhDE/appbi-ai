'use client';

/**
 * FeedbackModal — user corrects an AI response by selecting the right resource.
 * Submits to POST /api/v1/ai/feedback which triggers the knowledge loop.
 */
import React, { useState } from 'react';
import { X, Search } from 'lucide-react';
import apiClient from '@/lib/api-client';
import { toast } from 'sonner';

interface Props {
  sessionId: string;
  messageId?: string;
  userQuery: string;
  aiMatchedResourceType?: string;
  aiMatchedResourceId?: number;
  onClose: () => void;
}

const FEEDBACK_TYPES = [
  { value: 'wrong_table', label: 'Used wrong table' },
  { value: 'wrong_chart', label: 'Used wrong chart' },
  { value: 'unclear', label: 'Answer was unclear' },
  { value: 'other', label: 'Other' },
];

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
  const [feedbackType, setFeedbackType] = useState('wrong_table');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<ResourceOption[]>([]);
  const [selectedResource, setSelectedResource] = useState<ResourceOption | null>(null);
  const [notes, setNotes] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Correct AI response</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* User query reminder */}
        <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600 border">
          <span className="text-xs font-medium text-gray-400 block mb-0.5">Your question</span>
          {userQuery}
        </div>

        {/* Feedback type */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">What was wrong?</label>
          <div className="space-y-1">
            {FEEDBACK_TYPES.map((t) => (
              <label key={t.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="feedback_type"
                  value={t.value}
                  checked={feedbackType === t.value}
                  onChange={() => {
                    setFeedbackType(t.value);
                    setSearchResults([]);
                    setSelectedResource(null);
                  }}
                  className="text-blue-600"
                />
                <span className="text-sm text-gray-700">{t.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Resource search (only for wrong_table / wrong_chart) */}
        {(feedbackType === 'wrong_table' || feedbackType === 'wrong_chart') && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Select the correct {feedbackType === 'wrong_chart' ? 'chart' : 'table'}
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder={`Search ${feedbackType === 'wrong_chart' ? 'charts' : 'tables'}...`}
                className="flex-1 border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <button
                onClick={handleSearch}
                disabled={isSearching}
                className="px-3 py-1.5 bg-gray-100 border rounded text-sm hover:bg-gray-200 disabled:opacity-40"
              >
                <Search className="w-4 h-4" />
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="border rounded max-h-40 overflow-y-auto">
                {searchResults.map((r) => (
                  <button
                    key={`${r.type}:${r.id}`}
                    onClick={() => setSelectedResource(r)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors ${
                      selectedResource?.id === r.id && selectedResource?.type === r.type
                        ? 'bg-blue-50 text-blue-700 font-medium'
                        : 'text-gray-700'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}
            {selectedResource && (
              <p className="text-xs text-green-600 mt-1">
                Selected: <strong>{selectedResource.label}</strong>
              </p>
            )}
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional context..."
            rows={2}
            className="w-full border rounded px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 border rounded text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-40"
          >
            {isSubmitting ? 'Submitting...' : 'Submit feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}
