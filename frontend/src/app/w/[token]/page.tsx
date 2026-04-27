'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Globe, Image as ImageIcon, Loader2, Lock } from 'lucide-react';

import WorkboardFormRenderer from '@/components/workboards/WorkboardFormRenderer';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input } from '@/components/ui/Input';
import type {
  WorkboardPublicPayload,
  WorkboardRenderViewResponse,
} from '@/lib/api/workboards';
import {
  clearPublicSession,
  getPublicSession,
  publicWorkboardApi,
  savePublicSession,
} from '@/lib/api/public';

export default function PublicWorkboardPage() {
  const params = useParams<{ token: string }>();
  const token = String(params.token || '');

  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(false);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<WorkboardPublicPayload | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formSeed, setFormSeed] = useState(0);

  useEffect(() => {
    if (!token) return;
    void loadPayload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function extractErrorMessage(err: unknown, fallback: string): string {
    if (typeof err === 'object' && err !== null) {
      const response = (err as { response?: { data?: { detail?: unknown } } }).response;
      const detail = response?.data?.detail;
      if (typeof detail === 'string' && detail.trim()) {
        return detail;
      }
    }
    return fallback;
  }

  async function loadPayload(sessionToken?: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await publicWorkboardApi.get(token, sessionToken || getPublicSession(token) || undefined);
      setPayload(data);
      setRequiresPassword(false);
    } catch (err: unknown) {
      const response = (err as { response?: { status?: number; headers?: Record<string, string> } }).response;
      const status = response?.status;
      const passwordHeader = response?.headers?.['x-link-password-required'];
      if (status === 401 && passwordHeader) {
        clearPublicSession(token);
        setRequiresPassword(true);
        setPayload(null);
      } else {
        setError(extractErrorMessage(err, 'Could not load shared workboard.'));
      }
    } finally {
      setLoading(false);
    }
  }

  async function authenticate() {
    if (!password.trim()) {
      setError('Password is required.');
      return;
    }
    setAuthLoading(true);
    setError(null);
    try {
      const { session_token, expires_in } = await publicWorkboardApi.auth(token, password);
      savePublicSession(token, session_token, expires_in);
      setPassword('');
      await loadPayload(session_token);
    } catch (err: unknown) {
      setError(extractErrorMessage(err, 'Incorrect password.'));
    } finally {
      setAuthLoading(false);
    }
  }

  async function submitForm(values: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    setSubmitMessage(null);
    try {
      await publicWorkboardApi.submit(token, values, getPublicSession(token) || undefined);
      setSubmitMessage('Form submitted successfully.');
      setFormSeed((current) => current + 1);
    } catch (err: unknown) {
      const detail = (
        err as { response?: { data?: { detail?: unknown } } }
      )?.response?.data?.detail;
      if (detail && typeof detail === 'object' && 'message' in detail) {
        setError(String((detail as { message?: unknown }).message ?? 'Submit failed.'));
      } else {
        setError(typeof detail === 'string' ? detail : 'Submit failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-base">
        <Loader2 className="h-7 w-7 animate-spin text-brand" />
      </div>
    );
  }

  if (requiresPassword) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-base px-4">
        <div className="w-full max-w-md rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-6 shadow-linear-sm">
          <div className="mb-4 flex items-center gap-2 text-text-primary">
            <Lock className="h-5 w-5 text-brand" />
            <h1 className="text-h3 font-emphasis">Password required</h1>
          </div>
          <FieldGroup label="Password" required>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void authenticate();
                }
              }}
              autoFocus
            />
          </FieldGroup>
          {error ? <p className="mt-3 text-caption text-red-600">{error}</p> : null}
          <div className="mt-4 flex justify-end">
            <Button
              variant="primary"
              onClick={() => void authenticate()}
              disabled={authLoading}
              leadingIcon={authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-base px-4">
        <div className="w-full max-w-xl rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-8 text-center shadow-linear-sm">
          <Globe className="mx-auto h-10 w-10 text-text-tertiary" />
          <p className="mt-4 text-body text-text-secondary">{error ?? 'Shared workboard not found.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-6 shadow-linear-sm">
          <div className="flex items-start gap-3">
            <Globe className="mt-0.5 h-5 w-5 text-brand" />
            <div className="min-w-0">
              <h1 className="text-h3 font-emphasis text-text-primary">
                {payload.link?.name || payload.workboard?.name}
              </h1>
              {payload.workboard?.description ? (
                <p className="mt-1 text-caption text-text-tertiary">{payload.workboard.description}</p>
              ) : null}
            </div>
          </div>
        </div>

        {payload.mode === 'form' && payload.form ? (
          <div className="space-y-3">
            {submitMessage ? (
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-caption text-emerald-700">
                {submitMessage}
              </div>
            ) : null}
            <WorkboardFormRenderer
              key={formSeed}
              form={payload.form}
              title={payload.form.title || payload.link?.name || payload.workboard?.name}
              submitLabel={payload.form.submit_label || 'Submit'}
              submitting={submitting}
              error={error}
              onSubmit={submitForm}
            />
          </div>
        ) : (
          <ReadonlyPublicView data={payload.rendered_view as WorkboardRenderViewResponse} />
        )}
      </div>
    </div>
  );
}

function ReadonlyPublicView({ data }: { data: WorkboardRenderViewResponse }) {
  const kind = data?.view?.kind;
  const rows = data?.rows ?? [];
  const cols = data?.columns ?? [];
  const titleCol = (data?.view?.config?.title_column as string) || data?.table?.label_column || cols[0];
  const imageCol =
    (data?.view?.config?.image_column as string)
    || cols.find((column) => /image|photo|url|logo/i.test(column));

  if (!data) {
    return (
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-8 text-caption text-text-tertiary">
        No public view configured.
      </div>
    );
  }

  if (kind === 'gallery') {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {rows.map((row, index) => (
          <div key={index} className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
            <div className="aspect-square bg-surface-2">
              {imageCol && row[imageCol] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={String(row[imageCol])} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                  <ImageIcon className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="px-3 py-2 text-caption font-emphasis text-text-primary">
              {String(row[titleCol] ?? '')}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (kind === 'deck') {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row, index) => (
          <div key={index} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-4">
            <div className="mb-2 text-body font-emphasis text-text-primary">
              {String(row[titleCol] ?? '')}
            </div>
            <dl className="space-y-1.5">
              {cols.filter((column) => column !== titleCol).slice(0, 4).map((column) => (
                <div key={column} className="grid grid-cols-2 gap-2">
                  <dt className="truncate text-label uppercase tracking-wide text-text-tertiary">{column}</dt>
                  <dd className="truncate text-caption text-text-secondary">{String(row[column] ?? '')}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="border-b border-[rgb(var(--border-line))] px-4 py-3 text-body font-emphasis text-text-primary">
        {data.view?.label}
      </div>
      <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
        <thead className="bg-surface-2">
          <tr>
            {cols.map((column) => (
              <th
                key={column}
                className="px-3 py-2 text-left text-label font-emphasis uppercase tracking-wide text-text-tertiary"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--border-line))]">
          {rows.map((row, index) => (
            <tr key={index}>
              {cols.map((column) => (
                <td key={column} className="px-3 py-2 text-caption text-text-primary">
                  {String(row[column] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
