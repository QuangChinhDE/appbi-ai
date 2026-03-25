'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquareText, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';

import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { ShareDialog } from '@/components/common/ShareDialog';
import { ChatSessionList } from '@/components/ai-chat/ChatSessionList';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { AI_CHAT_HTTP_URL } from '@/lib/ai-services';
import type { SessionSummary } from '@/components/ai-chat/ChatSessionList';

export default function ChatListPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shareSession, setShareSession] = useState<SessionSummary | null>(null);
  const [authToken, setAuthToken] = useState<string>('');
  const [chatServiceAvailable, setChatServiceAvailable] = useState<boolean | null>(null);
  const { data: permData } = usePermissions();
  const canShare = hasPermission(permData?.permissions, 'ai_chat', 'edit');
  const activeToday = sessions.filter((session) => {
    const lastActive = new Date(session.last_active).getTime();
    return Number.isFinite(lastActive) && Date.now() - lastActive <= 24 * 60 * 60 * 1000;
  }).length;

  useEffect(() => {
    fetch('/api/auth/token')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.token) {
          setAuthToken(data.token);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (authToken) {
      fetchSessions();
    }
  }, [authToken]);

  function authHeaders(): Record<string, string> {
    return authToken ? { Authorization: `Bearer ${authToken}` } : {};
  }

  async function fetchSessions() {
    setLoading(true);
    try {
      const response = await fetch(`${AI_CHAT_HTTP_URL}/chat/sessions`, { headers: authHeaders() });
      if (response.ok) {
        setSessions(await response.json());
        setChatServiceAvailable(true);
      } else {
        setChatServiceAvailable(false);
      }
    } catch {
      setChatServiceAvailable(false);
    } finally {
      setLoading(false);
    }
  }

  async function handleNewChat() {
    if (chatServiceAvailable === false) {
      toast.error('AI Chat service is offline. Start ai-chat-service to use chat.');
      return;
    }

    setCreating(true);
    try {
      const response = await fetch(`${AI_CHAT_HTTP_URL}/chat/sessions`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error();
      const { session_id } = await response.json();
      router.push(`/chat/${session_id}`);
    } catch {
      toast.error('AI Chat service is offline. Start ai-chat-service to create a new chat.');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await fetch(`${AI_CHAT_HTTP_URL}/chat/sessions/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      setSessions((prev) => prev.filter((session) => session.session_id !== id));
    } catch {
      // ignore delete failure when service is unavailable
    } finally {
      setDeletingId(null);
    }
  }

  function ServiceWarning() {
    if (chatServiceAvailable !== false) return null;

    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        AI Chat service is offline. Start `ai-chat-service` if you want to use the chat module. AI Reports can still run separately.
      </div>
    );
  }

  return (
    <>
      <PageListLayout
        title="AI Chat"
        description={`${sessions.length} conversation${sessions.length !== 1 ? 's' : ''}`}
        overview={(
          <ModuleOverview
            icon={MessageSquareText}
            title="Keep conversational analysis separate from saved reports and dashboards"
            description="AI Chat is the fast back-and-forth workspace for ad hoc questions, follow-up prompts, and shared discussions. Use it when you want exploration in conversation form instead of a persisted report workflow."
            badges={['Ad hoc analysis', 'Conversations', 'Shareable sessions']}
            stats={[
              {
                label: 'Conversations',
                value: sessions.length,
                helper: 'Saved chat threads currently available to reopen',
              },
              {
                label: 'Active 24h',
                value: activeToday,
                helper: 'Sessions with activity in the last 24 hours',
              },
              {
                label: 'Service status',
                value:
                  chatServiceAvailable === false ? (
                    <span className="inline-flex rounded-full bg-rose-50 px-3 py-1 text-sm font-semibold text-rose-700">
                      Offline
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">
                      Online
                    </span>
                  ),
                helper: 'Live availability of the AI Chat backend service',
              },
            ]}
          />
        )}
        action={
          <button
            onClick={handleNewChat}
            disabled={creating || chatServiceAvailable === false}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            New Conversation
          </button>
        }
        isLoading={loading}
        loadingText="Loading conversations..."
        searchPlaceholder="Search conversations..."
        defaultView="grid"
      >
        {({ viewMode, filterText }) => {
          const filtered = sessions.filter(
            (session) =>
              session.title.toLowerCase().includes(filterText.toLowerCase()) ||
              (session.last_message ?? '').toLowerCase().includes(filterText.toLowerCase()),
          );

          if (!loading && sessions.length === 0) {
            return (
              <div className="space-y-4">
                <ServiceWarning />
                <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
                  <MessageSquareText className="mx-auto mb-4 h-12 w-12 text-gray-400" />
                  <h3 className="mb-2 text-lg font-medium text-gray-900">No conversations yet</h3>
                  <p className="text-gray-500">Start a new chat when the AI Chat service is running.</p>
                </div>
              </div>
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="space-y-4">
                <ServiceWarning />
                <div className="flex h-48 flex-col items-center justify-center text-center">
                  <Search className="mb-2 h-8 w-8 text-gray-300" />
                  <p className="text-sm text-gray-500">
                    No results for &ldquo;<strong>{filterText}</strong>&rdquo;
                  </p>
                </div>
              </div>
            );
          }

          return (
            <div className="space-y-4">
              <ServiceWarning />
              <ChatSessionList
                sessions={filtered}
                viewMode={viewMode}
                onDelete={handleDelete}
                onShare={canShare ? (session) => setShareSession(session) : undefined}
                deletingId={deletingId}
              />
            </div>
          );
        }}
      </PageListLayout>

      {shareSession && (
        <ShareDialog
          resourceType="chat_session"
          resourceId={shareSession.session_id}
          resourceName={shareSession.title}
          onClose={() => setShareSession(null)}
        />
      )}
    </>
  );
}
