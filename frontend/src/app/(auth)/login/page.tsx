'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { BarChart3 } from 'lucide-react';

import { authConfig } from '@/lib/auth-config';

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
      if (!res.ok) {
        throw { response: { status: res.status, data } };
      }
      window.location.replace('/dashboards');
    } catch (err: any) {
      const fallback = 'Google sign-in failed. Please try again.';
      setError(extractDetail(err?.response?.data, fallback));
    } finally {
      setGoogleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canUseGoogle || !googleReady || !googleButtonRef.current || !window.google) {
      return;
    }

    googleButtonRef.current.innerHTML = '';
    window.google.accounts.id.initialize({
      client_id: authConfig.googleClientId,
      callback: (response) => {
        void submitGoogleCredential(response.credential);
      },
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
      if (!res.ok) {
        throw { response: { status: res.status, data } };
      }
      window.location.replace('/dashboards');
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (typeof detail === 'string') {
        setError(detail);
      } else if (err?.response?.status === 429) {
        setError('Too many attempts. Please wait a minute and try again.');
      } else {
        setError('Login failed. Please check your credentials.');
      }
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

      <div className="bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl flex items-center justify-center mb-3">
            <BarChart3 className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            AppBI
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            {canUseGoogle ? 'Sign in with your Google account' : 'Sign in to your account'}
          </p>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        {!canUseGoogle && !canUsePassword && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Authentication is not configured yet. Enable Google sign-in or password login in the environment settings.
          </div>
        )}

        {canUseGoogle && (
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Continue with the Google account that matches your AppBI user email.
            </div>
            <div className="flex justify-center">
              <div ref={googleButtonRef} className="min-h-11" />
            </div>
            {googleLoading && (
              <p className="text-center text-sm text-gray-500">Signing you in with Google...</p>
            )}
          </div>
        )}

        {authConfig.googleEnabled && !authConfig.googleClientId && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Google sign-in is enabled, but `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is missing.
          </div>
        )}

        {canUseGoogle && canUsePassword && (
          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-gray-400">
            <div className="h-px flex-1 bg-gray-200" />
            <span>or</span>
            <div className="h-px flex-1 bg-gray-200" />
          </div>
        )}

        {canUsePassword && (
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="********"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-gradient-to-r from-blue-600 to-purple-600 text-white text-sm font-medium rounded-lg hover:from-blue-700 hover:to-purple-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
            >
              {loading ? 'Signing in...' : 'Sign in with password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
