/**
 * WorkboardPreview — split-screen iframe preview of the public mini-app.
 *
 * Picks a workspace that can host this workboard preview, asks the backend to
 * mint a "preview session" cookie under a chosen role/username, then
 * embeds the public ``/ws/{token}/workboards/{id}`` URL in an iframe.
 *
 * Because the cookie is httpOnly + scoped to the same origin, the iframe
 * can fetch the public API exactly as a real worker would — RLS rules
 * apply, write enforcement happens, and IT/DE sees the actual end-user
 * experience without leaving the Builder tab.
 */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, UserCheck } from 'lucide-react';

import type { Workboard } from '@/lib/api/workboards';
import { apiClient } from '@/lib/api-client';

interface Props {
  workboard: Workboard;
}

interface WorkspaceLite {
  id: number;
  slug: string;
  name: string;
  token: string;
  app_users_config?: Record<string, unknown> | null;
  menu_config: Array<{ workboard_slug: string }>;
}

function isWorkboardLinked(ws: WorkspaceLite, slug: string) {
  return (ws.menu_config || []).some((m) => m.workboard_slug === slug);
}

function hasAppUsersConfig(ws: WorkspaceLite) {
  return Boolean(ws.app_users_config && Object.keys(ws.app_users_config).length > 0);
}

function sortPreviewWorkspaces(data: WorkspaceLite[], slug: string) {
  return [...data].sort((a, b) => {
    const score = (ws: WorkspaceLite) =>
      (hasAppUsersConfig(ws) ? 4 : 0) + (isWorkboardLinked(ws, slug) ? 1 : 0);
    return score(b) - score(a);
  });
}

function getApiErrorMessage(error: unknown, fallback: string) {
  const maybeApiError = error as { response?: { data?: { detail?: unknown } } };
  const detail = maybeApiError.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

const DEMO_ACCOUNTS: Array<{ u: string; p: string; r: string; t: string }> = [
  { u: 'lead01', p: '111111', r: 'team_lead', t: 'A / 1' },
  { u: 'lead02', p: '222222', r: 'team_lead', t: 'B / 2' },
  { u: 'w001', p: '100001', r: 'worker', t: 'A / 1' },
  { u: 'w002', p: '100002', r: 'worker', t: 'A / 1' },
  { u: 'w003', p: '100003', r: 'worker', t: 'A / 1' },
  { u: 'w004', p: '100004', r: 'worker', t: 'B / 2' },
  { u: 'w005', p: '100005', r: 'worker', t: 'B / 2' },
];

export default function WorkboardPreview({ workboard }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceLite | null>(null);
  const [previewUsername, setPreviewUsername] = useState('lead01');
  const [iframeKey, setIframeKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workboardSlug = workboard.slug ?? '';

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiClient.get<WorkspaceLite[]>('/workspaces');
        const data = r.data || [];
        if (!alive) return;
        const ordered = sortPreviewWorkspaces(data, workboardSlug);
        setWorkspaces(ordered);
        setActiveWorkspace(ordered[0] ?? null);
        setSessionReady(false);
      } catch (e: unknown) {
        setError(getApiErrorMessage(e, 'Không tải được workspaces.'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workboard.id, workboardSlug]);

  const startPreview = useCallback(async () => {
    if (!activeWorkspace) return;
    setSessionLoading(true);
    setError(null);
    try {
      await apiClient.post(
        `/workspaces/${activeWorkspace.id}/preview-session`,
        { username: previewUsername, workboard_id: workboard.id },
      );
      setSessionReady(true);
      setIframeKey((k) => k + 1);
    } catch (e: unknown) {
      setError(getApiErrorMessage(e, 'Không tạo được preview session.'));
    } finally {
      setSessionLoading(false);
    }
  }, [activeWorkspace, previewUsername, workboard.id]);

  const previewUrl = useMemo(() => {
    if (!activeWorkspace) return null;
    return `/ws/${activeWorkspace.token}/workboards/${workboard.id}`;
  }, [activeWorkspace, workboard.id]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-5 text-caption text-warning">
          <h2 className="mb-1 text-body font-emphasis">
            Chưa có workspace public để chạy preview
          </h2>
          <p>
            Tạo workspace có app_users_config rồi mở lại preview.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <h3 className="mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          Workspace
        </h3>
        <select
          value={activeWorkspace?.id ?? ''}
          onChange={(e) => {
            const ws = workspaces.find((w) => w.id === Number(e.target.value));
            if (ws) {
              setActiveWorkspace(ws);
              setSessionReady(false);
            }
          }}
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-caption"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {isWorkboardLinked(w, workboardSlug) ? '' : ' (preview)'}
            </option>
          ))}
        </select>

        <h3 className="mt-4 mb-2 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          Đăng nhập giả lập
        </h3>
        <select
          value={previewUsername}
          onChange={(e) => {
            setPreviewUsername(e.target.value);
            setSessionReady(false);
          }}
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-caption"
        >
          {DEMO_ACCOUNTS.map((a) => (
            <option key={a.u} value={a.u}>
              {a.u} ({a.r}) — {a.t}
            </option>
          ))}
        </select>

        <button
          onClick={startPreview}
          disabled={sessionLoading || !activeWorkspace}
          className="mt-3 flex w-full items-center justify-center gap-1 rounded-md bg-brand px-3 py-2 text-caption font-emphasis text-text-inverse disabled:opacity-60"
        >
          {sessionLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <UserCheck className="h-3.5 w-3.5" />
          )}
          {sessionLoading ? 'Tạo phiên…' : 'Bắt đầu preview'}
        </button>

        {sessionReady && (
          <button
            onClick={() => setIframeKey((k) => k + 1)}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-1.5 text-tiny text-text-secondary hover:bg-surface-2"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh iframe
          </button>
        )}

        {previewUrl && (
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2 py-1.5 text-tiny text-text-secondary hover:bg-surface-2"
          >
            <ExternalLink className="h-3 w-3" />
            Mở tab mới
          </a>
        )}

        {error && (
          <p className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-tiny text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 border-t border-[rgb(var(--border-line))] pt-3">
          <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Tài khoản demo
          </h4>
          <table className="w-full text-tiny">
            <tbody>
              {DEMO_ACCOUNTS.map((a) => (
                <tr key={a.u} className="border-b border-[rgb(var(--border-line))] last:border-0">
                  <td className="py-0.5 font-mono">{a.u}</td>
                  <td className="py-0.5 font-mono">{a.p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </aside>

      <div className="flex-1 bg-surface-2">
        {!sessionReady ? (
          <div className="flex h-full items-center justify-center text-center">
            <div>
              <UserCheck className="mx-auto mb-3 h-8 w-8 text-text-tertiary" />
              <p className="text-body text-text-secondary">
                Chọn user + bấm Bắt đầu preview để mở mini-app trong iframe
              </p>
            </div>
          </div>
        ) : previewUrl ? (
          <iframe
            key={iframeKey}
            src={previewUrl}
            className="h-full w-full bg-white"
            title="Mini-app preview"
          />
        ) : null}
      </div>
    </div>
  );
}
