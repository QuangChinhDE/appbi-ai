'use client';

/**
 * "Connect Claude to AppBI" — the consent step of the MCP integration's OAuth flow
 * (docs/features/mcp-integration-layer/spec.md §2.2).
 *
 * The user is signed in to AppBI normally (the middleware sends a signed-out visitor
 * to /login and back here — the txn id is in the PATH because login keeps only the
 * pathname). On Allow, this page mints a dedicated, scoped, expiring personal access
 * token through the EXISTING session-only API — AppBI itself rejects scopes above the
 * user's own rights — and hands it to the MCP service with a same-origin form POST.
 *
 * The callback path is a constant of this page, never read from the URL or from the
 * MCP response, so the token can only ever be posted to this origin's MCP endpoint.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { authApi, personalAccessTokensApi } from '@/lib/api-client';
import { extractApiError } from '@/lib/api-errors';
import { useI18n } from '@/providers/LanguageProvider';

const MCP_CALLBACK_PATH = '/mcp-oauth/appbi-callback';
const MCP_TXN_PATH = '/mcp-oauth/txn/';
const EXPIRY_CHOICES = [7, 30, 60, 90];

type ConnectInfo = {
  mode: 'connect';
  client_name: string;
  client_id_host: string | null;
  redirect_host: string | null;
  redirect_is_loopback: boolean;
  requested_scopes: { scope: string; description: string }[];
  can_write: boolean;
  appbi_scopes: { full: Record<string, string>; read: Record<string, string> };
  default_expires_in_days: number;
  max_expires_in_days: number;
};

type VerifyInfo = {
  mode: 'verify';
  pat: { name: string; expires_in_days: number; scopes: Record<string, string> };
};

type TxnInfo = ConnectInfo | VerifyInfo;

function postToMcp(fields: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = MCP_CALLBACK_PATH;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

export default function ConnectMcpPage() {
  const { t } = useI18n();
  const params = useParams<{ txn: string }>();
  const txn = String(params?.txn || '');
  const [info, setInfo] = useState<TxnInfo | null>(null);
  const [loadError, setLoadError] = useState<'expired' | 'failed' | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [level, setLevel] = useState<'full' | 'read'>('full');
  // AppBI refuses a token above the user's own rights, so a view-only user is
  // offered read-only access instead of an Allow that would fail.
  const [userCanWrite, setUserCanWrite] = useState(true);
  const [days, setDays] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [res, me] = await Promise.all([
          fetch(MCP_TXN_PATH + encodeURIComponent(txn), { credentials: 'same-origin', cache: 'no-store' }),
          authApi.me(),
        ]);
        if (cancelled) return;
        setUserEmail(String(me?.email || ''));
        const perms: Record<string, string> = (me?.permissions as Record<string, string>) || {};
        const rank: Record<string, number> = { none: 0, view: 1, edit: 2, full: 3 };
        const writable = ['datasets', 'explore_charts', 'dashboards'].every((m) => (rank[perms[m]] ?? 0) >= 2);
        setUserCanWrite(writable);
        if (res.status === 404) {
          setLoadError('expired');
          return;
        }
        if (!res.ok) {
          setLoadError('failed');
          return;
        }
        const data = (await res.json()) as TxnInfo;
        setInfo(data);
        if (data.mode === 'connect') {
          setDays(data.default_expires_in_days || 30);
          if (!data.can_write) setLevel('read');
        }
      } catch {
        if (!cancelled) setLoadError('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [txn]);

  useEffect(() => {
    if (!userCanWrite) setLevel('read');
  }, [userCanWrite]);

  const appbiScopes = useMemo(() => {
    if (!info || info.mode !== 'connect') return null;
    return level === 'full' ? info.appbi_scopes.full : info.appbi_scopes.read;
  }, [info, level]);

  async function allow() {
    if (!info || submitted.current) return;
    setBusy(true);
    setError('');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const payload =
        info.mode === 'verify'
          ? { name: info.pat.name, scopes: info.pat.scopes, expires_in_days: info.pat.expires_in_days }
          : {
              name: `Claude MCP · ${info.client_name.slice(0, 40)} · ${today}`,
              scopes: appbiScopes || {},
              expires_in_days: Math.min(days, info.max_expires_in_days || 90),
            };
      const created = await personalAccessTokensApi.create(payload);
      submitted.current = true;
      postToMcp({
        txn,
        decision: 'allow',
        pat: created.token,
        granted: info.mode === 'connect' ? level : 'read',
        pat_expires_at: created.item?.expires_at || '',
      });
    } catch (err) {
      setError(extractApiError(err, t('connectMcp.error.createFailed')));
      setBusy(false);
    }
  }

  function deny() {
    if (submitted.current) return;
    submitted.current = true;
    postToMcp({ txn, decision: 'deny' });
  }

  return (
    <main className="min-h-screen bg-surface-0 px-4 py-10">
      <div className="mx-auto w-full max-w-xl rounded-xl border border-[rgb(var(--border-subtle))] bg-surface-1 p-6 shadow-linear-sm">
        {loadError ? (
          <>
            <h1 className="text-title font-semibold text-text-primary">
              {loadError === 'expired' ? t('connectMcp.expired.title') : t('connectMcp.failed.title')}
            </h1>
            <p className="mt-2 text-body text-text-secondary">
              {loadError === 'expired' ? t('connectMcp.expired.body') : t('connectMcp.failed.body')}
            </p>
          </>
        ) : !info ? (
          <p className="text-body text-text-secondary">{t('common.loading')}</p>
        ) : info.mode === 'verify' ? (
          <>
            <h1 className="text-title font-semibold text-text-primary">{t('connectMcp.verify.title')}</h1>
            <p className="mt-2 text-body text-text-secondary">{t('connectMcp.verify.body', { email: userEmail })}</p>
            {error ? <p className="mt-4 text-body text-danger">{error}</p> : null}
            <div className="mt-6 flex flex-wrap gap-3">
              <Button variant="primary" onClick={allow} disabled={busy}>{t('connectMcp.verify.confirm')}</Button>
              <Button variant="secondary" onClick={deny} disabled={busy}>{t('common.cancel')}</Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-title font-semibold text-text-primary">{t('connectMcp.title', { client: info.client_name })}</h1>
            <p className="mt-2 text-body text-text-secondary">{t('connectMcp.signedInAs', { email: userEmail })}</p>
            <div className="mt-4 rounded-lg bg-surface-2 p-3 text-caption text-text-secondary">
              {info.redirect_is_loopback
                ? t('connectMcp.redirect.loopback')
                : t('connectMcp.redirect.host', { host: info.redirect_host || '?' })}
              {info.client_id_host ? <div className="mt-1">{t('connectMcp.clientVerified', { host: info.client_id_host })}</div> : null}
            </div>

            <h2 className="mt-6 text-body font-semibold text-text-primary">{t('connectMcp.canDo')}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-text-secondary">
              {info.requested_scopes
                .filter((s) => level === 'full' || s.scope === 'appbi.read')
                .map((s) => (
                  <li key={s.scope}>{s.description}</li>
                ))}
              <li>{t('connectMcp.ownRights')}</li>
            </ul>

            {info.can_write && !userCanWrite ? (
              <p className="mt-4 text-body text-text-secondary">{t('connectMcp.readOnlyForced')}</p>
            ) : null}
            {info.can_write && userCanWrite ? (
              <label className="mt-4 flex items-center gap-2 text-body text-text-primary">
                <input
                  type="checkbox"
                  checked={level === 'read'}
                  onChange={(e) => setLevel(e.target.checked ? 'read' : 'full')}
                />
                {t('connectMcp.readOnly')}
              </label>
            ) : null}

            <label className="mt-4 block text-body text-text-primary">
              {t('connectMcp.expiry')}
              <select
                className="ml-2 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {EXPIRY_CHOICES.filter((d) => d <= (info.max_expires_in_days || 90)).map((d) => (
                  <option key={d} value={d}>{t('connectMcp.days', { count: d })}</option>
                ))}
              </select>
            </label>

            {appbiScopes ? (
              <p className="mt-3 text-caption text-text-tertiary">
                {t('connectMcp.tokenNote', {
                  modules: Object.entries(appbiScopes).map(([m, l]) => `${m}: ${l}`).join(', '),
                })}
              </p>
            ) : null}

            {error ? <p className="mt-4 text-body text-danger">{error}</p> : null}
            <div className="mt-6 flex flex-wrap gap-3">
              <Button variant="primary" onClick={allow} disabled={busy}>{t('connectMcp.allow')}</Button>
              <Button variant="secondary" onClick={deny} disabled={busy}>{t('connectMcp.deny')}</Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
