/**
 * WorkboardShareModal — public-sharing for ONE app, kept dead simple:
 *   • one public link + one Bật/Tắt switch (Bật = anyone can open the full app
 *     via the link with a PIN; Tắt = link stops accepting logins).
 *   • the multi-Cổng power feature (bundling several apps behind one portal,
 *     attaching to other Cổng) is tucked into a collapsed "Nâng cao" section.
 *
 * Opened from the builder topbar "Chia sẻ" button. After any change it reloads
 * and fires `appbi:workboard-cong-changed` so an open Live Preview re-resolves
 * its preview Cổng without a page reload.
 */
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, Loader2, Power, PowerOff, Share2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import { workspaceAdminApi, type WorkspaceAdmin } from '@/lib/api/workspaces';
import type { Workboard } from '@/lib/api/workboards';

export const WORKBOARD_CONG_CHANGED = 'appbi:workboard-cong-changed';
export const WORKBOARD_SHARE_OPEN = 'appbi:workboard-share-open';

interface Props {
  workboard: Pick<Workboard, 'id' | 'name' | 'slug' | 'icon' | 'description'>;
  onClose: () => void;
}

function publicLink(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/ws/${token}`;
}

function apiErr(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' && d.trim() ? d : fallback;
}

export default function WorkboardShareModal({ workboard, onClose }: Props) {
  const slug = workboard.slug ?? '';
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<WorkspaceAdmin[]>([]);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setWorkspaces(await workspaceAdminApi.list());
    } catch (err) {
      setError(apiErr(err, 'Không tải được trạng thái chia sẻ.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const announceChanged = () =>
    window.dispatchEvent(new CustomEvent(WORKBOARD_CONG_CHANGED));

  const isLinked = (ws: WorkspaceAdmin) =>
    (ws.menu_config || []).some((m) => m.workboard_slug === slug);

  const linked = workspaces.filter(isLinked);
  const others = workspaces.filter((ws) => !isLinked(ws));

  // The app's "primary" public link = its OWN dedicated Cổng (menu holds only
  // this app) — that's the "one app, one link" the simple switch controls.
  // Among dedicated ones prefer active. A shared Cổng (bundling several apps)
  // never becomes the primary; it's managed under "Nâng cao" instead. So a
  // freshly-shared app (Bật creates a dedicated Cổng) reads cleanly here.
  const primary =
    [...linked].sort((a, b) => {
      const score = (w: WorkspaceAdmin) =>
        ((w.menu_config || []).length === 1 ? 4 : 0)
        + (w.is_active !== false ? 1 : 0);
      return score(b) - score(a);
    })[0] || null;

  const createCong = async () => {
    if (!slug) return;
    setBusyId('new');
    setError(null);
    try {
      await workspaceAdminApi.createWithWorkboard({
        name: workboard.name?.trim() || slug,
        workboardSlug: slug,
        workboardLabel: workboard.name?.trim() || slug,
        workboardIcon: workboard.icon,
        workboardDescription: workboard.description,
      });
      await reload();
      announceChanged();
      toast.success('Đã bật chia sẻ công khai — copy link để gửi cho mọi người');
    } catch (err) {
      setError(apiErr(err, 'Không bật được chia sẻ.'));
    } finally {
      setBusyId(null);
    }
  };

  const attach = async (ws: WorkspaceAdmin) => {
    if (!slug) return;
    setBusyId(ws.id);
    setError(null);
    try {
      await workspaceAdminApi.attachWorkboard(ws.id, {
        workboard_slug: slug,
        label: workboard.name?.trim() || slug,
        icon: workboard.icon,
        description: workboard.description,
      });
      await reload();
      announceChanged();
      toast.success(`Đã gắn app vào "${ws.name}"`);
    } catch (err) {
      setError(apiErr(err, 'Không gắn được app vào Cổng.'));
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (ws: WorkspaceAdmin) => {
    setBusyId(ws.id);
    setError(null);
    try {
      await workspaceAdminApi.setActive(ws.id, ws.is_active === false);
      await reload();
      announceChanged();
    } catch (err) {
      setError(apiErr(err, 'Không đổi được trạng thái chia sẻ.'));
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (ws: WorkspaceAdmin) => {
    try {
      await navigator.clipboard.writeText(publicLink(ws.token));
      setCopiedId(ws.id);
      window.setTimeout(() => setCopiedId((c) => (c === ws.id ? null : c)), 1800);
    } catch {
      toast.error('Trình duyệt chặn copy — bôi đen link để copy thủ công');
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Chia sẻ app công khai"
      size="md"
      footer={<Button variant="ghost" size="sm" onClick={onClose}>Đóng</Button>}
    >
      <div className="space-y-4">
        <p className="text-caption text-text-secondary">
          Bật để mọi người mở <strong>toàn bộ app</strong> qua 1 link và đăng nhập bằng
          PIN — không cần tài khoản AppBI. Tắt khi không muốn cho xem nữa.
        </p>

        {!slug && (
          <div className="rounded-md border border-warning/20 bg-warning/5 p-3 text-caption text-warning">
            App chưa có slug — lưu app trong Builder trước khi chia sẻ.
          </div>
        )}
        {error && <div className="text-caption text-danger">{error}</div>}

        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        ) : !primary ? (
          // ── Not shared yet — one button to turn it on ──
          <div className="flex flex-col items-start gap-3 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-4">
            <div className="flex items-center gap-2 text-body text-text-primary">
              <Share2 className="h-4 w-4 text-text-tertiary" />
              App này <strong>chưa công khai</strong>.
            </div>
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<Power className="h-3.5 w-3.5" />}
              onClick={createCong}
              disabled={!slug || busyId === 'new'}
              loading={busyId === 'new'}
            >
              Bật chia sẻ công khai
            </Button>
          </div>
        ) : (
          // ── Shared — show the link + one Bật/Tắt switch ──
          <div className="space-y-3 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-4">
            <div className="flex items-center justify-between gap-2">
              <FilterTag tone={primary.is_active === false ? 'danger' : 'success'} className="cursor-default">
                {primary.is_active === false ? '● Đã tắt — không ai vào được' : '● Đang công khai'}
              </FilterTag>
              <Button
                variant={primary.is_active === false ? 'primary' : 'outline'}
                size="sm"
                loading={busyId === primary.id}
                disabled={busyId === primary.id}
                onClick={() => void toggleActive(primary)}
                leadingIcon={primary.is_active === false ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
                className={primary.is_active === false ? '' : 'text-danger'}
              >
                {primary.is_active === false ? 'Bật lại' : 'Tắt chia sẻ'}
              </Button>
            </div>
            <div>
              <div className="mb-1 text-caption text-text-tertiary">Link gửi cho mọi người:</div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={publicLink(primary.token)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 truncate rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-caption text-text-primary"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void copyLink(primary)}
                  leadingIcon={copiedId === primary.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                >
                  {copiedId === primary.id ? 'Đã copy' : 'Copy'}
                </Button>
                <a href={publicLink(primary.token)} target="_blank" rel="noreferrer">
                  <Button variant="ghost" size="sm">Mở</Button>
                </a>
              </div>
            </div>
          </div>
        )}

        {/* ── Nâng cao: nhiều Cổng (gộp nhiều app / nhiều link) — gập lại ── */}
        {!loading && (
          <div className="rounded-md border border-[rgb(var(--border-line))]">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-caption text-text-secondary hover:text-text-primary"
            >
              <span>Nâng cao — quản lý nhiều Cổng / nhiều link (gộp nhiều app)</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>
            {showAdvanced && (
              <div className="space-y-3 border-t border-[rgb(var(--border-line))] p-3">
                {linked.length > 0 && (
                  <Section title={`Cổng đang chứa app này (${linked.length})`}>
                    {linked.map((ws) => (
                      <CongRow
                        key={ws.id}
                        ws={ws}
                        busy={busyId === ws.id}
                        copied={copiedId === ws.id}
                        onToggle={() => void toggleActive(ws)}
                        onCopy={() => void copyLink(ws)}
                      />
                    ))}
                  </Section>
                )}
                {others.length > 0 && (
                  <Section title={`Cổng khác (${others.length})`}>
                    {others.map((ws) => (
                      <div key={ws.id} className="flex items-center justify-between gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                        <span className="truncate text-caption text-text-secondary">{ws.name}</span>
                        <Button
                          variant="outline"
                          size="xs"
                          loading={busyId === ws.id}
                          disabled={!slug || busyId === ws.id}
                          onClick={() => void attach(ws)}
                        >
                          Gắn app vào
                        </Button>
                      </div>
                    ))}
                  </Section>
                )}
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={createCong}
                  disabled={!slug || busyId === 'new'}
                  loading={busyId === 'new'}
                >
                  Tạo thêm Cổng mới
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function CongRow({
  ws, busy, copied, onToggle, onCopy,
}: {
  ws: WorkspaceAdmin;
  busy: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-caption font-emphasis text-text-primary">{ws.name}</span>
          <FilterTag tone={ws.is_active === false ? 'danger' : 'success'} className="cursor-default">
            {ws.is_active === false ? 'Đã tắt' : 'Đang bật'}
          </FilterTag>
        </div>
        <Button
          variant="outline"
          size="xs"
          loading={busy}
          disabled={busy}
          onClick={onToggle}
          leadingIcon={ws.is_active === false ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
          className={ws.is_active === false ? 'text-danger' : ''}
        >
          {ws.is_active === false ? 'Bật' : 'Tắt'}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={publicLink(ws.token)}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 truncate rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-caption text-text-primary"
        />
        <Button variant="secondary" size="xs" onClick={onCopy}
          leadingIcon={copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}>
          {copied ? 'Đã copy' : 'Copy link'}
        </Button>
        <a href={publicLink(ws.token)} target="_blank" rel="noreferrer">
          <Button variant="ghost" size="xs">Mở</Button>
        </a>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
        {title}
      </h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
