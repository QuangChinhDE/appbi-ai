'use client';

/**
 * History as the viewer experienced it: a list of conversations.
 *
 * WHY THE UNIT IS A CONVERSATION.
 * A list of turns answers "did this call succeed" and hides the only thing that
 * matters about a bad session. Somebody who asked four times because the first
 * three answers were useless appeared as four unrelated rows, three of them `ok` —
 * each turn DID answer. What went wrong lived BETWEEN the rows, in the fact that
 * the same person kept asking, and a per-turn view is the one shape that cannot
 * show it.
 *
 * WHY IT LOOKS LIKE THE REST OF THE APP.
 * The first version drew a card grid with its own header styling. Every other list
 * in this product — brains, dashboards, datasets — is built on `app-list-table`,
 * and this one was not, so the Runs tab read as a screen from a different product.
 * Cards were also the wrong shape for the job: an author comes here hunting for the
 * conversation that went wrong, which means comparing turn counts, outcomes and
 * ratings DOWN a column, and a grid puts those at different offsets on different
 * lines.
 *
 * This component only LISTS. Opening one is the parent's business, because what
 * opens is the three-pane run view — the conversation's turns on the left, the flow
 * in the middle, the chosen step on the right — and that machinery already lives
 * there. Nothing new is stored either: `agent_flow_runs.session_key` has been on
 * the row since the table existed.
 */
import { AlertTriangle, Loader2, MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  listConversations,
  type ConversationSummary, type RunSourceFilter,
} from '@/lib/agentFlows';

import { RunStatusBadge, formatWhen } from './shared';

export function ConversationsPanel({
  brainKey, hours, source, search, status, rated, activeKey, onOpen, onCountChange,
}: {
  brainKey: string;
  hours: number;
  source: RunSourceFilter;
  search?: string;
  status?: string;
  rated?: 'up' | 'down' | 'any' | '';
  /** Highlighted row, when the parent already has one open. */
  activeKey?: string | null;
  onOpen: (key: string) => void;
  /** So the parent's filter bar can show the count next to the controls that
   *  produced it, instead of this panel growing a second bar of its own. */
  onCountChange?: (n: number) => void;
}) {
  const { t, language } = useI18n();
  const locale = language === 'vi' ? 'vi-VN' : 'en-US';
  const [rows, setRows] = React.useState<ConversationSummary[] | null>(null);

  React.useEffect(() => {
    let alive = true;
    setRows(null);
    listConversations(brainKey, {
      since_hours: hours,
      source,
      status: status || undefined,
      rated: rated || undefined,
      search: search || undefined,
      limit: 80,
    })
      .then((res) => {
        if (!alive) return;
        setRows(res.conversations);
        onCountChange?.(res.total);
      })
      .catch(() => { if (alive) { setRows([]); onCountChange?.(0); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brainKey, hours, source, status, rated, search]);

  const anyRoute = rows?.some((c) => c.paths.length) ?? false;
  const anyRating = rows?.some((c) => c.up || c.down) ?? false;
  const wide = anyRoute || anyRating;

  if (rows === null) {
    return (
      <div className="p-4"><Loader2 className="h-4 w-4 animate-spin text-text-tertiary" /></div>
    );
  }

  if (!rows.length) {
    return (
      <div className="p-4">
        <EmptyState
          icon={<MessageSquare className="h-5 w-5" />}
          title={t('agentFlows.conv.empty')}
          description={t('agentFlows.conv.emptyHint')}
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <table className="app-list-table">
        <thead>
          <tr>
            {/* A COLUMN THAT IS EMPTY IN EVERY ROW IS NOISE.
                A two-step flow has no branches, so "Routes taken" was a 20%-wide
                strip of em-dashes pushing the figures away from their headers; a
                flow nobody has rated is the same for "Rated". Dropped when the data
                says nothing, and the width goes to the question — the one column
                that always has something to say. */}
            <th className={cn('app-list-header', wide ? 'w-[36%]' : 'w-[56%]')}>
              {t('agentFlows.conv.colOpening')}
            </th>
            <th className="app-list-header app-list-header-right w-[8%]">{t('agentFlows.conv.colTurns')}</th>
            <th className="app-list-header w-[12%]">{t('agentFlows.conv.colOutcome')}</th>
            {anyRoute && (
              <th className="app-list-header w-[20%]">{t('agentFlows.conv.colRoutes')}</th>
            )}
            {anyRating && (
              <th className="app-list-header app-list-header-right w-[8%]">{t('agentFlows.conv.colRating')}</th>
            )}
            <th className="app-list-header app-list-header-right w-[8%]">{t('agentFlows.conv.colTokens')}</th>
            <th className="app-list-header app-list-header-right w-[14%]">{t('agentFlows.conv.colLast')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
          {rows.map((c) => (
            <tr
              key={c.key}
              onClick={() => onOpen(c.key)}
              className={cn(
                'cursor-pointer transition',
                activeKey === c.key ? 'bg-brand/5' : 'hover:bg-surface-2',
              )}
            >
              <td className="app-list-cell">
                <div className="flex items-start gap-2">
                  <span className="app-list-text-main text-caption text-text-secondary">
                    {c.first_question || t('agentFlows.common.none')}
                  </span>
                  {c.is_test && (
                    <Badge size="xs" variant="info">{t('agentFlows.runs.testBadge')}</Badge>
                  )}
                </div>
              </td>
              <td className="app-list-cell-tight text-right text-caption tabular-nums">
                <span className="inline-flex items-center gap-1">
                  {/* KEPT ASKING — the one thing a conversation view can say that no
                      per-turn row can: this person was not satisfied by the early
                      answers. */}
                  {c.kept_asking && (
                    <span title={t('agentFlows.conv.keptAsking', { n: c.turns })}>
                      <AlertTriangle className="h-3 w-3 text-warning" />
                    </span>
                  )}
                  {c.turns}
                </span>
              </td>
              <td className="app-list-cell-tight">
                <RunStatusBadge status={c.worst_status} />
              </td>
              {anyRoute && (
                <td className="app-list-cell-tight">
                  {/* More than one route inside a single conversation means the flow
                      classified the same person differently as they talked — either
                      the design working, or the bug. */}
                  <span
                    className="block truncate text-tiny text-text-tertiary"
                    title={c.paths.join(' | ')}
                  >
                    {c.paths.join(' | ') || '—'}
                  </span>
                </td>
              )}
              {anyRating && (
                <td className="app-list-cell-tight text-right">
                  {!c.up && !c.down ? (
                    <span className="text-tiny text-text-quaternary">—</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {!!c.up && (
                        <span className="inline-flex items-center gap-0.5 text-tiny text-success">
                          <ThumbsUp className="h-3 w-3" />{c.up}
                        </span>
                      )}
                      {!!c.down && (
                        <span className="inline-flex items-center gap-0.5 text-tiny text-danger">
                          <ThumbsDown className="h-3 w-3" />{c.down}
                        </span>
                      )}
                    </span>
                  )}
                </td>
              )}
              <td className="app-list-cell-tight text-right text-tiny tabular-nums text-text-tertiary">
                {c.tokens.toLocaleString()}
              </td>
              <td className="app-list-cell-tight text-right text-tiny text-text-quaternary">
                {formatWhen(c.last_at, locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
