'use client';

/**
 * "Ask your Claude" — the viewer connects THEIR OWN Claude to the public report they have
 * open (Public Read MCP). Public surface: no signed-in client here (lib/api/public.ts only).
 *
 * Claude cannot be embedded in this page (claude.ai is not frameable and we do not try);
 * the supported layout is split screen: Claude in its own window, this report beside it,
 * kept in sync through the bridge (lib/public-mcp/bridge.ts).
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

export function PublicClaudePanel({ kind, token, sessionToken, viewState, apply, onClose }: PublicClaudePanelProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<BridgeStatus>('idle');
  const [detail, setDetail] = useState('');
  const [session, setSession] = useState<BridgeSession | null>(null);
  const [now, setNow] = useState(Date.now());
  const [log, setLog] = useState<Array<{ at: number; text: string; ok: boolean }>>([]);
  const bridgeRef = useRef<ReportBridge | null>(null);
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

  const start = useCallback(async () => {
    const b = new ReportBridge({
      apply: (cmd) => applyRef.current(cmd),
      getState: () => stateRef.current,
      onStatus: (s, d) => { setStatus(s); if (d) setDetail(d); },
      onCommand: (cmd, res) => setLog((l) => [{ at: Date.now(), text: describe(cmd, res), ok: res.ok }, ...l].slice(0, 12)),
    });
    bridgeRef.current = b;
    try {
      setSession(await b.start(kind, token, sessionToken));
    } catch (e: any) {
      setStatus('error');
      setDetail(e?.response?.data?.message || e?.message || '');
    }
  }, [kind, token, sessionToken, describe]);

  // the viewer's view changed (their own click or a command): tell their Claude
  useEffect(() => { void bridgeRef.current?.pushState(); }, [viewState]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    const end = () => { void bridgeRef.current?.stop(); };
    window.addEventListener('pagehide', end);
    return () => { clearInterval(id); window.removeEventListener('pagehide', end); end(); };
  }, []);

  const openClaude = () => {
    const w = Math.round(window.screen.availWidth * 0.42);
    window.open('https://claude.ai/new', 'appbi-claude',
      `popup=yes,width=${w},height=${window.screen.availHeight},left=${window.screen.availWidth - w},top=0`);
  };

  const minutes = session ? Math.max(0, Math.ceil((session.pairExpiresAt - now) / 60_000)) : 0;
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-slate-200 bg-white text-[13px] text-slate-700" data-testid="public-claude-panel">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div className="flex items-center gap-2 font-semibold text-slate-900"><Sparkles className="h-4 w-4 text-orange-500" />{t('publicClaude.title')}</div>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="close"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <p className="leading-relaxed text-slate-600">{t('publicClaude.intro')}</p>
        {status === 'idle' && (
          <button type="button" className="w-full rounded-md bg-slate-900 px-3 py-2 text-white hover:bg-slate-800" onClick={() => void start()} data-testid="public-claude-start">
            {t('publicClaude.start')}
          </button>
        )}
        {status === 'starting' && <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />{t('publicClaude.starting')}</div>}
        {status === 'error' && <div className="rounded-md bg-red-50 px-3 py-2 text-red-700" data-testid="public-claude-error">{t('publicClaude.error', { msg: detail })}</div>}
        {session && (status === 'waiting' || status === 'connected') && (
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
            <div className={`flex items-center gap-2 rounded-md px-3 py-2 ${status === 'connected' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-600'}`} data-testid="public-claude-status" data-status={status}>
              {status === 'connected' ? <Check className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
              {status === 'connected' ? t('publicClaude.connected') : t('publicClaude.waiting')}
            </div>
            <button type="button" className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 hover:bg-slate-50" onClick={openClaude}>
              <ExternalLink className="h-4 w-4" />{t('publicClaude.openClaude')}
            </button>
            <p className="text-[11px] leading-relaxed text-slate-500">{t('publicClaude.splitNote')}</p>
          </>
        )}
        {status === 'ended' && <div className="rounded-md bg-slate-50 px-3 py-2 text-slate-600" data-testid="public-claude-ended">{t('publicClaude.ended')}</div>}
        {log.length > 0 && (
          <div className="space-y-1" data-testid="public-claude-activity">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('publicClaude.activity')}</div>
            {log.map((l) => (
              <div key={l.at + l.text} className={`text-[12px] ${l.ok ? 'text-slate-700' : 'text-red-600'}`}>
                {new Date(l.at).toLocaleTimeString()} · {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
      {(status === 'waiting' || status === 'connected') && (
        <div className="border-t border-slate-200 px-4 py-2.5">
          <button type="button" className="inline-flex items-center gap-1.5 text-[12px] text-slate-600 hover:text-red-600" onClick={() => void bridgeRef.current?.stop()} data-testid="public-claude-disconnect">
            <Link2Off className="h-3.5 w-3.5" />{t('publicClaude.disconnect')}
          </button>
          <p className="mt-1 text-[11px] text-slate-400">{t('publicClaude.privacy')}</p>
        </div>
      )}
    </aside>
  );
}
