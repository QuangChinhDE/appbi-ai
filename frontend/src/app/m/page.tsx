'use client';

/**
 * Multi-workspace launcher — the PWA home screen (start_url=/m).
 *
 * End-users add workspaces (paste a public link or token), then tap to open
 * the mini-app at /ws/{token}. The list is saved locally (this device only).
 * Model C: this is the installable "app" home — no store needed.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Download, Loader2, Plus, Share, Trash2, Zap } from 'lucide-react';
import { workspaceApi } from '@/lib/api/workspace';
import PwaRegister from '@/components/pwa/PwaRegister';

interface SavedWs {
  token: string;
  name: string;
  ts: number;
}
const LS_KEY = 'appbi_workspaces';

function parseToken(input: string): string {
  const s = input.trim();
  const m = s.match(/\/ws\/([^/?#\s]+)/);
  return (m ? m[1] : s).trim();
}

function loadList(): SavedWs[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveList(list: SavedWs[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

export default function LauncherPage() {
  const router = useRouter();
  const [list, setList] = useState<SavedWs[]>([]);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PWA install prompt (Android/Chrome)
  const [installEvt, setInstallEvt] = useState<Event | null>(null);
  // iOS Safari has no install prompt — show the manual "Add to Home Screen" hint.
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    setList(loadList());
    const onBip = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e);
    };
    window.addEventListener('beforeinstallprompt', onBip);
    // Detect iOS (incl. iPadOS, which reports as MacIntel + touch) and whether
    // we're already running standalone (added to home screen) — only nudge when
    // it's iOS and NOT yet installed.
    const ua = window.navigator.userAgent.toLowerCase();
    const isIOS =
      /iphone|ipad|ipod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIosHint(isIOS && !standalone);
    return () => window.removeEventListener('beforeinstallprompt', onBip);
  }, []);

  const addWorkspace = useCallback(async () => {
    setError(null);
    const token = parseToken(input);
    if (!token) {
      setError('Hãy dán link hoặc mã workspace.');
      return;
    }
    if (list.some((w) => w.token === token)) {
      setError('Workspace này đã có trong danh sách.');
      return;
    }
    setBusy(true);
    try {
      const { workspace } = await workspaceApi.getMeta(token);
      const next = [{ token, name: workspace?.name || 'Workspace', ts: Date.now() }, ...list];
      setList(next);
      saveList(next);
      setInput('');
      setAdding(false);
    } catch {
      setError('Không tìm thấy workspace. Kiểm tra lại link/mã.');
    } finally {
      setBusy(false);
    }
  }, [input, list]);

  const remove = (token: string) => {
    const next = list.filter((w) => w.token !== token);
    setList(next);
    saveList(next);
  };

  const open = (w: SavedWs) => {
    const next = [{ ...w, ts: Date.now() }, ...list.filter((x) => x.token !== w.token)];
    setList(next);
    saveList(next);
    router.push(`/ws/${w.token}`);
  };

  const doInstall = async () => {
    if (!installEvt) return;
    // @ts-expect-error - beforeinstallprompt is non-standard
    installEvt.prompt?.();
    setInstallEvt(null);
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-slate-50">
      <PwaRegister />

      {/* Hero */}
      <header className="bg-gradient-to-br from-[#082569] via-[#0D3B7A] to-[#1565C0] px-5 pb-6 pt-8 text-white">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25">
            <Zap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold leading-tight">Ứng dụng của tôi</h1>
            <p className="text-xs text-blue-100">Chọn workspace để vào nhập liệu &amp; báo cáo</p>
          </div>
        </div>
        {installEvt && (
          <button
            onClick={doInstall}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold ring-1 ring-white/25 hover:bg-white/25"
          >
            <Download className="h-4 w-4" /> Cài ứng dụng về màn hình chính
          </button>
        )}
        {iosHint && !installEvt && (
          <div className="mt-4 rounded-xl bg-white/15 px-4 py-3 ring-1 ring-white/25">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Share className="h-4 w-4" /> Cài lên iPhone/iPad
            </p>
            <p className="mt-1 text-xs leading-relaxed text-blue-100">
              iPhone không có nút cài tự động. Mở trang này bằng <b>Safari</b>, bấm
              nút <b>Chia sẻ</b> (ô vuông có mũi tên ↑ ở thanh dưới), rồi chọn{' '}
              <b>“Thêm vào Màn hình chính”</b>.
            </p>
          </div>
        )}
      </header>

      <main className="flex-1 px-4 py-4">
        {/* Add workspace */}
        {adding ? (
          <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="mb-1 block text-xs font-semibold text-slate-500">
              Link hoặc mã workspace
            </label>
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addWorkspace()}
              placeholder="Dán link .../ws/abc... hoặc mã"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[#1565C0]"
            />
            {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
            <div className="mt-3 flex gap-2">
              <button
                onClick={addWorkspace}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#0D3B7A] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Thêm
              </button>
              <button
                onClick={() => {
                  setAdding(false);
                  setError(null);
                  setInput('');
                }}
                className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-600"
              >
                Huỷ
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-4 py-3.5 text-sm font-semibold text-[#0D3B7A] hover:bg-slate-50"
          >
            <Plus className="h-4 w-4" /> Thêm workspace
          </button>
        )}

        {/* List */}
        {list.length === 0 ? (
          <div className="mt-10 text-center text-sm text-slate-400">
            Chưa có workspace nào.
            <br />
            Bấm “Thêm workspace” và dán link được cấp.
          </div>
        ) : (
          <ul className="space-y-2.5">
            {list.map((w) => (
              <li
                key={w.token}
                className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm"
              >
                <button onClick={() => open(w)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#0D3B7A] text-white">
                    <Zap className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-800">{w.name}</p>
                    <p className="truncate text-[11px] text-slate-400">{w.token.slice(0, 14)}…</p>
                  </div>
                </button>
                <button
                  onClick={() => remove(w.token)}
                  title="Xoá khỏi danh sách"
                  className="flex-shrink-0 rounded-lg p-2 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => open(w)}
                  className="flex-shrink-0 rounded-lg bg-slate-100 p-2 text-[#0D3B7A]"
                >
                  <ArrowRight className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="px-4 pb-5 pt-2 text-center text-[11px] text-slate-400">
        AppBI · Danh sách lưu trên thiết bị này
      </footer>
    </div>
  );
}
