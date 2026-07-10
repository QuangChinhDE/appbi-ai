'use client';

/**
 * Semantic Lineage & Impact — reads the SEMANTIC MODEL (columns, measures,
 * joins) and lets you trace, from any column or measure, everything downstream
 * it affects: dependent measures, tables joined on it, and the charts /
 * dashboards that consume it. Red = a failing quality rule or open incident,
 * so "this column is broken → here's the blast radius" is one click away.
 * Backed by /observability/semantic-lineage.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Table2, KeyRound, ShieldCheck, AlertTriangle, Sigma, BarChart3, LayoutDashboard,
  GitBranch, ArrowRight, Info,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import { getSemanticLineage, type SemanticLineage, type SemTable } from '@/lib/observability';

type Sel = { kind: 'column' | 'measure'; tableId: number; name: string } | null;
const mkey = (tableId: number, name: string) => `${tableId}:${name}`;

export function SemanticLineageTab({ datasetId }: { datasetId: number }) {
  const { t } = useI18n();
  const [g, setG] = useState<SemanticLineage | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Sel>(null);

  useEffect(() => {
    setLoading(true);
    getSemanticLineage(datasetId).then(setG).catch(() => setG(null)).finally(() => setLoading(false));
  }, [datasetId]);

  const tableById = useMemo(() => new Map((g?.tables ?? []).map((tb) => [tb.tableId, tb])), [g]);

  // Auto-select the first column that has a failing rule / incident, so a broken
  // column's blast radius shows immediately.
  useEffect(() => {
    if (!g || sel) return;
    for (const tb of g.tables) {
      const bad = tb.columns.find((c) => c.failingRules > 0 || c.incidents > 0);
      if (bad) { setSel({ kind: 'column', tableId: tb.tableId, name: bad.name }); return; }
    }
    const firstCol = g.tables.find((tb) => tb.columns.length)?.columns[0];
    const firstT = g.tables.find((tb) => tb.columns.length);
    if (firstT && firstCol) setSel({ kind: 'column', tableId: firstT.tableId, name: firstCol.name });
  }, [g, sel]);

  const impact = useMemo(() => computeImpact(g, sel), [g, sel]);

  if (loading) return <p className="py-10 text-center text-caption text-text-tertiary">{t('observability.loading')}</p>;
  if (!g || !g.dataset) return <p className="py-10 text-center text-caption text-text-tertiary">{t('observability.lineage.selectPrompt')}</p>;
  if (!g.hasModel || g.tables.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center">
        <GitBranch className="mx-auto mb-3 h-10 w-10 text-text-quaternary" />
        <p className="text-caption text-text-tertiary">{t('observability.semantic.noModel')}</p>
      </div>
    );
  }

  const ruleCols = g.tables.reduce((a, tb) => a + tb.columns.filter((c) => c.rules > 0).length, 0);
  const failingCols = g.tables.reduce((a, tb) => a + tb.columns.filter((c) => c.failingRules > 0 || c.incidents > 0).length, 0);

  return (
    <div className="space-y-4">
      {/* summary */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-tertiary">
        <span>{t('observability.semantic.summary', { tables: g.tables.length, joins: g.joins.length, charts: g.charts.length })}</span>
        <span className={cn(failingCols > 0 && 'text-danger font-emphasis')}>{t('observability.semantic.coverage', { ruleCols, failing: failingCols })}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        {/* LEFT — tables → columns + measures */}
        <div className="space-y-3">
          <div>
            <h3 className="text-caption font-strong text-text-primary">{t('observability.semantic.tablesTitle')}</h3>
            <p className="text-tiny text-text-quaternary">{t('observability.semantic.tablesHint')}</p>
          </div>
          {g.tables.map((tb) => (
            <TableCard key={tb.tableId} tb={tb} sel={sel} onSelect={setSel} />
          ))}

          {g.joins.length > 0 && (
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-wide text-text-quaternary"><GitBranch className="h-3.5 w-3.5" />{t('observability.semantic.joinsTitle')}</h4>
              <ul className="space-y-1">
                {g.joins.map((j, i) => (
                  <li key={i} className="flex items-center gap-1.5 text-tiny text-text-tertiary">
                    <span className="text-text-secondary">{tableById.get(j.fromTable)?.name ?? j.fromTable}</span>
                    <code className="text-text-quaternary">{j.fromColumn}</code>
                    <ArrowRight className="h-3 w-3 text-text-quaternary" />
                    <span className="text-text-secondary">{tableById.get(j.toTable)?.name ?? j.toTable}</span>
                    <code className="text-text-quaternary">{j.toColumn}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* RIGHT — impact of selected node */}
        <ImpactPanel g={g} sel={sel} impact={impact} tableById={tableById} />
      </div>
    </div>
  );
}

function TableCard({ tb, sel, onSelect }: { tb: SemTable; sel: Sel; onSelect: (s: Sel) => void }) {
  const { t } = useI18n();
  return (
    <div className={cn('overflow-hidden rounded-xl border bg-surface-1', tb.openIncidents > 0 ? 'border-danger/40' : 'border-[rgb(var(--border-line))]')}>
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
        <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary"><Table2 className="h-3.5 w-3.5 text-text-tertiary" />{tb.name}</span>
        <span className="flex items-center gap-2 text-tiny text-text-quaternary">
          {tb.source && <span>{tb.source}</span>}
          {tb.openIncidents > 0 && <span className="inline-flex items-center gap-0.5 text-danger"><AlertTriangle className="h-3 w-3" />{tb.openIncidents}</span>}
        </span>
      </div>
      <div className="space-y-2 p-3">
        <div>
          <div className="mb-1 text-tiny uppercase tracking-wide text-text-quaternary">{t('observability.semantic.columns')} ({tb.columns.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {tb.columns.map((c) => {
              const bad = c.failingRules > 0 || c.incidents > 0;
              const active = sel?.kind === 'column' && sel.tableId === tb.tableId && sel.name === c.name;
              return (
                <button key={c.name} onClick={() => onSelect({ kind: 'column', tableId: tb.tableId, name: c.name })}
                  className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-tiny transition-colors',
                    active ? 'border-brand bg-brand/10 text-brand ring-1 ring-brand'
                      : bad ? 'border-danger/40 bg-danger/5 text-danger'
                      : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:border-[rgb(var(--border-strong))]')}>
                  {c.joinKey && <KeyRound className="h-3 w-3 opacity-70" />}
                  {c.name}
                  {c.rules > 0 && !bad && <ShieldCheck className="h-3 w-3 text-success" />}
                  {bad && <AlertTriangle className="h-3 w-3" />}
                </button>
              );
            })}
          </div>
        </div>
        {tb.measures.length > 0 && (
          <div>
            <div className="mb-1 text-tiny uppercase tracking-wide text-text-quaternary">{t('observability.semantic.measures')} ({tb.measures.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {tb.measures.map((m) => {
                const active = sel?.kind === 'measure' && sel.tableId === tb.tableId && sel.name === m.name;
                return (
                  <button key={m.name} onClick={() => onSelect({ kind: 'measure', tableId: tb.tableId, name: m.name })}
                    className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-tiny transition-colors',
                      active ? 'border-brand bg-brand/10 text-brand ring-1 ring-brand'
                        : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:border-[rgb(var(--border-strong))]')}>
                    <Sigma className="h-3 w-3 opacity-70" />{m.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ImpactPanel({ g, sel, impact, tableById }: {
  g: SemanticLineage; sel: Sel; impact: ReturnType<typeof computeImpact>; tableById: Map<number, SemTable>;
}) {
  const { t } = useI18n();
  if (!sel || !impact) {
    return <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] p-6 text-center text-caption text-text-quaternary lg:sticky lg:top-2">{t('observability.semantic.impact.prompt')}</div>;
  }
  const selTable = tableById.get(sel.tableId);
  const empty = impact.measures.length === 0 && impact.joined.length === 0 && impact.charts.length === 0 && impact.dashboards.length === 0;
  return (
    <div className="space-y-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 lg:sticky lg:top-2 self-start">
      <div>
        <div className="flex items-center gap-1.5 text-tiny uppercase tracking-wide text-text-quaternary">
          {sel.kind === 'column' ? <Table2 className="h-3 w-3" /> : <Sigma className="h-3 w-3" />}
          {sel.kind === 'column' ? t('observability.semantic.kind.column') : t('observability.semantic.kind.measure')} · {selTable?.name}
        </div>
        <h3 className="text-small font-strong text-text-primary">{t('observability.semantic.impact.title', { name: sel.name })}</h3>
      </div>

      <div className={cn('flex items-start gap-1.5 rounded-lg px-3 py-2 text-tiny',
        impact.hasIssue ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-text-tertiary')}>
        {impact.hasIssue ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />}
        <span>{impact.hasIssue ? t('observability.semantic.impact.hasIssue') : t('observability.semantic.impact.clean')}</span>
      </div>

      {empty ? (
        <p className="py-3 text-center text-tiny text-text-quaternary">{t('observability.semantic.impact.none')}</p>
      ) : (
        <div className="space-y-3">
          <ImpactGroup icon={<Sigma className="h-3.5 w-3.5" />} title={t('observability.semantic.impact.measures')} count={impact.measures.length}
            items={impact.measures.map((m) => `${tableById.get(m.table)?.name ?? m.table} · ${m.name}`)} />
          <ImpactGroup icon={<GitBranch className="h-3.5 w-3.5" />} title={t('observability.semantic.impact.joined')} count={impact.joined.length}
            items={impact.joined.map((j) => `${tableById.get(j.tableId)?.name ?? j.tableId}${j.column ? ` · ${j.column}` : ''}`)} />
          <ImpactGroup icon={<BarChart3 className="h-3.5 w-3.5" />} title={t('observability.semantic.impact.charts')} count={impact.charts.length}
            items={impact.charts.map((c) => c.name)} />
          <ImpactGroup icon={<LayoutDashboard className="h-3.5 w-3.5" />} title={t('observability.semantic.impact.dashboards')} count={impact.dashboards.length}
            items={impact.dashboards.map((d) => d.name)} tone="danger" />
        </div>
      )}
    </div>
  );
}

function ImpactGroup({ icon, title, count, items, tone }: { icon: React.ReactNode; title: string; count: number; items: string[]; tone?: 'danger' }) {
  if (count === 0) return null;
  return (
    <div>
      <div className={cn('mb-1 flex items-center gap-1.5 text-tiny font-emphasis', tone === 'danger' ? 'text-danger' : 'text-text-secondary')}>
        {icon}{title} <span className="rounded-full bg-surface-2 px-1.5 text-text-tertiary">{count}</span>
      </div>
      <ul className="space-y-0.5 pl-5">
        {items.slice(0, 12).map((it, i) => <li key={i} className="truncate text-tiny text-text-tertiary" title={it}>{it}</li>)}
        {items.length > 12 && <li className="text-tiny text-text-quaternary">+{items.length - 12}</li>}
      </ul>
    </div>
  );
}

// ── impact traversal (client-side over the semantic graph) ───────────────────
function computeImpact(g: SemanticLineage | null, sel: Sel) {
  if (!g || !sel) return null;
  const allMeasures = g.tables.flatMap((tb) => tb.measures.map((m) => ({ ...m, table: tb.tableId })));

  // seed affected-measure set
  const affected = new Set<string>();
  if (sel.kind === 'measure') {
    affected.add(mkey(sel.tableId, sel.name));
  } else {
    for (const m of allMeasures) {
      if (m.dependsColumns.some((d) => d.table === sel.tableId && d.column === sel.name)) affected.add(mkey(m.table, m.name));
    }
  }
  // transitive: measures that depend on an already-affected measure
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of allMeasures) {
      const k = mkey(m.table, m.name);
      if (!affected.has(k) && m.dependsMeasures.some((d) => affected.has(mkey(d.table, d.measure)))) {
        affected.add(k); changed = true;
      }
    }
  }
  const measures = allMeasures
    .filter((m) => affected.has(mkey(m.table, m.name)) && !(sel.kind === 'measure' && m.table === sel.tableId && m.name === sel.name))
    .map((m) => ({ table: m.table, name: m.label || m.name }));

  // joined tables (only meaningful for a column that is a join key)
  const joined: { tableId: number; column?: string | null }[] = [];
  if (sel.kind === 'column') {
    for (const j of g.joins) {
      if (j.fromTable === sel.tableId && j.fromColumn === sel.name) joined.push({ tableId: j.toTable, column: j.toColumn });
      if (j.toTable === sel.tableId && j.toColumn === sel.name) joined.push({ tableId: j.fromTable, column: j.fromColumn });
    }
  }

  // charts: direct column use OR use of an affected measure
  const charts = g.charts.filter((c) =>
    (sel.kind === 'column' && c.tableId === sel.tableId && c.usesColumns.includes(sel.name))
    || c.usesMeasures.some((mn) => affected.has(mkey(c.tableId, mn))));
  const dashIds = new Set<number>();
  charts.forEach((c) => c.dashboardIds.forEach((d) => dashIds.add(d)));
  const dashboards = g.dashboards.filter((d) => dashIds.has(d.id));

  // does the selected node itself carry an issue?
  const selTable = g.tables.find((tb) => tb.tableId === sel.tableId);
  const selCol = sel.kind === 'column' ? selTable?.columns.find((c) => c.name === sel.name) : undefined;
  const hasIssue = !!(selCol && (selCol.failingRules > 0 || selCol.incidents > 0));

  return { measures, joined, charts, dashboards, hasIssue };
}
