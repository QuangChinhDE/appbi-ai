'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquareText, Plus, Search } from 'lucide-react';
import { toast } from '@/lib/toast';

import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { ShareDialog } from '@/components/common/ShareDialog';
import { CreateScopedChatModal } from '@/components/ai-chat/CreateScopedChatModal';
import { ChatSessionList } from '@/components/ai-chat/ChatSessionList';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterTag } from '@/components/ui/FilterTag';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getAiChatHttpUrl } from '@/lib/ai-services';
import { useI18n } from '@/providers/LanguageProvider';
import type { SessionSummary } from '@/components/ai-chat/ChatSessionList';

export default function ChatListPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shareSession, setShareSession] = useState<SessionSummary | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [authToken, setAuthToken] = useState<string>('');
  const [chatServiceAvailable, setChatServiceAvailable] = useState<boolean | null>(null);
  const [listFilters, setListFilters] = useState<{ dataset?: string }>({});
  const { data: permData } = usePermissions();
  const canShare = hasPermission(permData?.permissions, 'ai_chat', 'edit');
  const activeToday = sessions.filter((session) => {
    const lastActive = new Date(session.last_active).getTime();
    return Number.isFinite(lastActive) && Date.now() - lastActive <= 24 * 60 * 60 * 1000;
  }).length;

  const clearListFilters = () => setListFilters({});

  useEffect(() => {
    fetch('/api/auth/token')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.token) setAuthToken(data.token);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (authToken) fetchSessions();
  }, [authToken]);

  function authHeaders(): Record<string, string> {
    return authToken ? { Authorization: `Bearer ${authToken}` } : {};
  }

  async function fetchSessions() {
    setLoading(true);
    try {
      const response = await fetch(`${getAiChatHttpUrl()}/chat/sessions`, { headers: authHeaders() });
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
    if (!authToken) {
      toast.error('Authentication is still loading. Please try again in a moment.');
      return;
    }
    if (chatServiceAvailable === false) {
      toast.error('AI Chat service is offline. Start ai-chat-service to use chat.');
      return;
    }
    setIsCreateModalOpen(true);
  }

  async function handleCreateScopedChat(dataset: { id: number; name: string }) {
    setCreating(true);
    try {
      const response = await fetch(`${getAiChatHttpUrl()}/chat/sessions`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            dataset_id: dataset.id,
            dataset_name: dataset.name,
            active_resource: {
              type: 'dataset',
              id: dataset.id,
              name: dataset.name,
              dataset_id: dataset.id,
              dataset_name: dataset.name,
            },
          },
        }),
      });
      if (!response.ok) throw new Error();
      const { session_id } = await response.json();
      setIsCreateModalOpen(false);
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
      await fetch(`${getAiChatHttpUrl()}/chat/sessions/${id}`, {
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
      <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
        AI Chat service is offline. Start `ai-chat-service` if you want to use the chat module. AI Reports can still run separately.
      </div>
    );
  }

  return (
    <>
      <PageListLayout
        title={t('module.chat.title')}
        description={`${sessions.length} conversation${sessions.length !== 1 ? 's' : ''}`}
        overview={(
          <ModuleOverview
            icon={MessageSquareText}
            title={t('overview.chat.title')}
            description={t('overview.chat.description')}
            badges={[t('overview.chat.badge1'), t('overview.chat.badge2'), t('overview.chat.badge3')]}
            stats={[
              { label: t('overview.chat.conversations'), value: sessions.length, helper: t('overview.chat.conversationsHelper') },
              { label: t('overview.chat.active'), value: activeToday, helper: t('overview.chat.activeHelper') },
              {
                label: t('overview.chat.service'),
                value:
                  chatServiceAvailable === false ? (
                    <Badge variant="danger" size="sm">{t('overview.chat.offline')}</Badge>
                  ) : (
                    <Badge variant="success" size="sm" dot>{t('overview.chat.online')}</Badge>
                  ),
                helper: t('overview.chat.serviceHelper'),
              },
            ]}
          />
        )}
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={handleNewChat}
            disabled={creating || chatServiceAvailable === false || !authToken}
            loading={creating}
            leadingIcon={creating ? undefined : <Plus className="h-3.5 w-3.5" />}
          >
            {t('action.newChat')}
          </Button>
        }
        isLoading={loading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="list"
        activeFilters={listFilters.dataset ? (
          <>
            <FilterTag tone="brand" active onClick={clearListFilters}>
              Dataset #{listFilters.dataset}
            </FilterTag>
            <Button variant="ghost" size="xs" onClick={clearListFilters}>
              Clear filters
            </Button>
          </>
        ) : null}
      >
        {({ viewMode, filterText }) => {
          const filtered = sessions.filter(
            (session) => {
              const matchesSearch =
                session.title.toLowerCase().includes(filterText.toLowerCase()) ||
                (session.last_message ?? '').toLowerCase().includes(filterText.toLowerCase()) ||
                (session.context?.dataset_name ?? '').toLowerCase().includes(filterText.toLowerCase());

              return (
                matchesSearch &&
                (!listFilters.dataset || String(session.context?.dataset_id ?? '') === listFilters.dataset)
              );
            },
          );

          if (!loading && sessions.length === 0) {
            return (
              <div className="space-y-3">
                <ServiceWarning />
                <EmptyState
                  icon={<MessageSquareText />}
                  title="No conversations yet"
                  description="Start a new chat when the AI Chat service is running."
                />
              </div>
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="space-y-3">
                <ServiceWarning />
                <div className="flex h-48 flex-col items-center justify-center text-center">
                  <Search className="mb-2 h-7 w-7 text-text-quaternary" />
                  <p className="text-caption text-text-tertiary">
                    No results for &ldquo;<strong className="text-text-primary">{filterText}</strong>&rdquo;
                  </p>
                </div>
              </div>
            );
          }

          return (
            <div className="space-y-3">
              <ServiceWarning />
              <ChatSessionList
                sessions={filtered}
                viewMode={viewMode}
                onDelete={handleDelete}
                onShare={canShare ? (session) => setShareSession(session) : undefined}
                deletingId={deletingId}
                activeFilters={listFilters}
                onFilterClick={(key, value) => {
                  if (key === 'dataset') {
                    setListFilters((current) => ({
                      ...current,
                      dataset: current.dataset === value ? undefined : value,
                    }));
                  }
                }}
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

      {isCreateModalOpen && (
        <CreateScopedChatModal
          isOpen={isCreateModalOpen}
          creating={creating}
          onClose={() => setIsCreateModalOpen(false)}
          onCreate={handleCreateScopedChat}
        />
      )}
    </>
  );
}
