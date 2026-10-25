'use client';

/**
 * AI Analyst ("Phân tích dữ liệu"): governed questions about the person's own
 * semantic Datasets, kept as SESSIONS that survive a reload, have a URL
 * (/analyst/s/{id}) and can be shared like any other AppBI resource.
 *
 * The page never decides access or numbers. The backend lists only the sources the
 * person may explore, runs every read through the Governed Query Service, keeps the
 * follow-up context in the session (never echoed from here), and redacts a stored
 * answer for anyone who cannot read its sources now.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronDown, ChevronUp, Database, History, Loader2, MessagesSquare, Pencil, Plus, Send, Share2, Sparkles, Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { ExchangeCard, errorText, type Exchange } from '@/components/analyst/AnalystTurnView';
import { hasPermission, usePermissions } from '@/hooks/use-permissions';
import { useI18n } from '@/providers/LanguageProvider';
import {
  analystApi, newTurnId, type AnalystSessionDetail, type AnalystSessionSummary, type AnalystSource,
} from '@/lib/api/analyst';

const STEP_KEYS = ['discovery', 'plan', 'governed_query', 'verify'] as const;
const CARD = 'rounded-lg border border-stroke-strong bg-surface-1';

type AskOpts = {
  followUp?: boolean; consent?: string; plan?: Record<string, unknown>; datasetId?: number;
  valueChoice?: { plan: Record<string, unknown>; field: string; value: string }; choiceToken?: string;
};

function toExchanges(detail: AnalystSessionDetail): Exchange[] {
  return detail.turns.map((t) => ({
    question: t.question, turn: t.response, redacted: t.redacted, askedAt: t.asked_at, askedByMe: t.asked_by_me,
  }));
}

export default function AnalystWorkspace({ sessionId }: { sessionId?: number }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { data: me } = usePermissions();
  const canChat = hasPermission(me?.permissions, 'chat', 'view');

  const [sources, setSources] = useState<AnalystSource[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [sessions, setSessions] = useState<AnalystSessionSummary[] | null>(null);
  const [session, setSession] = useState<AnalystSessionSummary | null>(null);
  const [currentId, setCurrentId] = useState<number | undefined>(sessionId);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'missing' | 'error'>(sessionId ? 'loading' : 'idle');
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const [running, setRunning] = useState<{ turnId: string; question: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Index from which the conversation is a new topic: the next question is sent
   *  without follow-up context (the server holds a follow-up to the previous source). */
  const [topicStart, setTopicStart] = useState(0);
  const [showEarlier, setShowEarlier] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** The turn in flight, readable from the cancel loop (state in its closure goes stale). */
  const runningRef = useRef<string | null>(null);
  useEffect(() => { runningRef.current = running?.turnId ?? null; }, [running]);

  const readOnly = !!session && !session.can_ask;

  const refreshSessions = useCallback(() => {
    analystApi.sessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    analystApi.catalog().then(setSources).catch((err) => {
      if ((err as { response?: { status?: number } })?.response?.status === 404) setDisabled(true);
      setSources([]);
    });
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!sessionId) return;
    setLoadState('loading');
    analystApi.session(sessionId).then((d) => {
      setSession(d);
      setHistory(toExchanges(d));
      setLoadState('idle');
    }).catch((err) => {
      setLoadState((err as { response?: { status?: number } })?.response?.status === 404 ? 'missing' : 'error');
    });
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [history, running]);

  const hasAnswer = useMemo(
    () => history.slice(topicStart).some((ex) => ex.turn?.status === 'answered' && !ex.redacted),
    [history, topicStart]);

  const ask = useCallback(async (q: string, opts: AskOpts = {}) => {
    const text = q.trim();
    if (!text || running || readOnly) return;
    const turnId = newTurnId();
    setRunning({ turnId, question: text });
    setQuestion('');
    try {
      let id = currentId;
      if (!id) {
        // The first question opens a session; its URL is kept from now on.
        const created = await analystApi.createSession();
        id = created.id;
        setCurrentId(id);
        setSession(created);
        window.history.replaceState(null, '', `/analyst/s/${id}`);
      }
      const turn = await analystApi.askInSession(id, {
        question: text, turn_id: turnId,
        follow_up: !!opts.followUp,
        drop_consent: opts.consent ?? null,
        consented_plan: opts.plan ?? null,
        dataset_id: opts.datasetId ?? null,
        value_choice: opts.valueChoice ?? null,
        choice_token: opts.choiceToken ?? null,
      });
      setHistory((h) => [...h, { question: text, turn, askedByMe: true, askedAt: new Date().toISOString() }]);
      refreshSessions();
    } catch (err) {
      setHistory((h) => [...h, { question: text, turn: null, error: errorText(err) }]);
    } finally {
      setRunning(null);
      setCancelling(false);
    }
  }, [running, readOnly, currentId, refreshSessions]);

  const cancel = useCallback(async () => {
    if (!running) return;
    setCancelling(true);
    // The server can only mark a query that is already RUNNING; a click while the
    // question is still being planned marks nothing and was silently lost (browser G:
    // the turn ran to its 60 s bound). Ask again each second until the turn ends.
    const turnId = running.turnId;
    try {
      while (runningRef.current === turnId) {
        if ((await analystApi.cancel(turnId)) > 0) break;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    } catch {
      setCancelling(false);
    }
  }, [running]);

  const acceptDrop = useCallback(async (ex: Exchange) => {
    const d = ex.turn?.detail;
    if (!d?.query_fingerprint || !d.dropped?.length) return;
    try {
      const token = await analystApi.consent(d.query_fingerprint, d.dropped.map((x) => x.field));
      // Re-run exactly the plan that was refused; the server re-validates it.
      await ask(ex.question, { consent: token, plan: ex.turn?.plan ?? undefined });
    } catch (err) {
      setHistory((h) => [...h, { question: ex.question, turn: null, error: errorText(err) }]);
    }
  }, [ask]);

  const submit = () => ask(question, { followUp: hasAnswer });

  const rename = async () => {
    if (!currentId || renaming === null) return;
    try {
      const s = await analystApi.renameSession(currentId, renaming);
      setSession((cur) => (cur ? { ...cur, title: s.title } : cur));
      refreshSessions();
    } finally {
      setRenaming(null);
    }
  };

  const title = session?.title || t('analyst.session.untitled');

  return (
    <div className="min-h-full bg-surface-0" data-testid="analyst-page">
      <header className="border-b border-stroke-line bg-surface-1 px-4 pt-6 pb-4 sm:px-6 xl:px-8">
        <AiModeSwitch canChat={canChat} />
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-h1 font-emphasis text-text-primary">
              {t('analyst.title')}
              <Badge variant="warning" size="md" data-testid="analyst-preview-label">{t('analyst.previewLabel')}</Badge>
            </h1>
            <p className="mt-1 text-caption text-text-tertiary">{t('analyst.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" className="lg:hidden" leadingIcon={<History className="h-4 w-4" />}
                    onClick={() => setShowSessions((v) => !v)} aria-expanded={showSessions} data-testid="analyst-sessions-toggle">
              {t('analyst.session.list')}
            </Button>
            <Button variant="primary" size="sm" leadingIcon={<Plus className="h-4 w-4" />}
                    onClick={() => router.push('/analyst')} data-testid="analyst-new-session">
              {t('analyst.session.new')}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row xl:px-8">
        <SessionList sessions={sessions} currentId={currentId}
                     className={`${showSessions ? 'block' : 'hidden'} lg:block`} />

        <main className="min-w-0 flex-1 space-y-4">
          {/* Truthful on every visit: the answers are governed, their accuracy is not certified. */}
          <p role="note" data-testid="analyst-warning"
             className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-caption text-warning">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('analyst.previewWarning')}
          </p>
          {disabled ? (
            <div role="alert" className={`${CARD} p-4 text-caption text-text-tertiary`}>{t('analyst.disabled')}</div>
          ) : null}

          {loadState === 'missing' ? (
            <EmptyState icon={<History className="h-8 w-8" />} title={t('analyst.session.missingTitle')}
                        description={t('analyst.session.missingBody')} className={CARD}
                        action={<Button variant="primary" size="sm" onClick={() => router.push('/analyst')}>{t('analyst.session.new')}</Button>} />
          ) : loadState === 'error' ? (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-caption text-danger">{t('analyst.error')}</div>
          ) : loadState === 'loading' ? (
            <div className="flex items-center gap-2 py-10 text-caption text-text-tertiary" data-testid="analyst-session-loading">
              <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden />{t('analyst.session.loading')}
            </div>
          ) : (
            <>
              {currentId && session ? (
                <section className={`${CARD} flex flex-wrap items-center justify-between gap-2 px-4 py-3`} data-testid="analyst-session-header">
                  {renaming !== null ? (
                    <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); rename(); }}>
                      <Input value={renaming} onChange={(e) => setRenaming(e.target.value)} maxLength={255} autoFocus
                             aria-label={t('analyst.session.rename')} data-testid="analyst-session-title-input" className="min-w-0 flex-1" />
                      <Button type="submit" variant="primary" size="sm">{t('analyst.session.save')}</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(null)}>{t('analyst.session.cancelEdit')}</Button>
                    </form>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="truncate text-small font-emphasis text-text-primary" data-testid="analyst-session-title">{title}</h2>
                      {!session.is_owner ? (
                        <Badge variant={session.can_ask ? 'brand' : 'neutral'} size="sm" data-testid="analyst-session-access">
                          {t(`analyst.session.access.${session.access}`)}
                        </Badge>
                      ) : null}
                    </div>
                  )}
                  {renaming === null ? (
                    <div className="flex flex-wrap items-center gap-1">
                      {session.is_owner ? (
                        <>
                          <Button variant="ghost" size="sm" leadingIcon={<Pencil className="h-4 w-4" />}
                                  onClick={() => setRenaming(session.title || '')} data-testid="analyst-session-rename">
                            {t('analyst.session.rename')}
                          </Button>
                          <Button variant="ghost" size="sm" leadingIcon={<Share2 className="h-4 w-4" />}
                                  onClick={() => setSharing(true)} data-testid="analyst-session-share">
                            {t('analyst.session.share')}
                          </Button>
                        </>
                      ) : null}
                      {session.is_owner || session.access === 'full' ? (
                        <Button variant="ghost" size="sm" leadingIcon={<Trash2 className="h-4 w-4" />}
                                onClick={() => setConfirmDelete(true)} data-testid="analyst-session-delete">
                          {t('analyst.session.delete')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {readOnly ? (
                <p role="note" className="rounded-lg border border-stroke-line bg-surface-2 px-3 py-2 text-caption text-text-secondary"
                   data-testid="analyst-read-only">{t('analyst.session.readOnly')}</p>
              ) : null}

              <SourcesPanel sources={sources} />
              {history.length === 0 && !running && !readOnly ? <HowToPanel sources={sources} onExample={setQuestion} /> : null}

              {topicStart > 0 ? (
                <Button variant="link" size="xs" onClick={() => setShowEarlier((v) => !v)} data-testid="analyst-earlier-toggle">
                  {showEarlier ? t('analyst.hideEarlier') : t('analyst.showEarlier', { n: topicStart })}
                </Button>
              ) : null}
              {history.map((ex, i) => (i < topicStart && !showEarlier) ? null : (
                <ExchangeCard key={i} ex={ex} locale={locale} readOnly={readOnly} onAccept={() => acceptDrop(ex)}
                              onOption={(opt) => {
                                // A metric or source the server offered: the SAME question with that
                                // option's signed token (the server re-validates it; no text is appended).
                                const pick = ex.turn?.choices?.find((c) => c.label === opt)
                                  ?? ex.turn?.sources?.find((s) => s.label === opt && s.token);
                                if (pick?.token) return ask(ex.question, { choiceToken: pick.token });
                                const src = ex.turn?.sources?.find((s) => s.label === opt);
                                if (src) return ask(ex.question, { datasetId: src.dataset_id });
                                // A real value picked for a filter that matched none: the same plan, that value.
                                if (ex.turn?.choice_field && ex.turn.plan) {
                                  return ask(`${ex.question} — ${opt}`, {
                                    valueChoice: { plan: ex.turn.plan, field: ex.turn.choice_field, value: opt } });
                                }
                                return ask(`${ex.question} — ${opt}`);
                              }} />
              ))}

              {running ? (
                <section aria-live="polite" className={`${CARD} p-4`} data-testid="analyst-running">
                  <p className="mb-3 text-caption font-emphasis text-text-primary">{running.question}</p>
                  <ol className="space-y-2">
                    {STEP_KEYS.map((k) => (
                      <li key={k} className="flex items-center gap-2 text-caption text-text-tertiary">
                        <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden />{t(`analyst.step.${k}`)}
                      </li>
                    ))}
                  </ol>
                  <Button variant="secondary" size="sm" className="mt-3 text-danger" onClick={cancel} loading={cancelling}
                          data-testid="analyst-cancel">
                    {cancelling ? t('analyst.cancelling') : t('analyst.cancel')}
                  </Button>
                </section>
              ) : null}

              {readOnly ? null : (
                <form onSubmit={(e) => { e.preventDefault(); submit(); }}
                      className={`${CARD} sticky bottom-0 z-10 p-3 shadow-linear`}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label htmlFor="analyst-question" className="block text-label text-text-tertiary">
                      {hasAnswer ? t('analyst.followUp') : t('analyst.ask')}
                    </label>
                    {history.length > topicStart ? (
                      <Button type="button" variant="link" size="xs" data-testid="analyst-new-topic"
                              onClick={() => { setTopicStart(history.length); setShowEarlier(false); }}>
                        {t('analyst.newTopic')}
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex items-end gap-2">
                    <Textarea id="analyst-question" data-testid="analyst-question" value={question} rows={2} maxLength={1000}
                              onChange={(e) => setQuestion(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                              placeholder={hasAnswer ? t('analyst.followUpPlaceholder') : t('analyst.placeholder')}
                              className="min-h-[44px] flex-1 resize-y" />
                    <Button type="submit" variant="primary" size="lg" disabled={!question.trim() || !!running || disabled}
                            leadingIcon={<Send className="h-4 w-4" />} data-testid="analyst-ask">
                      {t('analyst.ask')}
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
        <ShareDialog resourceType="analyst_session" resourceId={currentId} resourceName={title}
                     notice={t('analyst.session.shareNotice')} onClose={() => setSharing(false)} />
      ) : null}
      <ConfirmDialog isOpen={confirmDelete} onClose={() => setConfirmDelete(false)} variant="danger"
                     title={t('analyst.session.deleteTitle')} description={t('analyst.session.deleteBody', { title })}
                     confirmLabel={t('analyst.session.delete')}
                     onConfirm={async () => {
                       if (!currentId) return;
                       await analystApi.deleteSession(currentId);
                       router.push('/analyst');
                     }} />
    </div>
  );
}

/** The two AI modes, side by side, so the difference is stated where people choose. */
function AiModeSwitch({ canChat }: { canChat: boolean }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('analyst.mode.label')} className="flex flex-wrap gap-2" data-testid="ai-mode-switch">
      {canChat ? (
        <Link href="/chat" data-testid="ai-mode-chat"
              className="group flex min-w-0 flex-1 basis-56 items-start gap-2 rounded-lg border border-stroke-line bg-surface-1 px-3 py-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-focus-brand sm:flex-none">
          <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
          <span className="min-w-0">
            <span className="block text-caption font-emphasis text-text-secondary">{t('analyst.mode.chat')}</span>
            <span className="block text-micro font-normal text-text-tertiary">{t('analyst.mode.chatHint')}</span>
          </span>
        </Link>
      ) : null}
      <span aria-current="page" data-testid="ai-mode-analyst"
            className="flex min-w-0 flex-1 basis-56 items-start gap-2 rounded-lg border border-brand/40 bg-brand-container px-3 py-2 sm:flex-none">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
        <span className="min-w-0">
          <span className="block text-caption font-emphasis text-brand-on-container">{t('analyst.mode.analyst')}</span>
          <span className="block text-micro font-normal text-brand-on-container/80">{t('analyst.mode.analystHint')}</span>
        </span>
      </span>
    </nav>
  );
}

function SessionList({ sessions, currentId, className }: {
  sessions: AnalystSessionSummary[] | null; currentId?: number; className?: string;
}) {
  const { t, locale } = useI18n();
  return (
    <aside className={`w-full shrink-0 lg:w-64 ${className || ''}`} data-testid="analyst-sessions">
      <div className={CARD}>
        <h2 className="border-b border-stroke-line px-3 py-2 text-label uppercase tracking-wide text-text-tertiary">
          {t('analyst.session.list')}
        </h2>
        {sessions === null ? (
          <div className="flex items-center gap-2 px-3 py-3 text-caption text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden />{t('analyst.session.loading')}
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-3 py-3 text-caption text-text-tertiary" data-testid="analyst-sessions-empty">{t('analyst.session.none')}</p>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto py-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link href={`/analyst/s/${s.id}`} data-testid="analyst-session-item" aria-current={s.id === currentId ? 'page' : undefined}
                      className={`block px-3 py-2 focus-visible:outline-none focus-visible:shadow-focus-brand ${
                        s.id === currentId ? 'bg-brand-container text-brand-on-container' : 'text-text-secondary hover:bg-surface-2'}`}>
                  <span className="block truncate text-caption font-emphasis">{s.title || t('analyst.session.untitled')}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-micro font-normal text-text-tertiary">
                    {s.last_active_at ? new Date(s.last_active_at).toLocaleDateString(locale) : null}
                    {!s.is_owner ? <Badge variant="neutral" size="xs">{t(`analyst.session.access.${s.access}`)}</Badge> : null}
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
function HowToPanel({ sources, onExample }: { sources: AnalystSource[] | null; onExample: (q: string) => void }) {
  const { t } = useI18n();
  const examples = useMemo(() => {
    // one "metric by dimension" per source first, so one source cannot fill the list,
    // then totals (the catalog lists no identifiers as dimensions)
    const by: string[] = [];
    const totals: string[] = [];
    for (const s of sources || []) {
      const [m1] = s.measures;
      const [d1] = s.dimensions;
      if (m1 && d1) by.push(t('analyst.howto.exampleBy', { measure: m1, dimension: d1.toLowerCase() }));
      if (m1) totals.push(t('analyst.howto.exampleTotal', { measure: m1.toLowerCase() }));
    }
    return [...new Set([...by, ...totals])].slice(0, 4);
  }, [sources, t]);
  if (!sources?.length) return null;
  return (
    <section className={`${CARD} p-4 text-caption`} data-testid="analyst-howto">
      <h2 className="text-label uppercase tracking-wide text-text-tertiary">{t('analyst.howto.title')}</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-text-secondary">
        {[1, 2, 3, 4, 5, 6].map((n) => <li key={n}>{t(`analyst.howto.step${n}`)}</li>)}
      </ol>
      {examples.length ? (
        <>
          <p className="mt-3 text-label text-text-tertiary">{t('analyst.howto.examples')}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {examples.map((q) => (
              <Button key={q} variant="tonal" size="xs" onClick={() => onExample(q)} data-testid="analyst-example">{q}</Button>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function SourcesPanel({ sources }: { sources: AnalystSource[] | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // One entry per Dataset: its explores offer nearly the same fields (dogfood: one
  // Dataset was listed five times with the same measures in another order).
  const datasets = useMemo(() => {
    const by = new Map<string, { dataset: string; source_type: string; measures: string[] }>();
    (sources || []).forEach((s) => {
      const d = by.get(s.dataset) || { dataset: s.dataset, source_type: s.source_type, measures: [] };
      s.measures.forEach((m) => { if (!d.measures.includes(m)) d.measures.push(m); });
      by.set(s.dataset, d);
    });
    return [...by.values()];
  }, [sources]);
  if (sources === null) return null;
  return (
    <section className={CARD} data-testid="analyst-sources">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="flex w-full items-center justify-between rounded-lg px-4 py-3 text-left text-caption font-emphasis text-text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-focus-brand">
        <span className="flex items-center gap-2"><Database className="h-4 w-4 text-brand" aria-hidden />
          {t('analyst.sources')} <Badge variant="brand" size="sm" pill>{datasets.length}</Badge></span>
        {open ? <ChevronUp className="h-4 w-4 text-text-tertiary" aria-hidden /> : <ChevronDown className="h-4 w-4 text-text-tertiary" aria-hidden />}
      </button>
      {open ? (
        <div className="border-t border-stroke-line px-4 py-3">
          {sources.length === 0 ? <p className="text-caption text-text-tertiary">{t('analyst.sourcesEmpty')}</p> : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {datasets.map((s) => (
                <li key={s.dataset} className="rounded-md border border-stroke-line p-2 text-label font-normal" data-testid="analyst-source">
                  <div className="font-emphasis text-text-primary">{s.dataset} <span className="font-normal text-text-quaternary">· {s.source_type}</span></div>
                  <div className="mt-1 text-text-tertiary">{s.measures.join(', ')}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
