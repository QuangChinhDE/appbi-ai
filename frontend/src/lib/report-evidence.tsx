'use client';

/**
 * Report evidence — the rows each tile is CURRENTLY showing, shared with the
 * blocks that state findings about them.
 *
 * A tile publishes what it rendered (or `pending` while it refetches for new
 * filters). A narrative block subscribes and derives its findings from exactly
 * those rows. Two consequences that matter to a reader:
 *
 *  - the number in a sentence and the number on the chart are the same number,
 *    because they are computed from the same response;
 *  - while a filter change is in flight the sentence shows "updating" — it never
 *    sits beside the new chart still stating the old conclusion.
 *
 * One store per rendered report (builder page, public view, embed). No new data
 * path: the tiles already fetch through the client their surface is allowed to
 * use (authed on the builder, `publicClient` on /d and /embed).
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { currencySymbolFor } from '@/lib/chart-semantic-maps';
import { findingsForReport, type Finding, type MeasureFormatSpec, type TileEvidence } from '@/lib/report-findings';
import type { ChartDataResponse } from '@/types/api';

type Entry = { status: 'pending' } | { status: 'ready'; evidence: TileEvidence } | { status: 'none' };

class EvidenceStore {
  private entries = new Map<number, Entry>();
  private listeners = new Set<() => void>();
  private version = 0;

  set(tileId: number, entry: Entry | null) {
    const prev = this.entries.get(tileId);
    if (entry === null) {
      if (!prev) return;
      this.entries.delete(tileId);
    } else {
      if (prev && prev.status === entry.status && prev.status !== 'ready') return;
      if (prev && prev.status === 'ready' && entry.status === 'ready' && prev.evidence === entry.evidence) return;
      this.entries.set(tileId, entry);
    }
    this.version += 1;
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  get(tileId: number) { return this.entries.get(tileId); }
  all() { return this.entries; }
}

const EvidenceContext = createContext<EvidenceStore | null>(null);

/** One store per rendered report. Nested providers join the outer store, so
 *  a page may provide it high up (the AI panel reads findings) and the grid can
 *  still provide it on surfaces that have no outer one (public, embed). */
export function ReportEvidenceProvider({ children }: { children: React.ReactNode }) {
  const outer = useContext(EvidenceContext);
  const store = useMemo(() => outer ?? new EvidenceStore(), [outer]);
  return <EvidenceContext.Provider value={store}>{children}</EvidenceContext.Provider>;
}

/** A tile reports what it is showing. `undefined` evidence while loading or
 *  refetching publishes `pending`; unmount withdraws the entry. */
export function usePublishTileEvidence(tileId: number | undefined, evidence: TileEvidence | null | undefined, loading: boolean) {
  const store = useContext(EvidenceContext);
  const idRef = useRef(tileId);
  idRef.current = tileId;
  useEffect(() => {
    if (!store || tileId == null) return;
    if (loading) store.set(tileId, { status: 'pending' });
    else if (evidence) store.set(tileId, { status: 'ready', evidence });
    else store.set(tileId, { status: 'none' });
  }, [store, tileId, evidence, loading]);
  useEffect(() => () => { if (store && idRef.current != null) store.set(idRef.current, null); }, [store]);
}

export interface ReportFindingsState {
  findings: Map<string, Finding>;
  status: (tileId: number) => 'pending' | 'ready' | 'none' | 'unknown';
}

/** Findings over every tile that has published. Re-derived when any tile's
 *  evidence changes, so a filter change flows straight through. */
export function useReportFindings(): ReportFindingsState {
  const store = useContext(EvidenceContext);
  const version = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getVersion ?? (() => 0),
    store?.getVersion ?? (() => 0),
  );
  return useMemo(() => {
    if (!store) return { findings: new Map(), status: () => 'unknown' as const };
    const ready: TileEvidence[] = [];
    store.all().forEach((e) => { if (e.status === 'ready') ready.push(e.evidence); });
    return {
      findings: findingsForReport(ready),
      status: (tileId: number) => store.get(tileId)?.status ?? 'unknown',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);
}

// ── Building a tile's evidence ───────────────────────────────────────────────

interface ModelMeasure { name: string; label?: string | null; type?: string; format?: { kind?: string; currency?: string | null; decimals?: number | null } | null }
interface ModelView { name: string; measures?: ModelMeasure[] | null; dimensions?: { name: string; label?: string | null }[] | null }

const ADDITIVE_AGGS = new Set(['sum', 'count']);

function findMeasure(views: ModelView[] | undefined | null, field: string): ModelMeasure | undefined {
  if (!views || !field.includes('.')) return undefined;
  const [viewName, name] = [field.slice(0, field.lastIndexOf('.')), field.slice(field.lastIndexOf('.') + 1)];
  return views.find((v) => v.name === viewName)?.measures?.find((m) => m.name === name);
}

export interface BuildEvidenceInput {
  tileId: number;
  chartType: string;
  title: string;
  roleConfig: any;
  styleConfig?: any;
  response: ChartDataResponse | null | undefined;
  views?: ModelView[] | null;
}

/** The evidence a tile can offer, or null when it has none (no measure, no rows). */
export function buildTileEvidence(input: BuildEvidenceInput): TileEvidence | null {
  const { response, roleConfig: rc } = input;
  if (!response || !Array.isArray(response.data) || !rc) return null;
  const metric = (rc.metrics ?? [])[0];
  if (!metric?.field) return null;
  const measure = findMeasure(input.views, metric.field);
  const agg = String(metric.agg || 'auto').toLowerCase();
  const measureType = String(measure?.type || '').toLowerCase();
  const additive = agg === 'auto' ? ADDITIVE_AGGS.has(measureType) : ADDITIVE_AGGS.has(agg);
  const kind = measure?.format?.kind;
  const format: MeasureFormatSpec = {
    kind: kind === 'percent' || kind === 'currency' ? kind : 'number',
    currencySymbol: kind === 'currency' ? currencySymbolFor(measure?.format?.currency ?? undefined) : undefined,
    decimals: measure?.format?.decimals ?? undefined,
  };
  const tc = response.time_completeness;
  const timeField: string | undefined = rc.timeField || (tc?.field ?? undefined);
  const grain = (tc?.grain as string | undefined) ?? (timeField ? rc.timeGrains?.[timeField] : undefined);
  const style = input.styleConfig ?? {};
  const targetRaw = style.kpiBenchmarkValue;
  const target = targetRaw !== undefined && targetRaw !== '' && targetRaw !== null && Number.isFinite(Number(targetRaw))
    ? { value: Number(targetRaw), label: style.kpiBenchmarkLabel, direction: style.kpiGoalDirection === 'down' ? 'down' as const : 'up' as const }
    : undefined;
  return {
    tileId: input.tileId,
    chartType: String(input.chartType || '').toUpperCase(),
    title: input.title,
    measureField: metric.field,
    measureLabel: (measure?.label || '').trim() || input.title,
    additive,
    format,
    dimensionField: rc.dimension && rc.dimension !== timeField ? rc.dimension : (timeField ? undefined : rc.dimension),
    timeField: tc?.field || (grain ? timeField : undefined) || (String(input.chartType).toUpperCase() === 'TIME_SERIES' ? timeField : undefined),
    grain,
    rows: response.data,
    partialBuckets: (tc?.partial ?? []).map((p) => String(p.bucket)),
    target,
  };
}
