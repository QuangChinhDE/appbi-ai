'use client';

/**
 * The assistants you may talk to — a module landing page, not a chat sidebar.
 *
 * WHY THIS SCREEN EXISTS AT ALL
 * -----------------------------
 * The first version dropped the reader straight into a two-pane chat shell, with
 * the assistants as plain text rows in a narrow column. It "worked" — clicking a
 * row did change the URL — and it was still wrong twice over. A row with no card,
 * no border and no chevron does not read as something you pick, and selecting one
 * changed almost nothing on screen, so the honest reaction was "I can't select
 * anything". And a module that invents its own landing is a module users have to
 * learn twice: every other catalogue here (Datasets, Dashboards, Agent Flows) is
 * `PageListLayout` + a stats strip + a card grid, with a title and a sentence
 * saying what the screen is for.
 *
 * So this is that same screen, with the same primitives and the same class names.
 * The conversation is what comes AFTER choosing, on its own screen.
 */
import { Bot, FileText, MessageSquare, MessagesSquare, Plus, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import React from 'react';

import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/providers/LanguageProvider';
import type { ChatBrain, ChatThread } from '@/lib/directChat';

import { formatWhen } from '@/components/agent-flows/shared';

export function AssistantCatalogue({
  brains, threads, loading, canBuild, onOpen,
}: {
  brains: ChatBrain[];
  threads: ChatThread[];
  loading: boolean;
  canBuild: boolean;
  onOpen: (brainKey: string) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = React.useState('');

  const countFor = React.useCallback(
    (key: string) => threads.filter((x) => x.brain_key === key).length,
    [threads],
  );

  /** The list arrives newest-first from the server, so the first match is it. */
  const lastUsedFor = React.useCallback(
    (key: string) => threads.find((x) => x.brain_key === key)?.last_active_at || null,
    [threads],
  );

  const shown = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return brains;
    return brains.filter(
      (b) => b.name.toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q),
    );
  }, [brains, search]);

  const totalSources = brains.reduce((n, b) => n + (b.knowledge_count || 0), 0);

  return (
    <PageListLayout
      title={t('chat.title')}
      description={t('chat.description')}
      overview={(
        <ModuleOverview
          icon={MessagesSquare}
          title={t('chat.overviewTitle')}
          stats={[
            { label: t('chat.stat.assistants'), value: brains.length, helper: t('chat.stat.assistantsHelper') },
            { label: t('chat.stat.conversations'), value: threads.length, helper: t('chat.stat.conversationsHelper') },
            { label: t('chat.stat.knowledge'), value: totalSources },
          ]}
          storageKey="ai-chat-overview"
        />
      )}
      isLoading={loading}
      searchPlaceholder={t('chat.searchPlaceholder')}
      searchValue={search}
      onSearchValueChange={setSearch}
      // List first, with the grid a toggle away — the same default every other
      // catalogue in the product uses. A grid-only screen with the toggle removed
      // was the one place a reader had to learn a second way of reading a list.
      defaultView="list"
    >
      {({ viewMode }) => {
        if (!brains.length) {
          return (
            <EmptyState
              icon={<Bot className="h-6 w-6" />}
              title={t('chat.empty.title')}
              description={t('chat.empty.description')}
              action={canBuild ? (
                <Link href="/agent-flows">
                  <Button size="sm" variant="secondary" leadingIcon={<Plus className="h-3.5 w-3.5" />}>
                    {t('chat.empty.goToStudio')}
                  </Button>
                </Link>
              ) : undefined}
            />
          );
        }
        if (!shown.length) {
          return (
            <EmptyState
              icon={<Bot className="h-6 w-6" />}
              title={t('chat.noMatch.title')}
              description={t('chat.noMatch.description')}
              action={(
                <Button size="sm" variant="secondary" onClick={() => setSearch('')}>
                  {t('chat.clearSearch')}
                </Button>
              )}
            />
          );
        }
        return (
          <PaginatedCollection
            items={shown}
            viewMode={viewMode}
            resetKey={`${search}|${viewMode}`}
          >
            {({ pageItems, pagination, hasFooter }) => (
              <div className={viewMode === 'grid' ? 'space-y-3' : undefined}>
                {viewMode === 'grid' ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {pageItems.map((b) => (
                      <AssistantCard
                        key={b.brain_key}
                        brain={b}
                        conversations={countFor(b.brain_key)}
                        onOpen={() => onOpen(b.brain_key)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={`border border-[rgb(var(--border-line))] bg-surface-1 ${hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl'}`}>
                    <div className="app-list-table-wrap">
                      <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                        <thead className="bg-surface-2">
                          <tr>
                            <th className="app-list-header w-[46%]">{t('chat.header.assistant')}</th>
                            <th className="app-list-header w-[12%]">{t('chat.header.sources')}</th>
                            <th className="app-list-header w-[16%]">{t('chat.header.conversations')}</th>
                            <th className="app-list-header w-[18%]">{t('chat.header.lastUsed')}</th>
                            <th className="app-list-header w-[92px] text-right">{t('chat.header.actions')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                          {pageItems.map((b) => (
                            <AssistantRow
                              key={b.brain_key}
                              brain={b}
                              conversations={countFor(b.brain_key)}
                              lastUsed={lastUsedFor(b.brain_key)}
                              onOpen={() => onOpen(b.brain_key)}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {pagination}
              </div>
            )}
          </PaginatedCollection>
        );
      }}
    </PageListLayout>
  );
}

function AssistantRow({
  brain, conversations, lastUsed, onOpen,
}: {
  brain: ChatBrain;
  conversations: number;
  lastUsed: string | null;
  onOpen: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <tr className="hover:bg-surface-2">
      <td className="app-list-cell">
        <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 text-left">
          <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
            <Bot className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">
              {brain.name}
            </span>
            <span className="app-list-text-sub mt-0.5 block text-tiny text-text-tertiary">
              {brain.description || t('chat.card.noDescription')}
            </span>
          </span>
        </button>
      </td>
      <td className="app-list-cell text-caption text-text-secondary">{brain.knowledge_count}</td>
      <td className="app-list-cell text-caption text-text-secondary">
        {conversations || <span className="text-text-quaternary">—</span>}
      </td>
      <td className="app-list-cell text-tiny text-text-tertiary">
        {formatWhen(lastUsed, locale === 'vi' ? 'vi-VN' : 'en-US')}
      </td>
      <td className="app-list-cell text-right">
        <Button size="sm" variant="secondary" onClick={onOpen}>{t('chat.open')}</Button>
      </td>
    </tr>
  );
}

function AssistantCard({
  brain, conversations, onOpen,
}: {
  brain: ChatBrain;
  conversations: number;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="group rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-[box-shadow,border-color] hover:border-[rgb(var(--border-strong))] hover:shadow-linear">
      <button type="button" onClick={onOpen} className="w-full p-4 text-left">
        <div className="mb-2.5 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Bot className="h-4 w-4" />
            </span>
            <span className="block min-w-0 truncate text-small font-strong text-text-primary transition-colors group-hover:text-brand">
              {brain.name}
            </span>
          </div>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-text-quaternary transition-colors group-hover:text-brand" />
        </div>

        <p className="mb-3 line-clamp-2 min-h-[2.25rem] text-caption leading-relaxed text-text-secondary">
          {brain.description || (
            <span className="text-text-quaternary">{t('chat.card.noDescription')}</span>
          )}
        </p>

        <div className="flex flex-wrap items-center gap-3 text-tiny text-text-quaternary">
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {t('chat.card.sources', { n: brain.knowledge_count })}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {conversations
              ? t('chat.card.conversations', { n: conversations })
              : t('chat.card.noConversation')}
          </span>
        </div>
      </button>
    </div>
  );
}
