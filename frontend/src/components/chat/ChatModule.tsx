'use client';

/**
 * The Chat module: choose an assistant, then talk to it.
 *
 * TWO SCREENS, AND THE FIRST ONE IS A CATALOGUE. `/chat` is a module landing page
 * built from the same primitives as every other catalogue here; `?brain=…` opens
 * that assistant's conversations. The URL addresses both, so a link to a
 * conversation is a link to a conversation.
 *
 * This file owns the DATA and the turn; the two screens own their layout. Keeping
 * the stream here is deliberate — a conversation must survive the reader renaming a
 * thread or the sidebar re-rendering, and a stream owned by a screen dies with it.
 *
 * ONE TURN BELONGS TO ONE THREAD. Every update a stream makes is addressed to the
 * thread it was started in, and is dropped unless that thread is the one on screen.
 * Leaving the thread — opening another, starting a new one, going back to the
 * catalogue, closing the page — STOPS the turn: the server records it as abandoned,
 * so the thread shows honestly what happened when it is reopened. Before this, a
 * stream from thread A kept patching "the last message" of whatever was open, and
 * wrote A's answer into B.
 *
 * WHAT IT REUSES. The answer renderer (`RichMarkdown`, `AnswerBlocks`,
 * `CitationCards`) and the SSE parser are shared with the rest of the product, so an
 * answer looks the same here as in the Studio. What it does NOT inherit is the
 * public bot's surroundings — BYOK key panel, briefing wizard, recon, chart-scroll —
 * none of which exist without a dashboard.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import React from 'react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toast } from '@/lib/toast';
import {
  ChatHttpError,
  createThread, deleteThread, listChatBrains, listThreads, rateAnswer, readThread,
  renameThread, streamChatTurn,
  type ChatBrain, type ChatMessage, type ChatThread, type ChatThreadDetail,
} from '@/lib/directChat';
import type { FlowOutputEnvelope } from '@/lib/agentFlows';
import { useI18n } from '@/providers/LanguageProvider';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';

import { AssistantCatalogue } from './AssistantCatalogue';
import { ConversationView } from './ConversationView';

interface Turn {
  threadId: number;
  controller: AbortController;
}

export function ChatModule() {
  const { t, language } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { data: permData } = usePermissions();
  const brainKey = params.get('brain') || '';
  const threadId = Number(params.get('thread') || 0) || 0;

  const [brains, setBrains] = React.useState<ChatBrain[]>([]);
  const [threads, setThreads] = React.useState<ChatThread[]>([]);
  const [detail, setDetail] = React.useState<ChatThreadDetail | null>(null);
  const [loadingBrains, setLoadingBrains] = React.useState(true);
  const [loadingThread, setLoadingThread] = React.useState(false);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const [deleting, setDeleting] = React.useState<ChatThread | null>(null);

  //: The turn in flight, and the thread it belongs to.
  const turnRef = React.useRef<Turn | null>(null);
  //: The thread on screen RIGHT NOW. A ref, not the render's `threadId`: a stream
  //: callback closes over the render it started in, and asking that stale value
  //: "is this still the open thread?" always answers yes.
  const activeThreadRef = React.useRef(threadId);
  //: A thread this screen has just CREATED and is showing, before the router has
  //: put its id in the URL. Without it, a render in that gap reset the active
  //: thread to 0 and the turn's own updates were dropped — a send that failed
  //: fast lost its bubble and its "failed" label.
  const pendingThreadRef = React.useRef<number | null>(null);
  activeThreadRef.current = threadId || pendingThreadRef.current || 0;
  //: A thread whose transcript is ALREADY on screen because we are the ones
  //: writing it. Sending the first message creates the thread and puts its id in
  //: the URL, which wakes the loader below — and at that moment the server has
  //: nothing recorded yet, so it answered with an empty transcript and wiped the
  //: reply mid-stream. Consumed once, so revisiting the thread later still loads.
  const skipLoadRef = React.useRef<number | null>(null);

  const go = React.useCallback((brain: string, thread?: number, replace = false) => {
    const q = new URLSearchParams();
    if (brain) q.set('brain', brain);
    if (thread) q.set('thread', String(thread));
    const url = q.toString() ? `/chat?${q}` : '/chat';
    if (replace) router.replace(url); else router.push(url);
  }, [router]);

  React.useEffect(() => {
    let alive = true;
    // `language` ('en'|'vi'), NOT `locale` ('en-US'|'vi-VN'). Passing the locale
    // made the backend's `lang == "en"` check miss, so an English reader saw
    // Vietnamese capability chips — the labels are the one reader-facing
    // string the server produces here.
    listChatBrains(language)
      .then((rows) => { if (alive) setBrains(rows); })
      .catch(() => { if (alive) setBrains([]); })
      .finally(() => { if (alive) setLoadingBrains(false); });
    return () => { alive = false; };
    // Re-fetched on a language switch: the capability labels come from the
    // backend, so leaving this out would show Vietnamese classes on an English UI
    // until the next reload.
  }, [language]);

  // ALL threads, always — the catalogue shows a per-assistant count, and fetching
  // per assistant would be one request per card.
  const refreshThreads = React.useCallback(() => {
    listThreads().then(setThreads).catch(() => setThreads([]));
  }, []);
  React.useEffect(() => { refreshThreads(); }, [refreshThreads]);

  // LEAVING A THREAD STOPS ITS TURN. Opening another thread, starting a new one
  // and going back to the catalogue all change `threadId`; closing the page
  // unmounts. The server records the abandoned turn, so nothing is lost silently.
  React.useEffect(() => {
    // The URL has caught up with a thread we created; it is the truth again.
    if (threadId && pendingThreadRef.current === threadId) pendingThreadRef.current = null;
    const turn = turnRef.current;
    if (turn && turn.threadId && turn.threadId !== threadId && pendingThreadRef.current !== turn.threadId) {
      turn.controller.abort();
    }
  }, [threadId]);

  /** Leaving this conversation on purpose — back, or a new one — ends its turn,
   *  including one still creating its thread (which must not then navigate). */
  const leave = React.useCallback(() => {
    pendingThreadRef.current = null;
    turnRef.current?.controller.abort();
  }, []);
  React.useEffect(() => () => { turnRef.current?.controller.abort(); }, []);

  const loadThread = React.useCallback((id: number, opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoadingThread(true);
    return readThread(id, language)
      .then((d) => {
        if (activeThreadRef.current !== id) return;
        // A quiet refresh that lands after the NEXT question was sent would
        // replace that live turn with a record that does not contain it yet.
        if (opts.quiet && turnRef.current) return;
        setDetail(d);
        setMessages(d.messages || []);
      })
      .catch((e) => {
        if (activeThreadRef.current !== id) return;
        if (opts.quiet) return;
        setDetail(null);
        setMessages([]);
        // A STALE OR FOREIGN LINK is said, and the URL is put back on the
        // assistant — leaving the dead id there made the next question post to a
        // thread that answers 404, which read as "chat is broken".
        const st = (e as { response?: { status?: number } })?.response?.status;
        if (st === 404 || st === 403) {
          toast.error(t('chat.error.threadNotFound'));
          go(brainKey, undefined, true);
        }
      })
      .finally(() => { if (!opts.quiet && activeThreadRef.current === id) setLoadingThread(false); });
  }, [brainKey, go, language, t]);

  React.useEffect(() => {
    if (!threadId) { setDetail(null); setMessages([]); setLoadingThread(false); return; }
    if (skipLoadRef.current === threadId) { skipLoadRef.current = null; return; }
    loadThread(threadId);
    // `loadThread` changes with language; a language switch must not reload (and
    // wipe) a thread mid-turn, and the readonly sentence is translated by code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  /** Patch the assistant message of THIS turn — only while its thread is open. */
  const patchTurn = (turn: Turn, patch: Partial<ChatMessage>) => {
    if (activeThreadRef.current !== turn.threadId || turnRef.current !== turn) return;
    setMessages((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  };

  const send = async () => {
    const question = input.trim();
    // `turnRef`, not only `streaming`: two Enter presses inside one render both
    // saw `streaming === false` and created two threads, two turns.
    if (!question || streaming || turnRef.current || !brainKey) return;
    const controller = new AbortController();
    const turn: Turn = { threadId, controller };
    turnRef.current = turn;
    setStreaming(true);
    setStatus('');

    // THE THREAD IS BORN HERE, not when the assistant was opened. Someone who
    // opens an assistant and leaves should not have left a row behind.
    if (!turn.threadId) {
      try {
        const th = await createThread(brainKey);
        if (controller.signal.aborted) {
          // Left (Back / New conversation / Stop) while the thread was being
          // made: nothing was asked, so nothing is shown and nobody is moved.
          turnRef.current = null;
          setStreaming(false);
          refreshThreads();
          return;
        }
        turn.threadId = th.id;
        skipLoadRef.current = th.id;
        pendingThreadRef.current = th.id;
        activeThreadRef.current = th.id;
        setThreads((prev) => [th, ...prev.filter((x) => x.id !== th.id)]);
        setDetail({
          ...th,
          brain_name: brains.find((b) => b.brain_key === brainKey)?.name || '',
          // We just created it, so it is ours — stated rather than left undefined,
          // because `access` is what decides whether the Share button renders.
          access: 'owner' as const,
          readonly_reason: '',
          readonly_message: '',
          messages: [],
        });
        // `replace`, not `push`: the empty state and the first turn are the same
        // step of the same conversation, so Back should leave the assistant, not
        // return to a conversation that no longer looks like this.
        go(brainKey, th.id, true);
      } catch (e) {
        turnRef.current = null;
        setStreaming(false);
        toast.error(errText(e, t('chat.error.create'), t));
        return;
      }
    }

    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: question },
      { role: 'assistant', content: '' },
    ]);

    let streamed = '';
    let gotResult = false;
    let failed = false;

    try {
      for await (const ev of streamChatTurn(turn.threadId, question, language, controller.signal)) {
        switch (ev.type) {
          case 'text':
            streamed += ev.text || '';
            patchTurn(turn, { content: streamed });
            break;
          case 'status':
            if (activeThreadRef.current === turn.threadId) setStatus(ev.text || '');
            break;
          case 'node_started':
            if (activeThreadRef.current === turn.threadId) {
              setStatus(ev.name ? t('chat.runningStep', { name: ev.name }) : t('chat.thinking'));
            }
            break;
          case 'tool_result':
            if (!ev.ok && ev.error && activeThreadRef.current === turn.threadId) {
              setStatus(t('chat.toolFailed', { tool: ev.tool }));
            }
            break;
          case 'result': {
            // THE TERMINAL ENVELOPE IS THE ANSWER. The streamed prose is what the
            // model said on the way; this is what the engine decided it produced —
            // typed blocks, the citations behind each figure, and any notice that
            // qualifies it.
            const env = ev.envelope;
            gotResult = true;
            patchTurn(turn, {
              content: streamed || plainFromBlocks(env),
              blocks: env?.answer?.blocks || [],
              citations: env?.citations || [],
              notices: env?.notices || [],
              status: env?.status,
            });
            break;
          }
          case 'error':
            failed = true;
            patchTurn(turn, { content: `${streamed}\n\n_⚠️ ${ev.text}_`, status: 'failed' });
            break;
          default:
            break;
        }
      }
      // A stream that closed without a terminal result did NOT answer, whatever
      // prose arrived on the way. Saying so beats leaving a half-sentence that
      // looks like a finished reply.
      if (!gotResult && !failed && !controller.signal.aborted) {
        patchTurn(turn, { status: 'failed' });
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        // THE REASON GOES WHERE THE FAILURE IS — under the turn — not in a toast
        // that sat on top of the Send button the reader needs to retry.
        const reason = errText(e, t('chat.error.send'), t);
        patchTurn(turn, {
          content: streamed ? `${streamed}\n\n_⚠️ ${reason}_` : `_⚠️ ${reason}_`,
          status: 'failed',
        });
      }
    } finally {
      const stillMine = turnRef.current === turn;
      if (stillMine) turnRef.current = null;
      // A turn stopped while its thread is open says so; one that was left
      // behind by navigation is not drawn anywhere.
      if (controller.signal.aborted && activeThreadRef.current === turn.threadId) {
        setMessages((prev) => {
          if (!prev.length) return prev;
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1], status: 'stopped' };
          return next;
        });
      }
      if (stillMine) {
        setStreaming(false);
        setStatus('');
      }
      refreshThreads();   // the server titles a thread from its first question
      // THE SERVER'S RECORD REPLACES THE LIVE DRAFT once the turn is over, so
      // what is on screen is what reload will show — and the answer gains its
      // run id, which is what rating it needs. Quiet: no spinner, no wipe on error.
      // ONLY after a terminal result: a send refused before the server recorded
      // anything (HTTP 500, network) has no record, and refreshing would erase
      // the question and its "failed" label from under the reader.
      if (gotResult && !controller.signal.aborted && activeThreadRef.current === turn.threadId) {
        void loadThread(turn.threadId, { quiet: true });
      }
    }
  };

  const doRate = async (runId: number, rating: 'up' | 'down' | null) => {
    if (!threadId) return;
    const before = messages.find((m) => m.run_id === runId)?.rating ?? null;
    const set = (r: string | null) => setMessages((prev) => prev.map((m) => (
      m.run_id === runId ? { ...m, rating: r } : m)));
    set(rating);
    try {
      await rateAnswer(threadId, runId, rating);
    } catch (e) {
      set(before);
      toast.error(errText(e, t('chat.error.rate'), t));
    }
  };

  const doRename = async (id: number, title: string) => {
    try {
      const th = await renameThread(id, title);
      setThreads((prev) => prev.map((x) => (x.id === id ? { ...x, ...th } : x)));
      if (id === threadId) setDetail((d) => (d ? { ...d, title: th.title } : d));
    } catch (e) {
      toast.error(errText(e, t('chat.error.rename'), t));
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await deleteThread(deleting.id);
      setThreads((prev) => prev.filter((x) => x.id !== deleting.id));
      if (deleting.id === threadId) go(brainKey);
      setDeleting(null);
    } catch (e) {
      toast.error(errText(e, t('chat.error.delete'), t));
    }
  };

  const activeBrain = brains.find((b) => b.brain_key === brainKey) || null;

  return (
    <>
      {brainKey ? (
        <ConversationView
          brain={activeBrain}
          brainsLoaded={!loadingBrains}
          threads={threads.filter((x) => x.brain_key === brainKey)}
          detail={detail}
          threadId={threadId}
          messages={messages}
          loadingThread={loadingThread}
          streaming={streaming}
          status={status}
          input={input}
          onInputChange={setInput}
          onSend={send}
          onStop={() => turnRef.current?.controller.abort()}
          onBack={() => { leave(); go(''); }}
          onNewThread={() => { leave(); setMessages([]); setDetail(null); go(brainKey); }}
          onOpenThread={(id) => { if (id !== threadId) leave(); go(brainKey, id); }}
          onRename={doRename}
          onDelete={setDeleting}
          onRate={doRate}
        />
      ) : (
        <AssistantCatalogue
          brains={brains}
          threads={threads}
          loading={loadingBrains}
          canBuild={hasPermission(permData?.permissions, 'agent_flows', 'edit')}
          onOpen={(key) => {
            // Straight into the assistant's most recent conversation when there is
            // one. A reader coming back to an assistant almost always means "carry
            // on", and making them pick from a list first is a step that answers a
            // question they did not ask.
            const last = threads.find((x) => x.brain_key === key);
            go(key, last?.id);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={doDelete}
        title={t('chat.delete.title')}
        description={t('chat.delete.description', { title: deleting?.title || t('chat.untitled') })}
        confirmLabel={t('chat.delete')}
        variant="danger"
      />
    </>
  );
}

/** A fallback for the rare turn that produced blocks but streamed no prose. Only
 *  `text` blocks have words; the rest are rendered, not flattened. */
function plainFromBlocks(env: FlowOutputEnvelope | null | undefined): string {
  return (env?.answer?.blocks || [])
    .map((b) => (b.type === 'text' ? b.markdown : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** A refusal in the reader's language. A status the server decided before the
 *  stream opened is worded here; 429 keeps the server's sentence, which carries
 *  the quota figures. */
function errText(
  e: unknown, fallback: string, t: (k: string) => string,
): string {
  const status = e instanceof ChatHttpError
    ? e.status
    : (e as { response?: { status?: number } })?.response?.status;
  if (status === 403) return t('chat.error.readOnly');
  if (status === 404) return t('chat.error.notFound');
  if (status === 409) return t('chat.error.noKey');
  // ONLY the quota refusal carries a server sentence worth showing (its limits).
  // Anything else — a 500, a proxy page, a network error — is worded here: raw
  // server text is not a reader message and may carry internals.
  if (status === 429) {
    const msg = e as { message?: string; response?: { data?: { detail?: unknown } } };
    const detail = e instanceof ChatHttpError ? msg.message : msg?.response?.data?.detail;
    if (typeof detail === 'string' && detail) return detail;
  }
  return fallback;
}
