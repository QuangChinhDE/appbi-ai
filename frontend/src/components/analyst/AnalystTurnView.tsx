'use client';

/**
 * One AI Analyst exchange: the question and what the server returned for it -
 * an answer (summary, chart, table, checks, evidence, chart draft, feedback), a
 * clarification, a refusal, "unsupported", or a stored turn the viewer may no
 * longer read (`redacted`: a shared session never shows numbers from a Dataset the
 * viewer cannot read). The page never decides access or numbers.
 */
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Lock, ShieldCheck, XCircle } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';
import { analystApi, type AnalystTurn } from '@/lib/api/analyst';
import { chartApi } from '@/lib/api/charts';
import { extractApiError } from '@/lib/api-errors';
import { getPalette } from '@/lib/chartColors';
import type { ChartCreate } from '@/types/api';

/** The app's default chart series palette (the same one Chart Builder uses). */
const SERIES_COLORS = getPalette('default').colors;
const BRAND = 'rgb(var(--brand))';
const GRID = 'rgb(var(--border-line))';
const MAX_SERIES = 8;

const CARD = 'rounded-lg border border-stroke-strong bg-surface-1';
const HEADING = 'text-label uppercase tracking-wide text-text-tertiary';

export type Exchange = {
  question: string;
  turn: AnalystTurn | null;
  error?: string;
  /** a stored turn the viewer may not read now (no response is sent) */
  redacted?: boolean;
  askedAt?: string | null;
  askedByMe?: boolean;
};

export function errorText(err: unknown): string {
  return extractApiError(err, 'error');
}

function fmt(v: unknown, locale: string): string {
  if (typeof v === 'number') return v.toLocaleString(locale, { maximumFractionDigits: 2 });
  if (v === null || v === undefined) return '—';
  return String(v);
}

function period(v: unknown): string {
  const s = String(v ?? '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : s.slice(0, 10);
}

/** Rows -> recharts points: one point per period, one key per series. */
function chartModel(turn: AnalystTurn) {
  const cols = turn.columns || [];
  const plan = (turn.plan || {}) as { time_grains?: Record<string, string> };
  const timeRef = Object.keys(plan.time_grains || {})[0];
  const measure = cols.find((c) => c.role === 'measure');
  const time = cols.find((c) => c.role === 'dimension' && c.ref === timeRef);
  const cats = cols.filter((c) => c.role === 'dimension' && c !== time);
  const cat = cats[0];
  // More than one category cannot be drawn as one series per category without
  // hiding one of them: the table shows it instead (dogfood: vùng × kênh drew region only).
  if (!measure || cats.length > 1) return null;
  const rows = turn.rows || [];
  if (time) {
    const totals = new Map<string, number>();
    rows.forEach((r) => {
      const k = cat ? String(r[cat.name]) : measure.label;
      totals.set(k, (totals.get(k) || 0) + Number(r[measure.name] || 0));
    });
    const series = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SERIES).map(([k]) => k);
    const byPeriod = new Map<string, Record<string, number | string>>();
    rows.forEach((r) => {
      const p = period(r[time.name]);
      const k = cat ? String(r[cat.name]) : measure.label;
      if (!series.includes(k)) return;
      const point = byPeriod.get(p) || { period: p };
      point[k] = Number(point[k] || 0) + Number(r[measure.name] || 0);
      byPeriod.set(p, point);
    });
    const points = [...byPeriod.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
    return { kind: 'line' as const, points, series, measure: measure.label, hidden: totals.size - series.length };
  }
  if (cat) {
    const points = rows.map((r) => ({ period: String(r[cat.name]), [measure.label]: Number(r[measure.name] || 0) }))
      .sort((a, b) => Number(b[measure.label]) - Number(a[measure.label])).slice(0, 15);
    return { kind: 'bar' as const, points, series: [measure.label], measure: measure.label, hidden: 0 };
  }
  return null;
}

export function ExchangeCard({ ex, locale, onAccept, onOption, readOnly }: {
  ex: Exchange; locale: string; onAccept: () => void; onOption: (o: string) => void;
  /** a shared session the viewer may read but not ask in: no option buttons */
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const turn = ex.turn;
  return (
    <article className="space-y-3" data-testid="analyst-exchange">
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-brand-container px-3 py-2 text-caption text-brand-on-container">
          {ex.question}
        </p>
      </div>
      {ex.askedAt ? (
        <p className="text-right text-micro text-text-quaternary" data-testid="analyst-asked-at">
          {t('analyst.session.askedAt', { at: new Date(ex.askedAt).toLocaleString(locale) })}
          {ex.askedByMe === false ? ` · ${t('analyst.session.askedByOther')}` : ''}
        </p>
      ) : null}
      {ex.redacted ? (
        <div className={`${CARD} flex items-start gap-2 p-4 text-caption text-text-secondary`} data-testid="analyst-redacted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
          <span>{t('analyst.session.redacted')}</span>
        </div>
      ) : ex.error || !turn ? (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-caption text-danger" data-testid="analyst-error">
          {t('analyst.error')} <span className="text-micro">({ex.error})</span>
        </div>
      ) : turn.status === 'answered' ? <AnswerView turn={turn} locale={locale} readOnly={readOnly} />
        : turn.status === 'refused' ? (
          <div role="alert" className="rounded-lg border border-warning/30 bg-warning-bg p-4 text-caption" data-testid="analyst-refused" data-code={turn.code}>
            <div className="flex items-center gap-2 font-emphasis text-warning"><AlertTriangle className="h-4 w-4" aria-hidden />
              {turn.code === 'filter_would_drop' ? t('analyst.dropTitle') : t('analyst.refused')}</div>
            <p className="mt-1 text-text-secondary">{turn.message}</p>
            {turn.code === 'filter_would_drop' && turn.detail?.dropped?.length ? (
              <>
                <ul className="mt-2 list-disc pl-5 text-label font-normal text-text-tertiary">
                  {turn.detail.dropped.map((d) => <li key={d.field}>{d.field} — {d.reason}</li>)}
                </ul>
                <p className="mt-2 text-label font-normal text-text-tertiary">{t('analyst.dropBody')}</p>
                {turn.consent_available && !readOnly ? (
                  <Button variant="outline" size="sm" className="mt-2" onClick={onAccept} data-testid="analyst-accept-drop">
                    {t('analyst.dropAccept')}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : turn.status === 'clarify' ? (
          <div className={`${CARD} p-4 text-caption`} data-testid="analyst-clarify">
            <div className="font-emphasis text-text-primary">{t('analyst.clarify')}</div>
            <p className="mt-1 text-text-secondary">{turn.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(turn.options || []).map((o) => (
                <Button key={o} variant="tonal" size="xs" disabled={readOnly} onClick={() => onOption(o)}>{o}</Button>
              ))}
            </div>
          </div>
        ) : (
          <div className={`${CARD} p-4 text-caption`} data-testid="analyst-unsupported">
            <div className="flex items-center gap-2 font-emphasis text-text-primary">
              <XCircle className="h-4 w-4 text-text-tertiary" aria-hidden />{t('analyst.unsupported')}</div>
            <p className="mt-1 text-text-secondary">{turn.message}</p>
          </div>
        )}
    </article>
  );
}

function AnswerView({ turn, locale, readOnly }: { turn: AnalystTurn; locale: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const model = useMemo(() => chartModel(turn), [turn]);
  const a = turn.answer!;
  const ev = turn.evidence!;
  const interp = String((turn.plan as { interpretation?: string } | undefined)?.interpretation || '');
  const axis = { fontSize: 11, fill: 'rgb(var(--text-tertiary))' };
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-3" data-testid="analyst-answer">
      <div className="min-w-0 space-y-3 lg:col-span-2">
        <section className={`${CARD} p-4`}>
          <h2 className={HEADING}>{t('analyst.answer')}</h2>
          <p className="mt-1 text-body font-emphasis text-text-primary" data-testid="analyst-headline">{a.headline}</p>
          {a.bullets.length ? (
            <ul className="mt-2 space-y-1 text-caption text-text-secondary">{a.bullets.map((b, i) => <li key={i}>• {b}</li>)}</ul>
          ) : null}
          {a.note ? <p className="mt-2 text-label font-normal text-text-tertiary">{a.note}</p> : null}
          {interp ? (
            <p className="mt-2 text-label font-normal text-text-tertiary">
              <span className="font-emphasis">{t('analyst.interpretation')}:</span> {interp}
            </p>
          ) : null}
        </section>

        {model ? (
          <section className={`${CARD} p-4`} data-testid="analyst-chart">
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                {model.kind === 'line' ? (
                  <LineChart data={model.points} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                    <XAxis dataKey="period" tick={axis} interval={0} angle={model.points.length > 4 ? -30 : 0}
                           textAnchor={model.points.length > 4 ? 'end' : 'middle'} height={model.points.length > 4 ? 56 : 30}
                           tickFormatter={(v: string) => (String(v).length > 14 ? `${String(v).slice(0, 13)}…` : String(v))} />
                    <YAxis tick={axis} width={72} tickFormatter={(v) => Number(v).toLocaleString(locale, { notation: 'compact' })} />
                    <Tooltip formatter={(v) => fmt(v, locale)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {model.series.map((s, i) => (
                      <Line key={s} type="monotone" dataKey={s} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} dot={false}
                            strokeWidth={2} isAnimationActive={false} />
                    ))}
                  </LineChart>
                ) : (
                  <BarChart data={model.points} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                    <XAxis dataKey="period" tick={axis} interval={0} angle={model.points.length > 4 ? -30 : 0}
                           textAnchor={model.points.length > 4 ? 'end' : 'middle'} height={model.points.length > 4 ? 56 : 30}
                           tickFormatter={(v: string) => (String(v).length > 14 ? `${String(v).slice(0, 13)}…` : String(v))} />
                    <YAxis tick={axis} width={72} tickFormatter={(v) => Number(v).toLocaleString(locale, { notation: 'compact' })} />
                    <Tooltip formatter={(v) => fmt(v, locale)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey={model.measure} fill={BRAND} isAnimationActive={false} />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
          </section>
        ) : null}

        <DataTable turn={turn} locale={locale} />
      </div>

      <aside className="min-w-0 space-y-3">
        <section className={`${CARD} p-4`} data-testid="analyst-checks">
          <h2 className={HEADING}>{t('analyst.checks')}</h2>
          <ul className="mt-2 space-y-1">
            {a.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-label font-normal text-text-secondary">
                {c.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label={t('analyst.check.ok')} />
                  : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-label={t('analyst.check.warning')} />}{c.detail}
              </li>
            ))}
          </ul>
        </section>
        <section className={`${CARD} p-4`} data-testid="analyst-evidence">
          <h2 className={`flex items-center gap-1.5 ${HEADING}`}>
            <ShieldCheck className="h-3.5 w-3.5 text-brand" aria-hidden />{t('analyst.evidence')}</h2>
          <dl className="mt-2 space-y-1.5 text-label font-normal text-text-secondary">
            <Row k={t('analyst.evidence.source')} v={`${ev.source} · ${ev.source_type}`} />
            <Row k={t('analyst.evidence.measures')} v={ev.measures.join(', ')} />
            <Row k={t('analyst.evidence.filters')} v={(ev.filters_described ?? ev.filters_applied).length
              ? (ev.filters_described ?? ev.filters_applied).join('; ') : t('analyst.evidence.none')} />
            <Row k={t('analyst.evidence.bounds')} v={t('analyst.evidence.boundsValue', { rows: ev.bounds.max_rows, seconds: ev.bounds.timeout_seconds })} />
            <Row k={t('analyst.evidence.duration')} v={`${ev.duration_ms} ms`} />
            <Row k={t('analyst.evidence.freshness')} v={ev.freshness} />
            <Row k={t('analyst.evidence.queryId')} v={<code data-testid="analyst-query-id">{ev.query_id}</code>} />
            <Row k={t('analyst.evidence.fingerprint')} v={<code>{ev.sql_fingerprint}</code>} />
          </dl>
        </section>
        <ChartDraftPanel turn={turn} />
        {readOnly ? null : <FeedbackPanel turnId={turn.turn_id} />}
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,40%)_1fr] gap-2">
      <dt className="text-text-tertiary">{k}</dt>
      <dd className="break-all">{v}</dd>
    </div>
  );
}

function DataTable({ turn, locale }: { turn: AnalystTurn; locale: string }) {
  const { t } = useI18n();
  const cols = turn.columns || [];
  const rows = (turn.rows || []).slice(0, 200);
  return (
    <section className={`${CARD} min-w-0`} data-testid="analyst-table">
      <h2 className={`px-4 pt-3 ${HEADING}`}>{t('analyst.table')}</h2>
      {turn.truncated ? <p className="px-4 text-label font-normal text-warning">{t('analyst.truncated')}</p> : null}
      <div className="max-h-80 overflow-auto p-2">
        <table className="w-full text-left text-label font-normal">
          <thead className="sticky top-0 bg-surface-1">
            <tr>{cols.map((c) => (
              <th key={c.name} scope="col" className="whitespace-nowrap border-b border-stroke-strong px-2 py-1.5 font-emphasis text-text-tertiary">{c.label}</th>
            ))}</tr>
          </thead>
          <tbody className="text-text-secondary">
            {rows.map((r, i) => (
              <tr key={i} className="odd:bg-surface-2">
                {cols.map((c) => (
                  <td key={c.name} className={`px-2 py-1 ${c.role === 'measure' ? 'text-right tabular-nums' : ''}`}>
                    {c.role === 'dimension' && /date|time/i.test(String(c.ref)) ? period(r[c.name]) : fmt(r[c.name], locale)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const REASONS = ['wrong_metric', 'wrong_dataset', 'wrong_filter', 'incorrect_number', 'wrong_interpretation',
  'unsupported_but_answerable', 'ux_issue'] as const;

function FeedbackPanel({ turnId }: { turnId?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ sent?: 'up' | 'down'; comment: string; reason: string; error?: string }>(
    { comment: '', reason: '' });
  if (!turnId) return null;
  const send = async (verdict: 'up' | 'down') => {
    try {
      await analystApi.feedback(turnId, verdict, state.comment, verdict === 'up' ? 'correct' : state.reason);
      setState((s) => ({ ...s, sent: verdict, error: undefined }));
    } catch (err) {
      setState((s) => ({ ...s, error: errorText(err) }));
    }
  };
  return (
    <section className={`${CARD} p-4`} data-testid="analyst-feedback">
      <h2 className={HEADING}>{t('analyst.feedback')}</h2>
      {state.sent ? (
        <p className="mt-1 text-label font-normal text-success" data-testid="analyst-feedback-sent">{t('analyst.feedbackThanks')}</p>
      ) : (
        <>
          <Select value={state.reason} onChange={(e) => setState((s) => ({ ...s, reason: e.target.value }))}
                  aria-label={t('analyst.feedbackReason')} data-testid="analyst-feedback-reason" className="mt-2 w-full">
            <option value="">{t('analyst.feedbackReason')}</option>
            {REASONS.map((r) => <option key={r} value={r}>{t(`analyst.feedbackReason.${r}`)}</option>)}
          </Select>
          <Textarea value={state.comment} onChange={(e) => setState((s) => ({ ...s, comment: e.target.value }))}
                    maxLength={1000} rows={2} placeholder={t('analyst.feedbackPlaceholder')}
                    aria-label={t('analyst.feedbackPlaceholder')}
                    className="mt-2 w-full" data-testid="analyst-feedback-comment" />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="xs" onClick={() => send('up')} data-testid="analyst-feedback-up">{t('analyst.feedbackUp')}</Button>
            <Button variant="secondary" size="xs" onClick={() => send('down')} data-testid="analyst-feedback-down">{t('analyst.feedbackDown')}</Button>
          </div>
        </>
      )}
      {state.error ? <p role="alert" className="mt-1 text-label font-normal text-danger">{state.error}</p> : null}
    </section>
  );
}

function ChartDraftPanel({ turn }: { turn: AnalystTurn }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ saving?: boolean; id?: number; error?: string }>({});
  const draft = turn.chart_draft;
  const save = async () => {
    if (!draft || draft.dataset_table_id == null) return;
    setState({ saving: true });
    try {
      const chart = await chartApi.create(draft as unknown as ChartCreate);
      setState({ id: chart.id });
    } catch (err) {
      setState({ error: errorText(err) });
    }
  };
  return (
    <section className={`${CARD} p-4`} data-testid="analyst-chart-draft">
      <h2 className={HEADING}>{t('analyst.chart')}</h2>
      {draft ? (
        <>
          <p className="mt-1 text-label font-normal text-text-secondary">{draft.chart_type} · {draft.name}</p>
          {state.id ? (
            <p className="mt-2 text-label font-normal text-success" data-testid="analyst-chart-saved">{t('analyst.saved')}{' '}
              <Link href={`/explore/${state.id}`} className="font-emphasis text-brand underline" data-testid="analyst-open-chart">{t('analyst.openChart')}</Link></p>
          ) : turn.can_save === false ? (
            <p className="mt-2 text-label font-normal text-text-tertiary" data-testid="analyst-save-not-allowed">{t('analyst.saveNotAllowed')}</p>
          ) : (
            <Button variant="primary" size="xs" className="mt-2" onClick={save} loading={state.saving} data-testid="analyst-save-chart">
              {state.saving ? t('analyst.saving') : t('analyst.saveChart')}
            </Button>
          )}
          {state.error ? <p role="alert" className="mt-2 text-label font-normal text-danger" data-testid="analyst-save-error">{t('analyst.saveFailed', { reason: state.error })}</p> : null}
        </>
      ) : <p className="mt-1 text-label font-normal text-text-tertiary">{turn.chart_draft_unavailable}</p>}
    </section>
  );
}
