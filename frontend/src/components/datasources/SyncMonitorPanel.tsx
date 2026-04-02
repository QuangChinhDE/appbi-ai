'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StopCircle,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Ban,
  Minus,
} from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { dataSourceApi } from '@/lib/api/datasources';
import { useCancelSync, useSyncJobs } from '@/hooks/use-datasources';
import type { SyncJob } from '@/types/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogEntry {
  ts: string;
  level: string;
  message: string;
  table?: string;
}

interface Props {
  datasourceId: number;
  jobId: number;
  onClose: () => void;
}

function finalizeTableProgress(
  progress: Record<string, string>,
  status: string,
): Record<string, string> {
  const terminalStatus = status === 'success'
    ? 'done'
    : status === 'cancelled'
    ? 'cancelled'
    : status === 'failed' || status === 'timeout'
    ? 'failed'
    : 'running';

  return Object.fromEntries(
    Object.entries(progress).map(([table, tableStatus]) => {
      if (tableStatus === 'done' || tableStatus === 'failed' || tableStatus === 'cancelled') {
        return [table, tableStatus];
      }
      return [table, terminalStatus];
    }),
  );
}

// ── Table progress icon ───────────────────────────────────────────────────────

function TableStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />;
    case 'done':
      return <CheckCircle className="w-3.5 h-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-500" />;
    case 'cancelled':
      return <Ban className="w-3.5 h-3.5 text-amber-500" />;
    default:
      return <Minus className="w-3.5 h-3.5 text-gray-300" />;
  }
}

function LogLevelBadge({ level }: { level: string }) {
  if (level === 'ERROR')
    return <span className="text-[10px] font-semibold text-red-500 w-10 shrink-0">ERR</span>;
  if (level === 'WARN')
    return <span className="text-[10px] font-semibold text-amber-500 w-10 shrink-0">WARN</span>;
  return <span className="text-[10px] font-semibold text-gray-400 w-10 shrink-0">INFO</span>;
}

function LogStageBadge({ message }: { message: string }) {
  const match = message.match(/^\[(SOURCE|WRITE|FINALIZE|DUCKDB|DONE)\]/);
  const stage = match?.[1];
  if (!stage) {
    return null;
  }

  const className =
    stage === 'SOURCE'
      ? 'bg-sky-500/15 text-sky-300 border-sky-500/20'
      : stage === 'WRITE'
      ? 'bg-blue-500/15 text-blue-300 border-blue-500/20'
      : stage === 'FINALIZE'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/20'
      : stage === 'DUCKDB'
      ? 'bg-violet-500/15 text-violet-300 border-violet-500/20'
      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20';

  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${className}`}>
      {stage}
    </span>
  );
}

function formatLogMessage(message: string) {
  return message.replace(/^\[(SOURCE|WRITE|FINALIZE|DUCKDB|DONE)\]\s*/, '');
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SyncMonitorPanel({ datasourceId, jobId, onClose }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tableProgress, setTableProgress] = useState<Record<string, string>>({});
  const [jobStatus, setJobStatus] = useState<string>('running');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showTables, setShowTables] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const cancelMutation = useCancelSync();
  const { data: jobsData } = useSyncJobs(datasourceId, 5);

  // Find current job info from jobs list
  const currentJob = (jobsData?.jobs ?? []).find((j: SyncJob) => j.id === jobId);

  useEffect(() => {
    if (currentJob?.status) {
      setJobStatus(currentJob.status);
    }
  }, [currentJob?.status]);

  // Auto-scroll log container
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // SSE connection
  useEffect(() => {
    const url = dataSourceApi.syncLogsUrl(datasourceId, jobId);
    const eventSource = new EventSource(url, { withCredentials: true });
    setStreamError(null);

    eventSource.onmessage = (event) => {
      try {
        const entry: LogEntry = JSON.parse(event.data);
        setLogs((prev) => [...prev, entry]);
      } catch {
        // ignore unparseable
      }
    };

    eventSource.addEventListener('progress', (event) => {
      try {
        const progress = JSON.parse((event as MessageEvent).data);
        setTableProgress(progress);
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener('done', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setJobStatus(data.status);
        setTableProgress((prev) => finalizeTableProgress(data.table_progress ?? prev, data.status));
        setStreamError(null);
      } catch {
        // ignore
      }
      eventSource.close();
    });

    eventSource.onerror = () => {
      setStreamError('Log stream disconnected. The job may still be running.');
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [datasourceId, jobId]);

  // Handle manual scroll
  const handleScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const handleCancel = () => {
    cancelMutation.mutate({ dsId: datasourceId, jobId });
  };

  const isRunning = jobStatus === 'running';
  const tableEntries = Object.entries(tableProgress);
  const doneCount = tableEntries.filter(([, s]) => s === 'done' || s === 'failed' || s === 'cancelled').length;
  const totalCount = tableEntries.length;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Sync logs • Run #${jobId}`}
      size="xl"
      footer={
        isRunning ? (
          <button
            onClick={handleCancel}
            disabled={cancelMutation.isPending}
            className="flex items-center gap-1.5 rounded bg-red-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            <StopCircle className="h-3.5 w-3.5" />
            Cancel sync
          </button>
        ) : undefined
      }
    >
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 bg-gray-900 px-4 py-3 text-white">
          <div className="flex items-center gap-3">
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
            ) : jobStatus === 'success' ? (
              <CheckCircle className="w-4 h-4 text-green-400" />
            ) : jobStatus === 'cancelled' ? (
              <Ban className="w-4 h-4 text-amber-400" />
            ) : (
              <XCircle className="w-4 h-4 text-red-400" />
            )}
            <span className="text-sm font-medium">
              {isRunning
                ? `Syncing… ${totalCount > 0 ? `(${doneCount}/${totalCount} tables)` : ''}`
                : jobStatus === 'success'
                ? `Sync complete — ${currentJob?.rows_synced?.toLocaleString() ?? doneCount} rows`
                : jobStatus === 'cancelled'
                ? 'Sync cancelled'
                : 'Sync failed'}
            </span>
          </div>
          <span className="rounded-full border border-white/15 bg-white/10 px-2 py-1 text-[11px] text-gray-200">
            Click outside to close
          </span>
        </div>

        {tableEntries.length > 0 && (
          <div className="border-b border-gray-200">
            <button
              onClick={() => setShowTables(!showTables)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              {showTables ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
              Tables ({doneCount}/{totalCount})
              <div className="ml-2 h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    jobStatus === 'failed'
                      ? 'bg-red-500'
                      : jobStatus === 'cancelled'
                      ? 'bg-amber-500'
                      : 'bg-blue-500'
                  }`}
                  style={{ width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%` }}
                />
              </div>
            </button>
            {showTables && (
              <div className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto px-4 pb-2">
                {tableEntries.map(([table, status]) => (
                  <div key={table} className="flex items-center gap-2 py-0.5">
                    <TableStatusIcon status={status} />
                    <span className="truncate font-mono text-xs text-gray-700" title={table}>
                      {table.includes('.') ? table.split('.').pop() : table}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div
          ref={logContainerRef}
          onScroll={handleScroll}
          className="h-[26rem] overflow-y-auto bg-gray-950 px-4 py-2 font-mono text-xs leading-5"
        >
          {streamError && (
            <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300">
              {streamError}
            </div>
          )}
          {logs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-gray-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {isRunning ? 'Waiting for sync logs…' : 'No in-memory logs available for this run.'}
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex gap-2 py-0.5">
                <span className="shrink-0 text-gray-600">
                  {new Date(log.ts).toLocaleString('en-GB', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <LogLevelBadge level={log.level} />
                <LogStageBadge message={log.message} />
                <span
                  className={`${
                    log.level === 'ERROR'
                      ? 'text-red-400'
                      : log.level === 'WARN'
                      ? 'text-amber-400'
                      : 'text-gray-300'
                  }`}
                >
                  {formatLogMessage(log.message)}
                </span>
              </div>
            ))
          )}
        </div>

        {!autoScroll && isRunning && (
          <button
            onClick={() => {
              setAutoScroll(true);
              if (logContainerRef.current) {
                logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
              }
            }}
            className="w-full bg-blue-50 py-1.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-100"
          >
            ↓ Scroll to bottom
          </button>
        )}
      </div>
    </Modal>
  );
}
