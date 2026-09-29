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
  /** The heading of the section a tile belongs to (report-structure), if any —
   *  used to say WHICH part of the report a period belongs to. */
  sectionTitleOf?: (tileId: number) => string | null;
}

const ReportMetaContext = createContext<ReportMeta>({});

export function ReportMetaProvider({ value, children }: { value: ReportMeta; children: React.ReactNode }) {
  return <ReportMetaContext.Provider value={value}>{children}</ReportMetaContext.Provider>;
}

export function useReportMeta(): ReportMeta {
  return useContext(ReportMetaContext);
}

interface TileSpan { tileId: number; start: Date; end: Date; startRaw: string; endRaw: string; grain?: string }

function spanOf(e: TileEvidence): TileSpan | null {
  if (!e.timeField || !Array.isArray(e.rows)) return null;
  let first: { date: Date; raw: string } | null = null;
  let last: { date: Date; raw: string } | null = null;
  for (const row of e.rows) {
    const raw = row?.[e.timeField];
    if (raw === null || raw === undefined || raw === '') continue;
    const d = parseBucket(String(raw));
    if (!d) continue;
    if (!first || d < first.date) first = { date: d, raw: String(raw) };
    if (!last || d > last.date) last = { date: d, raw: String(raw) };
  }
  return first && last ? { tileId: e.tileId, start: first.date, end: last.date, startRaw: first.raw, endRaw: last.raw, grain: e.grain } : null;
}

/**
 * The span(s) the report's time series cover right now, or null when no tile
 * shows a time axis.
 *
 * One span when the series overlap ("Sep 2016 – Sep 2018": a filter or a
 * partial last month moves an edge, not the story). Several when they do not —
 * a report over two independent datasets covers two periods, and stating their
 * union ("Sep 2016 – Dec 2025") would tell a reader each covers nine years.
 * Each is named by its section when all its tiles sit in one
 * ("Marketplace: Sep 2016 – Sep 2018 · Sales: Jan 2024 – Dec 2025").
 */
export function reportPeriodLabel(
  evidence: TileEvidence[],
  locale?: string,
  sectionTitleOf?: (tileId: number) => string | null,
): string | null {
  const spans = evidence.map(spanOf).filter((s): s is TileSpan => s !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (spans.length === 0) return null;
  // Overlapping spans are one period; a gap starts another.
  const clusters: TileSpan[][] = [];
  for (const s of spans) {
    const cur = clusters[clusters.length - 1];
    const curEnd = cur ? Math.max(...cur.map((c) => c.end.getTime())) : -Infinity;
    if (cur && s.start.getTime() <= curEnd) cur.push(s);
    else clusters.push([s]);
  }
  const label = (cluster: TileSpan[]) => {
    const first = cluster.reduce((m, s) => (s.start < m.start ? s : m));
    const last = cluster.reduce((m, s) => (s.end > m.end ? s : m));
    const grain = cluster.find((s) => s.grain)?.grain
      ?? inferGrain(cluster.flatMap((s) => [{ date: s.start }, { date: s.end }]));
    const a = formatBucketLabel(first.startRaw, grain, locale);
    const b = formatBucketLabel(last.endRaw, grain, locale);
    return a === b ? a : `${a} – ${b}`;
  };
  if (clusters.length === 1) return label(clusters[0]);
  return clusters.map((cluster) => {
    const sections = new Set(cluster.map((s) => sectionTitleOf?.(s.tileId) ?? null));
    const only = sections.size === 1 ? [...sections][0] : null;
    return only ? `${only}: ${label(cluster)}` : label(cluster);
  }).join(' · ');
}

/** The heading title of each tile's section, from the report's structure. */
export function sectionTitlesOf(
  tiles: Array<{ id: number; widget_type?: string | null; widget_config?: any }>,
  sectionOf: Map<number, number | null>,
): (tileId: number) => string | null {
  const titleById = new Map(tiles.filter((t) => t.widget_type === 'section_header')
    .map((t) => [t.id, String(t.widget_config?.title ?? '').trim() || null]));
  return (tileId) => {
    const h = sectionOf.get(tileId);
    return h != null ? titleById.get(h) ?? null : null;
  };
}
