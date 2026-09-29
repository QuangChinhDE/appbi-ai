'use client';

/**
 * The report's opening: what the report is, what it covers, the period its data
 * spans and the context it is read in — and, where the data supports one, its
 * headline message.
 *
 * Nothing here is typed as a number. The title and description default to the
 * report's own; the period is computed from the rows the tiles show; the
 * context is the filters the surface applies; the headline is a finding whose
 * figure and verb come from the data (it says "updating" while a filter change
 * is in flight). A figure typed into an older header is still shown, marked as
 * static text in the builder, so nobody mistakes it for a live number.
 *
 * Three layouts — banner, split, minimal — over the report's own type scale and
 * accent, so the opening belongs to the report's design rather than being a
 * fixed gradient box. The same component draws it in the builder, on /d,
 * /embed and in the PDF.
 */
import React from 'react';

import { useReportFindings } from '@/lib/report-evidence';
import { findingHeadlineFigure, renderFindingSentence } from '@/lib/report-findings';
import { reportPeriodLabel, useReportMeta } from '@/lib/report-meta';
import { useI18n } from '@/providers/LanguageProvider';

export interface ReportHeaderConfig {
  headline?: string;
  subhead?: string;
  /** Older configs. */
  title?: string;
  subtitle?: string;
  description?: string;
  eyebrow?: string;
  variant?: 'banner' | 'split' | 'minimal';
  showPeriod?: boolean;
  showContext?: boolean;
  finding?: string;
  /** Legacy typed figure (static). */
  metric?: string;
  metricLabel?: string;
}

export function ReportHeaderWidget({ config, editing = false }: { config: ReportHeaderConfig; editing?: boolean }) {
  const { t, locale } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string; locale?: string };
  const meta = useReportMeta();
  const { findings, evidence, status } = useReportFindings();
  const variant = config.variant ?? 'banner';
  const title = String(config.headline ?? config.title ?? '').trim() || meta.name || '';
  const description = String(config.subhead ?? config.description ?? config.subtitle ?? '').trim() || String(meta.description ?? '').trim();
  const period = config.showPeriod === false ? null : reportPeriodLabel(evidence, locale);
  const facts = config.showContext === false ? [] : (meta.filterFacts ?? []);

  const key = String(config.finding ?? '');
  const finding = key ? findings.get(key) : undefined;
  const tileId = key ? Number(key.split(':')[1]) : NaN;
  const pending = !!key && !finding && Number.isFinite(tileId) && ['pending', 'unknown'].includes(status(tileId));
  const sentence = finding ? renderFindingSentence(finding, t, locale) : null;
  const figure = finding ? findingHeadlineFigure(finding, locale) : null;

  const metaRow = (period || config.showContext !== false) ? (
    <div className="dashboard-report-header__meta" data-header-meta>
      {period ? <span data-header-period>{t('report.header.period', { period })}</span> : null}
      {config.showContext !== false ? (
        <span data-header-context>
          {facts.length > 0 ? t('report.header.filtered', { filters: facts.join(' · ') }) : t('report.header.allData')}
        </span>
      ) : null}
    </div>
  ) : null;

  const headline = key ? (
    <div className="dashboard-report-header__headline" data-header-finding={key} data-finding-state={finding ? 'ready' : pending ? 'pending' : 'unavailable'}>
      {figure && variant === 'split' ? (
        <div className={`dashboard-report-header__figure is-${figure.direction ?? 'flat'}`}>{figure.figure}</div>
      ) : null}
      <p>{sentence ?? (pending ? t('report.finding.pending') : t('report.finding.unavailable'))}</p>
    </div>
  ) : null;

  const staticMetric = config.metric ? (
    <div className="dashboard-report-header__static" data-static-text title={editing ? t('report.header.staticFigure') : undefined}>
      <div className="dashboard-report-header__static-value">{config.metric}</div>
      {config.metricLabel ? <div className="dashboard-report-header__static-label">{config.metricLabel}</div> : null}
    </div>
  ) : null;

  return (
    <header
      className={`dashboard-report-header is-${variant}`}
      data-report-header
      data-header-variant={variant}
    >
      <div className="dashboard-report-header__main">
        {config.eyebrow ? <div className="dashboard-report-header__eyebrow">{config.eyebrow}</div> : null}
        {title ? <h1 className="dashboard-report-header__title">{title}</h1> : (
          editing ? <h1 className="dashboard-report-header__title is-placeholder">{t('report.header.untitled')}</h1> : null
        )}
        {description ? <p className="dashboard-report-header__description">{description}</p> : null}
        {variant !== 'split' ? headline : null}
        {metaRow}
      </div>
      {variant === 'split' ? (
        <div className="dashboard-report-header__aside">{headline}{staticMetric}</div>
      ) : staticMetric}
    </header>
  );
}
