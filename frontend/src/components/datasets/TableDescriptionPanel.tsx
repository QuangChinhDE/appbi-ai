'use client';

import React, { useState } from 'react';
import { RefreshCw, Pencil, Check, X, AlertTriangle, Bot, User, MessageSquare } from 'lucide-react';
import {
  useTableDescription,
  useUpdateTableDescription,
  useRegenerateTableDescription,
} from '@/hooks/useDescription';
import { toast } from 'sonner';

interface Props {
  workspaceId: number;
  tableId: number;
  canEdit: boolean;
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null;
  const cfg: Record<string, { label: string; className: string }> = {
    auto: { label: 'Auto-generated', className: 'bg-blue-100 text-blue-700' },
    user: { label: 'Edited', className: 'bg-green-100 text-green-700' },
    feedback: { label: 'From feedback', className: 'bg-purple-100 text-purple-700' },
  };
  const c = cfg[source] ?? { label: source, className: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${c.className}`}>
      {source === 'auto' && <Bot className="w-3 h-3" />}
      {source === 'user' && <User className="w-3 h-3" />}
      {source === 'feedback' && <MessageSquare className="w-3 h-3" />}
      {c.label}
    </span>
  );
}

export function TableDescriptionPanel({ workspaceId, tableId, canEdit }: Props) {
  const { data, isLoading } = useTableDescription(workspaceId, tableId);
  const updateMut = useUpdateTableDescription(workspaceId, tableId);
  const regenMut = useRegenerateTableDescription(workspaceId, tableId);

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-gray-400 animate-pulse">Loading description...</div>
    );
  }

  if (!data) return null;

  const handleEditDesc = () => {
    setDescDraft(data.auto_description ?? '');
    setEditingDesc(true);
  };

  const handleSaveDesc = async () => {
    try {
      await updateMut.mutateAsync({ auto_description: descDraft });
      setEditingDesc(false);
      toast.success('Description saved');
    } catch {
      toast.error('Failed to save description');
    }
  };

  const handleRegen = async () => {
    try {
      await regenMut.mutateAsync();
      toast.info('Regenerating description in background...');
    } catch {
      toast.error('Failed to trigger regeneration');
    }
  };

  return (
    <div className="border rounded-lg p-4 space-y-4 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-gray-700">AI Description</span>
          <SourceBadge source={data.description_source} />
        </div>
        {canEdit && (
          <div className="flex items-center gap-1">
            {!editingDesc && (
              <button
                onClick={handleEditDesc}
                className="p-1 rounded hover:bg-gray-100 text-gray-500"
                title="Edit description"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={handleRegen}
              disabled={regenMut.isPending}
              className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-40"
              title="Regenerate with AI"
            >
              <RefreshCw className={`w-4 h-4 ${regenMut.isPending ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {/* Schema change warning */}
      {data.schema_change_pending && (
        <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            Schema has changed since you last edited the description. Some columns may no longer be described.
            Consider regenerating.
          </span>
        </div>
      )}

      {/* Description */}
      {editingDesc ? (
        <div className="space-y-2">
          <textarea
            className="w-full border rounded p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
            rows={4}
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              onClick={handleSaveDesc}
              disabled={updateMut.isPending}
              className="flex items-center gap-1 px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-40"
            >
              <Check className="w-3 h-3" /> Save
            </button>
            <button
              onClick={() => setEditingDesc(false)}
              className="flex items-center gap-1 px-3 py-1 border rounded text-sm hover:bg-gray-50"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-600 leading-relaxed">
          {data.auto_description ?? (
            <span className="text-gray-400 italic">
              No description yet.{canEdit ? ' Click Regenerate to generate one.' : ''}
            </span>
          )}
        </p>
      )}

      {/* Column descriptions */}
      {data.column_descriptions && Object.keys(data.column_descriptions).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Columns
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {Object.entries(data.column_descriptions).map(([col, desc]) => (
              <div key={col} className="flex gap-2 text-sm">
                <span className="font-mono text-xs text-blue-700 bg-blue-50 px-1 rounded flex-shrink-0 self-start mt-0.5">
                  {col}
                </span>
                <span className="text-gray-600">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Common questions */}
      {data.common_questions && data.common_questions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Common questions
          </p>
          <div className="flex flex-wrap gap-1">
            {data.common_questions.map((q, i) => (
              <span
                key={i}
                className="text-xs bg-gray-100 text-gray-600 rounded px-2 py-1"
              >
                {q}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
