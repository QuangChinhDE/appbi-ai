'use client';

/**
 * One assistant, its conversations, and the turn being typed.
 *
 * THE FIRST MESSAGE CREATES THE THREAD. Picking an assistant used to land on an
 * empty dashed box with a "New conversation" button — a click that produced
 * nothing a reader could see and a row in the database whether or not they ever
 * asked anything. Now the composer is live the moment an assistant is open, and
 * the thread is created by the act of sending. Nothing is stored for someone who
 * changed their mind.
 */
import {
  ArrowLeft, Bot, Check, FileText, Loader2, MessageSquarePlus, Pencil, Send, Share2, Trash2, X,
} from 'lucide-react';
import React from 'react';

import { ShareDialog } from '@/components/common/ShareDialog';
import { ChartNamesContext, RichMarkdown, extractFollowups } from '@/components/common/AiAnswer';
import { CitationCards } from '@/components/common/CitationCards';
import { AnswerBlocks } from '@/components/dashboards/AnswerBlocks';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import type { ChatBrain, ChatMessage, ChatThread, ChatThreadDetail } from '@/lib/directChat';
import { readerNotices } from '@/lib/notices';

const EMPTY_CHART_NAMES = new Map<number, string>();

/** Notices worth showing a reader. The rest are for the Runs tab — a reader does
 *  not need to be told which branch of a flow did not match. */
const NOTICE_KEYS: Record<string, string> = {
  memory_reset: 'chat.notice.memoryReset',
  memory_expired: 'chat.notice.memoryExpired',
  budget_exhausted: 'chat.notice.budget',
  turn_abandoned: 'chat.notice.abandoned',
  answer_incomplete: 'chat.notice.incomplete',
  citations_invented: 'chat.notice.citationsInvented',
  citations_unsupported: 'chat.notice.citationsUnsupported',
  charts_unreadable: 'chat.notice.unreadable',
  partial_rows: 'chat.notice.partialRows',
  read_truncated: 'chat.notice.truncated',
  web_disabled: 'chat.notice.webOff',
};

export function ConversationView({
  brain, threads, detail, threadId, messages, loadingThread, streaming, status,
  input, onInputChange, onSend, onStop, onBack, onNewThread, onOpenThread,
  onRename, onDelete,
}: {
  brain: ChatBrain | null;
  threads: ChatThread[];
  detail: ChatThreadDetail | null;
  threadId: number;
  messages: ChatMessage[];
  loadingThread: boolean;
  streaming: boolean;
  status: string;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onBack: () => void;
  onNewThread: () => void;
  onOpenThread: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (thread: ChatThread) => void;
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = React.useState<number | null>(null);
  const [renameText, setRenameText] = React.useState('');
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, status]);

  const readonly = Boolean(detail?.readonly_reason);
  const [sharing, setSharing] = React.useState(false);
  //: Somebody else's conversation, open because they shared it (or because this
  //: account holds `chat: full`). Worth saying out loud: without it a reader can
  //: mistake a colleague's transcript for their own and wonder why it cannot be
  //: renamed.
  const notMine = detail != null && detail.access !== 'owner';

  return (
    <div className="flex h-full min-h-0">
      {/* ── This assistant's conversations ── */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-[rgb(var(--border-line))] bg-surface-1 lg:flex">
        <div className="border-b border-[rgb(var(--border-line))] px-3 py-2.5">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-tiny text-text-tertiary transition-colors hover:text-text-secondary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('chat.backToList')}
          </button>
        </div>

        <div className="px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Bot className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-caption font-strong text-text-primary">
                {brain?.name || detail?.brain_name || ''}
              </span>
              {brain ? (
                <span className="flex items-center gap-1 text-tiny text-text-quaternary">
                  <FileText className="h-3 w-3" />
                  {t('chat.card.sources', { n: brain.knowledge_count })}
                </span>
              ) : null}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="mt-3 w-full"
            leadingIcon={<MessageSquarePlus className="h-3.5 w-3.5" />}
            onClick={onNewThread}
          >
            {t('chat.newConversation')}
          </Button>
        </div>

        <p className="px-3 pb-1 text-micro uppercase tracking-wide text-text-quaternary">
          {t('chat.conversations')}
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {threads.map((th) => (
            <div
              key={th.id}
              className={cn(
                'group flex items-center gap-1 rounded px-2 py-1.5',
                th.id === threadId ? 'bg-surface-3' : 'hover:bg-surface-2',
              )}
            >
              {renaming === th.id ? (
                <>
                  <Input
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    className="h-7 text-xs"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { onRename(th.id, renameText.trim()); setRenaming(null); }
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                  <IconButton
                    aria-label={t('chat.save')}
                    onClick={() => { onRename(th.id, renameText.trim()); setRenaming(null); }}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton aria-label={t('chat.cancel')} onClick={() => setRenaming(null)}>
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onOpenThread(th.id)}
                    className="min-w-0 flex-1 truncate text-left text-caption text-text-secondary"
                    title={th.title || t('chat.untitled')}
                  >
                    {th.title || t('chat.untitled')}
                  </button>
                  <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                    <IconButton
                      aria-label={t('chat.rename')}
                      onClick={() => { setRenaming(th.id); setRenameText(th.title || ''); }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton aria-label={t('chat.delete')} onClick={() => onDelete(th)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* ── The conversation ── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-3">
          <IconButton aria-label={t('chat.backToList')} className="lg:hidden" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
          <div className="min-w-0">
            {/* The thread LIST is the one source of truth for a title: the server
                names a conversation from its first question, and that name reaches
                this screen through the refreshed list. Reading it off `detail`
                alone left the header saying "New conversation" under a sidebar row
                that already showed the real name. The assistant's name is the line
                below, so it is not a fallback here — that printed it twice. */}
            <p className="truncate text-small font-strong text-text-primary">
              {threads.find((x) => x.id === threadId)?.title
                || detail?.title
                || t('chat.untitled')}
            </p>
            <p className="truncate text-tiny text-text-tertiary">
              {brain?.name || detail?.brain_name || ''}
            </p>
          </div>

          {/* SHARING A CONVERSATION IS NOT SHARING THE ASSISTANT.
              This hands somebody THIS transcript. Whether they can then ask a
              question in it is still decided by the flow's own share — which is
              why a recipient can end up reading happily and seeing the input box
              disabled, with the server's own sentence explaining it.

              Owner only: `access` comes from the server, so the button and the
              endpoint cannot disagree about who may share. */}
          {detail?.access === 'owner' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSharing(true)}
              aria-label={t('chat.share')}
            >
              <Share2 className="h-3.5 w-3.5" /> {t('chat.share')}
            </Button>
          )}
        </header>

        {sharing && detail && (
          <ShareDialog
            resourceType="chat_thread"
            resourceId={detail.id}
            resourceName={detail.title || t('chat.untitled')}
            notice={
              <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3 text-caption leading-relaxed text-text-tertiary">
                {t('chat.shareNotice')}
              </p>
            }
            onClose={() => setSharing(false)}
          />
        )}

        {notMine ? (
          <div className="border-b border-[rgb(var(--border-line))] bg-surface-2 px-4 py-2 text-caption text-text-tertiary">
            {detail?.access === 'full' ? t('chat.viewingAsAdmin') : t('chat.sharedWithYou')}
          </div>
        ) : null}

        {readonly ? (
          <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-caption text-warning">
            {detail?.readonly_message || t('chat.readonlyFallback')}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loadingThread ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
            </div>
          ) : (
            <ChartNamesContext.Provider value={EMPTY_CHART_NAMES}>
              <div className="mx-auto max-w-3xl space-y-4">
                {!messages.length && brain ? (
                  <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5">
                    <div className="mb-2 flex items-center gap-2.5">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                        <Bot className="h-4 w-4" />
                      </span>
                      <span className="text-small font-strong text-text-primary">{brain.name}</span>
                    </div>
                    {brain.description ? (
                      <p className="mb-2 text-caption leading-relaxed text-text-secondary">
                        {brain.description}
                      </p>
                    ) : null}
                    <p className="text-caption text-text-tertiary">{t('chat.welcome.hint')}</p>

                    {/* BEFORE THE FIRST QUESTION, not after it comes back
                        unanswered. An assistant with no anomaly tool should say
                        so here rather than let a reader spend a turn finding
                        out. Absent capability degrades to the line above; it is
                        never rendered as "can answer nothing". */}
                    {brain.capability?.can?.length ? (
                      <div className="mt-3">
                        <p className="text-tiny font-strong uppercase tracking-wider text-text-quaternary">
                          {t('chat.welcome.canTitle')}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {brain.capability.can.map((c) => (
                            <span key={c.key}
                              className="rounded-md bg-surface-2 px-1.5 py-0.5 text-tiny text-text-secondary">
                              {c.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {brain.capability?.cannot?.length ? (
                      <div className="mt-3">
                        <p className="text-tiny font-strong uppercase tracking-wider text-text-quaternary">
                          {t('chat.welcome.cannotTitle')}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {brain.capability.cannot.map((c) => (
                            <span key={c.key}
                              className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-1.5 py-0.5 text-tiny text-text-quaternary">
                              {c.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {/* Derived from `can`, never authored, so a suggestion can
                        never propose something the assistant cannot do. */}
                    {!readonly && brain.capability?.suggested_questions?.length ? (
                      <div className="mt-3.5 flex flex-wrap gap-1.5">
                        {brain.capability.suggested_questions.map((q) => (
                          // FILLS THE BOX, does not send. `onSend` takes no
                          // argument, and handing it one is exactly the defect
                          // `qa:handler-arity` exists to catch. It also reads
                          // better: a suggestion the reader can edit before
                          // asking is a prompt, not a decision made for them.
                          <button key={q} type="button"
                            onClick={() => {
                              onInputChange(q);
                              // FOCUS FOLLOWS, or the reader has to click twice:
                              // once to choose the question and once to reach the
                              // box they were just handed.
                              document.querySelector<HTMLTextAreaElement>(
                                '[data-chat-input]')?.focus();
                            }}
                            className="rounded-full border border-[rgb(var(--border-line))] px-2.5 py-1 text-tiny text-text-secondary transition hover:border-brand/40 hover:text-brand">
                            {q}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    <p className="mt-3 flex items-center gap-1 text-tiny text-text-quaternary">
                      <FileText className="h-3 w-3" />
                      {t('chat.welcome.sources', { n: brain.knowledge_count })}
                    </p>
                  </div>
                ) : null}

                {messages.map((m, i) => <Bubble key={i} message={m} />)}

                {streaming && status ? (
                  <p className="flex items-center gap-2 text-caption text-text-tertiary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {status}
                  </p>
                ) : null}
                <div ref={endRef} />
              </div>
            </ChartNamesContext.Provider>
          )}
        </div>

        <div className="border-t border-[rgb(var(--border-line))] p-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
              }}
              disabled={readonly || streaming}
              rows={1}
              data-chat-input
              placeholder={readonly ? t('chat.placeholderReadonly') : t('chat.placeholder')}
              className={cn(
                'min-h-[42px] max-h-40 flex-1 resize-y rounded-lg border border-[rgb(var(--border-line))]',
                'bg-surface-1 px-3 py-2.5 text-small text-text-primary outline-none',
                'placeholder:text-text-quaternary focus:border-[rgb(var(--border-strong))]',
                'disabled:opacity-60',
              )}
            />
            {streaming ? (
              <Button variant="secondary" onClick={onStop}>{t('chat.stop')}</Button>
            ) : (
              <Button onClick={onSend} disabled={readonly || !input.trim()} aria-label={t('chat.send')}>
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const { t } = useI18n();

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-surface-3 px-3 py-2 text-small text-text-primary">
          {message.content}
        </div>
      </div>
    );
  }

  const { body } = extractFollowups(message.content || '');
  // READER SURFACE. The server already drops author diagnostics at its own
  // boundary; refusing them here too means neither layer is trusted alone.
  const notices = readerNotices(message.notices).filter((n) => NOTICE_KEYS[n.code] || n.text);

  return (
    <div className="space-y-2">
      {notices.length ? (
        <div className="space-y-1">
          {notices.map((n, i) => (
            <p key={i} className="text-caption text-text-tertiary">
              ⓘ {NOTICE_KEYS[n.code] ? t(NOTICE_KEYS[n.code]) : n.text}
            </p>
          ))}
        </div>
      ) : null}

      <div className="text-small text-text-primary">
        {message.blocks?.length ? (
          <AnswerBlocks blocks={message.blocks} renderMarkdown={(md) => <RichMarkdown text={md} />} />
        ) : (
          <RichMarkdown text={body} />
        )}
      </div>

      {message.citations?.length ? (
        <CitationCards citations={message.citations as never} collapsible />
      ) : null}
    </div>
  );
}
