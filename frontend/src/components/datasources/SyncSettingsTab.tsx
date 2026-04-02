'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Play,
  Save,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Table2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  useSyncConfig,
  useSaveSyncConfig,
  useSyncJobs,
  useTriggerSync,
  useCancelSync,
  useDataSourceSchema,
  useWatermarkCandidates,
} from '@/hooks/use-datasources';
import TableDetailModal from './TableDetailModal';
import SyncMonitorPanel from './SyncMonitorPanel';
import type {
  SyncConfig,
  SyncScheduleConfig,
  SyncTableConfig,
  SyncStrategyType,
  ScheduleType,
  SchemaEntry,
} from '@/types/api';

// ── Constants ─────────────────────────────────────────────────────────────

const TIMEZONES = [
  'UTC',
  'Asia/Ho_Chi_Minh',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Shanghai',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Australia/Sydney',
];

const BACKOFF_OPTIONS = [
  { value: '1m', label: '1 minute' },
  { value: '5m', label: '5 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
];

const STRATEGY_OPTIONS: { value: SyncStrategyType; label: string }[] = [
  { value: 'full_refresh', label: 'Full refresh' },
  { value: 'incremental', label: 'Incremental' },
  { value: 'append_only', label: 'Append only' },
  { value: 'manual', label: 'Manual' },
];

const HOURS = Array.from({ length: 24 }, (_, i) =>
  String(i).padStart(2, '0') + ':00',
);

// ── Helpers ────────────────────────────────────────────────────────────────

function cronToHuman(cron: string): string {
  try {
    const [min, hour, dom, mon, dow] = cron.trim().split(' ');
    if (dow === '*' && dom === '*' && mon === '*') {
      return `Daily at ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')} UTC`;
    }
    if (dow !== '*') {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `Weekly on ${days[parseInt(dow)]} at ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')} UTC`;
    }
    return cron;
  } catch {
    return cron;
  }
}

function buildCron(type: ScheduleType, schedule: SyncScheduleConfig): string {
  if (type === 'custom_cron') return schedule.cron_expression ?? '0 2 * * *';
  if (type === 'daily') {
    const [h, m] = (schedule.time ?? '02:00').split(':');
    return `${m ?? '0'} ${h ?? '2'} * * *`;
  }
  // interval — approximate with cron
  const hours = schedule.interval_hours ?? 6;
  return `0 */${hours} * * *`;
}

function nextRunLabel(cron: string, tz: string): string {
  // Simple server-side—just show human readable + timezone hint
  return `${cronToHuman(cron)} (${tz})`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatRows(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── Status badge ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium">
        <CheckCircle className="w-3 h-3" /> Success
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-red-600 text-xs font-medium">
        <XCircle className="w-3 h-3" /> Failed
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-blue-600 text-xs font-medium">
        <Loader2 className="w-3 h-3 animate-spin" /> Running
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium">
        <XCircle className="w-3 h-3" /> Cancelled
      </span>
    );
  }
  if (status === 'timeout') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium">
        <Clock className="w-3 h-3" /> Timeout
      </span>
    );
  }
  return <span className="text-xs text-gray-500">{status}</span>;
}

// ── Default configs ───────────────────────────────────────────────────────

function defaultSyncConfig(): SyncConfig {
  return {
    schedule: {
      enabled: false,
      type: 'daily',
      time: '02:00',
      timezone: 'UTC',
      interval_hours: 6,
      cron_expression: '0 2 * * *',
    },
    tables: {},
    retry: {
      max_attempts: 3,
      backoff_interval: '5m',
    },
    notification: {
      email_on_failure: true,
      webhook_url: '',
    },
  };
}

// ── SyncSettingsTab ────────────────────────────────────────────────────────

interface Props {
  datasourceId: number;
}

export default function SyncSettingsTab({ datasourceId }: Props) {
  const { data: configData, isLoading: configLoading } = useSyncConfig(datasourceId);
  const { data: schemaData } = useDataSourceSchema(datasourceId);
  const { data: jobsData, isLoading: jobsLoading } = useSyncJobs(datasourceId, 5);
  const saveMutation = useSaveSyncConfig();
  const syncMutation = useTriggerSync();
  const cancelMutation = useCancelSync();

  const [cfg, setCfg] = useState<SyncConfig>(defaultSyncConfig());
  const [saved, setSaved] = useState(false);
  const [tableModal, setTableModal] = useState<{ schema: string; name: string } | null>(null);
  const [monitorJobId, setMonitorJobId] = useState<number | null>(null);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);

  // Load stored config into state
  useEffect(() => {
    if (configData?.sync_config && Object.keys(configData.sync_config).length > 0) {
      setCfg({ ...defaultSyncConfig(), ...configData.sync_config });
    }
  }, [configData]);

  // Collect table list from schema — include all synced types
  const allTables: { schema: string; name: string }[] = [];
  (schemaData?.schemas ?? []).forEach((s: SchemaEntry) => {
    s.tables
      .filter((t) => t.type !== 'view')   // skip pure views — they have no rows to sync
      .forEach((t) => allTables.push({ schema: s.schema, name: t.name }));
  });

  const tableKey = (schema: string, name: string) => `${schema}.${name}`;

  // ── Update helpers ───────────────────────────────────────────────────────

  const updateSchedule = useCallback(
    (patch: Partial<SyncScheduleConfig>) =>
      setCfg((c) => ({ ...c, schedule: { ...c.schedule!, ...patch } })),
    [],
  );

  const updateTableConfig = useCallback(
    (key: string, patch: Partial<SyncTableConfig>) =>
      setCfg((c) => ({
        ...c,
        tables: {
          ...c.tables,
          [key]: { ...(c.tables?.[key] ?? { enabled: true, strategy: 'full_refresh' }), ...patch },
        },
      })),
    [],
  );

  const handleSave = async () => {
    // Ensure every visible table has an explicit entry in cfg.tables so the
    // backend doesn't skip them (backend defaults enabled to false).
    const completeTables: Record<string, SyncTableConfig> = { ...cfg.tables };
    allTables.forEach(({ schema, name }) => {
      const key = tableKey(schema, name);
      if (!completeTables[key]) {
        completeTables[key] = { enabled: true, strategy: 'full_refresh' };
      }
    });
    const completeConfig: SyncConfig = { ...cfg, tables: completeTables };
    await saveMutation.mutateAsync({ id: datasourceId, config: completeConfig });
    setCfg(completeConfig);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTriggerSync = () => {
    syncMutation.mutate(datasourceId);
  };

  // ── Computed values ──────────────────────────────────────────────────────

  const schedule = cfg.schedule ?? defaultSyncConfig().schedule!;
  const cron = buildCron(schedule.type, schedule);
  const nextRun = schedule.enabled ? nextRunLabel(cron, schedule.timezone ?? 'UTC') : null;
  const enabledTableCount = allTables.filter(({ schema, name }) => {
    const key = tableKey(schema, name);
    return (cfg.tables?.[key]?.enabled ?? true) !== false;
  }).length;
  const runningJob = (jobsData?.jobs ?? []).find((job) => job.status === 'running') ?? null;
  const latestJob = (jobsData?.jobs ?? [])[0] ?? null;

  if (configLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading sync settings…
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-gray-100 bg-gradient-to-r from-slate-50 to-white px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Sync control center</h2>
            <p className="mt-1 text-sm text-gray-500">
              Ưu tiên cấu hình bảng cần sync và theo dõi lịch sử chạy. Các tùy chỉnh nâng cao được gom riêng phía dưới.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleTriggerSync}
              disabled={syncMutation.isPending}
              className="flex items-center gap-2 rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              {syncMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Sync now
            </button>
            <button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saved ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saved ? 'Saved!' : 'Save settings'}
            </button>
          </div>
        </div>

        <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Tables selected</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900">{enabledTableCount}/{allTables.length}</div>
            <div className="mt-1 text-xs text-gray-500">Các bảng được bật sẽ tham gia vào đợt sync tiếp theo.</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Current run</div>
            <div className="mt-1 text-sm font-semibold text-gray-900">
              {runningJob ? `Running • Job #${runningJob.id}` : latestJob ? `Last run • Job #${latestJob.id}` : 'No runs yet'}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {runningJob
                ? 'Bấm vào dòng trong Run history để xem log realtime.'
                : latestJob
                ? `${latestJob.status} • ${formatRows(latestJob.rows_synced)} rows`
                : 'Chưa có lịch sử sync nào được ghi nhận.'}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Schedule</div>
            <div className="mt-1 text-sm font-semibold text-gray-900">
              {schedule.enabled ? 'Enabled' : 'Manual only'}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {schedule.enabled && nextRun ? nextRun : 'Lịch chạy tự động đang tắt.'}
            </div>
          </div>
        </div>
      </section>

      {/* ── Main section: Sync strategy per table ──────────────────────── */}
      <section className="bg-white border border-gray-100 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-800">Sync strategy per table</h3>
              <p className="text-xs text-gray-400 mt-0.5">
                Bật/tắt và chọn strategy cho từng bảng muốn sync
              </p>
            </div>
            {/* Select all / Deselect all */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  allTables.forEach(({ schema, name }) => {
                    const key = tableKey(schema, name);
                    updateTableConfig(key, { enabled: true });
                  });
                }}
                className="text-xs text-blue-600 hover:underline"
              >
                Select all
              </button>
              <span className="text-gray-300">|</span>
              <button
                type="button"
                onClick={() => {
                  allTables.forEach(({ schema, name }) => {
                    const key = tableKey(schema, name);
                    updateTableConfig(key, { enabled: false });
                  });
                }}
                className="text-xs text-gray-500 hover:underline"
              >
                Deselect all
              </button>
            </div>
          </div>
        </div>

        {allTables.length === 0 ? (
          <div className="px-5 py-6 text-sm text-gray-400 text-center">
            No tables found. Check connection on the Connection tab.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-center px-3 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide w-12">
                    Sync
                  </th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Table
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Strategy
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Watermark column
                  </th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Rows cached
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {allTables.map(({ schema, name }) => {
                  const key = tableKey(schema, name);
                  const tc: SyncTableConfig = cfg.tables?.[key] ?? {
                    enabled: true,
                    strategy: 'full_refresh',
                  };
                  const isEnabled = tc.enabled !== false;
                  const needsWatermark = tc.strategy === 'incremental';

                  return (
                    <tr key={key} className={`hover:bg-gray-50 ${!isEnabled ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => updateTableConfig(key, { enabled: e.target.checked })}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                        />
                      </td>
                      <td className="px-5 py-3">
                        <button
                          type="button"
                          onClick={() => setTableModal({ schema, name })}
                          className="flex items-center gap-1.5 group text-left hover:text-blue-600 transition-colors"
                        >
                          <Table2 className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500 flex-shrink-0" />
                          <span className="font-mono text-xs text-gray-400">{schema}.</span>
                          <span className="font-medium text-gray-800 group-hover:text-blue-600 underline-offset-2 group-hover:underline">{name}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={tc.strategy}
                          onChange={(e) =>
                            updateTableConfig(key, {
                              strategy: e.target.value as SyncStrategyType,
                              watermark_column: undefined,
                            })
                          }
                          disabled={!isEnabled}
                          className="border border-gray-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                        >
                          {STRATEGY_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        {needsWatermark ? (
                          <WatermarkSelect
                            datasourceId={datasourceId}
                            schema={schema}
                            table={name}
                            value={tc.watermark_column ?? ''}
                            onChange={(col) => updateTableConfig(key, { watermark_column: col })}
                          />
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right text-xs text-gray-500 font-mono">
                        {tc.rows_cached !== undefined ? formatRows(tc.rows_cached) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-5 py-3 border-t border-gray-50 bg-gray-50">
          <p className="text-xs text-gray-400">
            Bật/tắt checkbox để chọn bảng muốn sync. Watermark column chỉ hiện khi chọn Incremental.
            Chỉ các column timestamp/date/integer được hiển thị.
          </p>
        </div>
      </section>

      {/* ── Main section: Run history ──────────────────────────────────── */}
      <section className="bg-white border border-gray-100 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800">Run history</h3>
          <button className="text-xs text-blue-600 hover:underline flex items-center gap-1">
            View all <ExternalLink className="w-3 h-3" />
          </button>
        </div>

        {jobsLoading ? (
          <div className="flex items-center justify-center h-20">
            <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
          </div>
        ) : (jobsData?.jobs ?? []).length === 0 ? (
          <div className="px-5 py-6 text-sm text-gray-400 text-center">
            No sync runs yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-5 py-2.5 text-xs font-medium text-gray-500">Status</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Mode</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Started</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Duration</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Rows</th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(jobsData?.jobs ?? []).map((job) => (
                <tr
                  key={job.id}
                  className="cursor-pointer transition-colors hover:bg-blue-50"
                  onClick={() => setMonitorJobId(job.id)}
                >
                  <td className="px-5 py-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 capitalize">
                    {job.mode.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(job.started_at).toLocaleString('en-GB', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {formatDuration(job.duration_seconds)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {job.status === 'failed' ? (
                      <span className="text-xs text-red-500 flex items-center justify-end gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        {job.error_message?.slice(0, 40) ?? 'Error'}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600 font-mono">
                        {job.rows_synced !== null
                          ? `+${formatRows(job.rows_synced)} rows`
                          : '—'}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {job.status === 'running' ? (
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-blue-600">Click row to view</span>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            cancelMutation.mutate({ dsId: datasourceId, jobId: job.id });
                          }}
                          disabled={cancelMutation.isPending}
                          className="text-xs text-red-500 hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-blue-600">Click row to inspect</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="overflow-hidden rounded-lg border border-gray-100 bg-white">
        <button
          type="button"
          onClick={() => setShowAdvancedOptions((value) => !value)}
          className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-50"
        >
          <div>
            <h3 className="text-sm font-semibold text-gray-800">Advanced sync options</h3>
            <p className="mt-0.5 text-xs text-gray-400">
              Schedule, retry và notification được gom vào đây để màn hình chính gọn hơn.
            </p>
          </div>
          {showAdvancedOptions ? (
            <ChevronUp className="h-4 w-4 text-gray-500" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-500" />
          )}
        </button>

        {showAdvancedOptions && (
          <div className="grid gap-6 border-t border-gray-100 px-5 py-5 lg:grid-cols-2">
            <div className="rounded-lg border border-gray-200">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-4">
                <div>
                  <h4 className="text-sm font-semibold text-gray-800">Scheduled sync</h4>
                  <p className="mt-0.5 text-xs text-gray-400">Tự động pull data từ source theo lịch</p>
                </div>
                <button
                  onClick={() => updateSchedule({ enabled: !schedule.enabled })}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    schedule.enabled ? 'bg-blue-600' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      schedule.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {schedule.enabled ? (
                <div className="space-y-4 px-4 py-4">
                  <div>
                    <label className="mb-2 block text-xs font-medium text-gray-500">Schedule type</label>
                    <div className="flex gap-2">
                      {(['interval', 'daily', 'custom_cron'] as ScheduleType[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => updateSchedule({ type: t })}
                          className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                            schedule.type === t
                              ? 'border-blue-500 bg-blue-50 text-blue-700'
                              : 'border-gray-200 text-gray-600 hover:border-gray-300'
                          }`}
                        >
                          {t === 'interval' && (
                            <>
                              <div className="font-semibold">Interval</div>
                              <div className="text-xs font-normal opacity-70">Every X hours</div>
                            </>
                          )}
                          {t === 'daily' && (
                            <>
                              <div className="font-semibold">Daily</div>
                              <div className="text-xs font-normal opacity-70">Once per day</div>
                            </>
                          )}
                          {t === 'custom_cron' && (
                            <>
                              <div className="font-semibold">Custom cron</div>
                              <div className="text-xs font-normal opacity-70">Cron expression</div>
                            </>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  {schedule.type === 'interval' && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500">Every (hours)</label>
                      <select
                        value={schedule.interval_hours ?? 6}
                        onChange={(e) => updateSchedule({ interval_hours: parseInt(e.target.value) })}
                        className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
                          <option key={h} value={h}>
                            {h}h
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {schedule.type === 'daily' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500">Time (UTC)</label>
                        <select
                          value={schedule.time ?? '02:00'}
                          onChange={(e) => updateSchedule({ time: e.target.value })}
                          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {HOURS.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500">Timezone</label>
                        <select
                          value={schedule.timezone ?? 'UTC'}
                          onChange={(e) => updateSchedule({ timezone: e.target.value })}
                          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {TIMEZONES.map((tz) => (
                            <option key={tz} value={tz}>
                              {tz}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {schedule.type === 'custom_cron' && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500">Cron expression</label>
                      <input
                        type="text"
                        value={schedule.cron_expression ?? '0 2 * * *'}
                        onChange={(e) => updateSchedule({ cron_expression: e.target.value })}
                        placeholder="0 2 * * *"
                        className="w-full rounded-md border border-gray-200 px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  {nextRun && (
                    <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-600">
                      Tiếp theo: <span className="font-medium">{nextRun}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="px-4 py-4 text-sm text-gray-500">Schedule đang tắt. Sync chỉ chạy khi bấm tay.</div>
              )}
            </div>

            <div className="rounded-lg border border-gray-200">
              <div className="border-b border-gray-100 px-4 py-4">
                <h4 className="text-sm font-semibold text-gray-800">Retry &amp; notification</h4>
                <p className="mt-0.5 text-xs text-gray-400">Tùy chỉnh retry và cảnh báo khi sync lỗi</p>
              </div>
              <div className="space-y-4 px-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-500">Max retry attempts</label>
                    <select
                      value={cfg.retry?.max_attempts ?? 3}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          retry: { ...c.retry!, max_attempts: parseInt(e.target.value) },
                        }))
                      }
                      className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {[0, 1, 2, 3, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-500">Backoff interval</label>
                    <select
                      value={cfg.retry?.backoff_interval ?? '5m'}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          retry: { ...c.retry!, backoff_interval: e.target.value },
                        }))
                      }
                      className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {BACKOFF_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-medium text-gray-500">On failure notification</label>
                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={cfg.notification?.email_on_failure ?? true}
                        onChange={(e) =>
                          setCfg((c) => ({
                            ...c,
                            notification: {
                              ...c.notification!,
                              email_on_failure: e.target.checked,
                            },
                          }))
                        }
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">Email to admin</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!cfg.notification?.webhook_url}
                        onChange={(e) => {
                          if (!e.target.checked) {
                            setCfg((c) => ({
                              ...c,
                              notification: { ...c.notification!, webhook_url: '' },
                            }));
                          }
                        }}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">Webhook URL</span>
                    </label>
                    <input
                      type="url"
                      placeholder="https://hooks.slack.com/services/…"
                      value={cfg.notification?.webhook_url ?? ''}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          notification: { ...c.notification!, webhook_url: e.target.value },
                        }))
                      }
                      className="ml-6 w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Sync Monitor Panel ──────────────────────────────────────────── */}
      {monitorJobId && (
        <SyncMonitorPanel
          datasourceId={datasourceId}
          jobId={monitorJobId}
          onClose={() => setMonitorJobId(null)}
        />
      )}

      {/* ── Table Detail Modal ─────────────────────────────────────── */}
      {tableModal && (
        <TableDetailModal
          datasourceId={datasourceId}
          schema={tableModal.schema}
          table={tableModal.name}
          onClose={() => setTableModal(null)}
        />
      )}
    </div>
  );
}

// ── WatermarkSelect ── lazy-load watermark candidates ─────────────────────

function WatermarkSelect({
  datasourceId,
  schema,
  table,
  value,
  onChange,
}: {
  datasourceId: number;
  schema: string;
  table: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { data, isLoading } = useWatermarkCandidates(datasourceId, schema, table);

  if (isLoading) return <Loader2 className="w-3 h-3 animate-spin text-gray-400" />;

  const cols = data?.columns ?? [];
  if (cols.length === 0) {
    return <span className="text-xs text-gray-400">No suitable columns</span>;
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border border-gray-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <option value="">— select —</option>
      {cols.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name} ({c.type})
        </option>
      ))}
    </select>
  );
}
