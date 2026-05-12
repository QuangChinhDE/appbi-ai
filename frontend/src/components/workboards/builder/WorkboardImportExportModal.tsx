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
  const [includeCredentials, setIncludeCredentials] = useState(false);

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
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = workboard.slug || `workboard-${workboard.id}`;
    a.download = `${slug}.workboard.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
            Export includes the full layout plus a snapshot of all{' '}
            <strong>{tableCount}</strong> referenced tables (table names + columns).
            When importing into another instance, AppBI lets you remap tables/columns before creating it.
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
                Include credentials (PIN hashes) for {bundle.app_users?.length ?? 0} app users
              </div>
              <div className="mt-0.5 text-tiny text-text-tertiary">
                Default OFF to keep shared files safer. Turn this on only when the
                bundle must work immediately after import, such as demos or seed data.
                When off, an admin must reset each user PIN after import.
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
                    <div className="truncate text-tiny text-text-quaternary">
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
      <div className="text-tiny text-text-tertiary">{label}</div>
    </div>
  );
}

function getApiErrorMessage(err: unknown, fallback: string): string {
  return (err as ApiErrorShape)?.response?.data?.detail || fallback;
}
