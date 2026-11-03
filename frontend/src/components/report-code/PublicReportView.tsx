'use client';

/**
 * A published Report-as-Code page for an anonymous viewer (/d/r/<token>, /embed/r/<token>).
 * Public client only: this file and everything it renders never import the signed-in
 * API client. The report owns the whole page; AppBI adds only a slim attribution.
 *
 * A link may be password-protected (same gate and 2-hour session as a dashboard link),
 * expire (410), and lock filters — locks are applied by the server; the banner below
 * only shows the viewer which ones are fixed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Lock } from 'lucide-react';

import { PasswordGate } from '@/components/common/PublicPasswordGate';
import { ReportFrame } from '@/components/report-code/ReportFrame';
import { clearPublicSession, publicReportApi, savePublicSession, type PublicReportMeta } from '@/lib/api/public';
import type { FilterState } from '@/lib/report-code/protocol';

type Gate = { kind: 'password'; reauth: boolean } | { kind: 'error'; message: string } | null;

export function PublicReportView({ variant }: { variant: 'public' | 'embed' }) {
  const params = useParams<{ token: string }>();
  const token = String(params?.token || '');
  const [meta, setMeta] = useState<PublicReportMeta | null>(null);
  const [gate, setGate] = useState<Gate>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    publicReportApi.get(token)
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        setGate(null);
        const headline = typeof m.appearance?.headline === 'string' && m.appearance.headline ? m.appearance.headline : m.name;
        document.title = headline as string;
      })
      .catch((e) => {
        if (!alive) return;
        const status = e?.response?.status;
        if (status === 401) {
          clearPublicSession(token);
          setGate({ kind: 'password', reauth: attempt > 0 });
        } else if (status === 410) {
          setGate({ kind: 'error', message: 'Liên kết này đã hết hạn.' });
        } else {
          setGate({ kind: 'error', message: e?.response?.data?.detail || 'Báo cáo không tồn tại hoặc chưa được chia sẻ.' });
        }
      });
    return () => { alive = false; };
  }, [token, attempt]);

  const unlock = async (password: string) => {
    setSubmitting(true);
    setAuthError(null);
    try {
      const out = await publicReportApi.auth(token, password);
      savePublicSession(token, out.session_token, out.expires_in);
      setAttempt((n) => n + 1);
    } catch (e: any) {
      setAuthError(e?.response?.status === 403 ? 'Sai mật khẩu.' : (e?.response?.data?.detail || 'Không xác thực được.'));
    } finally {
      setSubmitting(false);
    }
  };

  const fetchData = useCallback((binding: string, state: FilterState) => publicReportApi.data(token, binding, state), [token]);
  const fetchValues = useCallback((key: string, search: string, state: FilterState) => publicReportApi.values(token, key, search, state), [token]);

  if (gate?.kind === 'password') {
    return (
      <PasswordGate onSubmit={unlock} error={authError} submitting={submitting} isReauth={gate.reauth}
        description="Báo cáo được chia sẻ này cần mật khẩu để xem." actionLabel="Mở báo cáo" />
    );
  }
  if (gate?.kind === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-center" data-testid="public-report-error">
        <div>
          <div className="text-base font-semibold text-slate-900">Không thể mở báo cáo</div>
          <div className="mt-2 text-sm text-slate-500">{gate.message}</div>
        </div>
      </div>
    );
  }
  if (!meta) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang tải báo cáo…</div>;
  }
  const sep = meta.document_url.includes('?') ? '&' : '?';
  const locked = meta.locked_filters || [];
  return (
    <div className="flex h-screen flex-col bg-white" data-testid="public-report" data-report-version={meta.version}>
      {locked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[11px] text-slate-600" data-testid="public-report-locked">
          <Lock className="h-3 w-3 text-slate-400" />
          {locked.map((f) => (
            <span key={f.key} className="rounded-full bg-white px-2 py-0.5 ring-1 ring-inset ring-slate-200">
              {f.label}: <b className="font-medium">{f.kind === 'date' ? `${f.value[0] || '…'} → ${f.value[1] || '…'}` : f.value.join(', ')}</b>
            </span>
          ))}
        </div>
      )}
      <ReportFrame
        src={`${meta.document_url}${sep}v=${meta.version}`}
        isolated={meta.isolated}
        bindings={meta.bindings}
        filters={meta.filters}
        fetchData={fetchData}
        fetchValues={fetchValues}
        mode="view"
        title={meta.name}
        className="min-h-0 flex-1"
      />
      {variant === 'public' && (
        <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-1.5 text-[11px] text-slate-400">
          <span>{meta.preview ? 'Xem trước liên kết · ' : ''}Phiên bản {meta.version}{meta.published_at ? ` · xuất bản ${new Date(meta.published_at).toLocaleString('vi-VN')}` : ''}</span>
          <span>Dữ liệu được quản trị bởi AppBI</span>
        </div>
      )}
    </div>
  );
}
