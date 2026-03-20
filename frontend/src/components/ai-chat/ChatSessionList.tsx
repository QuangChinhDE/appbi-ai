'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquareText, Trash2, Clock, Loader2, ExternalLink, Share2 } from 'lucide-react';
import type { ViewMode } from '@/components/common/PageListLayout';

export interface SessionSummary {
  session_id: string;
  title: string;
  created_at: string;
  last_active: string;
  message_count: number;
  last_message: string | null;
}

interface ChatSessionListProps {
  sessions: SessionSummary[];
  viewMode: ViewMode;
  onDelete: (id: string) => void;
  onShare?: (session: SessionSummary) => void;
  deletingId: string | null;
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

export function ChatSessionList({ sessions, viewMode, onDelete, onShare, deletingId }: ChatSessionListProps) {
  const router = useRouter();

  if (sessions.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
        <MessageSquareText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">Chưa có cuộc hội thoại nào</h3>
        <p className="text-gray-500">Nhấn &ldquo;Cuộc hội thoại mới&rdquo; để bắt đầu.</p>
      </div>
    );
  }

  /* ── List (table) view ─────────────────────────────────────── */
  if (viewMode === 'list') {
    return (
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tiêu đề
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tin nhắn cuối
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tin nhắn
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Hoạt động
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Thao tác
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sessions.map((s) => (
              <tr key={s.session_id} className="hover:bg-gray-50">
                <td className="px-6 py-4">
                  <div className="text-sm font-medium text-gray-900 max-w-xs truncate">{s.title}</div>
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm text-gray-500 max-w-sm truncate">
                    {s.last_message ?? <span className="italic text-gray-400">—</span>}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {s.message_count}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {timeAgo(s.last_active)}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => router.push(`/chat/${s.session_id}`)}
                      className="text-blue-600 hover:text-blue-900"
                      title="Mở cuộc hội thoại"
                    >
                      <ExternalLink className="h-5 w-5" />
                    </button>
                    {onShare && (
                      <button
                        onClick={() => onShare(s)}
                        className="text-purple-600 hover:text-purple-900"
                        title="Chia sẻ"
                      >
                        <Share2 className="h-5 w-5" />
                      </button>
                    )}
                    <button
                      onClick={() => onDelete(s.session_id)}
                      disabled={deletingId === s.session_id}
                      className="text-red-600 hover:text-red-900 disabled:opacity-50"
                      title="Xóa"
                    >
                      {deletingId === s.session_id
                        ? <Loader2 className="h-5 w-5 animate-spin" />
                        : <Trash2 className="h-5 w-5" />}
                    </button>
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
          className="group bg-white rounded-lg border border-gray-200 p-5 hover:border-blue-400 hover:shadow-md cursor-pointer transition-all flex flex-col gap-3"
        >
          {/* Icon + title row */}
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-100 to-blue-100 flex items-center justify-center flex-shrink-0">
              <MessageSquareText className="h-4 w-4 text-blue-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate leading-snug">{s.title}</p>
              <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                <Clock className="h-3 w-3" /> {timeAgo(s.last_active)}
              </p>
            </div>
          </div>

          {/* Last message preview */}
          {s.last_message ? (
            <p className="text-xs text-gray-500 line-clamp-2 flex-1">{s.last_message}</p>
          ) : (
            <p className="text-xs italic text-gray-400 flex-1">Chưa có tin nhắn</p>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-400">{s.message_count} tin nhắn</span>
            <div className="flex items-center gap-1">
              {onShare && (
                <button
                  onClick={(e) => { e.stopPropagation(); onShare(s); }}
                  className="p-1 rounded text-gray-400 hover:text-purple-500 hover:bg-purple-50 opacity-0 group-hover:opacity-100 transition-all"
                  title="Chia sẻ"
                >
                  <Share2 className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(s.session_id); }}
                disabled={deletingId === s.session_id}
                className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50"
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
