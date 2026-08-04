'use client';

/**
 * Operational (Workboard) dataset — OLTP *Destination* banner.
 *
 * An operational dataset is a live data store behind a Workboard, not a
 * reporting snapshot. This banner is where the store is set up and shown:
 *  - Not yet provisioned → a setup card: pick a Google Sheets connection, then
 *    either CREATE a new app-owned spreadsheet (declaring the initial tables &
 *    columns, schema-first) or BIND an existing one (tabs auto-discovered).
 *  - Provisioned → a compact live-store bar with a link to the spreadsheet and
 *    whether the app manages it (created) or it's bound.
 *
 * Reporting datasets never render this — the parent gates on
 * dataset.purpose === 'operational'.
 */

import { useMemo, useState } from 'react';
import {
  Database,
  ExternalLink,
  Loader2,
  Plus,
  Table2,
  Trash2,
  Sheet,
} from 'lucide-react';

import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  useDatasetDestination,
  useProvisionDestination,
  type OperationalTableSpec,
} from '@/hooks/use-datasets';
import { useDataSources } from '@/hooks/use-datasources';

interface DraftTable {
  name: string;
  columns: string; // comma-separated column names, kept as raw text while editing
}

function parseColumns(raw: string): { name: string }[] {
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

export function OperationalDestinationBanner({
  datasetId,
  datasetName,
  canEdit,
}: {
  datasetId: number;
  datasetName?: string | null;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const { data: destination, isLoading } = useDatasetDestination(datasetId);
  const { data: dataSources } = useDataSources();
  const provision = useProvisionDestination();

  const sheetsConnections = useMemo(
    () => (dataSources ?? []).filter((d: { type?: string }) => d.type === 'google_sheets'),
    [dataSources],
  );

  const [setupOpen, setSetupOpen] = useState(false);
  const [mode, setMode] = useState<'create' | 'bind'>('create');
  const [credentialId, setCredentialId] = useState<number | ''>('');
  const [tables, setTables] = useState<DraftTable[]>([{ name: '', columns: '' }]);

  // Provisioned → compact live-store bar.
  if (destination) {
    return (
      <div className="mx-4 mt-2 flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-xs">
        <Sheet className="h-4 w-4 text-emerald-500" />
        <span className="font-medium text-text-secondary">
          {t('datasets.detail.destination.liveStore')}
        </span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
          {destination.managed
            ? t('datasets.detail.destination.managed')
            : t('datasets.detail.destination.bound')}
        </span>
        {destination.spreadsheet_url && (
          <a
            href={destination.spreadsheet_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-brand hover:underline"
          >
            {t('datasets.detail.destination.openSheet')}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    );
  }

  if (isLoading) return null;

  // Not provisioned → setup card.
  const canSubmit =
    canEdit &&
    credentialId !== '' &&
    (mode === 'bind' ||
      tables.some((tb) => tb.name.trim().length > 0)) &&
    !provision.isPending;

  const submit = () => {
    if (credentialId === '') {
      toast.error(t('datasets.detail.destination.pickConnection'));
      return;
    }
    const cleanTables: OperationalTableSpec[] = tables
      .filter((tb) => tb.name.trim())
      .map((tb) => ({ name: tb.name.trim(), columns: parseColumns(tb.columns) }));
    if (mode === 'create' && cleanTables.length === 0) {
      toast.error(t('datasets.detail.destination.needTable'));
      return;
    }
    provision.mutate(
      {
        datasetId,
        credential_datasource_id: Number(credentialId),
        mode,
        title: datasetName ?? undefined,
        tables: mode === 'create' ? cleanTables : cleanTables.length ? cleanTables : undefined,
      },
      {
        onSuccess: () => {
          toast.success(t('datasets.detail.destination.provisioned'));
          setSetupOpen(false);
        },
        onError: (err: unknown) => {
          const detail =
            (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
            t('datasets.detail.destination.provisionError');
          toast.error(typeof detail === 'string' ? detail : t('datasets.detail.destination.provisionError'));
        },
      },
    );
  };

  return (
    <div className="mx-4 mt-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2.5 text-xs dark:border-amber-500/30 dark:bg-amber-500/10">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="font-medium text-text-secondary">
          {t('datasets.detail.destination.notSetTitle')}
        </span>
        <span className="text-text-tertiary">{t('datasets.detail.destination.notSetHint')}</span>
        {canEdit && !setupOpen && (
          <button
            onClick={() => setSetupOpen(true)}
            className="ml-auto rounded-md bg-brand px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
          >
            {t('datasets.detail.destination.setUp')}
          </button>
        )}
      </div>

      {setupOpen && canEdit && (
        <div className="mt-3 space-y-3 border-t border-amber-200/60 pt-3 dark:border-amber-500/20">
          {/* Connection */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-tertiary">
              {t('datasets.detail.destination.connection')}
            </label>
            <select
              value={credentialId}
              onChange={(e) => setCredentialId(e.target.value ? Number(e.target.value) : '')}
              className="w-full max-w-md rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="">{t('datasets.detail.destination.pickConnection')}</option>
              {sheetsConnections.map((c: { id: number; name: string }) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {sheetsConnections.length === 0 && (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">
                {t('datasets.detail.destination.noConnections')}
              </span>
            )}
          </div>

          {/* Mode */}
          <div className="flex gap-2">
            {(['create', 'bind'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  mode === m
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-[rgb(var(--border-line))] text-text-tertiary hover:bg-surface-2'
                }`}
              >
                {m === 'create'
                  ? t('datasets.detail.destination.modeCreate')
                  : t('datasets.detail.destination.modeBind')}
              </button>
            ))}
          </div>

          {/* Tables (create → required; bind → optional, blank = auto-discover) */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-tertiary">
              <Table2 className="h-3.5 w-3.5" />
              {mode === 'create'
                ? t('datasets.detail.destination.tablesCreate')
                : t('datasets.detail.destination.tablesBind')}
            </div>
            {tables.map((tb, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={tb.name}
                  onChange={(e) =>
                    setTables((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))
                  }
                  placeholder={t('datasets.detail.destination.tableName')}
                  className="w-40 rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <input
                  value={tb.columns}
                  onChange={(e) =>
                    setTables((prev) => prev.map((p, j) => (j === i ? { ...p, columns: e.target.value } : p)))
                  }
                  placeholder={t('datasets.detail.destination.columnsPlaceholder')}
                  className="flex-1 rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
                />
                {tables.length > 1 && (
                  <button
                    onClick={() => setTables((prev) => prev.filter((_, j) => j !== i))}
                    className="p-1 text-text-quaternary hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => setTables((prev) => [...prev, { name: '', columns: '' }])}
              className="inline-flex items-center gap-1 text-[11px] text-brand hover:underline"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('datasets.detail.destination.addTable')}
            </button>
            <p className="text-[11px] text-text-quaternary">
              {t('datasets.detail.destination.idHint')}
            </p>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {provision.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === 'create'
                ? t('datasets.detail.destination.createStore')
                : t('datasets.detail.destination.bindStore')}
            </button>
            <button
              onClick={() => setSetupOpen(false)}
              className="rounded-md px-2.5 py-1.5 text-[11px] text-text-tertiary hover:bg-surface-2"
            >
              {t('datasets.detail.destination.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
