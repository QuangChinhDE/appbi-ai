'use client';

/**
 * The password prompt of a protected public link — shared by the public dashboard
 * and the public AI Vibe Report. Public surface: no signed-in API client here.
 */
import { useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Loader2, Lock } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

export function PasswordGate({
  onSubmit,
  error,
  submitting,
  isReauth = false,
  description = 'This shared dashboard requires a password to view.',
  actionLabel = 'Unlock dashboard',
}: {
  onSubmit: (password: string) => void;
  error: string | null;
  submitting: boolean;
  isReauth?: boolean;
  description?: string;
  actionLabel?: string;
}) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0 px-4 py-8">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="border-b border-[rgb(var(--border-line))] px-6 py-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Lock className="h-5 w-5" />
          </div>
          <p className="text-tiny font-emphasis uppercase tracking-[0.18em] text-text-quaternary">
            Protected shared report
          </p>
          <h1 className="mt-2 text-h3 font-emphasis text-text-primary">
            {isReauth ? 'Session expired' : 'Password protected'}
          </h1>
          <p className="mt-2 text-caption text-text-tertiary">
            {isReauth
              ? 'Your 2-hour session ended. Enter the password again to continue.'
              : description}
          </p>
        </div>

        <div className="px-6 py-6">
          <label className="mb-1.5 block text-caption font-emphasis text-text-secondary">Password</label>
          <Input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value) {
                onSubmit(value);
              }
            }}
            placeholder="Enter password"
            autoFocus
            trailingIcon={
              <button
                type="button"
                onClick={() => setShow((current) => !current)}
                className="pointer-events-auto text-text-tertiary hover:text-text-primary"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            }
          />

          {error && (
            <p className="mt-3 flex items-center gap-1 text-tiny text-danger">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </p>
          )}

          <Button
            variant="primary"
            fullWidth
            className="mt-5"
            onClick={() => value && onSubmit(value)}
            disabled={submitting || !value}
            leadingIcon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          >
            {submitting ? 'Verifying...' : isReauth ? 'Continue viewing' : actionLabel}
          </Button>

          <p className="mt-4 text-center text-tiny text-text-quaternary">
            Sessions last 2 hours and keep the report read-only.
          </p>
        </div>
      </div>
    </div>
  );
}
