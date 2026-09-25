'use client';

/**
 * A narrative block: the report's words, with every figure bound to a finding.
 *
 * The block stores WHICH findings it states (`kind:tileId`) and optional prose;
 * it never stores a number. Each sentence is rendered from the finding computed
 * over the rows its tile is showing right now, so:
 *
 *   - change a filter → the tile refetches → the sentence shows "updating", then
 *     the new figure and, if the direction flipped, the new verb;
 *   - the filter leaves too little data → the sentence says so instead of
 *     stating something the data no longer supports.
 *
 * Author-typed prose is shown as written and marked as static text in the
 * editor, so no one mistakes a typed number for a live one.
 */
import React from 'react';

import { useReportFindings } from '@/lib/report-evidence';
import { renderFindingSentence, findingHeadlineFigure } from '@/lib/report-findings';
import { useI18n } from '@/providers/LanguageProvider';

export interface NarrativeConfig {
  variant?: 'headline' | 'summary' | 'callout' | 'chapter' | 'takeaway';
  eyebrow?: string;
  title?: string;
  prose?: string;
  tone?: string;
  items?: { finding: string }[];
  origin?: 'ai' | 'author';
}

/** Facts that only exist when the data has them — their absence is not a gap. */
const CONDITIONAL_KINDS = new Set(['partial_periods', 'concentration', 'attainment']);

function tileIdOf(key: string): number | null {
  const n = Number(key.split(':')[1]);
  return Number.isFinite(n) ? n : null;
}

export function NarrativeWidget({ config, editing = false }: { config: NarrativeConfig; editing?: boolean }) {
  const { t, locale } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string; locale?: string };
  const { findings, status } = useReportFindings();
  const variant = config.variant ?? 'summary';
  const items = config.items ?? [];

  const lines = items.map(({ finding: key }) => {
    const f = findings.get(key);
    const tileId = tileIdOf(key);
    const st = tileId == null ? 'unknown' : status(tileId);
    if (f) return { key, state: 'ready' as const, text: renderFindingSentence(f, t, locale), finding: f };
    if (st === 'pending' || st === 'unknown') return { key, state: 'pending' as const, text: t('report.finding.pending') };
    // A conditional fact that does not apply under these filters (no partial
    // period, too few categories for a top-3) is simply not stated. A core
    // claim that the data no longer supports says so instead.
    if (CONDITIONAL_KINDS.has(key.split(':')[0])) return null;
    return { key, state: 'unavailable' as const, text: t('report.finding.unavailable') };
  }).filter((l): l is NonNullable<typeof l> => l !== null);

  const headFigure = variant === 'takeaway' || variant === 'callout'
    ? lines.map((l) => (l.state === 'ready' ? findingHeadlineFigure(l.finding!, locale) : null)).find(Boolean)
    : null;

  return (
    <div
      className="dashboard-narrative h-full w-full overflow-auto"
      data-narrative-variant={variant}
      data-testid="narrative-widget"
      data-finding-state={lines.map((l) => l.state).join(',')}
    >
      <div className="dashboard-narrative__inner">
        {config.eyebrow ? <div className="dashboard-narrative__eyebrow">{config.eyebrow}</div> : null}
        {headFigure ? (
          <div className={`dashboard-narrative__figure is-${headFigure.direction ?? 'flat'}`}>{headFigure.figure}</div>
        ) : null}
        {config.title ? (
          variant === 'headline'
            ? <h2 className="dashboard-narrative__headline">{config.title}</h2>
            : <h3 className="dashboard-narrative__title">{config.title}</h3>
        ) : null}
        {variant === 'headline' && !config.title && lines[0]?.state === 'ready' ? (
          <h2 className="dashboard-narrative__headline" data-finding={lines[0].key}>{lines[0].text}</h2>
        ) : null}
        {config.prose ? (
          <p className="dashboard-narrative__prose" data-static-text>
            {config.prose}
          </p>
        ) : null}
        {lines.length > 0 ? (
          <ul className="dashboard-narrative__list">
            {lines.slice(variant === 'headline' && !config.title ? 1 : 0).map((l) => (
              <li key={l.key} className={`dashboard-narrative__item is-${l.state}`} data-finding={l.key}>
                {l.text}
              </li>
            ))}
          </ul>
        ) : editing ? (
          <p className="dashboard-narrative__hint">{t('report.narrative.emptyHint')}</p>
        ) : null}
        {editing && config.prose ? <p className="dashboard-narrative__hint">{t('report.narrative.static')}</p> : null}
      </div>
    </div>
  );
}
