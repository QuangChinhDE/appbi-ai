'use client';

/**
 * Who reacted, and what the flow was doing when they did.
 *
 * WHY A TAB AND NOT A COLUMN.
 * A thumbs-down had a column in the runs table and nothing else — one bit, next to
 * a question, with no way to ask the only question worth asking about it: is this
 * one annoyed person, or is something in the flow reliably producing bad answers?
 * One reaction is an anecdote; eight that all ran the same branch is a defect with
 * an address.
 *
 * WHY IT IS BUILT LIKE THE RUNS TAB.
 * The first version invented its own visual language — big coloured numerals,
 * bespoke bar-chart cards, card-per-item — and read as a screen from a different
 * product. It is not a different product and not even a different data set: these
 * are runs, filtered to the ones somebody rated. So it uses the same summary strip,
 * the same filter row and the same `app-list-table` as Runs, and a row opens the
 * same three-pane trace. What is left over — the thing this tab exists for — is one
 * row of chips naming what the complaints have in common, and those are FILTERS:
 * clicking one narrows the list to the runs that share it. A bar chart could only
 * be looked at.
 */
import { Loader2, MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  listFeedback, type FeedbackResult, type RunSourceFilter,
} from '@/lib/agentFlows';

import {
  RunStatusBadge, SourceFilter, Stat, StatStrip, formatWhen,
} from './shared';

/** Readable names for the signal codes this tab groups by.
 *
 *  Deliberately partial. `signals_for` emits a fixed set it builds itself
 *  (`status_*`, `step_error`, `no_citation`…) plus NOTICE codes, which any node may
 *  introduce — so a complete map is impossible. An unknown code falls through to
 *  itself rather than to a generic label: a raw `budget_exhausted` still tells the
 *  reader something, and a chip reading "Không rõ" would not. */
const SIGNAL_LABEL: Record<string, string> = {
  status_failed: 'agentFlows.feedback.signal.statusFailed',
  status_partial: 'agentFlows.feedback.signal.statusPartial',
  status_blocked: 'agentFlows.feedback.signal.statusBlocked',
  blocked: 'agentFlows.feedback.signal.blocked',
  missing_requirement: 'agentFlows.feedback.signal.missingRequirement',
  step_error: 'agentFlows.feedback.signal.stepError',
  step_skipped: 'agentFlows.feedback.signal.stepSkipped',
  no_citation: 'agentFlows.feedback.signal.noCitation',
  branch_unmatched: 'agentFlows.feedback.signal.branchUnmatched',
  read_truncated: 'agentFlows.feedback.signal.readTruncated',
  budget_exhausted: 'agentFlows.feedback.signal.budgetExhausted',
  loop_empty: 'agentFlows.feedback.signal.loopEmpty',
  turn_abandoned: 'agentFlows.feedback.signal.turnAbandoned',
  memory_reset: 'agentFlows.feedback.signal.memoryReset',
};

export function FeedbackTab({
  brainKey, onOpenRun, onOpenConversation,
}: {
  brainKey: string;
  onOpenRun: (runId: number) => void;
  onOpenConversation: (key: string) => void;
}) {
  const { t, language } = useI18n();
  const locale = language === 'vi' ? 'vi-VN' : 'en-US';
  const [data, setData] = React.useState<FeedbackResult | null>(null);
  const [hours, setHours] = React.useState<number>(24 * 7);
  const [rating, setRating] = React.useState<'' | 'up' | 'down'>('');
  const [source, setSource] = React.useState<RunSourceFilter>('all');
  /** Narrow to the runs sharing one signal. The chips are the point of the tab, and
   *  a chip you cannot act on is a chart. */
  const [signal, setSignal] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    listFeedback(brainKey, {
      since_hours: hours,
      rating: rating || undefined,
      source,
      limit: 100,
    })
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [brainKey, hours, rating, source]);

  const s = data?.summary;
  const items = React.useMemo(() => {
    const all = data?.items || [];
    return signal ? all.filter((i) => i.signals.some((x) => x.code === signal)) : all;
  }, [data, signal]);

  const labelOf = (k: string) => (SIGNAL_LABEL[k] ? t(SIGNAL_LABEL[k]) : k);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 border-b border-[rgb(var(--border-line))] px-4 pt-3">
        <StatStrip note={t('agentFlows.feedback.shareHint')}>
          <Stat value={s?.up ?? 0} label={t('agentFlows.feedback.up')} tone="success" />
          <Stat value={s?.down ?? 0} label={t('agentFlows.feedback.down')} tone="danger" />
          <Stat
            value={s ? `${Math.round(s.down_share * 100)}%` : '—'}
            label={t('agentFlows.feedback.downShare')}
          />
          <Stat value={s?.rated ?? 0} label={t('agentFlows.feedback.rated')} />
        </StatStrip>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}
            className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption">
            <option value={24}>{t('agentFlows.runs.range.24h')}</option>
            <option value={168}>{t('agentFlows.runs.range.7d')}</option>
            <option value={720}>{t('agentFlows.runs.range.30d')}</option>
          </select>
          <select value={rating} onChange={(e) => setRating(e.target.value as typeof rating)}
            className="h-8 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption">
            <option value="">{t('agentFlows.feedback.allRatings')}</option>
            <option value="down">{t('agentFlows.feedback.onlyDown')}</option>
            <option value="up">{t('agentFlows.feedback.onlyUp')}</option>
          </select>
          <SourceFilter value={source} onChange={setSource} />
          <span className="text-tiny text-text-tertiary">
            {t('agentFlows.feedback.showing', { n: items.length })}
          </span>
        </div>

        {/* WHAT THE COMPLAINTS HAVE IN COMMON — as filters, counted over the DOWN
            votes only, since a signal shared with an up vote is not what went wrong.
            The route chips sit beside the signal chips because "all of them ran
            Branch B" and "all of them raised branch_unmatched" are the same kind of
            finding and belong on one line. */}
        {!!s && s.down > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-tiny uppercase tracking-wide text-text-quaternary">
              {t('agentFlows.feedback.bySignal')}
            </span>
            {s.by_signal.map((r) => (
              <FilterTag
                key={r.key}
                tone="danger"
                active={signal === r.key}
                onClick={() => setSignal(signal === r.key ? null : r.key)}
              >
                {labelOf(r.key)} · {r.count}
              </FilterTag>
            ))}
            {s.by_path.map((r) => (
              <FilterTag key={`p:${r.key}`} tone="neutral" onClick={() => undefined}>
                {r.key} · {r.count}
              </FilterTag>
            ))}
            {signal && (
              <button
                type="button"
                onClick={() => setSignal(null)}
                className="text-tiny text-accent underline-offset-2 hover:underline"
              >
                {t('agentFlows.feedback.clearSignal')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
        ) : !items.length ? (
          <EmptyState
            icon={<ThumbsUp className="h-5 w-5" />}
            title={t('agentFlows.feedback.empty')}
            description={t('agentFlows.feedback.emptyHint')}
          />
        ) : (
          <table className="app-list-table">
            <thead>
              <tr>
                <th className="app-list-header w-[10%]">{t('agentFlows.feedback.colRating')}</th>
                <th className="app-list-header w-[30%]">{t('agentFlows.feedback.colQuestion')}</th>
                <th className="app-list-header w-[26%]">{t('agentFlows.feedback.colWhy')}</th>
                <th className="app-list-header w-[10%]">{t('agentFlows.conv.colOutcome')}</th>
                <th className="app-list-header w-[12%]">{t('agentFlows.conv.colRoutes')}</th>
                <th className="app-list-header app-list-header-right w-[12%]">{t('agentFlows.feedback.colWhen')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
              {items.map((it) => (
                <tr
                  key={it.run_id}
                  onClick={() => onOpenRun(it.run_id)}
                  className={cn(
                    'cursor-pointer transition hover:bg-surface-2',
                    it.rating === 'down' && 'bg-danger/[0.03]',
                  )}
                >
                  <td className="app-list-cell-tight">
                    <span className="inline-flex items-center gap-1.5">
                      {it.rating === 'down'
                        ? <ThumbsDown className="h-3.5 w-3.5 text-danger" />
                        : <ThumbsUp className="h-3.5 w-3.5 text-success" />}
                      {it.is_test && (
                        <Badge size="xs" variant="info">{t('agentFlows.runs.testBadge')}</Badge>
                      )}
                    </span>
                  </td>
                  <td className="app-list-cell">
                    <span className="app-list-text-main text-caption text-text-secondary">
                      {it.question || t('agentFlows.common.none')}
                    </span>
                    {/* WHICH TURN OF HOW MANY. A thumbs-down on turn one and one on
                        turn seven are different complaints, and the conversation is
                        the only place either is readable. */}
                    {it.conversation_turns > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenConversation(it.conversation_key);
                        }}
                        className="mt-1 flex items-center gap-1 text-tiny text-accent underline-offset-2 hover:underline"
                      >
                        <MessageSquare className="h-3 w-3" />
                        {t('agentFlows.feedback.openConversation', { n: it.conversation_turns })}
                      </button>
                    )}
                  </td>
                  <td className="app-list-cell-tight">
                    {!it.signals.length ? (
                      <span className="text-tiny text-text-quaternary">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {it.signals.slice(0, 2).map((sig, i) => (
                          <li key={i} className="text-tiny leading-5 text-warning">
                            {labelOf(sig.code)}
                          </li>
                        ))}
                        {it.signals.length > 2 && (
                          <li className="text-tiny text-text-quaternary">
                            +{it.signals.length - 2}
                          </li>
                        )}
                      </ul>
                    )}
                  </td>
                  <td className="app-list-cell-tight"><RunStatusBadge status={it.status} /></td>
                  <td className="app-list-cell-tight">
                    <span className="block truncate text-tiny text-text-tertiary" title={it.execution_path || ''}>
                      {it.execution_path || '—'}
                    </span>
                  </td>
                  <td className="app-list-cell-tight text-right text-tiny text-text-quaternary">
                    {formatWhen(it.at, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
