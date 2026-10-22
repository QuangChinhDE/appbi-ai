'use client';

/**
 * AppBI Analyst (M2 MVP): Question -> Source discovery -> Governed query ->
 * Verified answer -> Chart draft.
 *
 * The page never decides access or numbers. The backend lists only sources the
 * person may explore, runs every read through the Governed Query Service and
 * computes the answer's words from the governed rows; this page shows them,
 * with the evidence, and lets the person save the chart draft through the
 * existing chart API under their own rights.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Database, Loader2, Send, ShieldCheck, Sparkles, XCircle,
} from 'lucide-react';
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart,
} from 'recharts';

import { useI18n } from '@/providers/LanguageProvider';
import { analystApi, newTurnId, type AnalystSource, type AnalystTurn } from '@/lib/api/analyst';
import { chartApi } from '@/lib/api/charts';
import type { ChartCreate } from '@/types/api';

const STEP_KEYS = ['discovery', 'plan', 'governed_query', 'verify'] as const;
const SERIES_COLORS = ['#1a73e8', '#12b5cb', '#e8710a', '#9334e6', '#188038', '#d93025', '#f9ab00', '#5f6368'];
const MAX_SERIES = 8;

type Exchange = { question: string; turn: AnalystTurn | null; error?: string };

function errorText(err: unknown): string {
  const anyErr = err as { response?: { status?: number; data?: { detail?: unknown } }; message?: string };
  const detail = anyErr?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  return anyErr?.message || 'error';
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
  const cat = cols.find((c) => c.role === 'dimension' && c !== time);
  if (!measure) return null;
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

export default function AnalystPage() {
  const { t, locale } = useI18n();
  const [sources, setSources] = useState<AnalystSource[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const [running, setRunning] = useState<{ turnId: string; question: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Index from which the conversation is a new topic: follow-ups refine only
   *  answers after it (the server holds a follow-up to the previous source). */
  const [topicStart, setTopicStart] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    analystApi.catalog().then(setSources).catch((err) => {
      if ((err as { response?: { status?: number } })?.response?.status === 404) setDisabled(true);
      setSources([]);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [history, running]);

  const lastPlan = useMemo(() => {
    for (let i = history.length - 1; i >= topicStart; i -= 1) {
      const turn = history[i].turn;
      if (turn?.status === 'answered' && turn.plan) return turn.plan;
    }
    return null;
  }, [history, topicStart]);

  const ask = useCallback(async (q: string, opts: { followUp?: boolean; consent?: string; plan?: Record<string, unknown>; datasetId?: number } = {}) => {
    const text = q.trim();
    if (!text || running) return;
    const turnId = newTurnId();
    setRunning({ turnId, question: text });
    setQuestion('');
    try {
      const turn = await analystApi.ask({
        question: text, turn_id: turnId,
        previous_plan: opts.followUp ? lastPlan : null,
        drop_consent: opts.consent ?? null,
        consented_plan: opts.plan ?? null,
        dataset_id: opts.datasetId ?? null,
      });
      setHistory((h) => [...h, { question: text, turn }]);
    } catch (err) {
      setHistory((h) => [...h, { question: text, turn: null, error: errorText(err) }]);
    } finally {
      setRunning(null);
      setCancelling(false);
    }
  }, [running, lastPlan]);

  const cancel = useCallback(async () => {
    if (!running) return;
    setCancelling(true);
    try {
      await analystApi.cancel(running.turnId);
    } catch {
      setCancelling(false);
    }
  }, [running]);

  const acceptDrop = useCallback(async (ex: Exchange) => {
    const d = ex.turn?.detail;
    if (!d?.query_fingerprint || !d.dropped?.length) return;
    try {
      const token = await analystApi.consent(d.query_fingerprint, d.dropped.map((x) => x.field));
      // Re-run exactly the plan that was refused; the server re-validates it.
      await ask(ex.question, { consent: token, plan: ex.turn?.plan ?? undefined });
    } catch (err) {
      setHistory((h) => [...h, { question: ex.question, turn: null, error: errorText(err) }]);
    }
  }, [ask]);

  return (
    <div className="min-h-full bg-[#f8f9fa]" data-testid="analyst-page">
      <header className="border-b border-[#dadce0] bg-white px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-6xl items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-[#e8f0fe] p-2 text-[#1a73e8]"><Sparkles className="h-5 w-5" aria-hidden /></div>
          <div className="min-w-0">
            <h1 className="text-xl font-medium text-[#202124]">{t('analyst.title')}</h1>
            <p className="mt-0.5 text-sm text-[#5f6368]">{t('analyst.subtitle')}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4 sm:px-6">
        {disabled ? (
          <div role="alert" className="rounded-lg border border-[#dadce0] bg-white p-4 text-sm text-[#5f6368]">{t('analyst.disabled')}</div>
        ) : null}

        <SourcesPanel sources={sources} />

        {history.map((ex, i) => (
          <ExchangeCard key={i} ex={ex} locale={locale} onAccept={() => acceptDrop(ex)}
                        onOption={(opt) => {
                          // A choice between datasets re-asks the SAME question pinned to that source.
                          const src = ex.turn?.sources?.find((s) => s.label === opt);
                          return src ? ask(ex.question, { datasetId: src.dataset_id }) : ask(`${ex.question} — ${opt}`);
                        }} />
        ))}

        {running ? (
          <section aria-live="polite" className="rounded-lg border border-[#dadce0] bg-white p-4" data-testid="analyst-running">
            <p className="mb-3 text-sm font-medium text-[#202124]">{running.question}</p>
            <ol className="space-y-2">
              {STEP_KEYS.map((k) => (
                <li key={k} className="flex items-center gap-2 text-sm text-[#5f6368]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#1a73e8]" aria-hidden />{t(`analyst.step.${k}`)}
                </li>
              ))}
            </ol>
            <button type="button" onClick={cancel} disabled={cancelling} data-testid="analyst-cancel"
                    className="mt-3 rounded-md border border-[#dadce0] px-3 py-1.5 text-sm text-[#d93025] hover:bg-[#fce8e6] disabled:opacity-60">
              {cancelling ? t('analyst.cancelling') : t('analyst.cancel')}
            </button>
          </section>
        ) : null}

        <form onSubmit={(e) => { e.preventDefault(); ask(question, { followUp: !!lastPlan }); }}
              className="sticky bottom-0 rounded-lg border border-[#dadce0] bg-white p-3 shadow-sm">
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="analyst-question" className="block text-xs font-medium text-[#5f6368]">
              {lastPlan ? t('analyst.followUp') : t('analyst.ask')}
            </label>
            {lastPlan ? (
              <button type="button" onClick={() => setTopicStart(history.length)} data-testid="analyst-new-topic"
                      className="text-xs font-medium text-[#1a73e8] hover:underline">{t('analyst.newTopic')}</button>
            ) : null}
          </div>
          <div className="flex items-end gap-2">
            <textarea id="analyst-question" data-testid="analyst-question" value={question} rows={2} maxLength={1000}
                      onChange={(e) => setQuestion(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(question, { followUp: !!lastPlan }); } }}
                      placeholder={lastPlan ? t('analyst.followUpPlaceholder') : t('analyst.placeholder')}
                      className="min-h-[44px] flex-1 resize-y rounded-md border border-[#dadce0] px-3 py-2 text-sm focus:border-[#1a73e8] focus:outline-none focus:ring-1 focus:ring-[#1a73e8]" />
            <button type="submit" disabled={!question.trim() || !!running || disabled} data-testid="analyst-ask"
                    className="inline-flex h-10 items-center gap-1.5 rounded-md bg-[#1a73e8] px-4 text-sm font-medium text-white hover:bg-[#1765cc] disabled:bg-[#dadce0] disabled:text-[#80868b]">
              <Send className="h-4 w-4" aria-hidden />{t('analyst.ask')}
            </button>
          </div>
        </form>
        <div ref={bottomRef} />
      </main>
    </div>
  );
}

function SourcesPanel({ sources }: { sources: AnalystSource[] | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (sources === null) return null;
  return (
    <section className="rounded-lg border border-[#dadce0] bg-white" data-testid="analyst-sources">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-[#202124]">
        <span className="flex items-center gap-2"><Database className="h-4 w-4 text-[#1a73e8]" aria-hidden />
          {t('analyst.sources')} <span className="rounded-full bg-[#e8f0fe] px-2 text-xs text-[#1a73e8]">{sources.length}</span></span>
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>
      {open ? (
        <div className="border-t border-[#dadce0] px-4 py-3">
          {sources.length === 0 ? <p className="text-sm text-[#5f6368]">{t('analyst.sourcesEmpty')}</p> : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {sources.map((s) => (
                <li key={s.explore_id} className="rounded-md border border-[#e8eaed] p-2 text-xs">
                  <div className="font-medium text-[#202124]">{s.dataset} <span className="text-[#80868b]">· {s.source_type}</span></div>
                  <div className="mt-1 text-[#5f6368]">{s.measures.join(', ')}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ExchangeCard({ ex, locale, onAccept, onOption }: {
  ex: Exchange; locale: string; onAccept: () => void; onOption: (o: string) => void;
}) {
  const { t } = useI18n();
  const turn = ex.turn;
  return (
    <article className="space-y-3" data-testid="analyst-exchange">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-lg bg-[#e8f0fe] px-3 py-2 text-sm text-[#174ea6]">{ex.question}</p>
      </div>
      {ex.error || !turn ? (
        <div role="alert" className="rounded-lg border border-[#f4c7c3] bg-[#fce8e6] p-3 text-sm text-[#a50e0e]" data-testid="analyst-error">
          {t('analyst.error')} <span className="text-xs">({ex.error})</span>
        </div>
      ) : turn.status === 'answered' ? <AnswerView turn={turn} locale={locale} />
        : turn.status === 'refused' ? (
          <div role="alert" className="rounded-lg border border-[#fbe2b6] bg-[#fef7e0] p-4 text-sm" data-testid="analyst-refused" data-code={turn.code}>
            <div className="flex items-center gap-2 font-medium text-[#b06000]"><AlertTriangle className="h-4 w-4" aria-hidden />
              {turn.code === 'filter_would_drop' ? t('analyst.dropTitle') : t('analyst.refused')}</div>
            <p className="mt-1 text-[#3c4043]">{turn.message}</p>
            {turn.code === 'filter_would_drop' && turn.detail?.dropped?.length ? (
              <>
                <ul className="mt-2 list-disc pl-5 text-xs text-[#5f6368]">
                  {turn.detail.dropped.map((d) => <li key={d.field}>{d.field} — {d.reason}</li>)}
                </ul>
                <p className="mt-2 text-xs text-[#5f6368]">{t('analyst.dropBody')}</p>
                {turn.consent_available ? (
                  <button type="button" onClick={onAccept} data-testid="analyst-accept-drop"
                        className="mt-2 rounded-md border border-[#1a73e8] px-3 py-1.5 text-sm text-[#1a73e8] hover:bg-[#e8f0fe]">
                  {t('analyst.dropAccept')}</button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : turn.status === 'clarify' ? (
          <div className="rounded-lg border border-[#dadce0] bg-white p-4 text-sm" data-testid="analyst-clarify">
            <div className="font-medium text-[#202124]">{t('analyst.clarify')}</div>
            <p className="mt-1 text-[#3c4043]">{turn.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(turn.options || []).map((o) => (
                <button key={o} type="button" onClick={() => onOption(o)}
                        className="rounded-full border border-[#dadce0] px-3 py-1 text-xs text-[#1a73e8] hover:bg-[#e8f0fe]">{o}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-[#dadce0] bg-white p-4 text-sm" data-testid="analyst-unsupported">
            <div className="flex items-center gap-2 font-medium text-[#202124]"><XCircle className="h-4 w-4 text-[#5f6368]" aria-hidden />{t('analyst.unsupported')}</div>
            <p className="mt-1 text-[#3c4043]">{turn.message}</p>
          </div>
        )}
    </article>
  );
}

function AnswerView({ turn, locale }: { turn: AnalystTurn; locale: string }) {
  const { t } = useI18n();
  const model = useMemo(() => chartModel(turn), [turn]);
  const a = turn.answer!;
  const ev = turn.evidence!;
  const interp = String((turn.plan as { interpretation?: string } | undefined)?.interpretation || '');
  return (
    <div className="grid gap-3 lg:grid-cols-3" data-testid="analyst-answer">
      <div className="space-y-3 lg:col-span-2">
        <section className="rounded-lg border border-[#dadce0] bg-white p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[#5f6368]">{t('analyst.answer')}</h2>
          <p className="mt-1 text-base font-medium text-[#202124]" data-testid="analyst-headline">{a.headline}</p>
          {a.bullets.length ? (
            <ul className="mt-2 space-y-1 text-sm text-[#3c4043]">{a.bullets.map((b, i) => <li key={i}>• {b}</li>)}</ul>
          ) : null}
          {a.note ? <p className="mt-2 text-xs text-[#5f6368]">{a.note}</p> : null}
          {interp ? <p className="mt-2 text-xs text-[#5f6368]"><span className="font-medium">{t('analyst.interpretation')}:</span> {interp}</p> : null}
        </section>

        {model ? (
          <section className="rounded-lg border border-[#dadce0] bg-white p-4" data-testid="analyst-chart">
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                {model.kind === 'line' ? (
                  <LineChart data={model.points} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e8eaed" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={72} tickFormatter={(v) => Number(v).toLocaleString(locale, { notation: 'compact' })} />
                    <Tooltip formatter={(v) => fmt(v, locale)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {model.series.map((s, i) => (
                      <Line key={s} type="monotone" dataKey={s} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} dot={false} strokeWidth={2} isAnimationActive={false} />
                    ))}
                  </LineChart>
                ) : (
                  <BarChart data={model.points} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e8eaed" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={72} tickFormatter={(v) => Number(v).toLocaleString(locale, { notation: 'compact' })} />
                    <Tooltip formatter={(v) => fmt(v, locale)} />
                    <Bar dataKey={model.measure} fill="#1a73e8" isAnimationActive={false} />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
          </section>
        ) : null}

        <DataTable turn={turn} locale={locale} />
      </div>

      <aside className="space-y-3">
        <section className="rounded-lg border border-[#dadce0] bg-white p-4 text-sm" data-testid="analyst-checks">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[#5f6368]">{t('analyst.checks')}</h2>
          <ul className="mt-2 space-y-1">
            {a.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-xs text-[#3c4043]">
                {c.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#188038]" aria-label="ok" />
                  : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#b06000]" aria-label="warning" />}{c.detail}
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-lg border border-[#dadce0] bg-white p-4 text-xs" data-testid="analyst-evidence">
          <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[#5f6368]">
            <ShieldCheck className="h-3.5 w-3.5 text-[#1a73e8]" aria-hidden />{t('analyst.evidence')}</h2>
          <dl className="mt-2 space-y-1.5 text-[#3c4043]">
            <Row k={t('analyst.evidence.source')} v={`${ev.source} · ${ev.source_type}`} />
            <Row k={t('analyst.evidence.measures')} v={ev.measures.join(', ')} />
            <Row k={t('analyst.evidence.filters')} v={ev.filters_applied.length ? ev.filters_applied.join(', ') : t('analyst.evidence.none')} />
            <Row k={t('analyst.evidence.bounds')} v={t('analyst.evidence.boundsValue', { rows: ev.bounds.max_rows, seconds: ev.bounds.timeout_seconds })} />
            <Row k={t('analyst.evidence.duration')} v={`${ev.duration_ms} ms`} />
            <Row k={t('analyst.evidence.freshness')} v={ev.freshness} />
            <Row k={t('analyst.evidence.queryId')} v={<code data-testid="analyst-query-id">{ev.query_id}</code>} />
            <Row k={t('analyst.evidence.fingerprint')} v={<code>{ev.sql_fingerprint}</code>} />
          </dl>
        </section>
        <ChartDraftPanel turn={turn} />
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,40%)_1fr] gap-2">
      <dt className="text-[#5f6368]">{k}</dt>
      <dd className="break-all">{v}</dd>
    </div>
  );
}

function DataTable({ turn, locale }: { turn: AnalystTurn; locale: string }) {
  const { t } = useI18n();
  const cols = turn.columns || [];
  const rows = (turn.rows || []).slice(0, 200);
  return (
    <section className="rounded-lg border border-[#dadce0] bg-white" data-testid="analyst-table">
      <h2 className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-[#5f6368]">{t('analyst.table')}</h2>
      {turn.truncated ? <p className="px-4 text-xs text-[#b06000]">{t('analyst.truncated')}</p> : null}
      <div className="max-h-80 overflow-auto p-2">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-white">
            <tr>{cols.map((c) => <th key={c.name} scope="col" className="border-b border-[#dadce0] px-2 py-1.5 font-medium text-[#5f6368]">{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="odd:bg-[#f8f9fa]">
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
    <section className="rounded-lg border border-[#dadce0] bg-white p-4 text-sm" data-testid="analyst-chart-draft">
      <h2 className="text-xs font-medium uppercase tracking-wide text-[#5f6368]">{t('analyst.chart')}</h2>
      {draft ? (
        <>
          <p className="mt-1 text-xs text-[#3c4043]">{draft.chart_type} · {draft.name}</p>
          {state.id ? (
            <p className="mt-2 text-xs text-[#188038]" data-testid="analyst-chart-saved">{t('analyst.saved')}{' '}
              <Link href={`/explore/${state.id}`} className="font-medium text-[#1a73e8] underline" data-testid="analyst-open-chart">{t('analyst.openChart')}</Link></p>
          ) : (
            <button type="button" onClick={save} disabled={state.saving} data-testid="analyst-save-chart"
                    className="mt-2 rounded-md bg-[#1a73e8] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1765cc] disabled:opacity-60">
              {state.saving ? t('analyst.saving') : t('analyst.saveChart')}</button>
          )}
          {state.error ? <p role="alert" className="mt-2 text-xs text-[#d93025]" data-testid="analyst-save-error">{t('analyst.saveFailed', { reason: state.error })}</p> : null}
        </>
      ) : <p className="mt-1 text-xs text-[#5f6368]">{turn.chart_draft_unavailable}</p>}
    </section>
  );
}
