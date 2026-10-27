'use client';

/**
 * The public Dashboard AI Bot: a client of THE Answer Core.
 *
 * PO directive (2026-10-28): AppBI has one Answer Core. AI Chat and this bot are
 * its two consumers. A viewer of a public link asks; the server's Core reads the
 * link's PUBLISHED charts (the same governed path the tiles render through) and
 * writes the one final answer (`chat.v1`). A bound Agent Flow is an optional
 * add-on the Core may call for documents; it never answers here.
 *
 * What this component never does: ask for or send a provider key, pick a model
 * or a "thinking" mode, or compute a number. It renders what the Core returned:
 * the answer, its table, where it came from (chart, page, filters, freshness), a
 * clarification, an honest refusal, documents the add-on cited (their figures
 * marked as not verified), or a failure with a retry.
 *
 * Public bundle rule: only the public client (`lib/api/public`) - no authed API.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, MessageCircle, Plus, RotateCcw, Send, Square, ThumbsDown, ThumbsUp, X } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import {
  askPublicAnswer,
  cancelPublicAnswer,
  getPublicAiStatus,
  getPublicAnswerTurn,
  PublicAnswerRejected,
  ratePublicAnswer,
  type PublicAnswerEnvelope,
} from '@/lib/api/public';
import { applyReaderRating, revertReaderRating, type ReaderRating } from '@/lib/readerRating';
import { useI18n } from '@/providers/LanguageProvider';

interface Props {
  token: string;
  sessionToken?: string | null;
  dashboardName?: string;
  /** Viewer-applied slicer filters: the bot reads the same filtered report the viewer sees. */
  viewerFilters?: unknown[];
  /** The page the viewer is on: its charts are offered to the Core first. */
  pageId?: string | null;
}

interface Exchange {
  id: string;
  question: string;
  turnId?: string;
  running: boolean;
  steps: string[];
  envelope?: PublicAnswerEnvelope | null;
  error?: string;
  choiceToken?: string | null;
  /** the viewer's verdict on this answer (one current verdict, never cleared) */
  rating?: ReaderRating;
}

type Translate = (k: string, v?: Record<string, string | number>) => string;

const MAX_TABLE_ROWS = 12;

function newKey(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

function storageGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* private mode: the conversation lives in memory only */
  }
}

function fmt(v: unknown, locale: string): string {
  if (typeof v === 'number') return v.toLocaleString(locale, { maximumFractionDigits: 2 });
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

export function DashboardAiBot({ token, sessionToken, dashboardName, viewerFilters, pageId }: Props) {
  const { t, locale } = useI18n();
  const convStorage = `appbi.aiAnswer.conv.${token}`;
  const msgStorage = `appbi.aiAnswer.msgs.${token}`;
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [question, setQuestion] = useState('');
  const [conversationKey, setConversationKey] = useState<string>(() => storageGet(convStorage) || newKey());
  const [history, setHistory] = useState<Exchange[]>(() => {
    try {
      const raw = storageGet(msgStorage);
      return raw ? (JSON.parse(raw) as Exchange[]) : [];
    } catch {
      return [];
    }
  });
  const live = useRef<{ abort: AbortController; turnId?: string; stopRequested?: boolean } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = history.some((ex) => ex.running);

  useEffect(() => { storageSet(convStorage, conversationKey); }, [convStorage, conversationKey]);
  useEffect(() => {
    // finished turns are kept for this tab; a running one is resumed from the server
    storageSet(msgStorage, JSON.stringify(history.slice(-30)));
  }, [history, msgStorage]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [history, open]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    let stale = false;
    getPublicAiStatus(token, sessionToken)
      .then((s) => { if (!stale) setReady(Boolean(s.enabled && s.ready)); })
      .catch(() => { if (!stale) setReady(false); });
    return () => { stale = true; };
  }, [open, sessionToken, token]);

  const patch = useCallback((id: string, fn: (ex: Exchange) => Exchange) => {
    setHistory((h) => h.map((ex) => (ex.id === id ? fn(ex) : ex)));
  }, []);

  // A turn left running by a reload is not lost: read its terminal state from the server.
  const orphanId = history.find((ex) => ex.running && ex.turnId)?.id;
  useEffect(() => {
    if (!orphanId || live.current) return undefined;
    const orphan = history.find((ex) => ex.id === orphanId);
    if (!orphan?.turnId) return undefined;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const turn = await getPublicAnswerTurn(token, orphan.turnId as string, conversationKey, sessionToken);
        if (turn.status !== 'running') {
          patch(orphan.id, (ex) => ({ ...ex, running: false, envelope: turn.envelope }));
          return;
        }
      } catch {
        patch(orphan.id, (ex) => ({ ...ex, running: false, error: t('dashboards.aiBot.core.errorGeneric') }));
        return;
      }
      window.setTimeout(tick, 1500);
    };
    void tick();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphanId]);

  const stopTurn = useCallback(async (turnId: string, abort: AbortController) => {
    try {
      const r = await cancelPublicAnswer(token, turnId, conversationKey, sessionToken);
      if (r.cancelled) abort.abort();
    } catch {
      /* the stream ends with whatever the server decided */
    }
  }, [conversationKey, sessionToken, token]);

  const ask = useCallback(async (text: string, choiceToken?: string | null) => {
    const q = text.trim();
    if (!q || busy) return;
    const id = newKey();
    const abort = new AbortController();
    live.current = { abort };
    setQuestion('');
    setHistory((h) => [...h, { id, question: q, running: true, steps: [], choiceToken }]);
    try {
      for await (const ev of askPublicAnswer(token, {
        question: q,
        conversation_key: conversationKey,
        idempotency_key: newKey(),
        page_id: pageId ?? null,
        viewer_filters: Array.isArray(viewerFilters) ? viewerFilters : [],
        follow_up: true,
        choice_token: choiceToken ?? null,
      }, sessionToken, abort.signal)) {
        if (ev.type === 'accepted') {
          const stopRequested = live.current?.stopRequested;
          live.current = { abort, turnId: ev.turn_id };
          patch(id, (ex) => ({ ...ex, turnId: ev.turn_id }));
          // Stop was pressed before the server named the turn: stop it now
          if (stopRequested) void stopTurn(ev.turn_id, abort);
        } else if (ev.type === 'status' && ev.detail) {
          const detail = ev.detail;
          patch(id, (ex) => ({ ...ex, steps: [...ex.steps, detail].slice(-4) }));
        } else if (ev.type === 'final') {
          const envelope = ev.envelope;
          patch(id, (ex) => ({ ...ex, running: false, envelope }));
        }
      }
      patch(id, (ex) => (ex.running ? { ...ex, running: false } : ex));
    } catch (err) {
      if (abort.signal.aborted) {
        patch(id, (ex) => ({ ...ex, running: false, envelope: {
          v: 'chat.v1', status: 'cancelled', code: 'cancelled_by_user', message: null, data: null,
          supporting: null, notices: [] } }));
      } else {
        const message = err instanceof PublicAnswerRejected ? err.message : t('dashboards.aiBot.core.errorGeneric');
        patch(id, (ex) => ({ ...ex, running: false, error: message }));
      }
    } finally {
      live.current = null;
    }
  }, [busy, conversationKey, pageId, patch, sessionToken, stopTurn, t, token, viewerFilters]);

  const stop = useCallback(() => {
    const cur = live.current;
    if (!cur) return;
    // the turn is not named yet: remember the press, the `accepted` event acts on it
    if (!cur.turnId) { cur.stopRequested = true; return; }
    void stopTurn(cur.turnId, cur.abort);
  }, [stopTurn]);

  // The reader's thumb: one verdict, written to the turn; a failed save undoes itself.
  const handleRateMessage = useCallback(async (index: number, clicked: ReaderRating) => {
    const ex = history[index];
    if (!ex?.turnId) return;
    const previous = ex.rating;
    setHistory((h) => applyReaderRating(h, index, clicked));
    try {
      await ratePublicAnswer(token, ex.turnId, conversationKey, clicked, sessionToken);
    } catch {
      setHistory((h) => revertReaderRating(h, index, clicked, previous));
    }
  }, [conversationKey, history, sessionToken, token]);

  const reset = useCallback(() => {
    if (busy) return;
    setHistory([]);
    setConversationKey(newKey());
  }, [busy]);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 flex h-12 items-center gap-2 rounded-full bg-brand px-4 text-small font-emphasis text-text-inverse shadow-linear-md hover:bg-brand-hover"
          data-testid="ai-bot-open"
          aria-label={t('dashboards.aiBot.core.openAria')}
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
          <span className="hidden sm:inline">{t('dashboards.aiBot.core.open')}</span>
        </button>
      )}
      {open && (
        <section
          role="dialog"
          aria-label={t('dashboards.aiBot.core.title')}
          data-testid="ai-bot-panel"
          className="fixed inset-0 z-50 flex flex-col bg-surface-1 sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(640px,calc(100vh-40px))] sm:w-[420px] sm:rounded-xl sm:border sm:border-stroke-strong sm:shadow-linear-lg"
        >
          <header className="flex items-start gap-2 border-b border-stroke-subtle px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-small font-strong text-text-primary">{t('dashboards.aiBot.core.title')}</h2>
              <p className="truncate text-label text-text-tertiary">
                {dashboardName ? `${dashboardName} · ` : ''}{t('dashboards.aiBot.core.subtitle')}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={busy}
                    data-testid="ai-bot-new" title={t('dashboards.aiBot.core.newConversation')}
                    aria-label={t('dashboards.aiBot.core.newConversation')}>
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}
                    aria-label={t('dashboards.aiBot.core.closeAria')} data-testid="ai-bot-close">
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3" data-testid="ai-bot-history">
            {ready === false && (
              <p className="rounded-md bg-warning-bg p-3 text-caption text-text-primary" data-testid="ai-bot-not-ready">
                {t('dashboards.aiBot.core.notReady')}
              </p>
            )}
            {ready !== false && history.length === 0 && (
              <p className="text-caption text-text-tertiary" data-testid="ai-bot-empty">{t('dashboards.aiBot.core.empty')}</p>
            )}
            {history.map((ex, index) => (
              <ExchangeView key={ex.id} ex={ex} locale={locale} t={t}
                            onRetry={() => { void ask(ex.question, ex.choiceToken); }}
                            onPick={(tok) => { void ask(ex.question, tok); }}
                            onRate={(r) => { void handleRateMessage(index, r); }} busy={busy} />
            ))}
            <div ref={bottomRef} />
          </div>

          <form
            className="border-t border-stroke-subtle p-3"
            onSubmit={(e) => { e.preventDefault(); void ask(question); }}
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(question); }
                }}
                placeholder={t('dashboards.aiBot.core.placeholder')}
                rows={2}
                maxLength={2000}
                disabled={ready === false}
                className="min-h-[44px] min-w-0 flex-1 resize-none rounded-md border border-stroke-strong bg-surface-1 px-3 py-2 text-caption text-text-primary placeholder:text-text-quaternary focus:border-brand focus:outline-none"
                data-testid="ai-bot-input"
                aria-label={t('dashboards.aiBot.core.placeholder')}
              />
              {busy ? (
                <Button type="button" variant="secondary" onClick={stop} data-testid="ai-bot-stop">
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />{t('dashboards.aiBot.core.stop')}
                </Button>
              ) : (
                <Button type="submit" variant="primary" disabled={!question.trim() || ready === false}
                        data-testid="ai-bot-send">
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />{t('dashboards.aiBot.core.send')}
                </Button>
              )}
            </div>
          </form>
        </section>
      )}
    </>
  );
}

function ExchangeView({ ex, locale, t, onRetry, onPick, onRate, busy }: {
  ex: Exchange;
  locale: string;
  t: Translate;
  onRetry: () => void;
  onPick: (token: string) => void;
  onRate?: (rating: ReaderRating) => void;
  busy: boolean;
}) {
  const e = ex.envelope;
  // Only an answer the server holds can be rated: not an error bubble, a stopped or
  // failed turn, or a turn still running. Nothing in this panel is page-written.
  const message = {
    failed: Boolean(ex.error) || ex.running || !e || !['answered', 'clarification_required'].includes(e.status),
    local: false,
  };
  return (
    <article className="space-y-2" data-testid="ai-bot-exchange"
             data-status={e?.status || (ex.running ? 'running' : 'error')}>
      <p className="ml-auto w-fit max-w-[85%] break-words rounded-lg bg-brand-subtle px-3 py-2 text-caption text-text-primary">
        {ex.question}
      </p>
      {ex.running && (
        <div className="text-label text-text-tertiary" data-testid="ai-bot-running">
          <p>{t('dashboards.aiBot.core.thinking')}</p>
          {ex.steps.map((s, i) => <p key={i} className="truncate">· {s}</p>)}
        </div>
      )}
      {ex.error && (
        <div className="rounded-md bg-danger-bg p-3 text-caption" role="alert" data-testid="ai-bot-error">
          <p>{ex.error}</p>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry} disabled={busy} className="mt-1">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />{t('dashboards.aiBot.core.retry')}
          </Button>
        </div>
      )}
      {e && <EnvelopeView e={e} locale={locale} t={t} onRetry={onRetry} onPick={onPick} busy={busy} />}
      {!message.failed && !message.local && onRate && (
        <div className="flex items-center gap-1" data-testid="ai-bot-rating">
          {(['up', 'down'] as const).map((r) => (
            <button key={r} type="button" onClick={() => onRate(r)} aria-pressed={ex.rating === r}
                    aria-label={r === 'up' ? t('dashboards.aiBot.core.rateUp') : t('dashboards.aiBot.core.rateDown')}
                    data-testid={`ai-bot-rate-${r}`}
                    className={`rounded-md p-1 ${ex.rating === r ? 'bg-brand-subtle text-brand' : 'text-text-tertiary hover:bg-surface-2'}`}>
              {r === 'up' ? <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
                : <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function EnvelopeView({ e, locale, t, onRetry, onPick, busy }: {
  e: PublicAnswerEnvelope;
  locale: string;
  t: Translate;
  onRetry: () => void;
  onPick: (token: string) => void;
  busy: boolean;
}) {
  const data = e.data || null;
  const answer = data?.answer || null;
  const cols = useMemo(() => data?.columns || [], [data]);
  const rows = data?.rows || [];
  const ev = data?.evidence || null;
  const filters = [...(ev?.filters_described || []), ...(ev?.filters_applied || [])];
  const [allRows, setAllRows] = useState(false);
  const shown = allRows ? rows : rows.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="space-y-2">
      {e.status === 'answered' && answer && (
        <div className="rounded-lg border border-stroke-subtle p-3" data-testid="ai-bot-answer">
          {answer.headline && <p className="text-caption font-emphasis text-text-primary">{answer.headline}</p>}
          {(answer.bullets || []).length > 0 && (
            <ul className="mt-1 space-y-0.5 text-caption text-text-secondary">
              {(answer.bullets || []).map((b, i) => <li key={i}>• {b}</li>)}
            </ul>
          )}
          {answer.note && <p className="mt-1 text-label text-text-tertiary">{answer.note}</p>}
          {cols.length > 0 && rows.length > 0 && (
            <div className="mt-2 max-w-full overflow-x-auto">
              <table className="w-full text-label" data-testid="ai-bot-table">
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th key={c.name} className="px-1.5 py-1 text-left font-emphasis text-text-secondary">{c.label || c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={i} className="odd:bg-surface-2">
                      {cols.map((c) => (
                        <td key={c.name} className={`px-1.5 py-1 ${c.role === 'measure' ? 'text-right tabular-nums' : ''}`}>
                          {fmt(r[c.name], locale)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > shown.length && (
                <button
                  type="button"
                  className="mt-1 text-label text-text-link hover:underline"
                  data-testid="ai-bot-table-more"
                  onClick={() => setAllRows(true)}
                >
                  {t('dashboards.aiBot.core.showAllRows', { count: rows.length })}
                </button>
              )}
              {data?.truncated && (
                <p className="mt-1 text-label text-text-tertiary">{t('dashboards.aiBot.core.truncated')}</p>
              )}
            </div>
          )}
          {ev && (
            <div className="mt-2 space-y-0.5 text-label text-text-tertiary" data-testid="ai-bot-evidence">
              {ev.source && <p>{t('dashboards.aiBot.core.source', { source: ev.source })}</p>}
              {(ev.pages || []).length > 0 && <p>{t('dashboards.aiBot.core.pages', { pages: (ev.pages || []).join(', ') })}</p>}
              {filters.length > 0 && <p>{t('dashboards.aiBot.core.filters', { filters: filters.join('; ') })}</p>}
              {(ev.filters_withheld || 0) > 0 && (
                <p>{t('dashboards.aiBot.core.filtersWithheld', { count: ev.filters_withheld || 0 })}</p>
              )}
              {ev.freshness && ev.freshness !== 'live' && <p>{t('dashboards.aiBot.core.asOf', { asOf: ev.freshness })}</p>}
            </div>
          )}
        </div>
      )}
      {e.status === 'clarification_required' && (
        <div className="rounded-lg border border-stroke-subtle p-3 text-caption" data-testid="ai-bot-clarify">
          <p className="text-text-primary">{e.message || data?.message || t('dashboards.aiBot.core.pick')}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(data?.choices || []).filter((c) => c.token).map((c) => (
              <Button key={c.token} type="button" size="sm" variant="secondary" disabled={busy}
                      onClick={() => onPick(c.token as string)}>{c.label}</Button>
            ))}
            {(data?.choices || []).length === 0 && (data?.options || []).map((o) => (
              <span key={o} className="rounded-md bg-surface-2 px-2 py-1 text-label">{o}</span>
            ))}
          </div>
        </div>
      )}
      {e.status === 'refused' && (
        <p className="rounded-lg bg-warning-bg p-3 text-caption text-text-primary" role="status"
           data-testid="ai-bot-refused" data-code={e.code || ''}>
          {e.message || data?.message}
        </p>
      )}
      {e.code === 'documents_only' && (
        // no published data answers this; what follows comes from documents only (as AI Chat says)
        <p className="text-label text-text-tertiary" data-testid="ai-bot-no-data-part">
          {t('dashboards.aiBot.core.noDataPart')}
        </p>
      )}
      {e.status === 'failed' && (
        <div className="rounded-lg bg-danger-bg p-3 text-caption" role="alert" data-testid="ai-bot-failed"
             data-code={e.code || ''}>
          <p>{e.message || t('dashboards.aiBot.core.errorGeneric')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry} disabled={busy} className="mt-1">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />{t('dashboards.aiBot.core.retry')}
          </Button>
        </div>
      )}
      {e.status === 'cancelled' && (
        <p className="text-label text-text-tertiary" data-testid="ai-bot-cancelled">{t('dashboards.aiBot.core.cancelled')}</p>
      )}
      {e.supporting && ((e.supporting.documents || []).length > 0 || (e.supporting.findings || []).length > 0) && (
        <div className="rounded-lg border border-stroke-subtle p-3 text-caption" data-testid="ai-bot-supporting">
          <p className="mb-1 font-emphasis text-text-secondary">{t('dashboards.aiBot.core.documents')}</p>
          {(e.supporting.documents || []).map((d) => (
            <p key={d.doc_id} className="flex items-center gap-1 text-text-primary">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />{d.title || `#${d.doc_id}`}
            </p>
          ))}
          {(e.supporting.findings || []).map((f, i) => (
            <div key={i} className="mt-1">
              <p className="whitespace-pre-wrap text-text-secondary">{f.text}</p>
              {(f.unverified_figures || []).length > 0 && (
                <p className="text-label text-warning" data-testid="ai-bot-unverified">
                  {t('dashboards.aiBot.core.unverified', { figures: (f.unverified_figures || []).join(', ') })}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {(e.notices || []).length > 0 && (
        <div className="space-y-0.5 text-label text-text-tertiary" data-testid="ai-bot-notices">
          {(e.notices || []).map((n, i) => <p key={i}>{n.text}</p>)}
        </div>
      )}
    </div>
  );
}
