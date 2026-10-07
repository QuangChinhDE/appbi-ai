'use client';

/**
 * ChartFailurePanel — why the chart did not run, in the user's terms.
 *
 * A semantic refusal (two relationship paths with different meanings, a
 * fan-out …) is the engine declining to GUESS; the panel says that plainly and
 * points at what the user can change. The engine's own prose and the competing
 * paths stay available as detail for whoever models the data — never as the
 * headline. No route is ever picked here: the fix is a choice the user (or the
 * model owner) makes.
 */
import React from 'react';
import Link from 'next/link';
import { AlertTriangle, GitFork, Lock, ServerCrash } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';
import type { ChartFailure } from '@/lib/chart-failure';

interface ChartFailurePanelProps {
  failure: ChartFailure;
  /** Display name of the current base table, when one is set. */
  baseLabel?: string | null;
  /** Display names of the tables whose measures are computed (when ≠ base). */
  measureTables?: string[];
  /** Dataset whose model can be opened (null hides the link). */
  datasetId?: number | null;
  /** Whether the viewer may edit the dataset model. */
  canEditModel?: boolean;
}

export function ChartFailurePanel({ failure, baseLabel, measureTables = [], datasetId, canEditModel }: ChartFailurePanelProps) {
  const { t } = useI18n();
  const isRoute = failure.kind === 'ambiguous_route';
  const isRefusal = isRoute || failure.kind === 'semantic_refusal';
  const Icon = isRoute ? GitFork : failure.kind === 'permission' ? Lock : failure.kind === 'source_error' ? ServerCrash : AlertTriangle;
  const tone = isRefusal || failure.kind === 'invalid_config'
    ? 'border-warning/40 bg-warning/10'
    : 'border-danger/30 bg-danger/10';

  const title = isRoute
    ? (failure.target
      ? t('explore.failure.routeTitle', { target: failure.target })
      : t('explore.failure.routeTitleNoTarget'))
    : t(`explore.failure.${failure.kind}Title`);
  const body = isRoute ? t('explore.failure.routeBody') : isRefusal ? t('explore.failure.semantic_refusalBody') : '';

  return (
    <div
      data-testid="chart-failure"
      data-failure-kind={failure.kind}
      data-refusal-category={failure.category ?? ''}
      role="alert"
      className={`mx-auto w-full max-w-xl rounded-xl border p-4 text-sm ${tone}`}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-semibold text-text-primary" data-testid="chart-failure-title">{title}</p>
          {body && <p className="text-text-secondary">{body}</p>}
          {!isRefusal && failure.technical && (
            <p className="break-words text-text-secondary" data-testid="chart-failure-message">{failure.technical}</p>
          )}
          {isRefusal && (baseLabel || measureTables.length > 0) && (
            <p className="text-xs text-text-tertiary" data-testid="chart-failure-context">
              {baseLabel ? t('explore.failure.contextBase', { base: baseLabel }) : null}
              {measureTables.length > 0
                ? ` ${t('explore.failure.contextMeasures', { tables: measureTables.join(', ') })}`
                : null}
            </p>
          )}
          {isRefusal && (
            <ul className="list-disc space-y-1 pl-4 text-xs text-text-secondary" data-testid="chart-failure-actions">
              <li>{isRoute ? t('explore.failure.actionChangeField', { target: failure.target ?? '' }) : t('explore.failure.actionChangeFieldGeneric')}</li>
              <li>{t('explore.failure.actionChangeBase')}</li>
              <li>
                {canEditModel && datasetId != null ? (
                  <Link className="font-medium text-primary underline" href={`/datasets/${datasetId}?tab=model`}>
                    {t('explore.failure.actionOpenModel')}
                  </Link>
                ) : t('explore.failure.actionAskOwner')}
              </li>
            </ul>
          )}
          {isRefusal && (failure.routes?.length || failure.technical) && (
            <details className="text-xs text-text-tertiary" data-testid="chart-failure-details">
              <summary className="cursor-pointer select-none">{t('explore.failure.details')}</summary>
              {failure.routes && failure.routes.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-4" data-testid="chart-failure-routes">
                  {failure.routes.map((r) => <li key={r} className="font-mono">{r}</li>)}
                </ul>
              )}
              {failure.technical && <p className="mt-1 break-words">{failure.technical}</p>}
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
