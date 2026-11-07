'use client';

/**
 * Claude as the AI Bot's engine on a public report: the SAME chat look as AppBI's AI Bot,
 * answered by the viewer's OWN Claude (their subscription) running in AppBI's runtime pool.
 *
 * - AppBI leases this viewer a private Claude Code runtime, already connected to THIS report
 *   through the Public Read MCP (no pairing code).
 * - First time only: the viewer signs in with Claude Code's own `claude auth login`, shown
 *   compact inside the chat; sign-in completes with Anthropic in their browser. AppBI never
 *   reads or keeps their Claude credential.
 * - Each question goes to Claude Code (`claude -p`, stream-json) in that runtime; the report on
 *   screen follows the view changes Claude makes (filters, page, highlighted chart, drill).
 * Public surface: lib/api/public.ts and same-origin runtime paths only (no signed-in client).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send, Square } from 'lucide-react';

import { ClaudeSignIn } from '@/components/public-claude/ClaudeSignIn';
import { renderMarkdown } from '@/lib/dashboard-markdown';
import { ReportBridge, type ApplyResult, type BridgeCommand } from '@/lib/public-mcp/bridge';
import { useI18n } from '@/providers/LanguageProvider';

export interface ClaudeEngineProps {
  kind: 'dashboard' | 'report';
  token: string;
  sessionToken?: string | null;
  viewState: Record<string, unknown>;
  /** The publisher keeps this conversation (a notice is shown before the first question). */
  keepsHistory?: boolean;
  apply: (cmd: BridgeCommand) => Promise<ApplyResult> | ApplyResult;
}

type Phase = 'starting' | 'signin' | 'ready' | 'error';
interface Turn { id: string; question: string; answer: string; steps: string[]; running: boolean; error?: string }

const TOOL_KEYS: Record<string, string> = {
  get_report_context: 'publicClaude.chat.tool.context', get_view_state: 'publicClaude.chat.tool.view',
  read_chart: 'publicClaude.chat.tool.read', list_filter_values: 'publicClaude.chat.tool.values',
  calculate: 'publicClaude.chat.tool.calc', set_filters: 'publicClaude.chat.tool.filter',
  reset_filters: 'publicClaude.chat.tool.reset', go_to_page: 'publicClaude.chat.tool.page',
  focus_chart: 'publicClaude.chat.tool.focus', drill_down: 'publicClaude.chat.tool.drill',
  clear_drill_down: 'publicClaude.chat.tool.undrill',
};

function Bubble({ side, tone, children }: { side: 'user' | 'assistant'; tone?: 'warning' | 'danger'; children: React.ReactNode }) {
  const look = side === 'user'
    ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3 py-2 text-caption text-white shadow-sm'
    : `mr-auto w-full rounded-2xl rounded-bl-md border px-3 py-2 text-caption shadow-sm ${tone === 'danger'
      ? 'border-danger/30 bg-danger/5 text-danger' : tone === 'warning' ? 'border-warning/30 bg-warning/5 text-text-primary'
        : 'border-[rgb(var(--border-line))]/70 bg-surface-2 text-text-primary'}`;
  return <div className={look}>{children}</div>;
}

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

export function ClaudeChat({ engine, dashboardName, starters, resetSignal }: {
  engine: ClaudeEngineProps; dashboardName?: string; starters: string[]; resetSignal: number;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const bridgeRef = useRef<ReportBridge | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(engine.viewState);
  stateRef.current = engine.viewState;
  const applyRef = useRef(engine.apply);
  applyRef.current = engine.apply;

  const start = useCallback(async () => {
    setPhase('starting');
    setError('');
    try {
      const b = new ReportBridge({ apply: (c) => applyRef.current(c), getState: () => stateRef.current, onStatus: () => {} });
      bridgeRef.current = b;
      await b.start(engine.kind, engine.token, engine.sessionToken);
      const r = await b.runtime();
      if ('error' in r) {
        setError(r.error === 'pool_busy' ? t('publicClaude.rt.busy') : (r.message || t('publicClaude.rt.failed')));
        setPhase('error');
        void b.stop();
        return;
      }
      setBase(r.panelPath);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || t('publicClaude.rt.failed'));
      setPhase('error');
    }
  }, [engine.kind, engine.token, engine.sessionToken, t]);

  // Leaving the page (reload, navigation, closing the tab) only DETACHES: a reload of this tab
  // rejoins the same session, runtime, sign-in and conversation; a tab that never comes back is
  // ended by the service after a few minutes. Only "End session" ends it on purpose.
  useEffect(() => { void start(); return () => { bridgeRef.current?.detach(); }; }, [start]);
  useEffect(() => {
    const leave = () => { bridgeRef.current?.detach(); };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);

  // the conversation so far, kept by the runtime (a reload shows it again; Claude resumes it)
  useEffect(() => {
    if (!base) return;
    void (async () => {
      try {
        const r = await fetch(`${base}api/history`, { credentials: 'include', cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        const kept: Turn[] = (j.turns || []).map((x: any) => ({
          id: newId(), question: String(x.question || ''), answer: String(x.answer || ''),
          steps: (x.tools || []).map((n: string) => (TOOL_KEYS[n] ? t(TOOL_KEYS[n]) : n)), running: false,
          error: x.error ? t('publicClaude.chat.failed') : undefined,
        }));
        setTurns((now) => (now.length ? now : kept));
      } catch { /* a fresh runtime: nothing to show */ }
    })();
  }, [base, t]);
  // the viewer's view changed (their click or Claude's command): Claude reads the same view
  useEffect(() => { void bridgeRef.current?.pushState(); }, [engine.viewState]);

  // signed in yet? (Claude Code's own `claude auth status`, in the viewer's runtime)
  useEffect(() => {
    if (!base) return undefined;
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`${base}api/status`, { credentials: 'include', cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setPhase(j.signed_in ? 'ready' : 'signin');
      } catch { /* the runtime is starting */ }
    };
    void check();
    const id = setInterval(() => { if (phase !== 'ready') void check(); }, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [base, phase]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns, phase]);

  useEffect(() => {
    if (!resetSignal || !base) return;
    setTurns([]);
    void fetch(`${base}api/reset`, { method: 'POST', credentials: 'include' });
  }, [resetSignal, base]);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || busy || !base || phase !== 'ready') return;
    const id = newId();
    setQuestion('');
    setBusy(true);
    setTurns((all) => [...all, { id, question: text, answer: '', steps: [], running: true }]);
    const patch = (fn: (x: Turn) => Turn) => setTurns((all) => all.map((x) => (x.id === id ? fn(x) : x)));
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const r = await fetch(`${base}api/chat`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }), signal: ctl.signal,
      });
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let finalText = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'assistant') {
            for (const part of ev.message?.content || []) {
              if (part.type === 'text' && part.text) {
                const add = String(part.text);
                patch((x) => ({ ...x, answer: x.answer ? `${x.answer}\n\n${add}` : add }));
              } else if (part.type === 'tool_use') {
                const tool = String(part.name || '').replace(/^mcp__appbi-report__/, '');
                const key = TOOL_KEYS[tool];
                patch((x) => ({ ...x, steps: [...x.steps, key ? t(key) : tool] }));
              }
            }
          } else if (ev.type === 'result') {
            finalText = String(ev.result || '');
            if (ev.is_error) patch((x) => ({ ...x, error: finalText || t('publicClaude.chat.failed') }));
          } else if (ev.type === 'agent_error') {
            const msg = String(ev.message || '');
            patch((x) => ({ ...x, error: /log ?in|auth/i.test(msg) ? t('publicClaude.chat.signedOut') : t('publicClaude.chat.failed') }));
            if (/log ?in|auth/i.test(msg)) setPhase('signin');
          }
        }
      }
      // the final result is the authoritative answer text when Claude streamed nothing else
      patch((x) => ({ ...x, answer: x.answer || finalText, running: false }));
    } catch (e: any) {
      patch((x) => ({ ...x, running: false, error: e?.name === 'AbortError' ? t('publicClaude.chat.stopped') : (e?.message || t('publicClaude.chat.failed')) }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="claude-chat-history">
        {phase === 'starting' && (
          <Bubble side="assistant"><span className="inline-flex items-center gap-2 text-text-secondary"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('publicClaude.rt.starting')}</span></Bubble>
        )}
        {phase === 'error' && (
          <Bubble side="assistant" tone="danger">
            <p data-testid="claude-chat-error">{error}</p>
            <button type="button" className="mt-1 text-tiny underline" onClick={() => void start()}>{t('publicClaude.rt.retry')}</button>
          </Bubble>
        )}
        {phase === 'signin' && base && (
          <Bubble side="assistant"><ClaudeSignIn base={base} onSignedIn={() => setPhase('ready')} /></Bubble>
        )}
        {phase === 'ready' && turns.length === 0 && (
          <Bubble side="assistant">
            <div data-testid="claude-chat-empty">
              <p className="font-emphasis text-text-primary">{t('publicClaude.chat.welcome', { name: dashboardName || '' })}</p>
              <p className="mt-1 text-text-secondary">{t('publicClaude.chat.empty')}</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {starters.map((q) => (
                  <button key={q} type="button" onClick={() => { void ask(q); }} disabled={busy} data-testid="claude-chat-suggestion"
                    className="w-full rounded-lg border border-brand/30 bg-brand/5 px-2.5 py-1.5 text-left text-tiny font-emphasis text-brand transition-colors hover:bg-brand/15 disabled:opacity-50">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </Bubble>
        )}
        {turns.map((x) => (
          <article key={x.id} className="flex flex-col gap-1.5" data-testid="claude-chat-exchange">
            <Bubble side="user">{x.question}</Bubble>
            <Bubble side="assistant" tone={x.error ? 'danger' : undefined}>
              {x.steps.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1" data-testid="claude-chat-steps">
                  {x.steps.map((s, i) => (
                    <span key={i} className="rounded-full bg-brand/10 px-2 py-0.5 text-micro text-brand">{s}</span>
                  ))}
                </div>
              )}
              {x.answer && <div className="prose-sm max-w-none text-caption [&_table]:my-1.5 [&_table]:text-label [&_td]:px-1.5 [&_th]:px-1.5" data-testid="claude-chat-answer">{renderMarkdown(x.answer)}</div>}
              {x.running && !x.answer && (
                <span className="inline-flex items-center gap-2 text-text-secondary"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('publicClaude.chat.thinking')}</span>
              )}
              {x.error && <p className="mt-1 text-tiny" data-testid="claude-chat-turn-error">{x.error}</p>}
            </Bubble>
          </article>
        ))}
        <div ref={bottomRef} />
      </div>

      <form className="flex-shrink-0 border-t border-[rgb(var(--border-line))]/60 bg-gradient-to-t from-surface-2/80 to-surface-1 p-3"
        onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
        <div className="flex items-end gap-2 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 shadow-sm transition-all focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/20">
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={1} maxLength={4000}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(question); } }}
            placeholder={t('publicClaude.chat.placeholder')} disabled={phase !== 'ready'} style={{ maxHeight: 120 }}
            className="min-h-[28px] min-w-0 flex-1 resize-none border-0 bg-transparent text-caption text-text-primary placeholder:text-text-quaternary focus:outline-none focus:ring-0"
            data-testid="claude-chat-input" aria-label={t('publicClaude.chat.placeholder')} />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} data-testid="claude-chat-stop"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-danger/90 text-white shadow-sm hover:bg-danger">
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" disabled={!question.trim() || phase !== 'ready'} data-testid="claude-chat-send"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand text-white shadow-sm hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40">
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        {engine.keepsHistory && (
          <p className="mt-1.5 px-1 text-micro text-text-tertiary" data-testid="claude-chat-history-notice">{t('publicClaude.chat.historyNotice')}</p>
        )}
        <div className="mt-1.5 flex items-center justify-between px-1 text-micro text-text-quaternary">
          <span>{t('publicClaude.chat.hint')}</span>
          {base && (
            <button type="button" className="underline hover:text-danger" data-testid="claude-chat-end"
              onClick={async () => { await bridgeRef.current?.stop(); setBase(null); setTurns([]); setPhase('starting'); void start(); }}>
              {t('publicClaude.rt.end')}
            </button>
          )}
        </div>
      </form>
    </>
  );
}
