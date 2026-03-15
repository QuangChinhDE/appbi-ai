'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquareText, Plus, Search } from 'lucide-react';
import { PageListLayout } from '@/components/common/PageListLayout';
import { ChatSessionList } from '@/components/ai-chat/ChatSessionList';
import type { SessionSummary } from '@/components/ai-chat/ChatSessionList';

const AI_HTTP_URL = (process.env.NEXT_PUBLIC_AI_WS_URL || 'ws://localhost:8001/chat/ws')
  .replace(/^ws/, 'http')
  .replace('/chat/ws', '');

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
    } catch { /* AI service offline */ }
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
      router.push(`/chat/${crypto.randomUUID()}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await fetch(`${AI_HTTP_URL}/chat/sessions/${id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.session_id !== id));
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  }

  return (
    <PageListLayout
      title="AI Chat"
      description={`${sessions.length} cuộc hội thoại`}
      action={
        <button
          onClick={handleNewChat}
          disabled={creating}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Cuộc hội thoại mới
        </button>
      }
      isLoading={loading}
      loadingText="Đang tải danh sách hội thoại…"
      searchPlaceholder="Tìm theo tiêu đề…"
      defaultView="grid"
    >
      {({ viewMode, filterText }) => {
        const filtered = sessions.filter(s =>
          s.title.toLowerCase().includes(filterText.toLowerCase()) ||
          (s.last_message ?? '').toLowerCase().includes(filterText.toLowerCase())
        );

        if (!loading && sessions.length === 0) {
          return (
            <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
              <MessageSquareText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Chưa có cuộc hội thoại nào</h3>
              <p className="text-gray-500">Nhấn &ldquo;Cuộc hội thoại mới&rdquo; để bắt đầu.</p>
            </div>
          );
        }

        if (filtered.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <Search className="w-8 h-8 text-gray-300 mb-2" />
              <p className="text-sm text-gray-500">
                Không có kết quả cho &ldquo;<strong>{filterText}</strong>&rdquo;
              </p>
            </div>
          );
        }

        return (
          <ChatSessionList
            sessions={filtered}
            viewMode={viewMode}
            onDelete={handleDelete}
            deletingId={deletingId}
          />
        );
      }}
    </PageListLayout>
  );
}
