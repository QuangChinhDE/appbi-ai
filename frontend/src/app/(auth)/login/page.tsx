'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { BarChart3 } from 'lucide-react';

import { authConfig } from '@/lib/auth-config';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';

function extractDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object' && typeof (detail as { detail?: unknown }).detail === 'string') {
    return (detail as { detail: string }).detail;
  }
  return fallback;
}

export default function LoginPage() {
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const canUseGoogle = authConfig.googleEnabled && Boolean(authConfig.googleClientId);
  const canUsePassword = authConfig.passwordEnabled;

  const submitGoogleCredential = useCallback(async (credential: string) => {
    setError('');
    setGoogleLoading(true);
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      });
      const data = await res.json();
      if (!res.ok) throw { response: { status: res.status, data } };
      window.location.replace('/dashboards');
    } catch (err: any) {
      setError(extractDetail(err?.response?.data, 'Google sign-in failed. Please try again.'));
    } finally {
      setGoogleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canUseGoogle || !googleReady || !googleButtonRef.current || !window.google) return;
    googleButtonRef.current.innerHTML = '';
    window.google.accounts.id.initialize({
      client_id: authConfig.googleClientId,
      callback: (response) => { void submitGoogleCredential(response.credential); },
    });
    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: 320,
      logo_alignment: 'left',
    });
  }, [canUseGoogle, googleReady, submitGoogleCredential]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw { response: { status: res.status, data } };
      window.location.replace('/dashboards');
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (typeof detail === 'string') setError(detail);
      else if (err?.response?.status === 429) setError('Too many attempts. Please wait a minute and try again.');
      else setError('Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md">
      {authConfig.googleEnabled && (
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
          onLoad={() => setGoogleReady(true)}
        />
      )}

      <div className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] shadow-linear-lg p-7">
        <div className="flex flex-col items-center mb-7">
          <div className="w-10 h-10 bg-brand rounded-lg flex items-center justify-center mb-3">
            <BarChart3 className="h-5 w-5 text-text-inverse" />
          </div>
          <h1 className="text-h2 font-strong text-text-primary">AppBI</h1>
          <p className="text-text-tertiary text-caption mt-1">
            {canUseGoogle ? 'Sign in with your Google account' : 'Sign in to your account'}
          </p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-md bg-danger/8 border border-danger/25 text-danger text-caption">
            {error}
          </div>
        )}

        {!canUseGoogle && !canUsePassword && (
          <div className="rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-caption text-warning">
            Authentication is not configured yet. Enable Google sign-in or password login in the environment settings.
          </div>
        )}

        {canUseGoogle && (
          <div className="space-y-3">
            <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-secondary">
              Continue with the Google account that matches your AppBI user email.
            </div>
            <div className="flex justify-center">
              <div ref={googleButtonRef} className="min-h-11" />
            </div>
            {googleLoading && (
              <p className="text-center text-caption text-text-tertiary">Signing you in with Google...</p>
            )}
          </div>
        )}

        {authConfig.googleEnabled && !authConfig.googleClientId && (
          <div className="mt-4 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-caption text-warning">
            Google sign-in is enabled, but `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is missing.
          </div>
        )}

        {canUseGoogle && canUsePassword && (
          <div className="my-6 flex items-center gap-3 text-tiny uppercase tracking-[0.18em] text-text-quaternary">
            <div className="h-px flex-1 bg-[rgb(var(--border-line))]" />
            <span>or</span>
            <div className="h-px flex-1 bg-[rgb(var(--border-line))]" />
          </div>
        )}

        {canUsePassword && (
          <form onSubmit={handlePasswordSubmit} className="space-y-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email" required>Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password" required>Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="********"
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="md"
              fullWidth
              disabled={loading}
              loading={loading}
              className="mt-2"
            >
              {loading ? 'Signing in...' : 'Sign in with password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
