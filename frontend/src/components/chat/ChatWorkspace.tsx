'use client';

/**
 * AI Chat — the ONE chat of AppBI (docs/features/unified-ai-chat/contract.md).
 *
 * Ask about the Datasets you may explore; the Data Core answers through the
 * Governed Query Service under your own rights. No assistant has to be picked
 * first. A conversation MAY have an Agent Flow added as an extension, which brings
 * cited documents beside the verified numbers - never instead of them.
 *
 * The page never decides access or numbers. The server keeps the conversation
 * (URL /chat/c/{id}), the follow-up context, the turn state (a reload mid-turn
 * shows it still running, then its answer) and redacts any stored answer whose
 * sources the reader cannot open now.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  BookOpen, ChevronDown, ChevronUp, Database, History, Loader2, Pencil, Plus, Send, Share2, Sparkles, Square, Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { ExchangeCard, errorText, type Exchange } from '@/components/chat/ChatTurnView';
import { useI18n } from '@/providers/LanguageProvider';
import {
  chatApi, newIdempotencyKey, TurnRejected, type ChatExtensionOption, type ChatSource, type ConversationDetail,
  type ConversationSummary, type CoreResponse, type TurnBody,
} from '@/lib/api/chat';

const CARD = 'rounded-lg border border-stroke-strong bg-surface-1';

type AskOpts = {
  consent?: string; plan?: Record<string, unknown>; datasetId?: number;
  valueChoice?: { plan: Record<string, unknown>; field: string; value: string }; choiceToken?: string;
};

function toExchanges(detail: ConversationDetail): Exchange[] {
  return detail.turns.map((t) => ({
    question: t.question, envelope: t.envelope, status: t.status, turnId: t.turn_id, redacted: t.redacted,
    redactedReason: t.redacted_reason, askedAt: t.asked_at, askedByMe: t.asked_by_me,
  }));
}

function dataOf(ex: Exchange): CoreResponse | null {
  return ex.envelope?.data ?? null;
}

export default function ChatWorkspace({ conversationId }: { conversationId?: number }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();

  const [sources, setSources] = useState<ChatSource[] | null>(null);
  const [extensions, setExtensions] = useState<ChatExtensionOption[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [conv, setConv] = useState<ConversationSummary | null>(null);
  const [currentId, setCurrentId] = useState<number | undefined>(conversationId);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'missing' | 'error'>(conversationId ? 'loading' : 'idle');
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  /** The add-on chosen for a conversation that does not exist yet (or `?brain=`). */
  const [pendingFlow, setPendingFlow] = useState<string>(params?.get('brain') || '');
  /** Ask the add-on on THIS question even if it does not look like a document question. */
  const [useFlowNow, setUseFlowNow] = useState(false);
  /** The Dataset the person chose to ask about; '' = every source they may use. */
  const [sourceId, setSourceId] = useState<string>('');
  /** Index from which the conversation is a new topic: the next question is sent
   *  without follow-up context (the server holds a follow-up to the previous source). */
  const [topicStart, setTopicStart] = useState(0);
  const [showEarlier, setShowEarlier] = useState(false);
  const [showList, setShowList] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<{ turnId?: string; abort: AbortController } | null>(null);

  const readOnly = !!conv && !conv.can_ask;
  const flowKey = conv ? conv.extension_flow_key : (pendingFlow || null);
  const flowName = extensions.find((x) => x.flow_key === flowKey)?.name || flowKey;

  const refreshList = useCallback(() => {
    chatApi.conversations().then(setConversations).catch(() => setConversations([]));
  }, []);

  useEffect(() => {
    chatApi.catalog(locale).then((c) => { setSources(c.sources); setExtensions(c.extensions); })
      .catch(() => setSources([]));
    refreshList();
  }, [refreshList, locale]);

  // An old Flow-chat link (/chat?thread=N): open the conversation it became.
  useEffect(() => {
    const legacy = Number(params?.get('thread') || 0);
    if (!legacy || conversationId) return;
    chatApi.resolveLegacy('flow_thread', legacy)
      .then((id) => router.replace(`/chat/c/${id}`))
      .catch(() => setLoadState('missing'));
  }, [params, conversationId, router]);

  const load = useCallback(async (id: number) => {
    const d = await chatApi.conversation(id);
    setConv(d);
    setHistory(toExchanges(d));
    return d;
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    setLoadState('loading');
    load(conversationId).then(() => setLoadState('idle')).catch((err) => {
      setLoadState((err as { response?: { status?: number } })?.response?.status === 404 ? 'missing' : 'error');
    });
  }, [conversationId, load]);

  // A turn still running on the server (a reload mid-answer, or another tab):
  // re-read until it ends. The live stream of THIS tab needs no polling.
  const storedRunning = history.some((ex) => ex.status === 'running' && !ex.envelope);
  useEffect(() => {
    if (!storedRunning || busy || !currentId) return undefined;
    const timer = setInterval(() => { load(currentId).catch(() => undefined); }, 2000);
    return () => clearInterval(timer);
  }, [storedRunning, busy, currentId, load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [history]);

  const hasAnswer = useMemo(
    () => history.slice(topicStart).some((ex) => ex.envelope?.data?.status === 'answered' && !ex.redacted),
    [history, topicStart]);

  const patchLast = (fn: (ex: Exchange) => Exchange) =>
    setHistory((h) => (h.length ? [...h.slice(0, -1), fn(h[h.length - 1])] : h));

  const ask = useCallback(async (q: string, opts: AskOpts = {}) => {
    const text = q.trim();
    if (!text || busy || readOnly) return;
    setBusy(true);
    setQuestion('');
    const abort = new AbortController();
    liveRef.current = { abort };
    setHistory((h) => [...h, { question: text, envelope: null, status: 'running', progress: [], askedByMe: true,
                               askedAt: new Date().toISOString() }]);
    try {
      let id = currentId;
      if (!id) {
        // The first question opens the conversation; its URL is kept from now on.
        const created = await chatApi.create({ extension_flow_key: pendingFlow || null });
        id = created.id;
        setCurrentId(id);
        setConv(created);
        window.history.replaceState(null, '', `/chat/c/${id}`);
      }
      const body: TurnBody = {
        question: text, idempotency_key: newIdempotencyKey(), follow_up: hasAnswer,
        extension: useFlowNow ? 'always' : 'auto',
        drop_consent: opts.consent ?? null, consented_plan: opts.plan ?? null,
        dataset_id: opts.datasetId ?? (sourceId ? Number(sourceId) : null),
        value_choice: opts.valueChoice ?? null, choice_token: opts.choiceToken ?? null,
      };
      for await (const ev of chatApi.ask(id, body, abort.signal)) {
        if (ev.type === 'accepted') {
          liveRef.current = { turnId: ev.turn_id, abort };
          patchLast((ex) => ({ ...ex, turnId: ev.turn_id }));
        } else if (ev.type === 'status' && ev.detail) {
          patchLast((ex) => ({ ...ex, progress: [...(ex.progress || []), ev.detail] }));
        } else if (ev.type === 'extension' && ev.state === 'started') {
          patchLast((ex) => ({ ...ex, progress: [...(ex.progress || []), t('aichat.extension.running', { name: flowName || '' })] }));
        } else if (ev.type === 'final') {
          patchLast((ex) => ({ ...ex, envelope: ev.envelope, status: ev.envelope.status, turnId: ev.turn_id }));
        }
      }
      setUseFlowNow(false);
      refreshList();
    } catch (err) {
      if (abort.signal.aborted) {
        // stopped by the person: the server already recorded the turn as cancelled
        patchLast((ex) => (ex.envelope ? ex : { ...ex, status: 'cancelled', envelope: {
          v: 'chat.v1', status: 'cancelled', code: 'cancelled_by_user', message: null, data: null, supporting: null,
          notices: [] } }));
      } else {
        const message = err instanceof TurnRejected ? err.message : errorText(err);
        patchLast((ex) => ({ ...ex, status: undefined, envelope: null, error: message }));
      }
    } finally {
      liveRef.current = null;
      setBusy(false);
      setCancelling(false);
    }
  }, [busy, readOnly, currentId, pendingFlow, hasAnswer, useFlowNow, sourceId, refreshList, t, flowName]);

  const cancel = useCallback(async () => {
    const live = liveRef.current;
    if (!live?.turnId) return;
    setCancelling(true);
    try {
      // The server ends the turn now, whatever stage it is in (planning, the governed
      // read, or the add-on), and says whether it did: a turn that had already
      // finished keeps its answer, and the stream delivers it - the page never shows
      // "cancelled" for a turn the server answered.
      const r = await chatApi.cancel(live.turnId);
      if (r.cancelled) live.abort.abort();
      else setCancelling(false);
    } catch {
      setCancelling(false);
    }
  }, []);

  const acceptDrop = useCallback(async (ex: Exchange) => {
    const d = dataOf(ex)?.detail;
    if (!d?.query_fingerprint || !d.dropped?.length) return;
    try {
      const token = await chatApi.consent(d.query_fingerprint, d.dropped.map((x) => x.field));
      // Re-run exactly the plan that was refused; the server re-validates it.
      await ask(ex.question, { consent: token, plan: dataOf(ex)?.plan ?? undefined });
    } catch (err) {
      setHistory((h) => [...h, { question: ex.question, envelope: null, error: errorText(err) }]);
    }
  }, [ask]);

  const submit = () => ask(question);

  const rename = async () => {
    if (!currentId || renaming === null) return;
    try {
      const s = await chatApi.update(currentId, { title: renaming });
      setConv((cur) => (cur ? { ...cur, title: s.title } : cur));
      refreshList();
    } finally {
      setRenaming(null);
    }
  };

  const chooseFlow = async (key: string) => {
    if (!currentId) {
      setPendingFlow(key);
      return;
    }
    try {
      const s = await chatApi.update(currentId, { extension_flow_key: key });
      setConv((cur) => (cur ? { ...cur, extension_flow_key: s.extension_flow_key } : cur));
    } catch (err) {
      setHistory((h) => [...h, { question: t('aichat.extension.label'), envelope: null, error: errorText(err) }]);
    }
  };

  const datasetOptions = useMemo(() => {
    const by = new Map<number, string>();
    (sources || []).forEach((s) => { if (!by.has(s.dataset_id)) by.set(s.dataset_id, s.dataset); });
    return [...by.entries()].map(([id, name]) => ({ id, name }));
  }, [sources]);
  const title = conv?.title || t('aichat.session.untitled');
  const canChooseFlow = !readOnly && (!conv || conv.is_owner) && extensions.length > 0;

  return (
    <div className="min-h-full bg-surface-0" data-testid="chat-page">
      <header className="border-b border-stroke-line bg-surface-1 px-4 pt-6 pb-4 sm:px-6 xl:px-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-h1 font-emphasis text-text-primary">
              {t('aichat.title')}
              <Badge variant="warning" size="md" data-testid="chat-preview-label">{t('aichat.previewLabel')}</Badge>
            </h1>
            <p className="mt-1 text-caption text-text-tertiary">{t('aichat.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" className="lg:hidden" leadingIcon={<History className="h-4 w-4" />}
                    onClick={() => setShowList((v) => !v)} aria-expanded={showList} data-testid="chat-conversations-toggle">
              {t('aichat.session.list')}
            </Button>
            <Button variant="primary" size="sm" leadingIcon={<Plus className="h-4 w-4" />}
                    onClick={() => router.push('/chat')} data-testid="chat-new">
              {t('aichat.session.new')}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row xl:px-8">
        <ConversationList items={conversations} currentId={currentId}
                          className={`${showList ? 'block' : 'hidden'} lg:block`} />

        <main className="min-w-0 flex-1 space-y-4">
          {/* Truthful on every visit: the answers are governed, their accuracy is not certified. */}
          <p role="note" data-testid="chat-warning"
             className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-caption text-warning">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('aichat.previewWarning')}
          </p>

          {loadState === 'missing' ? (
            <EmptyState icon={<History className="h-8 w-8" />} title={t('aichat.session.missingTitle')}
                        description={t('aichat.session.missingBody')} className={CARD}
                        action={<Button variant="primary" size="sm" onClick={() => router.push('/chat')}>{t('aichat.session.new')}</Button>} />
          ) : loadState === 'error' ? (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-caption text-danger">{t('aichat.error')}</div>
          ) : loadState === 'loading' ? (
            <div className="flex items-center gap-2 py-10 text-caption text-text-tertiary" data-testid="chat-conversation-loading">
              <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden />{t('aichat.session.loading')}
            </div>
          ) : (
            <>
              {currentId && conv ? (
                <section className={`${CARD} flex flex-wrap items-center justify-between gap-2 px-4 py-3`} data-testid="chat-conversation-header">
                  {renaming !== null ? (
                    <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); rename(); }}>
                      <Input value={renaming} onChange={(e) => setRenaming(e.target.value)} maxLength={255} autoFocus
                             aria-label={t('aichat.session.rename')} data-testid="chat-conversation-title-input" className="min-w-0 flex-1" />
                      <Button type="submit" variant="primary" size="sm">{t('aichat.session.save')}</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(null)}>{t('aichat.session.cancelEdit')}</Button>
                    </form>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="truncate text-small font-emphasis text-text-primary" data-testid="chat-conversation-title">{title}</h2>
                      {!conv.is_owner ? (
                        <Badge variant={conv.can_ask ? 'brand' : 'neutral'} size="sm" data-testid="chat-conversation-access">
                          {t(`aichat.session.access.${conv.access}`)}
                        </Badge>
                      ) : null}
                    </div>
                  )}
                  {renaming === null ? (
                    <div className="flex flex-wrap items-center gap-1">
                      {conv.is_owner ? (
                        <>
                          <Button variant="ghost" size="sm" leadingIcon={<Pencil className="h-4 w-4" />}
                                  onClick={() => setRenaming(conv.title || '')} data-testid="chat-conversation-rename">
                            {t('aichat.session.rename')}
                          </Button>
                          <Button variant="ghost" size="sm" leadingIcon={<Share2 className="h-4 w-4" />}
                                  onClick={() => setSharing(true)} data-testid="chat-conversation-share">
                            {t('aichat.session.share')}
                          </Button>
                        </>
                      ) : null}
                      {conv.is_owner || conv.access === 'full' ? (
                        <Button variant="ghost" size="sm" leadingIcon={<Trash2 className="h-4 w-4" />}
                                onClick={() => setConfirmDelete(true)} data-testid="chat-conversation-delete">
                          {t('aichat.session.delete')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {readOnly ? (
                <p role="note" className="rounded-lg border border-stroke-line bg-surface-2 px-3 py-2 text-caption text-text-secondary"
                   data-testid="chat-read-only">{t('aichat.session.readOnly')}</p>
              ) : null}

              <SourcesPanel sources={sources} />
              {canChooseFlow || flowKey ? (
                <ExtensionPanel options={extensions} value={flowKey} name={flowName} editable={canChooseFlow}
                                onChange={chooseFlow} />
              ) : null}
              {history.length === 0 && !busy && !readOnly ? <HowToPanel sources={sources} onExample={setQuestion} /> : null}

              {topicStart > 0 ? (
                <Button variant="link" size="xs" onClick={() => setShowEarlier((v) => !v)} data-testid="chat-earlier-toggle">
                  {showEarlier ? t('aichat.hideEarlier') : t('aichat.showEarlier', { n: topicStart })}
                </Button>
              ) : null}
              {history.map((ex, i) => (i < topicStart && !showEarlier) ? null : (
                <ExchangeCard key={i} ex={ex} locale={locale} readOnly={readOnly} onAccept={() => acceptDrop(ex)}
                              onOption={(opt) => {
                                const d = dataOf(ex);
                                // A metric or source the server offered: the SAME question with that
                                // option's signed token (the server re-validates it; no text is appended).
                                const pick = d?.choices?.find((c) => c.label === opt)
                                  ?? d?.sources?.find((s) => s.label === opt && s.token);
                                if (pick?.token) return ask(ex.question, { choiceToken: pick.token });
                                const src = d?.sources?.find((s) => s.label === opt);
                                if (src) return ask(ex.question, { datasetId: src.dataset_id });
                                // A real value picked for a filter that matched none: the same plan, that value.
                                if (d?.choice_field && d.plan) {
                                  return ask(`${ex.question} — ${opt}`, {
                                    valueChoice: { plan: d.plan, field: d.choice_field, value: opt } });
                                }
                                return ask(`${ex.question} — ${opt}`);
                              }} />
              ))}

              {busy ? (
                <div className="flex justify-end">
                  <Button variant="secondary" size="sm" className="text-danger" onClick={cancel} loading={cancelling}
                          leadingIcon={<Square className="h-3.5 w-3.5" />} data-testid="chat-cancel">
                    {cancelling ? t('aichat.cancelling') : t('aichat.cancel')}
                  </Button>
                </div>
              ) : null}

              {readOnly ? null : (
                <form onSubmit={(e) => { e.preventDefault(); submit(); }}
                      className={`${CARD} sticky bottom-0 z-10 p-3 shadow-linear`}>
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="chat-question" className="block text-label text-text-tertiary">
                      {hasAnswer ? t('aichat.followUp') : t('aichat.ask')}
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      {flowKey ? (
                        <label className="flex items-center gap-1.5 text-label text-text-tertiary">
                          <input type="checkbox" checked={useFlowNow} onChange={(e) => setUseFlowNow(e.target.checked)}
                                 className="h-3.5 w-3.5 accent-[rgb(var(--brand))]" data-testid="chat-use-extension" />
                          {t('aichat.extension.useNow')}
                        </label>
                      ) : null}
                      {history.length > topicStart ? (
                        <Button type="button" variant="link" size="xs" data-testid="chat-new-topic"
                                onClick={() => { setTopicStart(history.length); setShowEarlier(false); }}>
                          {t('aichat.newTopic')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {sources && sources.length ? (
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <label htmlFor="chat-source" className="text-label text-text-tertiary">{t('aichat.source.label')}</label>
                      <Select id="chat-source" value={sourceId} data-testid="chat-source-select"
                              className="min-w-0 flex-1 sm:max-w-xs"
                              onChange={(e) => {
                                setSourceId(e.target.value);
                                // a different source is a new topic: no follow-up across sources
                                if (history.length > topicStart) { setTopicStart(history.length); setShowEarlier(false); }
                              }}>
                        <option value="">{t('aichat.source.all')}</option>
                        {datasetOptions.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
                      </Select>
                    </div>
                  ) : null}
                  <div className="flex items-end gap-2">
                    <Textarea id="chat-question" data-testid="chat-question" value={question} rows={2} maxLength={4000}
                              onChange={(e) => setQuestion(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                              placeholder={hasAnswer ? t('aichat.followUpPlaceholder') : t('aichat.placeholder')}
                              className="min-h-[44px] flex-1 resize-y" />
                    <Button type="submit" variant="primary" size="lg" disabled={!question.trim() || busy}
                            leadingIcon={<Send className="h-4 w-4" />} data-testid="chat-ask">
                      {t('aichat.ask')}
                    </Button>
                  </div>
                </form>
              )}
              <div ref={bottomRef} />
            </>
          )}
        </main>
      </div>

      {sharing && currentId ? (
        <ShareDialog resourceType="chat_conversation" resourceId={currentId} resourceName={title}
                     notice={t('aichat.session.shareNotice')} onClose={() => setSharing(false)} />
      ) : null}
      <ConfirmDialog isOpen={confirmDelete} onClose={() => setConfirmDelete(false)} variant="danger"
                     title={t('aichat.session.deleteTitle')} description={t('aichat.session.deleteBody', { title })}
                     confirmLabel={t('aichat.session.delete')}
                     onConfirm={async () => {
                       if (!currentId) return;
                       await chatApi.remove(currentId);
                       router.push('/chat');
                     }} />
    </div>
  );
}

/** The optional Agent Flow add-on: documents, rules and procedures beside the data. */
function ExtensionPanel({ options, value, name, editable, onChange }: {
  options: ChatExtensionOption[]; value: string | null; name: string | null; editable: boolean;
  onChange: (key: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className={`${CARD} flex flex-wrap items-center gap-2 px-4 py-3 text-caption`} data-testid="chat-extension">
      <BookOpen className="h-4 w-4 shrink-0 text-brand" aria-hidden />
      <span className="text-text-secondary">{t('aichat.extension.label')}</span>
      {editable ? (
        <Select value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label={t('aichat.extension.label')}
                className="min-w-0 flex-1 sm:max-w-xs" data-testid="chat-extension-select">
          <option value="">{t('aichat.extension.none')}</option>
          {options.map((o) => <option key={o.flow_key} value={o.flow_key}>{o.name}</option>)}
        </Select>
      ) : (
        <span className="font-emphasis text-text-primary" data-testid="chat-extension-name">{name || t('aichat.extension.none')}</span>
      )}
      <span className="w-full text-label font-normal text-text-tertiary">{t('aichat.extension.hint')}</span>
    </section>
  );
}

function ConversationList({ items, currentId, className }: {
  items: ConversationSummary[] | null; currentId?: number; className?: string;
}) {
  const { t, locale } = useI18n();
  return (
    <aside className={`w-full shrink-0 lg:w-64 ${className || ''}`} data-testid="chat-conversations">
      <div className={CARD}>
        <h2 className="border-b border-stroke-line px-3 py-2 text-label uppercase tracking-wide text-text-tertiary">
          {t('aichat.session.list')}
        </h2>
        {items === null ? (
          <div className="flex items-center gap-2 px-3 py-3 text-caption text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden />{t('aichat.session.loading')}
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-3 text-caption text-text-tertiary" data-testid="chat-conversations-empty">{t('aichat.session.none')}</p>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto py-1">
            {items.map((s) => (
              <li key={s.id}>
                <Link href={`/chat/c/${s.id}`} data-testid="chat-conversation-item" aria-current={s.id === currentId ? 'page' : undefined}
                      className={`block px-3 py-2 focus-visible:outline-none focus-visible:shadow-focus-brand ${
                        s.id === currentId ? 'bg-brand-container text-brand-on-container' : 'text-text-secondary hover:bg-surface-2'}`}>
                  <span className="block truncate text-caption font-emphasis">{s.title || t('aichat.session.untitled')}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-micro font-normal text-text-tertiary">
                    {s.last_active_at ? new Date(s.last_active_at).toLocaleDateString(locale) : null}
                    {!s.is_owner ? <Badge variant="neutral" size="xs">{t(`aichat.session.access.${s.access}`)}</Badge> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** First-visit guide. The examples are built from THIS person's own sources (their real
 *  metric and dimension labels), so they are answerable here and never canned. A click
 *  only fills the question box: the person still decides to ask. */
function HowToPanel({ sources, onExample }: { sources: ChatSource[] | null; onExample: (q: string) => void }) {
  const { t } = useI18n();
  const examples = useMemo(() => {
    const by: string[] = [];
    const totals: string[] = [];
    for (const s of sources || []) {
      const [m1] = s.measures;
      const [d1] = s.dimensions;
      if (m1 && d1) by.push(t('aichat.howto.exampleBy', { measure: m1, dimension: d1.toLowerCase() }));
      if (m1) totals.push(t('aichat.howto.exampleTotal', { measure: m1.toLowerCase() }));
    }
    return [...new Set([...by, ...totals])].slice(0, 4);
  }, [sources, t]);
  if (sources === null) return null;
  if (!sources.length) {
    return (
      <section className={`${CARD} p-4 text-caption text-text-secondary`} data-testid="chat-no-sources">
        <h2 className="text-label uppercase tracking-wide text-text-tertiary">{t('aichat.noSourcesTitle')}</h2>
        <p className="mt-1">{t('aichat.noSourcesBody')}</p>
      </section>
    );
  }
  return (
    <section className={`${CARD} p-4 text-caption`} data-testid="chat-howto">
      <h2 className="text-label uppercase tracking-wide text-text-tertiary">{t('aichat.howto.title')}</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-text-secondary">
        {[1, 2, 3, 4, 5, 6].map((n) => <li key={n}>{t(`aichat.howto.step${n}`)}</li>)}
      </ol>
      {examples.length ? (
        <>
          <p className="mt-3 text-label text-text-tertiary">{t('aichat.howto.examples')}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {examples.map((q) => (
              <Button key={q} variant="tonal" size="xs" onClick={() => onExample(q)} data-testid="chat-example">{q}</Button>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function SourcesPanel({ sources }: { sources: ChatSource[] | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // One entry per Dataset: its explores offer nearly the same fields.
  const datasets = useMemo(() => {
    const by = new Map<string, { dataset: string; source_type: string; measures: string[] }>();
    (sources || []).forEach((s) => {
      const d = by.get(s.dataset) || { dataset: s.dataset, source_type: s.source_type, measures: [] };
      s.measures.forEach((m) => { if (!d.measures.includes(m)) d.measures.push(m); });
      by.set(s.dataset, d);
    });
    return [...by.values()];
  }, [sources]);
  if (sources === null || sources.length === 0) return null;
  return (
    <section className={CARD} data-testid="chat-sources">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="flex w-full items-center justify-between rounded-lg px-4 py-3 text-left text-caption font-emphasis text-text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-focus-brand">
        <span className="flex items-center gap-2"><Database className="h-4 w-4 text-brand" aria-hidden />
          {t('aichat.sources')} <Badge variant="brand" size="sm" pill>{datasets.length}</Badge></span>
        {open ? <ChevronUp className="h-4 w-4 text-text-tertiary" aria-hidden /> : <ChevronDown className="h-4 w-4 text-text-tertiary" aria-hidden />}
      </button>
      {open ? (
        <div className="border-t border-stroke-line px-4 py-3">
          <ul className="grid gap-2 sm:grid-cols-2">
            {datasets.map((s) => (
              <li key={s.dataset} className="rounded-md border border-stroke-line p-2 text-label font-normal" data-testid="chat-source">
                <div className="font-emphasis text-text-primary">{s.dataset} <span className="font-normal text-text-quaternary">· {s.source_type}</span></div>
                <div className="mt-1 text-text-tertiary">{s.measures.join(', ')}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
