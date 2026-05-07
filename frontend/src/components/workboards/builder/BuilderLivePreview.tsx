/**
 * BuilderLivePreview — iframe pane embedded inside the builder.
 *
 * Mints a preview-session cookie once (so the iframe authenticates as a
 * picked role) and reloads the iframe whenever auto-save lands. Reload
 * is keyed by ``reloadKey`` from the parent so we don't refresh on every
 * keystroke — only when ``status`` flips to "saved".
 *
 * Because the iframe is same-origin and same workspace cookie, every
 * permission check (RLS, write enforcement) behaves exactly as a real
 * end-user. The role selector swaps the active app-user mid-session.
 */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Smartphone,
  Tablet,
  Laptop,
  AlertCircle,
  RotateCw,
} from 'lucide-react';

import {
  workboardApi,
  type Workboard,
  type WorkboardAppUserResponse,
} from '@/lib/api/workboards';
import { apiClient } from '@/lib/api-client';
import type { AutosaveStatus } from './useDebouncedAutosave';
import {
  buildAppUserRoleOptions,
  formatAppUserRoleLabel,
  normalizeAppUserRole,
} from './appUserRoles';
import {
  getAccessMode,
  sortPreviewWorkspaces,
  type WorkspaceLite,
} from './workspace-preview-utils';

function getApiErrorMessage(error: unknown, fallback: string) {
  const maybeApiError = error as { response?: { data?: { detail?: unknown } } };
  const detail = maybeApiError.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

type DeviceFrame = 'mobile' | 'tablet' | 'desktop';

const FRAME_DIMENSIONS: Record<DeviceFrame, { w: string; minH: string }> = {
  mobile: { w: '390px', minH: '720px' },
  tablet: { w: '820px', minH: '720px' },
  desktop: { w: '100%', minH: '720px' },
};

interface Props {
  workboard: Workboard;
  /** Status badge from auto-save hook. */
  saveStatus: AutosaveStatus;
  savedAt: Date | null;
  saveError: string | null;
  /** id of the currently active screen in the builder; iframe jumps to it. */
  activeScreenId: string | null;
  /** Toggle-collapse from parent so other panels can grab the space. */
  collapsed: boolean;
  onToggle: () => void;
}

export default function BuilderLivePreview({
  workboard,
  saveStatus,
  savedAt,
  saveError,
  activeScreenId,
  collapsed,
  onToggle,
}: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [activeWs, setActiveWs] = useState<WorkspaceLite | null>(null);
  const [appUsers, setAppUsers] = useState<WorkboardAppUserResponse[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [previewRole, setPreviewRole] = useState('');
  const [previewUsername, setPreviewUsername] = useState('');
  const [device, setDevice] = useState<DeviceFrame>('desktop');
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [loadingWs, setLoadingWs] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const workboardSlug = workboard.slug ?? '';

  // ── Resolve which workspace can host this preview ────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiClient.get<WorkspaceLite[]>('/workspaces');
        const data = r.data || [];
        if (!alive) return;
        const ordered = sortPreviewWorkspaces(data, workboardSlug);
        setWorkspaces(ordered);
        setActiveWs(ordered[0] ?? null);
        setSessionReady(false);
      } catch {
        // non-fatal
      } finally {
        if (alive) setLoadingWs(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workboard.id, workboardSlug]);

  const isInternal = activeWs ? getAccessMode(activeWs) === 'internal' : false;

  useEffect(() => {
    let alive = true;
    setLoadingUsers(true);
    (async () => {
      try {
        const rows = await workboardApi.listAppUsers(workboard.id);
        if (!alive) return;
        setAppUsers(rows);
      } catch {
        if (alive) setAppUsers([]);
      } finally {
        if (alive) setLoadingUsers(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workboard.id]);

  const activePreviewUsers = useMemo(
    () => appUsers.filter((user) => user.active),
    [appUsers],
  );

  const previewRoleOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of activePreviewUsers) {
      const role = normalizeAppUserRole(user.role) || 'user';
      counts.set(role, (counts.get(role) || 0) + 1);
    }
    return buildAppUserRoleOptions(Array.from(counts.keys()))
      .filter((option) => counts.has(option.value))
      .map((option) => ({ ...option, count: counts.get(option.value) || 0 }));
  }, [activePreviewUsers]);

  const filteredPreviewUsers = useMemo(() => {
    if (!previewRole) return activePreviewUsers;
    return activePreviewUsers.filter(
      (user) => (normalizeAppUserRole(user.role) || 'user') === previewRole,
    );
  }, [activePreviewUsers, previewRole]);

  useEffect(() => {
    if (isInternal || previewRole || loadingUsers || activePreviewUsers.length === 0) {
      return;
    }
    setPreviewRole(normalizeAppUserRole(activePreviewUsers[0].role) || 'user');
    setSessionReady(false);
  }, [activePreviewUsers, isInternal, loadingUsers, previewRole]);

  // Track the (workspace, username) tuple we last tried so a failed mint
  // doesn't spin into an infinite loop: without this, ``finally``'s
  // ``setSessionLoading(false)`` re-armed the auto-mint effect and we
  // hammered ``/preview-session`` on a stale preview identity until the
  // user navigated away.
  const lastAttemptRef = useRef<string | null>(null);

  // ── Mint preview-session cookie ──────────────────────────────────
  const startSession = async () => {
    if (!activeWs) return;
    const attemptKey = `${activeWs.id}::${previewRole}::${previewUsername.trim()}::${workboard.id}`;
    lastAttemptRef.current = attemptKey;
    setSessionLoading(true);
    setSessionError(null);
    try {
      const payload: { username?: string; role?: string; workboard_id: number } = {
        workboard_id: workboard.id,
      };
      // Internal workspaces mint the session from the AppBI staff identity
      // — role/user selectors are ignored for them. For public workspaces an
      // empty username asks the backend to pick the first active row for the
      // selected role.
      if (!isInternal) {
        if (previewRole) payload.role = previewRole;
        const username = previewUsername.trim();
        if (username) payload.username = username;
      }
      await apiClient.post(`/workspaces/${activeWs.id}/preview-session`, payload);
      setSessionReady(true);
      setIframeKey((k) => k + 1);
    } catch (err: unknown) {
      setSessionError(getApiErrorMessage(err, 'Không tạo được phiên preview.'));
    } finally {
      setSessionLoading(false);
    }
  };

  // Reset the "tried once" guard whenever the user changes the inputs that
  // would meaningfully change the request — so retrying after picking a
  // different workspace / username works without a manual refresh.
  useEffect(() => {
    lastAttemptRef.current = null;
  }, [activeWs?.id, previewRole, previewUsername, workboard.id]);

  // Auto-mint when workspace + user picked and we haven't started yet.
  // Skip when we already attempted this exact combination — even if the
  // attempt errored — so the effect doesn't loop forever on a 404/403.
  useEffect(() => {
    if (collapsed || !activeWs || sessionReady || sessionLoading) return;
    if (!isInternal && loadingUsers) return;
    if (!isInternal && activePreviewUsers.length > 0 && !previewRole) return;
    const attemptKey = `${activeWs.id}::${previewRole}::${previewUsername.trim()}::${workboard.id}`;
    if (lastAttemptRef.current === attemptKey) return;
    void startSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeWs,
    collapsed,
    activePreviewUsers.length,
    isInternal,
    loadingUsers,
    previewRole,
    previewUsername,
    sessionReady,
    sessionLoading,
  ]);

  // ── Reload iframe when auto-save lands ───────────────────────────
  const lastSavedRef = useRef<Date | null>(null);
  useEffect(() => {
    if (saveStatus === 'saved' && sessionReady && savedAt) {
      // Only reload when savedAt actually advances.
      if (lastSavedRef.current !== savedAt) {
        lastSavedRef.current = savedAt;
        setIframeKey((k) => k + 1);
      }
    }
  }, [saveStatus, savedAt, sessionReady]);

  // ── Reload iframe when active screen changes (jump to that screen) ─
  useEffect(() => {
    // Re-key the iframe so it lands on the latest layout + can route
    // to the active screen (handled by hash).
    if (sessionReady) {
      setIframeKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScreenId]);

  const previewUrl = useMemo(() => {
    if (!activeWs) return null;
    const base = `/ws/${activeWs.token}/workboards/${workboard.id}`;
    return activeScreenId ? `${base}#screen=${activeScreenId}` : base;
  }, [activeWs, workboard.id, activeScreenId]);

  // ── Collapsed: hide entirely so the editor fills the whole row.
  // The toggle that re-opens it lives in WorkboardBuilder's center panel.
  if (collapsed) {
    return null;
  }

  return (
    <aside className="flex w-1/2 shrink-0 flex-col border-l border-[rgb(var(--border-line))] bg-surface-1">
      {/* Header — sync indicator + toggle */}
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Live Preview
          </h3>
          <SyncBadge status={saveStatus} savedAt={savedAt} error={saveError} />
        </div>
        <button
          onClick={onToggle}
          className="rounded-md p-1 text-text-tertiary hover:bg-surface-2"
          title="Đóng Live Preview"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Toolbar — role + device + actions */}
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {!isInternal && (
            <>
              <select
                value={previewRole}
                onChange={(e) => {
                  setPreviewRole(e.target.value);
                  setPreviewUsername('');
                  setSessionReady(false);
                }}
                disabled={loadingUsers || activePreviewUsers.length === 0}
                className="max-w-[128px] rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-tiny disabled:opacity-60"
                title="Role preview"
              >
                <option value="">{loadingUsers ? 'Loading roles...' : 'Auto role'}</option>
                {previewRoleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} ({option.count})
                  </option>
                ))}
              </select>
              <select
                value={previewUsername}
                onChange={(e) => {
                  setPreviewUsername(e.target.value);
                  setSessionReady(false);
                }}
                disabled={loadingUsers || filteredPreviewUsers.length === 0}
                className="max-w-[190px] rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-tiny disabled:opacity-60"
                title="App user preview"
              >
                <option value="">
                  {filteredPreviewUsers.length === 0
                    ? 'No active users'
                    : previewRole
                      ? `First ${formatAppUserRoleLabel(previewRole)}`
                      : 'First active user'}
                </option>
                {filteredPreviewUsers.map((user) => (
                  <option key={user.id} value={user.username}>
                    {user.username}
                    {user.full_name ? ` - ${user.full_name}` : ''}
                  </option>
                ))}
              </select>
            </>
          )}
          {isInternal && (
            <span
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-tiny text-text-tertiary"
              title="Workspace internal — chạy bằng tài khoản AppBI"
            >
              Internal · AppBI staff
            </span>
          )}
          <div className="flex items-center gap-0.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-0.5">
            {(['mobile', 'tablet', 'desktop'] as DeviceFrame[]).map((d) => {
              const Icon = d === 'mobile' ? Smartphone : d === 'tablet' ? Tablet : Laptop;
              return (
                <button
                  key={d}
                  onClick={() => setDevice(d)}
                  className={`flex h-6 w-6 items-center justify-center rounded ${
                    device === d ? 'bg-text-primary text-text-inverse' : 'text-text-tertiary hover:text-text-primary'
                  }`}
                  title={d}
                >
                  <Icon className="h-3 w-3" />
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIframeKey((k) => k + 1)}
            className="rounded-md p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
            title="Refresh iframe"
            disabled={!sessionReady}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
              title="Mở tab mới"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Iframe area */}
      <div className="flex flex-1 flex-col overflow-hidden bg-slate-100">
        {loadingWs ? (
          <Centered>
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </Centered>
        ) : workspaces.length === 0 ? (
          <Centered>
            <div className="max-w-xs rounded-md border border-warning/30 bg-warning/10 p-3 text-tiny text-warning">
              Chưa có workspace nào để chạy live preview. Tạo workspace ở
              Settings → Workspaces — mặc định <code>public_app_users</code>{' '}
              cần chọn bảng người dùng cho mini-app.
            </div>
          </Centered>
        ) : sessionError ? (
          <Centered>
            <div className="max-w-xs rounded-md border border-danger/30 bg-danger/10 p-3 text-tiny text-danger">
              <div className="mb-2 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                Lỗi
              </div>
              {sessionError}
              <button
                onClick={startSession}
                className="mt-2 text-tiny text-brand hover:underline"
              >
                Thử lại
              </button>
            </div>
          </Centered>
        ) : !sessionReady ? (
          <Centered>
            <div className="text-center">
              <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-text-tertiary" />
              <p className="text-tiny text-text-tertiary">Đang tạo phiên preview…</p>
            </div>
          </Centered>
        ) : previewUrl ? (
          <div className="flex h-full items-start justify-center overflow-auto p-3">
            <div
              className="bg-white shadow-md ring-1 ring-slate-200 transition-all"
              style={{
                width: FRAME_DIMENSIONS[device].w,
                maxWidth: '100%',
                height: '100%',
                minHeight: FRAME_DIMENSIONS[device].minH,
                borderRadius: device === 'mobile' ? '24px' : '8px',
                overflow: 'hidden',
              }}
            >
              <iframe
                ref={iframeRef}
                key={iframeKey}
                src={previewUrl}
                className="h-full w-full bg-white"
                title="Mini-app live preview"
              />
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

// ── Sync badge ────────────────────────────────────────────────────────────

function SyncBadge({
  status,
  savedAt,
  error,
}: {
  status: AutosaveStatus;
  savedAt: Date | null;
  error: string | null;
}) {
  if (status === 'pending') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-tiny text-warning">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
        Đang gõ…
      </span>
    );
  }
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-tiny text-info">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Đang lưu…
      </span>
    );
  }
  if (status === 'saved' && savedAt) {
    return (
      <span
        className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-tiny text-success"
        title={`Lưu lúc ${savedAt.toLocaleTimeString()}`}
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        Đã đồng bộ
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        className="flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-tiny text-danger"
        title={error || ''}
      >
        <AlertCircle className="h-2.5 w-2.5" />
        Lỗi lưu
      </span>
    );
  }
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4">{children}</div>
  );
}
