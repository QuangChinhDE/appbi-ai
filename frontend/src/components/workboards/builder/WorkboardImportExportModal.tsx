/**
 * WorkboardImportExportModal — share workboard layouts as portable JSON.
 *
 * Export lives here because it needs the current workboard. Import delegates
 * to the shared list-page modal so table/column mapping stays consistent.
 */
'use client';

import React, { useEffect, useState } from 'react';
import {
  Download,
  FileJson,
  Loader2,
} from 'lucide-react';

import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import type { Workboard } from '@/lib/api/workboards';
import WorkboardImportModal from '@/components/workboards/WorkboardImportModal';

interface Props {
  workboard: Workboard;
  mode: 'export' | 'import';
  onClose: () => void;
}

interface ExportBundle {
  bundle_version?: number;
  tables_meta?: Record<string, ExportTableMeta>;
  layout_json?: { screens?: unknown[] };
  app_users?: Array<{ username?: string; pin_hash?: string }>;
  app_users_include_credentials?: boolean;
}

interface ExportTableMeta {
  display_name?: string | null;
  source_table_name?: string | null;
  dataset_name?: string | null;
  columns?: unknown[];
}

interface ApiErrorShape {
  response?: {
    data?: {
      detail?: string;
    };
  };
}

export default function WorkboardImportExportModal({
  workboard,
  mode,
  onClose,
}: Props) {
  return mode === 'export' ? (
    <ExportPanel workboard={workboard} onClose={onClose} />
  ) : (
    <WorkboardImportModal onClose={onClose} />
  );
}


function ExportPanel({
  workboard,
  onClose,
}: {
  workboard: Workboard;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  // Default ON: the common case is moving an app within the same system, where
  // carrying PIN hashes means users log in immediately after import. Turn OFF
  // before sharing a bundle outside the trusted system.
  const [includeCredentials, setIncludeCredentials] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await apiClient.get(
          `/workboards/${workboard.id}/export`,
          { params: { include_credentials: includeCredentials } },
        );
        if (alive) setBundle(r.data);
      } catch (err: unknown) {
        toast.error(getApiErrorMessage(err, 'Could not export.'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workboard.id, includeCredentials]);

  const handleDownload = () => {
    if (!bundle) return;
    // SERVER-driven download (not a client-side Blob + a.download). The backend
    // returns the bundle with `Content-Disposition: attachment`, so the browser
    // saves it reliably as `<slug>-workboard.json`. The previous Blob approach
    // depended on `a.download`, which some browsers ignored — saving the file as
    // a bare UUID with no extension. Same-origin (`/api/v1` proxy) so the
    // httpOnly auth cookie is sent with the request.
    const base = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
    const url =
      `${base}/workboards/${workboard.id}/export` +
      `?download=1&include_credentials=${includeCredentials}`;
    const a = document.createElement('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleCopy = async () => {
    if (!bundle) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      toast.success('Copied to clipboard');
    } catch {
      toast.error('The browser blocked clipboard copy');
    }
  };

  const tablesMeta = bundle?.tables_meta || {};
  const tableCount = Object.keys(tablesMeta).length;
  const screens = Array.isArray(bundle?.layout_json?.screens)
    ? bundle.layout_json.screens
    : [];

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Export workboard"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopy} disabled={!bundle}>
            Copy JSON
          </Button>
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<Download className="h-3.5 w-3.5" />}
            onClick={handleDownload}
            disabled={!bundle}
          >
            Download .json
          </Button>
        </>
      }
    >
      {loading && !bundle ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
        </div>
      ) : !bundle ? (
        <p className="text-caption text-text-tertiary">No data.</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-info/20 bg-info/5 p-3 text-caption text-text-secondary">
            Bundle gói trọn <strong>toàn bộ dataset</strong> (mọi bảng + cột + quan
            hệ/measure) và toàn bộ layout của app. Khi import ở chỗ khác, bạn chỉ
            cần <strong>chọn đúng Source</strong> — hệ thống tự tạo Dataset khớp
            Source đó rồi dựng lại app + bảng user.
          </div>

          <label className="flex items-start gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3 text-caption">
            <input
              type="checkbox"
              checked={includeCredentials}
              onChange={(e) => setIncludeCredentials(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5"
            />
            <div>
              <div className="font-medium text-text-primary">
                Kèm PIN (đã hash) cho {bundle.app_users?.length ?? 0} app user
              </div>
              <div className="mt-0.5 text-caption text-text-tertiary">
                Mặc định BẬT để chuyển nội bộ cùng hệ thống — import xong user đăng
                nhập được ngay. <strong>Tắt</strong> trước khi chia sẻ file ra ngoài;
                khi tắt, admin phải đặt lại PIN cho từng user sau import.
              </div>
            </div>
          </label>

          <div className="grid grid-cols-4 gap-3">
            <Stat label="Screens" value={screens.length} />
            <Stat label="Referenced tables" value={tableCount} />
            <Stat label="App users" value={bundle.app_users?.length ?? 0} />
            <Stat label="Bundle version" value={String(bundle.bundle_version ?? 1)} />
          </div>

          <div>
            <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              Tables in bundle
            </h4>
            <div className="space-y-1">
              {Object.entries(tablesMeta).map(([id, m]) => (
                <div
                  key={id}
                  className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-caption"
                >
                  <FileJson className="h-3.5 w-3.5 text-text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-emphasis text-text-primary">
                      {m.display_name || m.source_table_name || `Table ${id}`}
                    </div>
                    <div className="truncate text-caption text-text-quaternary">
                      {m.source_table_name} · {m.columns?.length || 0} columns ·
                      dataset: {m.dataset_name || '?'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}


function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2 text-center">
      <div className="text-h3 font-emphasis text-text-primary">{value}</div>
      <div className="text-caption text-text-tertiary">{label}</div>
    </div>
  );
}

function getApiErrorMessage(err: unknown, fallback: string): string {
  return (err as ApiErrorShape)?.response?.data?.detail || fallback;
}
