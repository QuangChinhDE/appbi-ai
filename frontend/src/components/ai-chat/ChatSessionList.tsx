'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquareText, Trash2, Clock, Loader2, Share2 } from 'lucide-react';
import type { ViewMode } from '@/components/common/PageListLayout';
import { FilterTag } from '@/components/ui/FilterTag';
import type { ChatSessionContext } from './types';
import { IconButton } from '@/components/ui/Button';

export interface SessionSummary {
  session_id: string;
  title: string;
  created_at: string;
  last_active: string;
  message_count: number;
  last_message: string | null;
  context?: ChatSessionContext | null;
}

interface ChatSessionListProps {
  sessions: SessionSummary[];
  viewMode: ViewMode;
  onDelete: (id: string) => void;
  onShare?: (session: SessionSummary) => void;
  deletingId: string | null;
  activeFilters?: Record<string, string | undefined>;
  onFilterClick?: (key: string, value: string) => void;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  return `${Math.floor(hrs / 24)} ngày trước`;
}

function getDatasetLabel(context?: ChatSessionContext | null) {
  if (!context?.dataset_id) return null;
  return context.dataset_name?.trim() || `Dataset #${context.dataset_id}`;
}

export function ChatSessionList({
  sessions,
  viewMode,
  onDelete,
  onShare,
  deletingId,
  activeFilters,
  onFilterClick,
}: ChatSessionListProps) {
  const router = useRouter();

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-12 text-center">
        <MessageSquareText className="h-12 w-12 text-text-quaternary mx-auto mb-4" />
        <h3 className="text-lg font-medium text-text-primary mb-2">Chưa có cuộc hội thoại nào</h3>
        <p className="text-text-tertiary">Nhấn &ldquo;Cuộc hội thoại mới&rdquo; để bắt đầu.</p>
      </div>
    );
  }

  /* ── List (table) view ─────────────────────────────────────── */
  if (viewMode === 'list') {
    return (
      <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
        <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
          <thead className="bg-surface-2">
            <tr>
              <th className="px-6 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                Tiêu đề
              </th>
              <th className="px-6 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                Tin nhắn cuối
              </th>
              <th className="px-6 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                Tin nhắn
              </th>
              <th className="px-6 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                Hoạt động
              </th>
              <th className="px-6 py-3 text-right text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                Thao tác
              </th>
            </tr>
          </thead>
          <tbody className="bg-surface-1 divide-y divide-[rgb(var(--border-line))]">
            {sessions.map((s) => (
              <tr key={s.session_id} className="hover:bg-surface-2">
                <td className="px-6 py-4">
                  <button
                    type="button"
                    onClick={() => router.push(`/chat/${s.session_id}`)}
                    className="max-w-xs text-left"
                  >
                    <div className="truncate text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{s.title}</div>
                    {getDatasetLabel(s.context) && (
                      <FilterTag
                        className="mt-1"
                        tone="brand"
                        active={activeFilters?.dataset === String(s.context?.dataset_id ?? '')}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (s.context?.dataset_id) {
                            onFilterClick?.('dataset', String(s.context.dataset_id));
                          }
                        }}
                      >
                        {getDatasetLabel(s.context)}
                      </FilterTag>
                    )}
                  </button>
                </td>
                <td className="px-6 py-4">
                  <div className="max-w-sm truncate text-caption text-text-tertiary">
                    {s.last_message ?? <span className="italic text-text-quaternary">—</span>}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-caption text-text-tertiary">
                  {s.message_count}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-caption text-text-tertiary">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {timeAgo(s.last_active)}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-caption">
                  <div className="flex justify-end gap-1">
                    {onShare && (
                      <IconButton
                        aria-label="Share chat session"
                        variant="ghost"
                        size="xs"
                        onClick={() => onShare(s)}
                        className="text-brand hover:bg-brand/10"
                        title="Chia sẻ"
                      >
                        <Share2 className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                    <IconButton
                      aria-label="Delete chat session"
                      variant="ghost"
                      size="xs"
                      onClick={() => onDelete(s.session_id)}
                      disabled={deletingId === s.session_id}
                      className="text-danger hover:bg-danger/10"
                      title="Xóa"
                    >
                      {deletingId === s.session_id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  /* ── Grid (card) view ──────────────────────────────────────── */
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {sessions.map((s) => (
        <div
          key={s.session_id}
          onClick={() => router.push(`/chat/${s.session_id}`)}
          className="group flex cursor-pointer flex-col gap-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-5 transition-all hover:border-brand/50 hover:shadow-linear"
        >
          {/* Icon + title row */}
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0">
              <MessageSquareText className="h-4 w-4 text-brand" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-text-primary truncate leading-snug">{s.title}</p>
              {getDatasetLabel(s.context) && (
                <FilterTag
                  className="mt-1"
                  tone="brand"
                  active={activeFilters?.dataset === String(s.context?.dataset_id ?? '')}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (s.context?.dataset_id) {
                      onFilterClick?.('dataset', String(s.context.dataset_id));
                    }
                  }}
                >
                  {getDatasetLabel(s.context)}
                </FilterTag>
              )}
              <p className="text-xs text-text-quaternary mt-0.5 flex items-center gap-1">
                <Clock className="h-3 w-3" /> {timeAgo(s.last_active)}
              </p>
            </div>
          </div>

          {/* Last message preview */}
          {s.last_message ? (
            <p className="text-xs text-text-tertiary line-clamp-2 flex-1">{s.last_message}</p>
          ) : (
            <p className="text-xs italic text-text-quaternary flex-1">Chưa có tin nhắn</p>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-[rgb(var(--border-line))]">
            <span className="text-xs text-text-quaternary">{s.message_count} tin nhắn</span>
            <div className="flex items-center gap-1">
              {onShare && (
                <button
                  onClick={(e) => { e.stopPropagation(); onShare(s); }}
                  className="p-1 rounded text-text-quaternary hover:text-brand hover:bg-brand/15 opacity-0 group-hover:opacity-100 transition-all"
                  title="Chia sẻ"
                >
                  <Share2 className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(s.session_id); }}
                disabled={deletingId === s.session_id}
                className="p-1 rounded text-text-quaternary hover:text-danger hover:bg-danger/10 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50"
                title="Xóa"
              >
              {deletingId === s.session_id
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Trash2 className="h-4 w-4" />}
            </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
