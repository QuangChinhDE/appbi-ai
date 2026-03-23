'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Check, X, AlertTriangle, Bot, User, MessageSquare, Sparkles, HelpCircle, Table2, Plus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
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
  const cfg: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
    auto: { label: 'AI tự tạo', icon: <Bot className="w-3 h-3" />, className: 'bg-blue-50 text-blue-600 border border-blue-200' },
    user: { label: 'Đã chỉnh sửa', icon: <User className="w-3 h-3" />, className: 'bg-emerald-50 text-emerald-600 border border-emerald-200' },
    feedback: { label: 'Từ phản hồi', icon: <MessageSquare className="w-3 h-3" />, className: 'bg-violet-50 text-violet-600 border border-violet-200' },
  };
  const c = cfg[source] ?? { label: source, icon: null, className: 'bg-gray-100 text-gray-500' };
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium ${c.className}`}>
      {c.icon}{c.label}
    </span>
  );
}

export function TableDescriptionPanel({ workspaceId, tableId, canEdit }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useTableDescription(workspaceId, tableId);
  const updateMut = useUpdateTableDescription(workspaceId, tableId);
  const regenMut = useRegenerateTableDescription(workspaceId, tableId);

  const [descDraft, setDescDraft] = useState('');
  const [commonQsDraft, setCommonQsDraft] = useState<string[]>([]);
  const [qInput, setQInput] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const prevUpdatedAtRef = useRef<string | null>(null);

  // Sync drafts when data arrives (only if not dirty)
  useEffect(() => {
    if (data && !isDirty && !isProcessing) {
      setDescDraft(data.auto_description ?? '');
      setCommonQsDraft(data.common_questions ?? []);
    }
  }, [data, isDirty, isProcessing]);

  // Poll every 2s while AI is processing
  useEffect(() => {
    if (!isProcessing) return;
    const pollTimer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['table-description', workspaceId, tableId] });
    }, 2000);
    // Safety timeout: stop after 90 seconds
    const safetyTimer = setTimeout(() => {
      setIsProcessing(false);
      queryClient.invalidateQueries({ queryKey: ['table-description', workspaceId, tableId] });
      toast.warning('Tạo mô tả mất nhiều thời gian. Hãy kiểm tra lại sau.');
    }, 90000);
    return () => { clearInterval(pollTimer); clearTimeout(safetyTimer); };
  }, [isProcessing, queryClient, workspaceId, tableId]);

  // Stop polling when updated_at changes
  useEffect(() => {
    if (!isProcessing || !data) return;
    if (data.description_updated_at !== prevUpdatedAtRef.current) {
      setIsProcessing(false);
      setIsDirty(false);
      setDescDraft(data.auto_description ?? '');
      setCommonQsDraft(data.common_questions ?? []);
      toast.success('AI đã hoàn tất tạo mô tả!');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.description_updated_at]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 animate-pulse p-2">
        <div className="h-4 bg-gray-100 rounded w-1/3" />
        <div className="h-24 bg-gray-100 rounded" />
        <div className="h-4 bg-gray-100 rounded w-1/2" />
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
      toast.success('Đã lưu mô tả');
    } catch {
      toast.error('Lưu thất bại');
    }
  };

  const handleRegen = async () => {
    prevUpdatedAtRef.current = data.description_updated_at ?? null;
    setIsProcessing(true);
    try {
      await regenMut.mutateAsync();
      toast.info('AI đang phân tích và tạo mô tả, vui lòng đợi...');
    } catch {
      setIsProcessing(false);
      toast.error('Không thể tạo lại mô tả');
    }
  };

  const addQ = () => {
    const q = qInput.trim();
    if (q) { setCommonQsDraft(p => [...p, q]); setIsDirty(true); }
    setQInput('');
  };

  const colEntries = data.column_descriptions ? Object.entries(data.column_descriptions) : [];
  const disabled = isProcessing || !canEdit;

  return (
    <div className="flex flex-col gap-6 relative">
      {/* Processing overlay */}
      {isProcessing && (
        <div className="absolute inset-0 z-10 bg-white/90 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 rounded-full border-4 border-violet-200 border-t-violet-600 animate-spin" />
          <div className="text-center">
            <p className="font-semibold text-gray-800">AI đang phân tích dữ liệu...</p>
            <p className="text-xs text-gray-500 mt-1">Quá trình có thể mất 10–30 giây</p>
          </div>
        </div>
      )}

      {/* Status row */}
      <div className="flex items-center justify-between">
        <SourceBadge source={data.description_source} />
        {canEdit && (
          <button
            onClick={handleRegen}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles className={`w-3.5 h-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
            {isProcessing ? 'Đang tạo...' : 'Tạo lại bằng AI'}
          </button>
        )}
      </div>

      {/* Schema change warning */}
      {data.schema_change_pending && !isProcessing && (
        <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
          <span>Cấu trúc bảng đã thay đổi. Mô tả có thể không còn chính xác — hãy tạo lại.</span>
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left — description + common questions */}
        <div className="flex flex-col gap-5">
          {/* Description */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              <Bot className="w-3.5 h-3.5" /> Mô tả bảng dữ liệu
            </label>
            <textarea
              className="w-full border border-gray-200 rounded-xl p-3.5 text-sm text-gray-700 leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              rows={6}
              value={descDraft}
              onChange={(e) => { setDescDraft(e.target.value); setIsDirty(true); }}
              placeholder="Nhập mô tả cho bảng dữ liệu này..."
              disabled={disabled}
            />
          </div>

          {/* Common questions */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              <HelpCircle className="w-3.5 h-3.5" /> Câu hỏi mẫu ({commonQsDraft.length})
            </label>
            <div className="space-y-1.5 mb-2">
              {commonQsDraft.map((q, i) => (
                <div key={i} className="flex items-start gap-2 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <span className="text-gray-300 font-bold mt-0.5 text-xs flex-shrink-0">{i + 1}.</span>
                  <span className="text-sm text-gray-700 flex-1 leading-snug">{q}</span>
                  {canEdit && !isProcessing && (
                    <button
                      onClick={() => { setCommonQsDraft(p => p.filter((_, j) => j !== i)); setIsDirty(true); }}
                      className="flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {commonQsDraft.length === 0 && (
                <p className="text-xs text-gray-400 italic px-1">Chưa có câu hỏi mẫu</p>
              )}
            </div>
            {canEdit && !isProcessing && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addQ())}
                  placeholder="Thêm câu hỏi và nhấn Enter..."
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-xs bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                />
                <button
                  onClick={addQ}
                  className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right — column descriptions */}
        <div>
          {colEntries.length > 0 ? (
            <div>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                <Table2 className="w-3.5 h-3.5" /> Mô tả cột ({colEntries.length})
              </label>
              <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {colEntries.map(([col, desc]) => (
                  <div key={col} className="flex flex-col gap-0.5 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                    <span className="font-mono text-xs font-semibold text-blue-600">{col}</span>
                    <span className="text-xs text-gray-600 leading-relaxed">{desc as string}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full min-h-[160px] text-center bg-gray-50 rounded-xl border border-dashed border-gray-200 p-6">
              <Table2 className="w-8 h-8 mb-2 text-gray-300" />
              <p className="text-sm font-medium text-gray-400">Chưa có mô tả cột</p>
              <p className="text-xs text-gray-400 mt-1">Nhấn "Tạo lại bằng AI" để sinh mô tả cho từng cột</p>
            </div>
          )}
        </div>
      </div>

      {/* Save bar */}
      {canEdit && (
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100">
          {isDirty && <span className="text-xs text-amber-600 font-medium">Có thay đổi chưa lưu</span>}
          <button
            onClick={handleSave}
            disabled={updateMut.isPending || !isDirty || isProcessing}
            className="inline-flex items-center gap-1.5 px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check className="w-4 h-4" />
            {updateMut.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
          </button>
        </div>
      )}
    </div>
  );
}
