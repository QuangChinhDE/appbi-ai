'use client';

/**
 * First-time Claude sign-in, inside the AI Bot chat. Anthropic's own flow, step by step:
 *  1. "Sign in to Claude" asks the viewer's runtime to start Claude Code's own
 *     `claude auth login --claudeai` and opens the Anthropic sign-in URL it prints (new tab);
 *  2. Anthropic shows the viewer a code (their redirect, fixed by Anthropic: it cannot be sent
 *     back to AppBI, by design);
 *  3. "Paste code and confirm" hands that code to the waiting `claude auth login`, which
 *     exchanges it with Anthropic. AppBI does not store or log it.
 *
 * Fewer clicks: Anthropic opens in a popup; once the viewer presses "Copy Code" there and comes
 * back (popup closed or this tab focused), the code is read from THEIR clipboard (the browser
 * asks them once) and confirmed by itself; a paste anywhere in the panel does the same. The
 * cross-origin popup itself can never be read — that is the browser's rule, not ours.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardPaste, ExternalLink, Loader2 } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';

export function ClaudeSignIn({ base, onSignedIn }: { base: string; onSignedIn: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<'idle' | 'opening' | 'waiting' | 'checking'>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const popupRef = useRef<Window | null>(null);
  const triedRef = useRef<string>('');
  const stepRef = useRef(step);
  stepRef.current = step;

  const open = async () => {
    setError('');
    setStep('opening');
    triedRef.current = '';
    // open the popup synchronously (popup blockers), then point it at Anthropic's URL
    const w = 520, h = 720;
    const left = Math.max(0, (window.screenX || 0) + (window.outerWidth - w) / 2);
    const top = Math.max(0, (window.screenY || 0) + (window.outerHeight - h) / 2);
    const tab = window.open('about:blank', 'appbi-claude-signin', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
    popupRef.current = tab;
    try {
      const r = await fetch(`${base}api/signin/start`, { method: 'POST', credentials: 'include' });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (tab) tab.location.href = j.url; else window.open(j.url, '_blank');
      setStep('waiting');
    } catch (e: any) {
      tab?.close();
      setError(t('publicClaude.signin.startFailed'));
      setStep('idle');
    }
  };

  const confirm = async (value: string) => {
    const v = value.trim();
    if (!v) return;
    setError('');
    setStep('checking');
    try {
      const r = await fetch(`${base}api/signin/code`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: v }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setCode('');
        try { popupRef.current?.close(); } catch { /* already closed */ }
        onSignedIn();
        return;
      }
      setError(j?.error === 'no_signin' ? t('publicClaude.signin.restart') : t('publicClaude.signin.rejected'));
      setStep(j?.error === 'no_signin' || j?.error === 'code_rejected' ? 'idle' : 'waiting');
    } catch {
      setError(t('publicClaude.signin.rejected'));
      setStep('waiting');
    }
  };

  // A copied Anthropic code: "<code>#<state>", no spaces. Anything else in the clipboard is left alone.
  const looksLikeCode = (v: string) => /^[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{10,}$/.test(v.trim());

  const tryClipboard = useCallback(async () => {
    if (stepRef.current !== 'waiting' || !navigator.clipboard?.readText) return;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (looksLikeCode(text) && text !== triedRef.current) {
        triedRef.current = text;
        setCode(text);
        await confirm(text);
      }
    } catch { /* not focused / not allowed: the buttons below still work */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the viewer comes back from the popup (closed it, or switched back): pick the code up
  useEffect(() => {
    if (step !== 'waiting') return;
    const onFocus = () => { void tryClipboard(); };
    const onPaste = (e: ClipboardEvent) => {
      const text = (e.clipboardData?.getData('text') || '').trim();
      if (looksLikeCode(text) && text !== triedRef.current) { e.preventDefault(); triedRef.current = text; setCode(text); void confirm(text); }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    document.addEventListener('paste', onPaste);
    const closedPoll = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) { popupRef.current = null; void tryClipboard(); }
    }, 600);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      document.removeEventListener('paste', onPaste);
      window.clearInterval(closedPoll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, tryClipboard]);

  const pasteAndConfirm = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) { setCode(text.trim()); await confirm(text); return; }
    } catch { /* the browser refused clipboard access: the field below still works */ }
    setError(t('publicClaude.signin.pasteManually'));
  };

  return (
    <div data-testid="claude-signin" className="space-y-2.5">
      <div>
        <p className="font-emphasis text-text-primary">{t('publicClaude.signin.title')}</p>
        <p className="mt-0.5 text-tiny text-text-secondary">{t('publicClaude.signin.intro')}</p>
      </div>

      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand/10 text-micro font-strong text-brand">1</span>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => void open()} disabled={step === 'opening' || step === 'checking'} data-testid="claude-signin-open"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#d97757] px-3 py-2 text-caption font-emphasis text-white shadow-sm transition-colors hover:bg-[#c4643f] disabled:opacity-60">
            {step === 'opening' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
            {t('publicClaude.signin.open')}
          </button>
          <p className="mt-1 text-micro text-text-tertiary">{t('publicClaude.signin.openHint')}</p>
          {step === 'waiting' && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-micro text-brand" data-testid="claude-signin-waiting">
              <Loader2 className="h-3 w-3 animate-spin" />{t('publicClaude.signin.waitingCode')}
            </p>
          )}
        </div>
      </div>

      <div className={`flex items-start gap-2 ${step === 'idle' || step === 'opening' ? 'opacity-50' : ''}`}>
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand/10 text-micro font-strong text-brand">2</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <button type="button" onClick={() => void pasteAndConfirm()} disabled={step === 'idle' || step === 'opening' || step === 'checking'}
            data-testid="claude-signin-paste"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-caption font-emphasis text-white shadow-sm transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50">
            {step === 'checking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardPaste className="h-3.5 w-3.5" />}
            {step === 'checking' ? t('publicClaude.signin.checking') : t('publicClaude.signin.paste')}
          </button>
          <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void confirm(code); }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} disabled={step === 'idle' || step === 'opening' || step === 'checking'}
              placeholder={t('publicClaude.signin.codePlaceholder')} autoComplete="off" spellCheck={false} data-testid="claude-signin-code"
              className="min-w-0 flex-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1.5 font-mono text-tiny text-text-primary placeholder:font-sans placeholder:text-text-quaternary focus:border-brand/60 focus:outline-none" />
            <button type="submit" disabled={!code.trim() || step === 'checking'}
              className="rounded-lg border border-[rgb(var(--border-line))] px-2.5 text-tiny text-text-secondary hover:bg-surface-2 disabled:opacity-40">OK</button>
          </form>
        </div>
      </div>

      {error && <p className="rounded-md bg-danger/5 px-2 py-1.5 text-tiny text-danger" role="alert" data-testid="claude-signin-error">{error}</p>}
    </div>
  );
}
