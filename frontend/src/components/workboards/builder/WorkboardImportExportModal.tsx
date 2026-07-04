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
import { useI18n } from '@/providers/LanguageProvider';

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
  const { t } = useI18n();
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
        toast.error(getApiErrorMessage(err, t('workboards.export.exportFailed')));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workboard.id, includeCredentials, t]);

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
      toast.success(t('workboards.export.copied'));
    } catch {
      toast.error(t('workboards.export.copyBlocked'));
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
      title={t('workboards.export.title')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('workboards.export.close')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopy} disabled={!bundle}>
            {t('workboards.export.copyJson')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<Download className="h-3.5 w-3.5" />}
            onClick={handleDownload}
            disabled={!bundle}
          >
            {t('workboards.export.downloadJson')}
          </Button>
        </>
      }
    >
      {loading && !bundle ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
        </div>
      ) : !bundle ? (
        <p className="text-caption text-text-tertiary">{t('workboards.export.noData')}</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-info/20 bg-info/5 p-3 text-caption text-text-secondary">
            {t('workboards.export.descriptionPrefix')} <strong>{t('workboards.export.entireDataset')}</strong>{' '}
            {t('workboards.export.descriptionMiddle')} <strong>{t('workboards.export.chooseSource')}</strong>{' '}
            {t('workboards.export.descriptionSuffix')}
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
                {t('workboards.export.includeCredentialsTitle', { count: bundle.app_users?.length ?? 0 })}
              </div>
              <div className="mt-0.5 text-caption text-text-tertiary">
                {t('workboards.export.includeCredentialsDescriptionPrefix')} <strong>{t('workboards.export.turnOff')}</strong>{' '}
                {t('workboards.export.includeCredentialsDescriptionSuffix')}
              </div>
            </div>
          </label>

          <div className="grid grid-cols-4 gap-3">
            <Stat label={t('workboards.export.screens')} value={screens.length} />
            <Stat label={t('workboards.export.referencedTables')} value={tableCount} />
            <Stat label={t('workboards.export.appUsers')} value={bundle.app_users?.length ?? 0} />
            <Stat label={t('workboards.export.bundleVersion')} value={String(bundle.bundle_version ?? 1)} />
          </div>

          <div>
            <h4 className="mb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              {t('workboards.export.tablesInBundle')}
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
                        {m.display_name || m.source_table_name || t('workboards.import.tableFallback', { id })}
                      </div>
                      <div className="truncate text-caption text-text-quaternary">
                        {m.source_table_name} · {t('workboards.import.columnCount', { count: m.columns?.length || 0 })} ·
                        {t('workboards.export.datasetLabel')} {m.dataset_name || '?'}
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
