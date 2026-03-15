'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, MessageSquareText, Plus, Trash2, Clock, Loader2 } from 'lucide-react';

const AI_HTTP_URL = (process.env.NEXT_PUBLIC_AI_WS_URL || 'ws://localhost:8001/chat/ws')
  .replace(/^ws/, 'http')
  .replace('/chat/ws', '');

interface SessionSummary {
  session_id: string;
  title: string;
  created_at: string;
  last_active: string;
  message_count: number;
  last_message: string | null;
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

export default function ChatListPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => { fetchSessions(); }, []);

  async function fetchSessions() {
    setLoading(true);
    try {
      const res = await fetch(`${AI_HTTP_URL}/chat/sessions`);
      if (res.ok) setSessions(await res.json());
    } catch { /* AI service offline — show empty state */ }
    finally { setLoading(false); }
  }

  async function handleNewChat() {
    setCreating(true);
    try {
      const res = await fetch(`${AI_HTTP_URL}/chat/sessions`, { method: 'POST' });
      if (!res.ok) throw new Error();
      const { session_id } = await res.json();
      router.push(`/chat/${session_id}`);
    } catch {
      // Fallback: navigate with a client-generated ID
      const id = crypto.randomUUID();
      router.push(`/chat/${id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setDeletingId(id);
    try {
      await fetch(`${AI_HTTP_URL}/chat/sessions/${id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.session_id !== id));
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
            <Bot className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">AI Chat</h1>
            <p className="text-sm text-gray-500">
              {loading ? 'Đang tải…' : `${sessions.length} cuộc hội thoại`}
            </p>
          </div>
        </div>
        <button
          onClick={handleNewChat}
          disabled={creating}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 text-sm font-medium"
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Cuộc hội thoại mới
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin mr-2" /> Đang tải…
        </div>
      )}

      {/* Empty state */}
      {!loading && sessions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center">
            <MessageSquareText className="h-8 w-8 text-gray-400" />
          </div>
          <div>
            <p className="text-base font-medium text-gray-700">Chưa có cuộc hội thoại nào</p>
            <p className="text-sm text-gray-500 mt-1">Nhấn &ldquo;Cuộc hội thoại mới&rdquo; để bắt đầu</p>
          </div>
        </div>
      )}

      {/* Session list */}
      {!loading && sessions.length > 0 && (
        <div className="space-y-2">
          {sessions.map(s => (
            <div
              key={s.session_id}
              onClick={() => router.push(`/chat/${s.session_id}`)}
              className="group flex items-start gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-sm cursor-pointer transition-all"
            >
              {/* Icon */}
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-100 to-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <MessageSquareText className="h-4 w-4 text-blue-500" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-900 truncate">{s.title}</p>
                  <span className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0">
                    <Clock className="h-3 w-3" />
                    {timeAgo(s.last_active)}
                  </span>
                </div>
                {s.last_message && (
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{s.last_message}</p>
                )}
                <p className="text-xs text-gray-400 mt-1">{s.message_count} tin nhắn</p>
              </div>

              {/* Delete button */}
              <button
                onClick={(e) => handleDelete(e, s.session_id)}
                disabled={deletingId === s.session_id}
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                title="Xóa cuộc hội thoại"
              >
                {deletingId === s.session_id
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Trash2 className="h-4 w-4" />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

