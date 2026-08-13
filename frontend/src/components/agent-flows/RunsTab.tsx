'use client';

/**
 * What this flow actually did, for real viewers.
 *
 * The four questions this screen exists to answer, none of which had an answer
 * before — the old telemetry table was keyed by link and knew nothing about flows,
 * versions or nodes:
 *
 *   which questions fail        → the flow needs another branch
 *   which node is slow          → optimise the right one
 *   is v6 better than v5        → runs carry their version
 *   was the answer any good     → the viewer's thumb, joined in
 *
 * Test runs are excluded by default. Without that, the first week of any flow's
 * numbers is mostly its author trying things.
 */
import React from 'react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  listRuns, runDetail, runStats,
  type RunDetail, type RunRow, type RunStats,
} from '@/lib/agentFlows';
import { formatWhen } from './shared';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success', partial: 'warning', blocked: 'danger', failed: 'danger', throttled: 'warning',
};
const STATUS_LABEL_KEY: Record<string, string> = {
  ok: 'agentFlows.runs.status.ok',
  partial: 'agentFlows.runs.status.partial',
  blocked: 'agentFlows.runs.status.blocked',
  failed: 'agentFlows.runs.status.failed',
  throttled: 'agentFlows.runs.status.throttled',
};

export function RunsTab({ brainKey }: { brainKey: string }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = React.useState<RunRow[]>([]);
  const [stats, setStats] = React.useState<RunStats | null>(null);
  const [detail, setDetail] = React.useState<RunDetail | null>(null);
  const [status, setStatus] = React.useState('');
  const [hours, setHours] = React.useState(24);
  const [search, setSearch] = React.useState('');
  const [includeTests, setIncludeTests] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      listRuns(brainKey, { status: status || undefined, since_hours: hours, search, include_tests: includeTests }),
      runStats(brainKey, hours),
    ])
      .then(([list, s]) => {
        if (!alive) return;
        setRows(list.runs);
        setStats(s);
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [brainKey, status, hours, search, includeTests]);

  const open = async (row: RunRow) => {
    setDetail(await runDetail(brainKey, row.id));
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-[1400px]">
        <div className="mb-3 flex flex-wrap items-center gap-6 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
          <Stat value={stats?.runs ?? 0} label={`Runs / ${hours}h`} />
          {/* "Trả lời được", not "Thành công": a `partial` run DID answer the
              viewer, so it counts here — but printing 100% THÀNH CÔNG above a row
              visibly marked "Một phần" makes the number look wrong even when it is
              right. The label is what had to change. */}
          <Stat value={`${stats?.success_rate ?? 0}%`} label={t('agentFlows.runs.answerable')} />
          <Stat value={`${((stats?.p95_latency_ms ?? 0) / 1000).toFixed(1)}s`} label="P95" />
          <Stat value={stats?.avg_tokens ?? 0} label="Token TB" />
          <Stat value={stats?.errors ?? 0} label={t('agentFlows.runs.errors')} />
          <Stat value={stats?.links ?? 0} label={t('agentFlows.runs.linksUsing')} />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={t('agentFlows.runs.searchPlaceholder')} className="w-72" />
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption">
            <option value="">{t('agentFlows.runs.allStatuses')}</option>
            {Object.keys(STATUS_LABEL_KEY).map((s) => <option key={s} value={s}>{t(STATUS_LABEL_KEY[s])}</option>)}
          </select>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}
            className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption">
            <option value={24}>{t('agentFlows.runs.range.24h')}</option>
            <option value={168}>{t('agentFlows.runs.range.7d')}</option>
            <option value={720}>{t('agentFlows.runs.range.30d')}</option>
          </select>
          <label className="flex items-center gap-1.5 text-caption text-text-tertiary">
            <input type="checkbox" checked={includeTests}
              onChange={(e) => setIncludeTests(e.target.checked)} />
            {t('agentFlows.runs.includeTests')}
          </label>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.8fr)]">
          <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
            <table className="w-full table-fixed border-collapse">
              <thead>
                <tr className="bg-surface-2 text-left text-tiny uppercase tracking-wider text-text-quaternary">
                  <th className="w-24 px-3 py-2.5">{t('agentFlows.runs.header.time')}</th>
                  <th className="w-28 px-3 py-2.5">{t('agentFlows.runs.header.status')}</th>
                  <th className="px-3 py-2.5">{t('agentFlows.runs.header.question')}</th>
                  <th className="w-52 px-3 py-2.5">{t('agentFlows.runs.header.path')}</th>
                  <th className="w-20 px-3 py-2.5">{t('agentFlows.runs.header.latency')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => open(r)}
                    className={cn('cursor-pointer border-t border-[rgb(var(--border-line))] text-caption hover:bg-surface-2',
                      detail?.id === r.id && 'bg-surface-2')}>
                    <td className="px-3 py-2.5 text-text-tertiary">{formatWhen(r.at, locale)}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_TONE[r.status] || 'neutral'} size="xs">
                        {STATUS_LABEL_KEY[r.status] ? t(STATUS_LABEL_KEY[r.status]) : r.status}
                      </Badge>
                    </td>
                    <td className="truncate px-3 py-2.5 text-text-secondary">{r.question || t('agentFlows.common.none')}</td>
                    <td className="truncate px-3 py-2.5 text-text-tertiary">{r.execution_path || t('agentFlows.common.none')}</td>
                    <td className="px-3 py-2.5 text-text-tertiary">
                      {r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)}s` : t('agentFlows.common.none')}
                    </td>
                  </tr>
                ))}
                {!rows.length && !loading && (
                  <tr><td colSpan={5} className="px-3 py-10 text-center text-caption text-text-tertiary">
                    {t('agentFlows.runs.empty')}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <aside className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
            {!detail ? (
              <p className="p-6 text-center text-caption text-text-tertiary">
                {t('agentFlows.runs.selectRun')}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2/40 px-3 py-2.5">
                  <b className="text-caption font-strong">Run #{detail.id}</b>
                  <Badge variant={STATUS_TONE[detail.status] || 'neutral'} size="xs">
                    {STATUS_LABEL_KEY[detail.status] ? t(STATUS_LABEL_KEY[detail.status]) : detail.status}
                  </Badge>
                  <div className="flex-1" />
                  {detail.version != null && <Badge size="xs" variant="neutral">v{detail.version}</Badge>}
                </div>
                <div className="p-3">
                  <Label>{t('agentFlows.runs.question')}</Label>
                  <p className="mt-1 text-caption text-text-secondary">{detail.question || t('agentFlows.common.none')}</p>

                  <Label className="mt-3">{t('agentFlows.runs.steps')}</Label>
                  <div className="mt-1 overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                    {detail.steps.map((s) => (
                      <div key={`${s.seq}-${s.key}`}
                        className="flex gap-2 border-t border-[rgb(var(--border-line))] p-2 first:border-t-0">
                        <StepMark status={s.status} />
                        <div className="min-w-0">
                          <b className="block text-tiny font-medium">{s.name || s.key}</b>
                          <span className="block text-tiny text-text-tertiary">
                            {s.type} · {s.ms ?? 0}ms
                            {s.status === 'reused' && t('agentFlows.runs.step.reused')}
                            {s.status === 'skipped' && t('agentFlows.runs.step.skipped')}
                          </span>
                          {s.error && <span className="block text-tiny text-danger">{s.error}</span>}
                        </div>
                      </div>
                    ))}
                  </div>

                  {!!detail.notices.length && (
                    <>
                      <Label className="mt-3">{t('agentFlows.runs.viewerNotes')}</Label>
                      {detail.notices.map((n, i) => (
                        <p key={i} className="mt-1 rounded-md border border-warning/20 bg-warning/5 p-2 text-tiny text-warning">
                          {n.text}
                        </p>
                      ))}
                    </>
                  )}

                  <Label className="mt-3">{t('agentFlows.runs.answer')}</Label>
                  <p className="mt-1 whitespace-pre-wrap text-caption leading-relaxed text-text-secondary">
                    {detail.answer || t('agentFlows.common.none')}
                  </p>

                  <Label className="mt-3">{t('agentFlows.runs.cost')}</Label>
                  <p className="mt-1 text-tiny text-text-tertiary">
                    {t('agentFlows.runs.usage', {
                      llm: detail.usage.llm_calls,
                      tools: detail.usage.tool_calls,
                      tokens: detail.usage.prompt_tokens + detail.usage.completion_tokens,
                    })}
                  </p>
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <strong className="text-body font-strong">{value}</strong>
      <span className="text-tiny uppercase tracking-wide text-text-tertiary">{label}</span>
    </div>
  );
}

function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('text-tiny font-strong uppercase tracking-wider text-text-quaternary', className)}>
      {children}
    </div>
  );
}

function StepMark({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    ok: ['bg-success/10 text-success', '✓'],
    reused: ['bg-info/10 text-info', '↺'],
    skipped: ['bg-surface-2 text-text-quaternary', '–'],
    error: ['bg-danger/10 text-danger', '×'],
    blocked: ['bg-danger/10 text-danger', '!'],
  };
  const [tone, glyph] = map[status] || map.ok;
  return (
    <span className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-tiny', tone)}>
      {glyph}
    </span>
  );
}
