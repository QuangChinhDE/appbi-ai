'use client';

/**
 * One AI Chat exchange: the question and the ONE envelope the server returned for
 * it (docs/features/unified-ai-chat/contract.md, D.5).
 *
 *   data        the Data Core's answer - summary, chart, table, checks, evidence,
 *               chart draft. The only place a business number comes from.
 *   supporting  documents an optional Agent Flow cited, its findings in its own
 *               words, and the figures in them the data core did NOT verify -
 *               always shown apart from the data, never merged into it.
 *   legacy      a conversation from before the unified chat, as it was.
 *
 * A stored turn the viewer may no longer read is `redacted` (a share never grants a
 * Dataset or a document). The page never decides access or numbers.
 */
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, Ban, BookOpen, CheckCircle2, Info, Loader2, Lock, ShieldCheck, XCircle,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';
import { chatApi, type ChatEnvelope, type CoreResponse, type Supporting, type TurnStatus } from '@/lib/api/chat';
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
  envelope: ChatEnvelope | null;
  /** `running` while the turn is in flight (live, or reloaded mid-turn) */
  status?: TurnStatus;
  /** live progress steps of a running turn */
  progress?: string[];
  turnId?: string;
  error?: string;
  /** a stored turn the viewer may not read now (no envelope is sent) */
  redacted?: boolean;
  redactedReason?: 'source_access' | 'asker_only' | null;
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
function chartModel(turn: CoreResponse) {
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
  /** a shared conversation the viewer may read but not ask in: no option buttons */
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const e = ex.envelope;
  return (
    <article className="space-y-3" data-testid="chat-exchange">
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-brand-container px-3 py-2 text-caption text-brand-on-container">
          {ex.question}
        </p>
      </div>
      {ex.askedAt ? (
        <p className="text-right text-micro text-text-quaternary" data-testid="chat-asked-at">
          {t('aichat.session.askedAt', { at: new Date(ex.askedAt).toLocaleString(locale) })}
          {ex.askedByMe === false ? ` · ${t('aichat.session.askedByOther')}` : ''}
        </p>
      ) : null}
      {ex.redacted ? (
        <div className={`${CARD} flex items-start gap-2 p-4 text-caption text-text-secondary`} data-testid="chat-redacted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
          <span>{ex.redactedReason === 'asker_only' ? t('aichat.session.redactedAskerOnly') : t('aichat.session.redacted')}</span>
        </div>
      ) : ex.status === 'running' && !e ? (
        <Running steps={ex.progress || []} />
      ) : ex.error || !e ? (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-caption text-danger" data-testid="chat-error">
          {t('aichat.error')} <span className="text-micro">({ex.error})</span>
        </div>
      ) : (
        <EnvelopeView e={e} locale={locale} onAccept={onAccept} onOption={onOption} readOnly={readOnly} />
      )}
    </article>
  );
}

function Running({ steps }: { steps: string[] }) {
  const { t } = useI18n();
  return (
    <div className={`${CARD} p-4 text-caption text-text-secondary`} data-testid="chat-running" aria-live="polite">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden />{t('aichat.thinking')}
      </div>
      {steps.length ? (
        <ol className="mt-2 space-y-0.5 text-label font-normal text-text-tertiary" data-testid="chat-progress">
          {steps.map((s, i) => <li key={i}>• {s}</li>)}
        </ol>
      ) : null}
    </div>
  );
}

function EnvelopeView({ e, locale, onAccept, onOption, readOnly }: {
  e: ChatEnvelope; locale: string; onAccept: () => void; onOption: (o: string) => void; readOnly?: boolean;
}) {
  const { t } = useI18n();
  const data = e.data;
  let main: React.ReactNode = null;
  if (e.legacy?.origin === 'flow_v0') {
    main = <LegacyAnswer e={e} />;
  } else if (e.status === 'cancelled') {
    main = (
      <div className={`${CARD} flex items-center gap-2 p-4 text-caption text-text-secondary`} data-testid="chat-cancelled">
        <Ban className="h-4 w-4 text-text-tertiary" aria-hidden />{t('aichat.cancelled')}
      </div>
    );
  } else if (e.status === 'failed') {
    main = (
      <div role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-4 text-caption" data-testid="chat-failed" data-code={e.code || ''}>
        <div className="flex items-center gap-2 font-emphasis text-danger"><XCircle className="h-4 w-4" aria-hidden />{t('aichat.failed')}</div>
        {e.message ? <p className="mt-1 text-text-secondary">{e.message}</p> : null}
      </div>
    );
  } else if (data?.status === 'answered') {
    main = <AnswerView turn={data} locale={locale} readOnly={readOnly} />;
  } else if (data?.status === 'clarify') {
    main = (
      <div className={`${CARD} p-4 text-caption`} data-testid="chat-clarify">
        <div className="font-emphasis text-text-primary">{t('aichat.clarify')}</div>
        <p className="mt-1 text-text-secondary">{data.message}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(data.options || []).map((o) => (
            <Button key={o} variant="tonal" size="xs" disabled={readOnly} onClick={() => onOption(o)}>{o}</Button>
          ))}
        </div>
      </div>
    );
  } else if (data?.status === 'refused') {
    main = (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-bg p-4 text-caption" data-testid="chat-refused" data-code={data.code}>
        <div className="flex items-center gap-2 font-emphasis text-warning"><AlertTriangle className="h-4 w-4" aria-hidden />
          {data.code === 'filter_would_drop' ? t('aichat.dropTitle') : t('aichat.refused')}</div>
        <p className="mt-1 text-text-secondary">{data.message}</p>
        {data.code === 'filter_would_drop' && data.detail?.dropped?.length ? (
          <>
            <ul className="mt-2 list-disc pl-5 text-label font-normal text-text-tertiary">
              {data.detail.dropped.map((d) => <li key={d.field}>{d.field} — {d.reason}</li>)}
            </ul>
            <p className="mt-2 text-label font-normal text-text-tertiary">{t('aichat.dropBody')}</p>
            {data.consent_available && !readOnly ? (
              <Button variant="outline" size="sm" className="mt-2" onClick={onAccept} data-testid="chat-accept-drop">
                {t('aichat.dropAccept')}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    );
  } else if (data) {
    // `unsupported`: no data question the Core could answer. With document
    // evidence below, this is said quietly; alone, it is the answer.
    main = e.code === 'documents_only' ? (
      <p className="text-label font-normal text-text-tertiary" data-testid="chat-no-data-part">{t('aichat.noDataPart')}</p>
    ) : (
      <div className={`${CARD} p-4 text-caption`} data-testid="chat-unsupported">
        <div className="flex items-center gap-2 font-emphasis text-text-primary">
          <XCircle className="h-4 w-4 text-text-tertiary" aria-hidden />{t('aichat.unsupported')}</div>
        <p className="mt-1 text-text-secondary">{data.message}</p>
      </div>
    );
  } else if (e.message) {
    main = (
      <div className={`${CARD} p-4 text-caption`} data-testid="chat-unsupported">
        <p className="text-text-secondary">{e.message}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {main}
      {e.supporting ? <SupportingPanel s={e.supporting} /> : null}
      {e.notices?.length ? (
        <ul className="space-y-1" data-testid="chat-notices">
          {e.notices.map((n) => (
            <li key={n.code} className="flex items-start gap-2 text-label font-normal text-text-tertiary" data-code={n.code}>
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{n.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SupportingPanel({ s }: { s: Supporting }) {
  const { t } = useI18n();
  if (s.status !== 'ok' || (!s.documents.length && !s.findings.length)) return null;
  return (
    <section className={`${CARD} p-4`} data-testid="chat-supporting" aria-label={t('aichat.supporting.title')}>
      <h2 className={`flex items-center gap-1.5 ${HEADING}`}>
        <BookOpen className="h-3.5 w-3.5 text-brand" aria-hidden />{t('aichat.supporting.title')}
      </h2>
      <p className="mt-1 text-label font-normal text-text-tertiary">
        {t('aichat.supporting.from', { name: s.flow_name })}
      </p>
      {s.findings.map((f, i) => (
        <div key={i} className="mt-2 space-y-2">
          <p className="whitespace-pre-wrap break-words text-caption text-text-secondary" data-testid="chat-finding">{f.text}</p>
          {f.unverified_figures.length ? (
            <p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-2 py-1.5 text-label font-normal text-warning"
               data-testid="chat-unverified-figures">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('aichat.supporting.unverified', { figures: f.unverified_figures.join(', ') })}
            </p>
          ) : null}
        </div>
      ))}
      {s.documents.length ? (
        <ul className="mt-3 space-y-2" data-testid="chat-documents">
          {s.documents.map((d) => (
            <li key={d.doc_id} className="rounded-md border border-stroke-subtle bg-surface-2 px-3 py-2 text-label font-normal">
              <div className="font-emphasis text-text-primary">{d.title || t('aichat.supporting.document', { id: d.doc_id })}</div>
              {d.quote ? <blockquote className="mt-1 border-l-2 border-stroke-strong pl-2 text-text-secondary">{d.quote}</blockquote> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function LegacyAnswer({ e }: { e: ChatEnvelope }) {
  const { t } = useI18n();
  const legacy = e.legacy!;
  return (
    <div className={`${CARD} p-4 text-caption`} data-testid="chat-legacy">
      <p className="text-label font-normal text-text-tertiary">{t('aichat.legacy.note')}</p>
      {legacy.content_pruned ? (
        <p className="mt-2 text-text-tertiary" data-testid="chat-legacy-pruned">{t('aichat.legacy.pruned')}</p>
      ) : legacy.answer ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-text-secondary">{legacy.answer}</p>
      ) : (
        <p className="mt-2 text-text-tertiary">{t('aichat.legacy.noAnswer')}</p>
      )}
    </div>
  );
}

function AnswerView({ turn, locale, readOnly }: { turn: CoreResponse; locale: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const model = useMemo(() => chartModel(turn), [turn]);
  const a = turn.answer!;
  const ev = turn.evidence!;
  const interp = String((turn.plan as { interpretation?: string } | undefined)?.interpretation || '');
  const axis = { fontSize: 11, fill: 'rgb(var(--text-tertiary))' };
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-3" data-testid="chat-answer">
      <div className="min-w-0 space-y-3 lg:col-span-2">
        <section className={`${CARD} p-4`}>
          <h2 className={HEADING}>{t('aichat.answer')}</h2>
          <p className="mt-1 text-body font-emphasis text-text-primary" data-testid="chat-headline">{a.headline}</p>
          {a.bullets.length ? (
            <ul className="mt-2 space-y-1 text-caption text-text-secondary">{a.bullets.map((b, i) => <li key={i}>• {b}</li>)}</ul>
          ) : null}
          {a.note ? <p className="mt-2 text-label font-normal text-text-tertiary">{a.note}</p> : null}
          {interp ? (
            <p className="mt-2 text-label font-normal text-text-tertiary">
              <span className="font-emphasis">{t('aichat.interpretation')}:</span> {interp}
            </p>
          ) : null}
        </section>

        {model ? (
          <section className={`${CARD} p-4`} data-testid="chat-chart">
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
        <section className={`${CARD} p-4`} data-testid="chat-checks">
          <h2 className={HEADING}>{t('aichat.checks')}</h2>
          <ul className="mt-2 space-y-1">
            {a.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-label font-normal text-text-secondary">
                {c.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label={t('aichat.check.ok')} />
                  : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-label={t('aichat.check.warning')} />}{c.detail}
              </li>
            ))}
          </ul>
        </section>
        <section className={`${CARD} p-4`} data-testid="chat-evidence">
          <h2 className={`flex items-center gap-1.5 ${HEADING}`}>
            <ShieldCheck className="h-3.5 w-3.5 text-brand" aria-hidden />{t('aichat.evidence')}</h2>
          <dl className="mt-2 space-y-1.5 text-label font-normal text-text-secondary">
            <Row k={t('aichat.evidence.source')} v={`${ev.source} · ${ev.source_type}`} />
            <Row k={t('aichat.evidence.measures')} v={ev.measures.join(', ')} />
            <Row k={t('aichat.evidence.filters')} v={(ev.filters_described ?? ev.filters_applied).length
              ? (ev.filters_described ?? ev.filters_applied).join('; ') : t('aichat.evidence.none')} />
            <Row k={t('aichat.evidence.bounds')} v={t('aichat.evidence.boundsValue', { rows: ev.bounds.max_rows, seconds: ev.bounds.timeout_seconds })} />
            <Row k={t('aichat.evidence.duration')} v={`${ev.duration_ms} ms`} />
            <Row k={t('aichat.evidence.freshness')} v={ev.freshness} />
            <Row k={t('aichat.evidence.queryId')} v={<code data-testid="chat-query-id">{ev.query_id}</code>} />
            <Row k={t('aichat.evidence.fingerprint')} v={<code>{ev.sql_fingerprint}</code>} />
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

function DataTable({ turn, locale }: { turn: CoreResponse; locale: string }) {
  const { t } = useI18n();
  const cols = turn.columns || [];
  const rows = (turn.rows || []).slice(0, 200);
  return (
    <section className={`${CARD} min-w-0`} data-testid="chat-table">
      <h2 className={`px-4 pt-3 ${HEADING}`}>{t('aichat.table')}</h2>
      {turn.truncated ? <p className="px-4 text-label font-normal text-warning">{t('aichat.truncated')}</p> : null}
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
  'unsupported_but_answerable', 'wrong_document', 'ux_issue'] as const;

function FeedbackPanel({ turnId }: { turnId?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ sent?: 'up' | 'down'; comment: string; reason: string; error?: string }>(
    { comment: '', reason: '' });
  if (!turnId) return null;
  const send = async (verdict: 'up' | 'down') => {
    try {
      await chatApi.feedback(turnId, verdict, state.comment, verdict === 'up' ? 'correct' : state.reason);
      setState((s) => ({ ...s, sent: verdict, error: undefined }));
    } catch (err) {
      setState((s) => ({ ...s, error: errorText(err) }));
    }
  };
  return (
    <section className={`${CARD} p-4`} data-testid="chat-feedback">
      <h2 className={HEADING}>{t('aichat.feedback')}</h2>
      {state.sent ? (
        <p className="mt-1 text-label font-normal text-success" data-testid="chat-feedback-sent">{t('aichat.feedbackThanks')}</p>
      ) : (
        <>
          <Select value={state.reason} onChange={(e) => setState((s) => ({ ...s, reason: e.target.value }))}
                  aria-label={t('aichat.feedbackReason')} data-testid="chat-feedback-reason" className="mt-2 w-full">
            <option value="">{t('aichat.feedbackReason')}</option>
            {REASONS.map((r) => <option key={r} value={r}>{t(`aichat.feedbackReason.${r}`)}</option>)}
          </Select>
          <Textarea value={state.comment} onChange={(e) => setState((s) => ({ ...s, comment: e.target.value }))}
                    maxLength={1000} rows={2} placeholder={t('aichat.feedbackPlaceholder')}
                    aria-label={t('aichat.feedbackPlaceholder')}
                    className="mt-2 w-full" data-testid="chat-feedback-comment" />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="xs" onClick={() => send('up')} data-testid="chat-feedback-up">{t('aichat.feedbackUp')}</Button>
            <Button variant="secondary" size="xs" onClick={() => send('down')} data-testid="chat-feedback-down">{t('aichat.feedbackDown')}</Button>
          </div>
        </>
      )}
      {state.error ? <p role="alert" className="mt-1 text-label font-normal text-danger">{state.error}</p> : null}
    </section>
  );
}

function ChartDraftPanel({ turn }: { turn: CoreResponse }) {
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
    <section className={`${CARD} p-4`} data-testid="chat-chart-draft">
      <h2 className={HEADING}>{t('aichat.chart')}</h2>
      {draft ? (
        <>
          <p className="mt-1 text-label font-normal text-text-secondary">{draft.chart_type} · {draft.name}</p>
          {state.id ? (
            <p className="mt-2 text-label font-normal text-success" data-testid="chat-chart-saved">{t('aichat.saved')}{' '}
              <Link href={`/explore/${state.id}`} className="font-emphasis text-brand underline" data-testid="chat-open-chart">{t('aichat.openChart')}</Link></p>
          ) : turn.can_save === false ? (
            <p className="mt-2 text-label font-normal text-text-tertiary" data-testid="chat-save-not-allowed">{t('aichat.saveNotAllowed')}</p>
          ) : (
            <Button variant="primary" size="xs" className="mt-2" onClick={save} loading={state.saving} data-testid="chat-save-chart">
              {state.saving ? t('aichat.saving') : t('aichat.saveChart')}
            </Button>
          )}
          {state.error ? <p role="alert" className="mt-2 text-label font-normal text-danger" data-testid="chat-save-error">{t('aichat.saveFailed', { reason: state.error })}</p> : null}
        </>
      ) : <p className="mt-1 text-label font-normal text-text-tertiary">{turn.chart_draft_unavailable}</p>}
    </section>
  );
}
