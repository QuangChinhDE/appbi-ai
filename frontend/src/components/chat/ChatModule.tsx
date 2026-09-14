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
  createThread, deleteThread, listChatBrains, listThreads, readThread, renameThread,
  streamChatTurn,
  type ChatBrain, type ChatMessage, type ChatThread, type ChatThreadDetail,
} from '@/lib/directChat';
import type { FlowOutputEnvelope } from '@/lib/agentFlows';
import { useI18n } from '@/providers/LanguageProvider';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';

import { AssistantCatalogue } from './AssistantCatalogue';
import { ConversationView } from './ConversationView';

export function ChatModule() {
  const { t } = useI18n();
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
  const abortRef = React.useRef<AbortController | null>(null);
  //: A thread whose transcript is ALREADY on screen because we are the ones
  //: writing it. Sending the first message creates the thread and puts its id in
  //: the URL, which wakes the loader below — and at that moment the server has
  //: nothing recorded yet, so it answered with an empty transcript and wiped the
  //: reply mid-stream. Consumed once, so revisiting the thread later still loads.
  const skipLoadRef = React.useRef<number | null>(null);

  const go = React.useCallback((brain: string, thread?: number) => {
    const q = new URLSearchParams();
    if (brain) q.set('brain', brain);
    if (thread) q.set('thread', String(thread));
    router.push(q.toString() ? `/chat?${q}` : '/chat');
  }, [router]);

  React.useEffect(() => {
    let alive = true;
    listChatBrains()
      .then((rows) => { if (alive) setBrains(rows); })
      .catch(() => { if (alive) setBrains([]); })
      .finally(() => { if (alive) setLoadingBrains(false); });
    return () => { alive = false; };
  }, []);

  // ALL threads, always — the catalogue shows a per-assistant count, and fetching
  // per assistant would be one request per card.
  const refreshThreads = React.useCallback(() => {
    listThreads().then(setThreads).catch(() => setThreads([]));
  }, []);
  React.useEffect(() => { refreshThreads(); }, [refreshThreads]);

  React.useEffect(() => {
    if (!threadId) { setDetail(null); setMessages([]); return; }
    if (skipLoadRef.current === threadId) { skipLoadRef.current = null; return; }
    let alive = true;
    setLoadingThread(true);
    readThread(threadId)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setMessages(d.messages || []);
      })
      .catch(() => { if (alive) { setDetail(null); setMessages([]); } })
      .finally(() => { if (alive) setLoadingThread(false); });
    return () => { alive = false; };
  }, [threadId]);

  const patchLast = (patch: Partial<ChatMessage>) => {
    setMessages((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  };

  const send = async () => {
    const question = input.trim();
    if (!question || streaming || !brainKey) return;

    // THE THREAD IS BORN HERE, not when the assistant was opened. Someone who
    // opens an assistant and leaves should not have left a row behind.
    let id = threadId;
    if (!id) {
      try {
        const th = await createThread(brainKey);
        id = th.id;
        skipLoadRef.current = id;
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
        const q = new URLSearchParams({ brain: brainKey, thread: String(id) });
        router.replace(`/chat?${q}`);
      } catch (e) {
        toast.error(errText(e, t('chat.error.create')));
        return;
      }
    }

    setInput('');
    setStreaming(true);
    setStatus('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: question },
      { role: 'assistant', content: '' },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = '';

    try {
      for await (const ev of streamChatTurn(id, question, controller.signal)) {
        switch (ev.type) {
          case 'text':
            streamed += ev.text || '';
            patchLast({ content: streamed });
            break;
          case 'status':
            setStatus(ev.text || '');
            break;
          case 'node_started':
            setStatus(ev.name ? t('chat.runningStep', { name: ev.name }) : t('chat.thinking'));
            break;
          case 'tool_result':
            if (!ev.ok && ev.error) setStatus(t('chat.toolFailed', { tool: ev.tool }));
            break;
          case 'result': {
            // THE TERMINAL ENVELOPE IS THE ANSWER. The streamed prose is what the
            // model said on the way; this is what the engine decided it produced —
            // typed blocks, the citations behind each figure, and any notice that
            // qualifies it.
            const env = ev.envelope;
            patchLast({
              content: streamed || plainFromBlocks(env),
              blocks: env?.answer?.blocks || [],
              citations: env?.citations || [],
              notices: env?.notices || [],
              status: env?.status,
            });
            break;
          }
          case 'error':
            patchLast({ content: `${streamed}\n\n_⚠️ ${ev.text}_` });
            break;
          default:
            break;
        }
      }
      refreshThreads();   // the server titles a thread from its first question
    } catch (e) {
      if (!controller.signal.aborted) {
        patchLast({ content: streamed, status: 'failed' });
        toast.error(errText(e, t('chat.error.send')));
      }
    } finally {
      setStreaming(false);
      setStatus('');
      abortRef.current = null;
    }
  };

  const doRename = async (id: number, title: string) => {
    try {
      const th = await renameThread(id, title);
      setThreads((prev) => prev.map((x) => (x.id === id ? th : x)));
      if (id === threadId) setDetail((d) => (d ? { ...d, title: th.title } : d));
    } catch (e) {
      toast.error(errText(e, t('chat.error.rename')));
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
      toast.error(errText(e, t('chat.error.delete')));
    }
  };

  const activeBrain = brains.find((b) => b.brain_key === brainKey) || null;

  return (
    <>
      {brainKey ? (
        <ConversationView
          brain={activeBrain}
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
          onStop={() => { abortRef.current?.abort(); setStreaming(false); setStatus(''); }}
          onBack={() => go('')}
          onNewThread={() => { setMessages([]); setDetail(null); go(brainKey); }}
          onOpenThread={(id) => go(brainKey, id)}
          onRename={doRename}
          onDelete={setDeleting}
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

function errText(e: unknown, fallback: string): string {
  const msg = (e as { message?: string })?.message;
  return msg && msg !== 'undefined' ? msg : fallback;
}
