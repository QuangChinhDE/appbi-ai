'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  AlertTriangle,
  BookMarked,
  Database,
  ExternalLink,
  FileText,
  LayoutDashboard,
  Network,
  Calculator,
  Sigma,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  governGraph,
  type CoverageRow,
  type KnowledgeGraph,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type KnowledgeNodeKind,
} from '@/lib/catalog';
import { useI18n } from '@/providers/LanguageProvider';

type GraphMode = 'all' | 'connected' | 'gaps';
type EdgeLayer = 'physical' | 'semantic' | 'knowledge';

type KindMeta = {
  icon: LucideIcon;
  color: string;
  soft: string;
  border: string;
};

const KIND_ORDER: KnowledgeNodeKind[] = ['dashboard', 'dataset', 'measure', 'metric', 'doc', 'term', 'caveat'];
const KIND_META: Record<KnowledgeNodeKind, KindMeta> = {
  dashboard: { icon: LayoutDashboard, color: '#2563eb', soft: '#eff6ff', border: '#93c5fd' },
  dataset: { icon: Database, color: '#0f766e', soft: '#f0fdfa', border: '#5eead4' },
  measure: { icon: Calculator, color: '#0369a1', soft: '#f0f9ff', border: '#7dd3fc' },
  metric: { icon: Sigma, color: '#b45309', soft: '#fffbeb', border: '#fcd34d' },
  doc: { icon: FileText, color: '#5e6ad2', soft: '#eef0fc', border: '#a5b4fc' },
  term: { icon: BookMarked, color: '#be185d', soft: '#fdf2f8', border: '#f9a8d4' },
  caveat: { icon: AlertTriangle, color: '#b91c1c', soft: '#fef2f2', border: '#fca5a5' },
};

const EDGE_COLOR: Record<KnowledgeGraphEdge['kind'], string> = {
  reads: '#94a3b8',
  explains: '#5e6ad2',
  defines: '#d97706',
  defined_in: '#0284c7',
  realized_by: '#b45309',
  means: '#be185d',
  applies_to: '#b91c1c',
  links: '#2563eb',
  references: '#b45309',
};

const ANCHORS: Record<KnowledgeNodeKind, { x: number; y: number }> = {
  dashboard: { x: 180, y: 470 },
  dataset: { x: 560, y: 460 },
  measure: { x: 830, y: 460 },
  metric: { x: 1080, y: 260 },
  doc: { x: 1350, y: 470 },
  term: { x: 1080, y: 760 },
  caveat: { x: 760, y: 760 },
};

type GraphNodeData = {
  source: KnowledgeGraphNode;
  degree: number;
  gap: boolean;
  dimmed: boolean;
  matched: boolean;
  showLabel: boolean;
};
type CanvasNode = Node<GraphNodeData, 'knowledge'>;

function hashAngle(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967295) * Math.PI * 2;
}

function coverageIndex(graph: KnowledgeGraph): Map<string, CoverageRow> {
  const out = new Map<string, CoverageRow>();
  graph.coverage.dashboards.forEach((row) => out.set(`dashboard:${row.id}`, row));
  graph.coverage.datasets.forEach((row) => out.set(`dataset:${row.id}`, row));
  return out;
}

function graphFacts(graph: KnowledgeGraph) {
  const degree = new Map<string, number>();
  const knowledgeDegree = new Map<string, number>();
  graph.nodes.forEach((node) => {
    degree.set(node.id, 0);
    knowledgeDegree.set(node.id, 0);
  });
  graph.edges.forEach((edge) => {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    if (edge.kind !== 'reads') {
      knowledgeDegree.set(edge.from, (knowledgeDegree.get(edge.from) ?? 0) + 1);
      knowledgeDegree.set(edge.to, (knowledgeDegree.get(edge.to) ?? 0) + 1);
    }
  });
  const coverage = coverageIndex(graph);
  const gaps = new Set<string>();
  graph.nodes.forEach((node) => {
    const row = coverage.get(node.id);
    const missingCoverage = row ? !(row.docs || row.metrics || row.terms || row.caveats) : false;
    if (missingCoverage || (!row && (knowledgeDegree.get(node.id) ?? 0) === 0)) gaps.add(node.id);
  });
  return { degree, coverage, gaps };
}

/** One bounded simulation produces a stable topology. It never runs while the
 * user pans or zooms, which keeps a 100+ node graph cheap to interact with. */
function networkLayout(graph: KnowledgeGraph, degree: Map<string, number>) {
  const ordered = [...graph.nodes].sort((a, b) => {
    const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (kind) return kind;
    const byDegree = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    return byDegree || a.label.localeCompare(b.label);
  });
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  const perKind = new Map<KnowledgeNodeKind, number>();
  ordered.forEach((node) => {
    const index = perKind.get(node.kind) ?? 0;
    perKind.set(node.kind, index + 1);
    const anchor = ANCHORS[node.kind];
    const angle = hashAngle(node.id) + index * 2.399963;
    const radius = 38 + Math.sqrt(index + 1) * (node.kind === 'dataset' ? 58 : 48);
    positions.set(node.id, {
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    });
  });

  for (let tick = 0; tick < 180; tick += 1) {
    const cooling = Math.max(0.08, 1 - tick / 190);
    for (let i = 0; i < ordered.length; i += 1) {
      const a = positions.get(ordered[i].id)!;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const b = positions.get(ordered[j].id)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance2 = Math.max(64, dx * dx + dy * dy);
        const distance = Math.sqrt(distance2);
        const force = 5200 / distance2;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    graph.edges.forEach((edge) => {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const desired = edge.kind === 'reads' ? 260 : 190;
      const force = (distance - desired) * 0.012;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    });
    ordered.forEach((node) => {
      const p = positions.get(node.id)!;
      const anchor = ANCHORS[node.kind];
      p.vx += (anchor.x - p.x) * 0.006;
      p.vy += (anchor.y - p.y) * 0.006;
      p.x += p.vx * cooling * 0.55;
      p.y += p.vy * cooling * 0.55;
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x = Math.max(30, Math.min(1450, p.x));
      p.y = Math.max(30, Math.min(960, p.y));
    });
  }
  return positions;
}

const KnowledgePoint = memo(function KnowledgePoint({ data, selected }: NodeProps<CanvasNode>) {
  const meta = KIND_META[data.source.kind];
  const Icon = meta.icon;
  const size = Math.min(44, 30 + data.degree * 2);
  return (
    <div
      className={cn('group relative h-11 w-11 transition-opacity', data.dimmed && 'opacity-20')}
      aria-label={`${data.source.label}, ${data.source.kind}`}
      title={data.source.label}
    >
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <div
        className={cn(
          'absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 transition-transform',
          selected && 'scale-110 ring-4 ring-brand/15',
          data.matched && 'ring-4 ring-warning/25',
          data.gap && 'border-dashed',
        )}
        style={{ width: size, height: size, color: meta.color, background: meta.soft, borderColor: meta.border }}
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </div>
      {data.gap && (
        <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full border border-white bg-warning" />
      )}
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 top-12 w-36 -translate-x-1/2 truncate text-center text-[11px] text-text-secondary transition-opacity group-hover:opacity-100',
          data.showLabel || selected || data.matched ? 'opacity-100' : 'opacity-0',
          (selected || data.matched) && 'font-strong text-text-primary',
        )}
      >
        {data.source.label}
      </span>
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !border-0 !bg-transparent" />
    </div>
  );
});

const NODE_TYPES = { knowledge: KnowledgePoint };

function Stat({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  return (
    <div className="min-w-0 border-r border-[rgb(var(--border-line))] px-3 last:border-r-0">
      <div className={cn('text-small font-strong tabular-nums', warning ? 'text-warning' : 'text-text-primary')}>{value}</div>
      <div className="truncate text-tiny text-text-tertiary">{label}</div>
    </div>
  );
}

function KindToggle({
  kind,
  count,
  active,
  onClick,
  label,
}: {
  kind: KnowledgeNodeKind;
  count: number;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-tiny transition-colors',
        active
          ? 'border-[rgb(var(--border-strong))] bg-surface-1 text-text-primary'
          : 'border-transparent bg-surface-2 text-text-quaternary',
      )}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" style={{ color: active ? meta.color : undefined }} />
      <span>{label}</span>
      <span className="tabular-nums text-text-quaternary">{count}</span>
    </button>
  );
}

function EmptyInspector({ graph, onSelect }: {
  graph: KnowledgeGraph;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const facts = useMemo(() => graphFacts(graph), [graph]);
  const hubs = useMemo(
    () => [...graph.nodes]
      .filter((node) => (facts.degree.get(node.id) ?? 0) > 0)
      .sort((a, b) => (facts.degree.get(b.id) ?? 0) - (facts.degree.get(a.id) ?? 0))
      .slice(0, 7),
    [facts.degree, graph.nodes],
  );
  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-[rgb(var(--border-line))] p-4">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-brand" />
          <h3 className="text-caption font-strong text-text-primary">{t('govern.graph.systemOverview')}</h3>
        </div>
      </div>
      <dl className="divide-y divide-[rgb(var(--border-line))] px-4 text-caption">
        <div className="flex items-center justify-between py-3">
          <dt className="text-text-tertiary">{t('govern.graph.reportsWithoutKnowledge')}</dt>
          <dd className="font-strong tabular-nums text-warning">{graph.totals.dashboards_without_knowledge}</dd>
        </div>
        <div className="flex items-center justify-between py-3">
          <dt className="text-text-tertiary">{t('govern.graph.orphanTerms')}</dt>
          <dd className="font-strong tabular-nums text-text-primary">{graph.totals.orphan_terms}</dd>
        </div>
      </dl>
      {hubs.length > 0 && (
        <div className="border-t border-[rgb(var(--border-line))] p-3">
          <h4 className="mb-1.5 px-1 text-tiny font-strong uppercase text-text-quaternary">{t('govern.graph.mostConnected')}</h4>
          <div className="space-y-0.5">
            {hubs.map((node) => {
              const meta = KIND_META[node.kind];
              const Icon = meta.icon;
              return (
                <button key={node.id} type="button" onClick={() => onSelect(node.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-surface-2">
                  <Icon className="h-3.5 w-3.5" style={{ color: meta.color }} />
                  <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">{node.label}</span>
                  <span className="text-tiny tabular-nums text-text-quaternary">{facts.degree.get(node.id)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function NodeInspector({
  graph,
  node,
  onSelect,
  onOpen,
}: {
  graph: KnowledgeGraph;
  node: KnowledgeGraphNode;
  onSelect: (id: string) => void;
  onOpen: (node: KnowledgeGraphNode) => void;
}) {
  const { t } = useI18n();
  const meta = KIND_META[node.kind];
  const Icon = meta.icon;
  const byId = useMemo(() => new Map(graph.nodes.map((item) => [item.id, item])), [graph.nodes]);
  const coverage = useMemo(() => coverageIndex(graph).get(node.id), [graph, node.id]);
  const neighbours = useMemo(() => graph.edges.flatMap((edge) => {
    if (edge.from === node.id && byId.has(edge.to)) return [{ edge, node: byId.get(edge.to)! }];
    if (edge.to === node.id && byId.has(edge.from)) return [{ edge, node: byId.get(edge.from)! }];
    return [];
  }), [byId, graph.edges, node.id]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-[rgb(var(--border-line))] p-4">
        <div className="mb-3 flex items-start gap-2.5">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md border"
            style={{ color: meta.color, background: meta.soft, borderColor: meta.border }}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-tiny text-text-quaternary">{t(`govern.graph.kind.${node.kind}`)}</div>
            <h3 className="break-words text-caption font-strong text-text-primary">{node.label}</h3>
          </div>
        </div>
        <button type="button" onClick={() => onOpen(node)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-surface-inverse px-2.5 text-tiny font-emphasis text-white hover:opacity-90">
          <ExternalLink className="h-3.5 w-3.5" />
          {t('govern.graph.openAsset')}
        </button>
      </div>

      {(node.status || node.owner || node.space || node.group) && (
        <dl className="divide-y divide-[rgb(var(--border-line))] px-4 text-caption">
          {node.status && <div className="flex justify-between gap-3 py-2.5"><dt className="text-text-tertiary">{t('govern.graph.status')}</dt><dd className="truncate text-text-primary">{node.status}</dd></div>}
          {node.owner && <div className="flex justify-between gap-3 py-2.5"><dt className="text-text-tertiary">{t('govern.graph.owner')}</dt><dd className="truncate text-text-primary">{node.owner}</dd></div>}
          {node.space && <div className="flex justify-between gap-3 py-2.5"><dt className="text-text-tertiary">{t('govern.graph.space')}</dt><dd className="truncate text-text-primary">{node.space}</dd></div>}
          {node.group && <div className="flex justify-between gap-3 py-2.5"><dt className="text-text-tertiary">{t('govern.graph.group')}</dt><dd className="truncate text-text-primary">{node.group}</dd></div>}
        </dl>
      )}

      {coverage && (
        <div className="border-t border-[rgb(var(--border-line))] p-4">
          <h4 className="mb-2 text-tiny font-strong uppercase text-text-quaternary">{t('govern.graph.coverage')}</h4>
          <div className="grid grid-cols-5 divide-x divide-[rgb(var(--border-line))] text-center">
            <Stat label={t('govern.graph.kind.doc')} value={coverage.docs} />
            <Stat label={t('govern.graph.kind.measure')} value={coverage.measures ?? 0} />
            <Stat label={t('govern.graph.kind.metric')} value={coverage.metrics} />
            <Stat label={t('govern.graph.kind.term')} value={coverage.terms} />
            <Stat label={t('govern.graph.kind.caveat')} value={coverage.caveats ?? 0} />
          </div>
        </div>
      )}

      <div className="border-t border-[rgb(var(--border-line))] p-3">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <h4 className="text-tiny font-strong uppercase text-text-quaternary">{t('govern.graph.connections')}</h4>
          <span className="text-tiny tabular-nums text-text-quaternary">{neighbours.length}</span>
        </div>
        {neighbours.length === 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-warning/40 bg-warning/5 p-2.5 text-tiny text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>{t('govern.graph.noConnections')}</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {neighbours.map(({ edge, node: neighbour }) => {
              const neighbourMeta = KIND_META[neighbour.kind];
              const NeighbourIcon = neighbourMeta.icon;
              return (
                <button key={`${edge.from}:${edge.to}:${edge.kind}`} type="button" onClick={() => onSelect(neighbour.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-surface-2">
                  <NeighbourIcon className="h-3.5 w-3.5 flex-none" style={{ color: neighbourMeta.color }} />
                  <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">{neighbour.label}</span>
                  <span className="flex-none text-[10px] text-text-quaternary">{t(`govern.graph.edge.${edge.kind}`)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function SystemKnowledgeGraph({
  query,
  onOpenDoc,
  onOpenMetric,
  onOpenVocab,
}: {
  query: string;
  onOpenDoc: (id: number) => void;
  onOpenMetric: (machineName: string) => void;
  onOpenVocab?: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<GraphMode>('all');
  const [kinds, setKinds] = useState<Set<KnowledgeNodeKind>>(() => new Set(KIND_ORDER));
  const [layers, setLayers] = useState<Set<EdgeLayer>>(() => new Set(['physical', 'semantic', 'knowledge']));
  const instanceRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);

  useEffect(() => {
    let active = true;
    governGraph()
      .then((payload) => { if (active) setGraph(payload); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  const facts = useMemo(() => graph ? graphFacts(graph) : null, [graph]);
  const layout = useMemo(() => graph && facts ? networkLayout(graph, facts.degree) : new Map(), [facts, graph]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchedIds = useMemo(() => {
    if (!graph || normalizedQuery.length < 2) return new Set<string>();
    return new Set(graph.nodes
      .filter((node) => `${node.label} ${node.ref} ${node.space ?? ''} ${node.group ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
      .map((node) => node.id));
  }, [graph, normalizedQuery]);

  const visibleIds = useMemo(() => {
    if (!graph || !facts) return new Set<string>();
    return new Set(graph.nodes.filter((node) => {
      if (!kinds.has(node.kind)) return false;
      if (mode === 'connected' && (facts.degree.get(node.id) ?? 0) === 0) return false;
      if (mode === 'gaps' && !facts.gaps.has(node.id)) return false;
      return true;
    }).map((node) => node.id));
  }, [facts, graph, kinds, mode]);

  useEffect(() => {
    if (selectedId && !visibleIds.has(selectedId)) setSelectedId(null);
  }, [selectedId, visibleIds]);

  const selectedNeighbours = useMemo(() => {
    const ids = new Set<string>();
    if (!graph || !selectedId) return ids;
    ids.add(selectedId);
    graph.edges.forEach((edge) => {
      if (edge.from === selectedId) ids.add(edge.to);
      if (edge.to === selectedId) ids.add(edge.from);
    });
    return ids;
  }, [graph, selectedId]);

  const canvasNodes = useMemo<CanvasNode[]>(() => {
    if (!graph || !facts) return [];
    return graph.nodes.map((source) => {
      const position = layout.get(source.id) ?? { x: 0, y: 0 };
      const degree = facts.degree.get(source.id) ?? 0;
      const dimmedBySelection = selectedId != null && !selectedNeighbours.has(source.id);
      const dimmedBySearch = matchedIds.size > 0 && !matchedIds.has(source.id);
      return {
        id: source.id,
        type: 'knowledge',
        position: { x: position.x, y: position.y },
        hidden: !visibleIds.has(source.id),
        selected: source.id === selectedId,
        draggable: false,
        selectable: true,
        focusable: true,
        ariaLabel: `${t(`govern.graph.kind.${source.kind}`)}: ${source.label}`,
        data: {
          source,
          degree,
          gap: facts.gaps.has(source.id),
          dimmed: dimmedBySelection || dimmedBySearch,
          matched: matchedIds.has(source.id),
          showLabel: degree >= 3,
        },
      };
    });
  }, [facts, graph, layout, matchedIds, selectedId, selectedNeighbours, t, visibleIds]);

  const canvasEdges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    return graph.edges.map((edge, index) => {
      const layer: EdgeLayer = edge.kind === 'reads'
        ? 'physical'
        : (edge.kind === 'defined_in' || edge.kind === 'realized_by')
          ? 'semantic'
          : 'knowledge';
      const incident = selectedId == null || edge.from === selectedId || edge.to === selectedId;
      return {
        id: `${edge.from}:${edge.to}:${edge.kind}:${index}`,
        source: edge.from,
        target: edge.to,
        hidden: !layers.has(layer) || !visibleIds.has(edge.from) || !visibleIds.has(edge.to),
        focusable: true,
        ariaLabel: t(`govern.graph.edge.${edge.kind}`),
        style: {
          stroke: EDGE_COLOR[edge.kind],
          strokeWidth: incident ? 1.8 : 1,
          opacity: incident ? (edge.kind === 'reads' ? 0.42 : 0.7) : 0.07,
          strokeDasharray: edge.kind === 'reads' ? undefined : '5 4',
        },
      };
    });
  }, [graph, layers, selectedId, t, visibleIds]);

  useEffect(() => {
    if (!instanceRef.current || matchedIds.size === 0) return;
    const targets = canvasNodes.filter((node) => matchedIds.has(node.id) && !node.hidden);
    if (targets.length > 0) instanceRef.current.fitView({ nodes: targets, padding: 0.35, duration: 350, maxZoom: 1.35 });
  }, [canvasNodes, matchedIds]);

  const counts = useMemo(() => {
    const out = new Map<KnowledgeNodeKind, number>(KIND_ORDER.map((kind) => [kind, 0]));
    graph?.nodes.forEach((node) => out.set(node.kind, (out.get(node.kind) ?? 0) + 1));
    return out;
  }, [graph]);

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
    const node = canvasNodes.find((item) => item.id === id);
    if (node && instanceRef.current) {
      instanceRef.current.setCenter(node.position.x + 22, node.position.y + 22, { zoom: 1.05, duration: 300 });
    }
  }, [canvasNodes]);

  const toggleKind = (kind: KnowledgeNodeKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind) && next.size > 1) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };
  const toggleLayer = (layer: EdgeLayer) => {
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  };
  const openNode = (node: KnowledgeGraphNode) => {
    if (node.kind === 'doc') onOpenDoc(Number(node.ref));
    else if (node.kind === 'metric') onOpenMetric(node.ref);
    else if (node.kind === 'term' || node.kind === 'caveat') onOpenVocab?.();
    else if (node.kind === 'measure' && node.dataset_id) router.push(`/datasets/${node.dataset_id}?tab=model`);
    else router.push(node.kind === 'dashboard' ? `/dashboards/${node.ref}` : `/datasets/${node.ref}`);
  };

  if (!graph && !failed) return <div className="py-16 text-center text-caption text-text-tertiary">{t('govern.loading')}</div>;
  if (failed) return <div className="py-16 text-center text-caption text-danger">{t('govern.graph.loadFailed')}</div>;
  if (!graph || graph.nodes.length === 0) return (
    <div className="border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-16 text-center">
      <Network className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
      <p className="text-caption text-text-tertiary">{t('govern.graph.emptyGlobal')}</p>
    </div>
  );

  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;
  return (
    <section className="overflow-hidden border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="flex flex-wrap items-center border-b border-[rgb(var(--border-line))] bg-surface-1 py-2">
        <div className="grid grid-cols-2 divide-x divide-[rgb(var(--border-line))] sm:grid-cols-4">
          <Stat label={t('govern.graph.nodes')} value={graph.nodes.length} />
          <Stat label={t('govern.graph.connections')} value={graph.edges.length} />
          <Stat label={t('govern.graph.knowledgeConnections')} value={graph.totals.knowledge_edges} />
          <Stat label={t('govern.graph.gaps')} value={facts?.gaps.size ?? 0} warning />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 px-3 py-1">
          {KIND_ORDER.map((kind) => (
            <KindToggle key={kind} kind={kind} count={counts.get(kind) ?? 0} active={kinds.has(kind)}
              onClick={() => toggleKind(kind)} label={t(`govern.graph.kind.${kind}`)} />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
        <div className="inline-flex rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-0.5">
          {(['all', 'connected', 'gaps'] as GraphMode[]).map((item) => (
            <button key={item} type="button" onClick={() => setMode(item)}
              className={cn('h-6 rounded px-2 text-tiny', mode === item ? 'bg-surface-inverse text-white' : 'text-text-tertiary hover:text-text-primary')}>
              {t(`govern.graph.mode.${item}`)}
            </button>
          ))}
        </div>
        <button type="button" aria-pressed={layers.has('physical')} onClick={() => toggleLayer('physical')}
          className={cn('inline-flex items-center gap-1.5 text-tiny', layers.has('physical') ? 'text-text-secondary' : 'text-text-quaternary')}>
          <span className="h-px w-5 bg-slate-400" />{t('govern.graph.physicalLayer')}
        </button>
        <button type="button" aria-pressed={layers.has('knowledge')} onClick={() => toggleLayer('knowledge')}
          className={cn('inline-flex items-center gap-1.5 text-tiny', layers.has('knowledge') ? 'text-text-secondary' : 'text-text-quaternary')}>
          <span className="w-5 border-t border-dashed border-brand" />{t('govern.graph.knowledgeLayer')}
        </button>
        <button type="button" aria-pressed={layers.has('semantic')} onClick={() => toggleLayer('semantic')}
          className={cn('inline-flex items-center gap-1.5 text-tiny', layers.has('semantic') ? 'text-text-secondary' : 'text-text-quaternary')}>
          <span className="h-px w-5 bg-sky-600" />{t('govern.graph.semanticLayer')}
        </button>
        {matchedIds.size > 0 && (
          <span className="ml-auto text-tiny tabular-nums text-text-tertiary">{t('govern.graph.matches', { count: matchedIds.size })}</span>
        )}
      </div>

      <div className="grid min-h-[560px] lg:h-[68vh] lg:max-h-[760px] lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="knowledge-network relative h-[560px] min-w-0 bg-surface-0 lg:h-full">
          <ReactFlow<CanvasNode, Edge>
            nodes={canvasNodes}
            edges={canvasEdges}
            nodeTypes={NODE_TYPES}
            onInit={(instance) => { instanceRef.current = instance; }}
            onNodeClick={(_, node) => selectNode(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.16, maxZoom: 0.9 }}
            minZoom={0.16}
            maxZoom={1.8}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            panOnScroll
            selectionOnDrag={false}
            autoPanOnNodeFocus
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d7dce4" />
            <Controls showInteractive={false} fitViewOptions={{ padding: 0.16, maxZoom: 0.9 }} />
            <MiniMap<CanvasNode>
              className="!hidden !border !border-[rgb(var(--border-line))] !bg-white/95 md:!block"
              pannable
              zoomable
              nodeColor={(node) => KIND_META[node.data.source.kind].color}
              nodeStrokeWidth={2}
              maskColor="rgba(247, 248, 248, 0.72)"
            />
          </ReactFlow>
        </div>
        <aside className="min-h-0 border-t border-[rgb(var(--border-line))] bg-surface-1 lg:border-l lg:border-t-0">
          {selected ? (
            <NodeInspector graph={graph} node={selected} onSelect={selectNode} onOpen={openNode} />
          ) : (
            <EmptyInspector graph={graph} onSelect={selectNode} />
          )}
        </aside>
      </div>
    </section>
  );
}

export default SystemKnowledgeGraph;
