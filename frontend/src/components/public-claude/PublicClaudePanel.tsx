'use client';

/**
 * "Claude" beside a public report (Public Read MCP). Public surface: no signed-in client here
 * (lib/api/public.ts only).
 *
 * Default: AppBI's Claude runtime pool — the viewer gets their OWN Claude Code session (the
 * unmodified binary, in its own clean container), already connected to THIS report; they only
 * sign in to their Claude account through Anthropic's own flow. The panel shows it in a frame
 * served by AppBI's edge to this browser only (lease cookie).
 * Fallback: connect the Claude they use elsewhere (claude.ai / Desktop) with a pairing code.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Link2Off, Loader2, Sparkles, X } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';
import { ReportBridge, type ApplyResult, type BridgeCommand, type BridgeSession, type BridgeStatus } from '@/lib/public-mcp/bridge';

export interface PublicClaudePanelProps {
  kind: 'dashboard' | 'report';
  token: string;
  sessionToken?: string | null;
  /** What the viewer sees now; reported to the viewer's Claude whenever it changes. */
  viewState: Record<string, unknown>;
  apply: (cmd: BridgeCommand) => Promise<ApplyResult> | ApplyResult;
  onClose: () => void;
}

type Mode = 'intro' | 'runtime' | 'pair';

function CopyBox({ value, testId }: { value: string; testId: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[12px] text-slate-800" data-testid={testId}>{value}</code>
      <button type="button" className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50"
        onClick={() => { void navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>
        {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{done ? t('publicClaude.copied') : t('publicClaude.copy')}
      </button>
    </div>
  );
}

const SUGGESTIONS = ['publicClaude.ask1', 'publicClaude.ask2', 'publicClaude.ask3', 'publicClaude.ask4'];

export function PublicClaudePanel({ kind, token, sessionToken, viewState, apply, onClose }: PublicClaudePanelProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('intro');
  const [status, setStatus] = useState<BridgeStatus>('idle');
  const [detail, setDetail] = useState('');
  const [session, setSession] = useState<BridgeSession | null>(null);
  const [panelPath, setPanelPath] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [log, setLog] = useState<Array<{ at: number; text: string; ok: boolean }>>([]);
  const bridgeRef = useRef<ReportBridge | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const stateRef = useRef(viewState);
  stateRef.current = viewState;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const describe = useCallback((cmd: BridgeCommand, res: ApplyResult): string => {
    if (!res.ok) return t('publicClaude.cmd.failed', { msg: res.error || '' });
    if (cmd.type === 'go_to_page') return t('publicClaude.cmd.go_to_page', { x: cmd.page });
    if (cmd.type === 'drill') return t('publicClaude.cmd.drill', { x: String(cmd.value) });
    return t(`publicClaude.cmd.${cmd.type}`);
  }, [t]);

  const openBridge = useCallback(async () => {
    const b = new ReportBridge({
      apply: (cmd) => applyRef.current(cmd),
      getState: () => stateRef.current,
      onStatus: (s, d) => { setStatus(s); if (d) setDetail(d); },
      onCommand: (cmd, res) => setLog((l) => [{ at: Date.now(), text: describe(cmd, res), ok: res.ok }, ...l].slice(0, 12)),
    });
    bridgeRef.current = b;
    setSession(await b.start(kind, token, sessionToken));
    return b;
  }, [kind, token, sessionToken, describe]);

  const startRuntime = useCallback(async () => {
    setMode('runtime');
    try {
      const b = await openBridge();
      const r = await b.runtime();
      if ('error' in r) {
        setStatus('error');
        setDetail(r.error === 'pool_busy' ? t('publicClaude.rt.busy') : (r.message || r.error));
        return;
      }
      setPanelPath(r.panelPath);
    } catch (e: any) {
      setStatus('error');
      setDetail(e?.response?.data?.message || e?.message || '');
    }
  }, [openBridge, t]);

  const startPair = useCallback(async () => {
    setMode('pair');
    try { await openBridge(); } catch (e: any) { setStatus('error'); setDetail(e?.response?.data?.message || e?.message || ''); }
  }, [openBridge]);

  const ask = (key: string) => {
    // a suggested QUESTION typed into the viewer's own Claude prompt (never a credential)
    try {
      const w = frameRef.current?.contentWindow as any;
      w?.term?.paste?.(t(key));
      frameRef.current?.focus();
    } catch { /* the frame is not ready yet */ }
  };

  const end = async () => {
    await bridgeRef.current?.stop();
    setPanelPath(null);
    setMode('intro');
    setSession(null);
    setStatus('idle');
  };

  // the viewer's view changed (their own click or a command): tell their Claude
  useEffect(() => { void bridgeRef.current?.pushState(); }, [viewState]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    const endOnLeave = () => { void bridgeRef.current?.stop(); };
    window.addEventListener('pagehide', endOnLeave);
    return () => { clearInterval(id); window.removeEventListener('pagehide', endOnLeave); endOnLeave(); };
  }, []);
  useEffect(() => { if (status === 'connected') setShowGuide(false); }, [status]);

  const minutes = session ? Math.max(0, Math.ceil((session.pairExpiresAt - now) / 60_000)) : 0;
  const live = status === 'waiting' || status === 'connected';
  return (
    <aside className={`flex ${mode === 'runtime' ? 'w-[min(560px,46vw)]' : 'w-[360px]'} shrink-0 flex-col border-l border-slate-200 bg-white text-[13px] text-slate-700`} data-testid="public-claude-panel" data-mode={mode}>
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div className="flex items-center gap-2 font-semibold text-slate-900"><Sparkles className="h-4 w-4 text-orange-500" />{t('publicClaude.title')}</div>
        <div className="flex items-center gap-2">
          {live && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${status === 'connected' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
              data-testid="public-claude-status" data-status={status}>
              {status === 'connected' ? t('publicClaude.connected') : t('publicClaude.rt.notYet')}
            </span>
          )}
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="close"><X className="h-4 w-4" /></button>
        </div>
      </div>

      {mode === 'intro' && (
        <div className="space-y-4 px-4 py-4">
          <p className="leading-relaxed text-slate-600">{t('publicClaude.rt.intro')}</p>
          <button type="button" className="w-full rounded-md bg-slate-900 px-3 py-2.5 font-medium text-white hover:bg-slate-800"
            onClick={() => void startRuntime()} data-testid="public-claude-runtime-start">{t('publicClaude.rt.start')}</button>
          <ul className="space-y-1.5 text-[12px] text-slate-500">
            <li>• {t('publicClaude.rt.point1')}</li>
            <li>• {t('publicClaude.rt.point2')}</li>
            <li>• {t('publicClaude.rt.point3')}</li>
          </ul>
          <button type="button" className="text-[12px] text-slate-500 underline" onClick={() => void startPair()} data-testid="public-claude-start">
            {t('publicClaude.rt.elsewhere')}
          </button>
        </div>
      )}

      {mode === 'runtime' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {status === 'error' && <div className="m-4 rounded-md bg-red-50 px-3 py-2 text-red-700" data-testid="public-claude-error">{detail}</div>}
          {!panelPath && status !== 'error' && (
            <div className="flex items-center gap-2 px-4 py-6 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />{t('publicClaude.rt.starting')}</div>
          )}
          {panelPath && (
            <>
              {showGuide && (
                <div className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-[12px] leading-relaxed text-amber-900" data-testid="public-claude-guide">
                  <div className="mb-1 flex items-center justify-between font-semibold">
                    {t('publicClaude.rt.guideTitle')}
                    <button type="button" className="text-amber-700" onClick={() => setShowGuide(false)}><X className="h-3.5 w-3.5" /></button>
                  </div>
                  <ol className="list-decimal space-y-0.5 pl-4">
                    <li>{t('publicClaude.rt.g1')}</li>
                    <li>{t('publicClaude.rt.g2')}</li>
                    <li>{t('publicClaude.rt.g3')}</li>
                    <li>{t('publicClaude.rt.g4')}</li>
                  </ol>
                </div>
              )}
              <iframe ref={frameRef} src={panelPath} title="Claude" className="min-h-0 w-full flex-1 border-0" data-testid="public-claude-frame"
                allow="clipboard-read; clipboard-write" />
              <div className="flex flex-wrap gap-1.5 border-t border-slate-200 px-3 py-2">
                {SUGGESTIONS.map((k) => (
                  <button key={k} type="button" onClick={() => ask(k)}
                    className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] text-slate-600 hover:border-slate-300 hover:bg-slate-50">
                    {t(k)}
                  </button>
                ))}
              </div>
            </>
          )}
          {log.length > 0 && (
            <div className="max-h-24 overflow-y-auto border-t border-slate-100 px-4 py-1.5 text-[11px] text-slate-500" data-testid="public-claude-activity">
              {log.map((l) => <div key={l.at + l.text} className={l.ok ? '' : 'text-red-600'}>{new Date(l.at).toLocaleTimeString()} · {l.text}</div>)}
            </div>
          )}
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2">
            <span className="text-[11px] text-slate-400">{t('publicClaude.rt.privacy')}</span>
            <button type="button" className="inline-flex items-center gap-1.5 text-[12px] text-slate-600 hover:text-red-600" onClick={() => void end()} data-testid="public-claude-disconnect">
              <Link2Off className="h-3.5 w-3.5" />{t('publicClaude.rt.end')}
            </button>
          </div>
        </div>
      )}

      {mode === 'pair' && (
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {status === 'starting' && <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />{t('publicClaude.starting')}</div>}
          {status === 'error' && <div className="rounded-md bg-red-50 px-3 py-2 text-red-700" data-testid="public-claude-error">{t('publicClaude.error', { msg: detail })}</div>}
          {session && live && (
            <>
              <div className="space-y-1.5">
                <div className="text-[12px] text-slate-500">1. {t('publicClaude.step1')}</div>
                <CopyBox value={session.connectorUrl} testId="public-claude-url" />
              </div>
              {status === 'waiting' && (
                <div className="space-y-1.5">
                  <div className="text-[12px] text-slate-500">2. {t('publicClaude.step2')}</div>
                  <div className="font-mono text-2xl font-semibold tracking-[0.2em] text-slate-900" data-testid="public-claude-code">{session.pairCode}</div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>{minutes > 0 ? t('publicClaude.expires', { m: String(minutes) }) : t('publicClaude.expired')}</span>
                    <button type="button" className="text-slate-600 underline" onClick={async () => { await bridgeRef.current?.newCode(); setSession(bridgeRef.current?.session || null); }}>
                      {t('publicClaude.newCode')}
                    </button>
                  </div>
                </div>
              )}
              <button type="button" className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 hover:bg-slate-50"
                onClick={() => window.open('https://claude.ai/new', 'appbi-claude', 'popup=yes')}>
                <ExternalLink className="h-4 w-4" />{t('publicClaude.openClaude')}
              </button>
              <p className="text-[11px] leading-relaxed text-slate-500">{t('publicClaude.splitNote')}</p>
              {log.length > 0 && (
                <div className="space-y-1" data-testid="public-claude-activity">
                  {log.map((l) => <div key={l.at + l.text} className={`text-[12px] ${l.ok ? 'text-slate-700' : 'text-red-600'}`}>{new Date(l.at).toLocaleTimeString()} · {l.text}</div>)}
                </div>
              )}
              <button type="button" className="inline-flex items-center gap-1.5 text-[12px] text-slate-600 hover:text-red-600" onClick={() => void end()} data-testid="public-claude-disconnect">
                <Link2Off className="h-3.5 w-3.5" />{t('publicClaude.disconnect')}
              </button>
            </>
          )}
          {status === 'ended' && <div className="rounded-md bg-slate-50 px-3 py-2 text-slate-600" data-testid="public-claude-ended">{t('publicClaude.ended')}</div>}
        </div>
      )}
    </aside>
  );
}
