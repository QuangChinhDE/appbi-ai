'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Eye,
  Filter,
  Info,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { Button } from '@/components/ui/Button';
import {
  type DatasetTable,
  type QualityDimensionSummary,
  type QualityRule,
  type QualityRuleResult,
  type QualityRun,
} from '@/hooks/use-datasets';

interface DatasetQualityReportModalProps {
  datasetId: number;
  open: boolean;
  onClose: () => void;
  latestRun: QualityRun | null;
  recentRuns: QualityRun[];
  rules: QualityRule[];
  tables: DatasetTable[];
  dimensionBreakdown: QualityDimensionSummary[];
}

interface RuleResultEntry {
  rule: QualityRule;
  tableName: string;
  result: QualityRuleResult;
  kind: 'passed' | 'info' | 'warning' | 'failed' | 'skipped';
}

type ReportStatus = RuleResultEntry['kind'];
type OutcomeFilter = 'all' | ReportStatus;
type SeverityFilter = 'all' | 'info' | 'warning' | 'error';

const RULE_TYPE_LABELS: Record<string, string> = {
  not_null: 'Not Null',
  not_blank: 'Not Blank',
  completeness_pct: 'Completeness %',
  accepted_values: 'Accepted Values',
  pattern_match: 'Pattern Match',
  range_check: 'Range Check',
  format_check: 'Format Check',
  unique_column: 'Unique Column',
  unique_combo: 'Unique Combination',
  cross_column: 'Cross-column Expression',
  cross_table: 'Cross-table Expression',
  freshness_days: 'Freshness',
  row_count_range: 'Row Count Range',
  statistical_range: 'Statistical Range',
  custom_sql: 'Custom SQL',
};

const SEVERITY_STYLES: Record<'info' | 'warning' | 'error', string> = {
  info: 'bg-brand/10 text-brand',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-danger/10 text-danger',
};

const OUTCOME_STYLES: Record<ReportStatus, string> = {
  passed: 'bg-success/10 text-success',
  info: 'bg-brand/10 text-brand',
  warning: 'bg-warning/10 text-warning',
  failed: 'bg-danger/10 text-danger',
  skipped: 'bg-surface-3 text-text-secondary',
};

function fmtDate(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function fmtDimensionLabel(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function resultKind(rule: QualityRule, result: QualityRuleResult): ReportStatus {
  if (result.skipped) return 'skipped';
  if (result.passed && !result.error) return 'passed';
  if (result.error || rule.severity === 'error') return 'failed';
  if (rule.severity === 'warning') return 'warning';
  return 'info';
}

function buildReportStats(entries: RuleResultEntry[]) {
  return {
    passed: entries.filter((entry) => entry.kind === 'passed').length,
    info: entries.filter((entry) => entry.kind === 'info').length,
    warning: entries.filter((entry) => entry.kind === 'warning').length,
    failed: entries.filter((entry) => entry.kind === 'failed').length,
    skipped: entries.filter((entry) => entry.kind === 'skipped').length,
    total: entries.length,
  };
}

export function DatasetQualityReportModal({
  datasetId,
  open,
  onClose,
  latestRun,
  recentRuns,
  rules,
  tables,
  dimensionBreakdown,
}: DatasetQualityReportModalProps) {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [dimensionFilter, setDimensionFilter] = useState<'all' | string>('all');
  const [tableFilter, setTableFilter] = useState<'all' | string>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');

  const ruleEntries = useMemo<RuleResultEntry[]>(() => {
    if (!latestRun?.results) return [];
    const tableMap = new Map<number, string>(
      tables.map((table) => [table.id, table.display_name || table.source_table_name || `Table ${table.id}`]),
    );

    return rules
      .map((rule) => {
        const result = latestRun.results?.[String(rule.id)];
        if (!result) return null;
        return {
          rule,
          tableName: tableMap.get(rule.table_id) || `Table ${rule.table_id}`,
          result,
          kind: resultKind(rule, result),
        };
      })
      .filter((entry): entry is RuleResultEntry => Boolean(entry))
      .sort((a, b) => {
        const order: Record<ReportStatus, number> = { failed: 0, warning: 1, info: 2, skipped: 3, passed: 4 };
        if (order[a.kind] !== order[b.kind]) {
          return order[a.kind] - order[b.kind];
        }
        const severityOrder = { error: 0, warning: 1, info: 2 };
        return severityOrder[a.rule.severity] - severityOrder[b.rule.severity];
      });
  }, [latestRun, rules, tables]);

  const runStats = useMemo(() => {
    return buildReportStats(ruleEntries);
  }, [ruleEntries]);

  const attentionEntries = useMemo(
    () => ruleEntries.filter((entry) => entry.kind === 'warning' || entry.kind === 'failed'),
    [ruleEntries],
  );

  const filteredEntries = useMemo(() => {
    return ruleEntries.filter((entry) => {
      if (outcomeFilter !== 'all' && entry.kind !== outcomeFilter) return false;
      if (dimensionFilter !== 'all' && entry.rule.dimension !== dimensionFilter) return false;
      if (tableFilter !== 'all' && entry.tableName !== tableFilter) return false;
      if (severityFilter !== 'all' && entry.rule.severity !== severityFilter) return false;
      return true;
    });
  }, [ruleEntries, outcomeFilter, dimensionFilter, tableFilter, severityFilter]);

  const filteredStats = useMemo(() => {
    return buildReportStats(filteredEntries);
  }, [filteredEntries]);

  const issueEntries = useMemo(
    () => filteredEntries.filter((entry) => entry.kind === 'warning' || entry.kind === 'failed').slice(0, 6),
    [filteredEntries],
  );

  const posture = runStats.failed > 0
    ? 'At risk'
    : runStats.warning > 0
      ? 'Watch'
      : runStats.info > 0
        ? 'Monitor'
        : typeof latestRun?.score === 'number'
          ? 'Stable'
          : 'Not scored';

  const uniqueTableNames = useMemo(
    () => Array.from(new Set(ruleEntries.map((entry) => entry.tableName))).sort(),
    [ruleEntries],
  );

  const uniqueDimensions = useMemo(
    () => Array.from(new Set(ruleEntries.map((entry) => entry.rule.dimension))).sort(),
    [ruleEntries],
  );

  if (!open) return null;

  return (
    <AppModalShell
      title="Quality Assessment Report"
      description="Static report view for the latest completed run, with fixed filters for operational review."
      icon={<Eye className="h-4 w-4" />}
      onClose={onClose}
      maxWidthClass="max-w-6xl"
      bodyClassName="p-0"
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      {!latestRun ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <ShieldCheck className="h-10 w-10 text-text-quaternary" />
          <div>
            <div className="text-small font-emphasis text-text-primary">No completed quality run yet</div>
            <div className="mt-1 text-caption text-text-tertiary">
              Run the dataset quality checks once to generate a report overview here.
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-surface-0">
          <section className="border-b border-[rgb(var(--border-line))] bg-[linear-gradient(135deg,rgba(27,99,255,0.08),rgba(27,99,255,0.02)_45%,rgba(255,255,255,0)_100%)] px-6 py-6">
            <div className="grid gap-5 lg:grid-cols-[1.4fr,0.8fr]">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-text-quaternary">Dataset quality assessment</div>
                <h3 className="mt-2 text-xl font-emphasis text-text-primary">Dataset #{datasetId}</h3>
                <div className="mt-2 flex flex-wrap gap-2 text-caption">
                  <span className="rounded-full bg-surface-1 px-2.5 py-1 text-text-secondary">
                    Run #{latestRun.id}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 capitalize ${latestRun.status === 'completed' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                    {latestRun.status}
                  </span>
                  {latestRun.trigger_source && (
                    <span className="rounded-full bg-brand/10 px-2.5 py-1 text-brand capitalize">
                      {latestRun.trigger_source}
                    </span>
                  )}
                  <span className="rounded-full bg-surface-1 px-2.5 py-1 text-text-secondary">
                    Generated {fmtDate(latestRun.completed_at || latestRun.started_at || latestRun.created_at)}
                  </span>
                </div>
                <p className="mt-4 max-w-2xl text-small leading-6 text-text-secondary">
                  This report gives a static operational readout of the latest quality execution. Use the fixed filters
                  below to narrow the findings register by outcome, dimension, table, or severity without losing the
                  overall report context.
                </p>
              </div>

              <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Executive posture</div>
                <div className="mt-2 flex items-center gap-3">
                  <div className={`text-3xl font-emphasis ${typeof latestRun.score === 'number' && latestRun.score >= 90 ? 'text-success' : typeof latestRun.score === 'number' && latestRun.score >= 70 ? 'text-warning' : 'text-danger'}`}>
                    {typeof latestRun.score === 'number' ? `${latestRun.score.toFixed(1)}%` : '—'}
                  </div>
                  <div>
                    <div className="text-small font-emphasis text-text-primary">{posture}</div>
                    <div className="text-caption text-text-tertiary">
                      {attentionEntries.length === 0
                        ? 'No warning or failed findings in the latest run.'
                        : `${attentionEntries.length} issue${attentionEntries.length === 1 ? '' : 's'} need attention.`}
                    </div>
                  </div>
                </div>
                {latestRun.error_message && (
                  <div className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-caption text-danger">
                    {latestRun.error_message}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="grid gap-3 border-b border-[rgb(var(--border-line))] px-6 py-4 md:grid-cols-2 xl:grid-cols-6">
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Rules in run</div>
              <div className="mt-1 text-small font-emphasis text-text-primary">{runStats.total}</div>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Passed</div>
              <div className="mt-1 text-small font-emphasis text-success">{runStats.passed}</div>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Info findings</div>
              <div className="mt-1 text-small font-emphasis text-brand">{runStats.info}</div>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Warning findings</div>
              <div className="mt-1 text-small font-emphasis text-warning">{runStats.warning}</div>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Failed</div>
              <div className="mt-1 text-small font-emphasis text-danger">{runStats.failed}</div>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Skipped</div>
              <div className="mt-1 text-small font-emphasis text-text-primary">{runStats.skipped}</div>
            </div>
          </section>

          <section className="border-b border-[rgb(var(--border-line))] px-6 py-4">
            <div className="mb-3 flex items-center gap-2 text-small font-emphasis text-text-primary">
              <Filter className="h-4 w-4 text-brand" />
              Findings filters
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-text-quaternary">Outcome</span>
                <select
                  value={outcomeFilter}
                  onChange={(event) => setOutcomeFilter(event.target.value as OutcomeFilter)}
                  className="h-9 w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption"
                >
                  <option value="all">All outcomes</option>
                  <option value="passed">Passed</option>
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="failed">Failed</option>
                  <option value="skipped">Skipped</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-text-quaternary">Dimension</span>
                <select
                  value={dimensionFilter}
                  onChange={(event) => setDimensionFilter(event.target.value)}
                  className="h-9 w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption"
                >
                  <option value="all">All dimensions</option>
                  {uniqueDimensions.map((dimension) => (
                    <option key={dimension} value={dimension}>{fmtDimensionLabel(dimension)}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-text-quaternary">Table</span>
                <select
                  value={tableFilter}
                  onChange={(event) => setTableFilter(event.target.value)}
                  className="h-9 w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption"
                >
                  <option value="all">All tables</option>
                  {uniqueTableNames.map((tableName) => (
                    <option key={tableName} value={tableName}>{tableName}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-wide text-text-quaternary">Severity</span>
                <select
                  value={severityFilter}
                  onChange={(event) => setSeverityFilter(event.target.value as SeverityFilter)}
                  className="h-9 w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption"
                >
                  <option value="all">All severities</option>
                  <option value="error">Error</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-caption text-text-tertiary">
              <span>Showing {filteredStats.total} of {runStats.total} rules.</span>
              <button
                type="button"
                onClick={() => {
                  setOutcomeFilter('all');
                  setDimensionFilter('all');
                  setTableFilter('all');
                  setSeverityFilter('all');
                }}
                className="rounded-full border border-[rgb(var(--border-line))] px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-1"
              >
                Reset filters
              </button>
            </div>
          </section>

          <div className="grid gap-5 px-6 py-5 lg:grid-cols-[1.3fr,0.9fr]">
            <section className="space-y-4">
              <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                <div className="mb-3 flex items-center gap-2 text-small font-emphasis text-text-primary">
                  <CalendarClock className="h-4 w-4 text-brand" />
                  Executive summary
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  <div className="rounded-xl bg-surface-2 px-3 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Filtered pass</div>
                    <div className="mt-1 text-small font-emphasis text-success">{filteredStats.passed}</div>
                  </div>
                  <div className="rounded-xl bg-surface-2 px-3 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Filtered info</div>
                    <div className="mt-1 text-small font-emphasis text-brand">{filteredStats.info}</div>
                  </div>
                  <div className="rounded-xl bg-surface-2 px-3 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Filtered warning</div>
                    <div className="mt-1 text-small font-emphasis text-warning">{filteredStats.warning}</div>
                  </div>
                  <div className="rounded-xl bg-surface-2 px-3 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Filtered failed</div>
                    <div className="mt-1 text-small font-emphasis text-danger">{filteredStats.failed}</div>
                  </div>
                  <div className="rounded-xl bg-surface-2 px-3 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Filtered scope</div>
                    <div className="mt-1 text-small font-emphasis text-text-primary">{new Set(filteredEntries.map((entry) => entry.tableName)).size || 0} tables</div>
                  </div>
                </div>
                <p className="mt-4 text-caption leading-6 text-text-secondary">
                  {attentionEntries.length === 0
                    ? 'The current report shows no warning or failed controls. Quality posture is stable for the evaluated rules.'
                    : 'Use the findings register below as the static review artifact for operational discussions, root-cause triage, and follow-up assignments.'}
                </p>
              </div>

              <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                <div className="mb-3 text-small font-emphasis text-text-primary">Dimension health</div>
                {dimensionBreakdown.length === 0 ? (
                  <div className="text-caption text-text-tertiary">No dimension summary available yet.</div>
                ) : (
                  <div className="space-y-3">
                    {dimensionBreakdown.map((dimension) => {
                      const enabled = dimension.enabled ?? 0;
                      const passed = dimension.passed ?? 0;
                      const pct = enabled > 0 ? Math.round((passed / enabled) * 100) : 0;
                      return (
                        <div key={dimension.dimension} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-caption font-emphasis text-text-primary">{fmtDimensionLabel(dimension.dimension)}</div>
                              <div className="mt-0.5 text-[11px] text-text-tertiary">{passed}/{enabled} passed</div>
                            </div>
                            <div className={`text-small font-emphasis ${pct >= 90 ? 'text-success' : pct >= 70 ? 'text-warning' : 'text-danger'}`}>{pct}%</div>
                          </div>
                          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
                            <div
                              className={`h-full rounded-full ${pct >= 90 ? 'bg-success' : pct >= 70 ? 'bg-warning' : 'bg-danger'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                <div className="mb-3 text-small font-emphasis text-text-primary">Findings register</div>
                {filteredEntries.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-4 py-6 text-center text-caption text-text-tertiary">
                    No findings match the current filters.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredEntries.map(({ rule, tableName, result, kind }) => (
                      <article key={rule.id} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-small font-emphasis text-text-primary">{rule.name}</div>
                            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                              <span className={`rounded-full px-2 py-0.5 font-medium ${OUTCOME_STYLES[kind]}`}>{kind}</span>
                              <span className={`rounded-full px-2 py-0.5 font-medium ${SEVERITY_STYLES[rule.severity]}`}>{rule.severity}</span>
                              <span className="rounded-full bg-surface-1 px-2 py-0.5 text-text-secondary">{fmtDimensionLabel(rule.dimension)}</span>
                              <span className="rounded-full bg-surface-1 px-2 py-0.5 text-text-secondary">{RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type}</span>
                            </div>
                          </div>
                          <div className="text-right text-[11px] text-text-tertiary">
                            <div>{tableName}</div>
                            {rule.column_name && <div>{rule.column_name}</div>}
                          </div>
                        </div>

                        <div className="mt-3 grid gap-2 text-caption md:grid-cols-3">
                          <div className="rounded-lg bg-surface-1 px-3 py-2">
                            <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Rows checked</div>
                            <div className="mt-1 font-emphasis text-text-primary">{result.rows_checked ?? '—'}</div>
                          </div>
                          <div className="rounded-lg bg-surface-1 px-3 py-2">
                            <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Rows failed</div>
                            <div className="mt-1 font-emphasis text-text-primary">{result.rows_failed ?? '—'}</div>
                          </div>
                          <div className="rounded-lg bg-surface-1 px-3 py-2">
                            <div className="text-[11px] uppercase tracking-wide text-text-quaternary">Failure rate</div>
                            <div className="mt-1 font-emphasis text-text-primary">
                              {typeof result.rows_checked === 'number' && result.rows_checked > 0 && typeof result.rows_failed === 'number'
                                ? `${((result.rows_failed / result.rows_checked) * 100).toFixed(1)}%`
                                : '—'}
                            </div>
                          </div>
                        </div>

                        {result.detail && (
                          <div className="mt-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-secondary">
                            {result.detail}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-4">
              <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                <div className="mb-3 text-small font-emphasis text-text-primary">Priority issues</div>
                {issueEntries.length === 0 ? (
                  <div className="rounded-xl bg-success/10 px-3 py-3 text-caption text-success">
                    No warning or failed findings remain under the current filters.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {issueEntries.map(({ rule, tableName, result, kind }) => (
                      <div key={rule.id} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-caption font-emphasis text-text-primary">{rule.name}</div>
                            <div className="mt-0.5 text-[11px] text-text-tertiary">{tableName}</div>
                          </div>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OUTCOME_STYLES[kind]}`}>{kind}</span>
                        </div>
                        <div className="mt-2 text-[11px] text-text-tertiary">
                          {typeof result.rows_failed === 'number' ? `${result.rows_failed} row(s) affected` : 'No row metrics available'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                <div className="mb-3 text-small font-emphasis text-text-primary">Recent run trail</div>
                {recentRuns.length === 0 ? (
                  <div className="text-caption text-text-tertiary">No run history available yet.</div>
                ) : (
                  <div className="space-y-2">
                    {recentRuns.slice(0, 8).map((run) => (
                      <div key={run.id} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-caption font-emphasis text-text-primary">Run #{run.id}</div>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${run.status === 'completed' ? 'bg-success/10 text-success' : run.status === 'failed' ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand'}`}>
                            {run.status}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                          <Clock3 className="h-3 w-3" />
                          {fmtDate(run.completed_at || run.started_at || run.created_at)}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                          {typeof run.score === 'number' && (
                            <span className="rounded-full bg-surface-1 px-2 py-0.5 text-text-secondary">Score {run.score.toFixed(1)}%</span>
                          )}
                          {run.trigger_source && (
                            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-brand capitalize">{run.trigger_source}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                <div className="mb-2 text-small font-emphasis text-text-primary">Review notes</div>
                <div className="space-y-2 text-caption text-text-tertiary">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>This report is intentionally static in structure so it can be used as a review artifact during quality checkpoints.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <span>Use the filters to narrow findings without changing the headline score or the original run context.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    <span>The scheduled email PDF remains the external share format; this modal is the in-app review format for multiple viewers.</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </AppModalShell>
  );
}
