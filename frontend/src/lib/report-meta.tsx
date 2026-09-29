'use client';

/**
 * What a report element may say ABOUT the report: its name and description,
 * and the context a reader needs to interpret it — the filters in force.
 * Provided by every surface that renders a report (builder, public, embed),
 * each from its own state, so the report header states the same thing the
 * surface actually applies.
 *
 * The period the data covers is computed from the rows the tiles are showing
 * (report evidence), never typed: filter to one state and the period is that
 * state's.
 */
import React, { createContext, useContext } from 'react';

import { formatBucketLabel, inferGrain, parseBucket, type TileEvidence } from '@/lib/report-findings';

export interface ReportMeta {
  name?: string;
  description?: string | null;
  /** The filters in force, each stated as a reader reads it ("Customer state: SP"). */
  filterFacts?: string[];
}

const ReportMetaContext = createContext<ReportMeta>({});

export function ReportMetaProvider({ value, children }: { value: ReportMeta; children: React.ReactNode }) {
  return <ReportMetaContext.Provider value={value}>{children}</ReportMetaContext.Provider>;
}

export function useReportMeta(): ReportMeta {
  return useContext(ReportMetaContext);
}

/** The span the report's time series cover right now ("Sep 2016 – Sep 2018"),
 *  or null when no tile shows a time axis. */
export function reportPeriodLabel(evidence: TileEvidence[], locale?: string): string | null {
  const points: Array<{ date: Date; raw: string }> = [];
  for (const e of evidence) {
    if (!e.timeField || !Array.isArray(e.rows)) continue;
    for (const row of e.rows) {
      const raw = row?.[e.timeField];
      if (raw === null || raw === undefined || raw === '') continue;
      const d = parseBucket(String(raw));
      if (d) points.push({ date: d, raw: String(raw) });
    }
  }
  if (points.length === 0) return null;
  points.sort((a, b) => a.date.getTime() - b.date.getTime());
  const first = points[0];
  const last = points[points.length - 1];
  const grain = evidence.find((e) => e.timeField && e.grain)?.grain ?? inferGrain(points.map((p) => ({ date: p.date })));
  const a = formatBucketLabel(first.raw, grain, locale);
  const b = formatBucketLabel(last.raw, grain, locale);
  return a === b ? a : `${a} – ${b}`;
}
