/**
 * WorkboardShareModal — public sharing for ONE app, simple:
 *   • Top: ONE public link (login → overview) + Copy/Mở, with an overall
 *     Bật/Tắt for the whole link.
 *   • Below: a Workspace → Screen tree where each workspace AND each screen has
 *     its own show/hide toggle. Hiding is PER PUBLIC LINK only — it lives on
 *     the Cổng's menu item (hidden_screen_ids), so the Builder still shows every
 *     screen; only the /ws link drops the hidden ones (nav + content blocked).
 *   • Multi-Cổng (bundling several apps behind one portal) stays collapsed under
 *     "Nâng cao".
 *
 * Opened from the builder topbar "Chia sẻ" button. Changes fire
 * `appbi:workboard-cong-changed` so an open Live Preview re-resolves.
 */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Copy, Eye, EyeOff, Loader2, Power, PowerOff, Share2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import { useWorkboard } from '@/hooks/use-workboards';
import { workspaceAdminApi, type WorkspaceAdmin } from '@/lib/api/workspaces';
import type { Workboard } from '@/lib/api/workboards';

export const WORKBOARD_CONG_CHANGED = 'appbi:workboard-cong-changed';
export const WORKBOARD_SHARE_OPEN = 'appbi:workboard-share-open';

interface Props {
  workboard: Pick<Workboard, 'id' | 'name' | 'slug' | 'icon' | 'description'>;
  onClose: () => void;
}

interface ScreenLite { id: string; title: string; kind: string }

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
  const { data: fullWb } = useWorkboard(workboard.id);
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<WorkspaceAdmin[]>([]);
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
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

  // The app's own dedicated public link (one app = one link); shared/bundled
  // Cổng never become primary — they live under "Nâng cao".
  const primary = useMemo(
    () =>
      [...linked].sort((a, b) => {
        const score = (w: WorkspaceAdmin) =>
          ((w.menu_config || []).length === 1 ? 4 : 0) + (w.is_active !== false ? 1 : 0);
        return score(b) - score(a);
      })[0] || null,
    [linked],
  );

  // Sync the per-link hidden set from the primary Cổng's menu item.
  const primaryHiddenKey = primary
    ? `${primary.id}:${((primary.menu_config || []).find((m) => m.workboard_slug === slug)?.hidden_screen_ids || []).join(',')}`
    : '';
  useEffect(() => {
    if (!primary) { setHidden([]); return; }
    const item = (primary.menu_config || []).find((m) => m.workboard_slug === slug);
    setHidden(item?.hidden_screen_ids || []);
  }, [primaryHiddenKey, primary, slug]);

  // ── Workspace → Screen tree (structure from the workboard layout) ──
  const screens = useMemo(
    () =>
      ((fullWb?.layout_json?.screens || []) as Array<Record<string, unknown>>).map((s) => ({
        id: String(s.id ?? ''),
        title: String(s.title ?? s.id ?? ''),
        kind: String(s.kind ?? ''),
      })).filter((s) => s.id) as ScreenLite[],
    [fullWb],
  );
  const groups = fullWb?.layout_json?.screen_groups || [];
  const screenById = useMemo(() => new Map(screens.map((s) => [s.id, s])), [screens]);
  const groupedTree = groups.map((g) => ({
    id: g.id,
    label: g.label,
    screens: (g.screen_ids || []).map((id) => screenById.get(id)).filter(Boolean) as ScreenLite[],
  }));
  const groupedIds = new Set(groups.flatMap((g) => g.screen_ids || []));
  const ungrouped = screens.filter((s) => !groupedIds.has(s.id));

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

  const copyLink = async () => {
    if (!primary) return;
    try {
      await navigator.clipboard.writeText(publicLink(primary.token));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Trình duyệt chặn copy — bôi đen link để copy thủ công');
    }
  };

  // Persist the per-link hidden set (optimistic). Touches only this app's menu
  // item on the primary Cổng.
  const persistHidden = useCallback(
    async (next: string[]) => {
      if (!primary || !slug) return;
      const prev = hidden;
      setHidden(next);
      try {
        await workspaceAdminApi.setHiddenScreens(primary.id, slug, next);
        announceChanged();
        setWorkspaces(await workspaceAdminApi.list());
      } catch (err) {
        setHidden(prev);
        setError(apiErr(err, 'Không lưu được hiển thị.'));
      }
    },
    [primary, slug, hidden],
  );

  const toggleScreen = (id: string) =>
    void persistHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
  const toggleGroup = (ids: string[]) => {
    const allShown = ids.every((id) => !hidden.includes(id));
    void persistHidden(
      allShown
        ? Array.from(new Set([...hidden, ...ids]))
        : hidden.filter((x) => !ids.includes(x)),
    );
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
          Mọi người mở app qua <strong>1 link</strong> rồi đăng nhập bằng PIN (không cần
          tài khoản AppBI). Bên dưới chọn workspace/screen nào hiện trên link — Builder
          vẫn giữ đủ mọi screen.
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
          <>
            {/* Link tổng + Bật/Tắt cả link */}
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
                  {primary.is_active === false ? 'Bật lại' : 'Tắt cả link'}
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
                  <Button variant="secondary" size="sm" onClick={() => void copyLink()}
                    leadingIcon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
                    {copied ? 'Đã copy' : 'Copy'}
                  </Button>
                  <a href={publicLink(primary.token)} target="_blank" rel="noreferrer">
                    <Button variant="ghost" size="sm">Mở</Button>
                  </a>
                </div>
              </div>
            </div>

            {/* Hiển thị workspace / screen nào trên link */}
            <div>
              <div className="mb-1.5 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                Hiển thị trên link (bật/tắt workspace hoặc từng screen)
              </div>
              <div className="space-y-2">
                {groupedTree.map((g) => {
                  const ids = g.screens.map((s) => s.id);
                  const allShown = ids.length > 0 && ids.every((id) => !hidden.includes(id));
                  return (
                    <div key={g.id} className="overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="truncate text-caption font-emphasis text-text-primary">
                          {g.label} <span className="text-text-quaternary">({g.screens.length})</span>
                        </span>
                        <VisToggle on={allShown} onClick={() => toggleGroup(ids)} disabled={ids.length === 0} />
                      </div>
                      <div className="divide-y divide-[rgb(var(--border-line))] border-t border-[rgb(var(--border-line))]">
                        {g.screens.map((s) => (
                          <ScreenRow key={s.id} s={s} shown={!hidden.includes(s.id)} onToggle={() => toggleScreen(s.id)} />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {ungrouped.length > 0 && (
                  <div className="overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
                    <div className="px-3 py-2 text-caption font-emphasis text-text-tertiary">
                      Khác (chưa phân workspace) <span className="text-text-quaternary">({ungrouped.length})</span>
                    </div>
                    <div className="divide-y divide-[rgb(var(--border-line))] border-t border-[rgb(var(--border-line))]">
                      {ungrouped.map((s) => (
                        <ScreenRow key={s.id} s={s} shown={!hidden.includes(s.id)} onToggle={() => toggleScreen(s.id)} />
                      ))}
                    </div>
                  </div>
                )}
                {groupedTree.length === 0 && ungrouped.length === 0 && (
                  <p className="text-caption text-text-tertiary">App chưa có screen nào.</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* Nâng cao: gộp nhiều app vào 1 portal */}
        {!loading && (
          <div className="rounded-md border border-[rgb(var(--border-line))]">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-caption text-text-secondary hover:text-text-primary"
            >
              <span>Nâng cao — gộp app vào nhiều Cổng / nhiều link</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>
            {showAdvanced && (
              <div className="space-y-2 border-t border-[rgb(var(--border-line))] p-3">
                {linked.map((ws) => (
                  <div key={ws.id} className="flex items-center justify-between gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-caption text-text-primary">{ws.name}</span>
                      <FilterTag tone={ws.is_active === false ? 'danger' : 'success'} className="cursor-default">
                        {ws.is_active === false ? 'Đã tắt' : 'Đang bật'}
                      </FilterTag>
                    </div>
                    <Button variant="outline" size="xs" loading={busyId === ws.id} disabled={busyId === ws.id} onClick={() => void toggleActive(ws)}>
                      {ws.is_active === false ? 'Bật' : 'Tắt'}
                    </Button>
                  </div>
                ))}
                {others.map((ws) => (
                  <div key={ws.id} className="flex items-center justify-between gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
                    <span className="truncate text-caption text-text-secondary">{ws.name}</span>
                    <Button variant="outline" size="xs" loading={busyId === ws.id} disabled={!slug || busyId === ws.id} onClick={() => void attach(ws)}>
                      Gắn app vào
                    </Button>
                  </div>
                ))}
                <Button variant="secondary" size="xs" onClick={createCong} disabled={!slug || busyId === 'new'} loading={busyId === 'new'}>
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

function ScreenRow({ s, shown, onToggle }: { s: ScreenLite; shown: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 pl-6">
      <span className={`min-w-0 truncate text-caption ${shown ? 'text-text-primary' : 'text-text-quaternary line-through'}`}>
        {s.title} <span className="text-tiny text-text-quaternary">· {s.kind}</span>
      </span>
      <VisToggle on={shown} onClick={onToggle} />
    </div>
  );
}

function VisToggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={on ? 'Đang hiện — bấm để ẩn trên link' : 'Đang ẩn — bấm để hiện'}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-tiny font-emphasis transition-colors disabled:opacity-40 ${
        on ? 'text-success hover:bg-success/10' : 'text-text-quaternary hover:bg-surface-2'
      }`}
    >
      {on ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      {on ? 'Hiện' : 'Ẩn'}
    </button>
  );
}
