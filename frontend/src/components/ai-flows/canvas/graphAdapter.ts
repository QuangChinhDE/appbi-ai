/**
 * Translate between the stored flow graph and React Flow's nodes/edges.
 *
 * The stored shape is what the RUNTIME executes; React Flow's shape is what the
 * canvas draws. Keeping the translation in one file means the builder can never
 * quietly invent a structure the engine does not understand — every edge the
 * user drags becomes a `next` / `routes[key]` / `on_success` on the way out.
 */
import dagre from 'dagre';
import type { Edge, Node } from '@xyflow/react';

import type { FlowGraph, FlowNode, Palette, ValidationError } from '@/lib/aiFlows';
import type { FlowNodeData } from './FlowNodeCard';
import { themeFor } from './nodeTheme';

export const NODE_W = 248;
export const NODE_H = 132;

/** Which named outputs a node type exposes, given its current config. */
export function outputsFor(key: string, node: FlowNode): { id: string; label: string }[] {
  if (node.type === 'end') return [];
  if (node.type === 'route') {
    return Object.keys(node.routes ?? {}).map((r) => ({ id: `route:${r}`, label: r }));
  }
  if (node.type === 'condition' || node.type === 'function' || node.type === 'verify') {
    return [
      { id: 'on_success', label: 'đạt' },
      { id: 'on_failure', label: 'lỗi' },
    ];
  }
  if (node.type === 'parallel') {
    return (node.branches ?? []).map((_, i) => ({
      id: `branch:${i}`, label: `nhánh ${i + 1}`,
    }));
  }
  return [];
}

function summaryFor(node: FlowNode, palette: Palette | null): string[] {
  const out: string[] = [];
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case 'agent':
      if (node.agent) out.push(node.agent);
      if (node.tools?.length) out.push(`${node.tools.length} công cụ`);
      break;
    case 'legacy':
      out.push(`Độ sâu: ${cfg.mode ?? 'auto'}`);
      break;
    case 'tool':
      if (node.tool) {
        const t = palette?.tools.find((x) => x.name === node.tool);
        out.push(t?.label_vi ?? node.tool);
      }
      break;
    case 'function':
    case 'verify': {
      const h = node.handler ?? (node.type === 'verify' ? 'verify_claims' : null);
      if (h) {
        const spec = palette?.handlers.find((x) => x.name === h);
        out.push(spec?.label_vi ?? h);
      }
      break;
    }
    case 'context': {
      const sources = (cfg.sources as string[]) ?? [];
      out.push(`${sources.length || 'mặc định'} nguồn tri thức`);
      if (cfg.max_tokens) out.push(`tối đa ${cfg.max_tokens} token`);
      break;
    }
    case 'route':
      out.push(`${Object.keys(node.routes ?? {}).length} nhánh`);
      break;
    case 'condition':
      if (node.when) out.push(node.when);
      break;
    case 'parallel':
      out.push(`${(node.branches ?? []).length} nhánh song song`);
      if (node.reducer) out.push(`gộp: ${node.reducer}`);
      break;
    case 'clarify':
      out.push('Dừng và hỏi lại người dùng');
      break;
    default:
      break;
  }
  const writes = (cfg.writable_state_fields as string[]) ?? [];
  if (writes.length) out.push(`ghi: ${writes.join(', ')}`);
  return out;
}

export interface ToRfOptions {
  graph: FlowGraph;
  palette: Palette | null;
  issues: ValidationError[];
  previewStates?: Record<string, { status: string; latencyMs?: number; usd?: number }>;
  readOnly?: boolean;
  onMenu?: (nodeKey: string, el: HTMLElement) => void;
}

export function toReactFlow({
  graph, palette, issues, previewStates, readOnly, onMenu,
}: ToRfOptions): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const typeLabel = (t: string) =>
    palette?.node_types.find((n) => n.type === t)?.label_vi ?? t;

  const byNode: Record<string, ValidationError[]> = {};
  issues.forEach((i) => {
    if (i.node_key) (byNode[i.node_key] ??= []).push(i);
  });

  // Auto-place anything without a saved position so a graph authored elsewhere
  // (an import, a seeded template) still opens readable rather than stacked.
  const positioned = autoLayout(graph, { onlyMissing: true });

  const nodes: Node<FlowNodeData>[] = Object.entries(graph.nodes).map(([key, node]) => {
    const mine = byNode[key] ?? [];
    const errs = mine.filter((i) => i.severity === 'error');
    const warns = mine.filter((i) => i.severity === 'warning');
    const pv = previewStates?.[key];
    return {
      id: key,
      type: 'flowCard',
      position: positioned[key] ?? { x: 0, y: 0 },
      draggable: !readOnly,
      data: {
        nodeKey: key,
        type: node.type,
        label: node.display_name || key,
        typeLabel: typeLabel(node.type),
        summary: summaryFor(node, palette),
        outputs: outputsFor(key, node),
        errorCount: errs.length,
        warningCount: warns.length,
        firstIssue: (errs[0] ?? warns[0])?.message,
        disabled: node.disabled,
        isEntry: graph.entrypoint === key,
        previewStatus: pv?.status as FlowNodeData['previewStatus'],
        previewLatencyMs: pv?.latencyMs,
        previewUsd: pv?.usd,
        readOnly,
        onMenu,
      },
    };
  });

  const edges: Edge[] = [];
  const push = (
    source: string, target: string, handle: string | undefined,
    label: string | undefined, tone: 'normal' | 'branch' | 'failure',
  ) => {
    if (!target || !graph.nodes[target]) return;
    const stroke =
      tone === 'failure' ? '#E77713' : tone === 'branch' ? '#7047D7' : '#98A2B3';
    edges.push({
      id: `${source}:${handle ?? 'next'}->${target}`,
      source,
      target,
      sourceHandle: handle,
      label,
      type: 'smoothstep',
      animated: false,
      markerEnd: { type: 'arrowclosed', color: stroke } as never,
      style: {
        stroke,
        strokeWidth: 1.6,
        strokeDasharray: tone === 'failure' ? '5 3' : undefined,
      },
      labelStyle: { fontSize: 10, fill: '#475467' },
      labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
      labelBgPadding: [3, 1] as [number, number],
    });
  };

  Object.entries(graph.nodes).forEach(([key, node]) => {
    if (node.type === 'route') {
      Object.entries(node.routes ?? {}).forEach(([intent, target]) =>
        push(key, target, `route:${intent}`, intent, 'branch'));
      if (node.next) push(key, node.next, undefined, undefined, 'normal');
      return;
    }
    if (node.type === 'parallel') {
      (node.branches ?? []).forEach((target, i) =>
        push(key, target, `branch:${i}`, `nhánh ${i + 1}`, 'branch'));
      if (node.next) push(key, node.next, undefined, 'gộp', 'normal');
      return;
    }
    if (node.on_success || node.on_failure) {
      if (node.on_success) push(key, node.on_success, 'on_success', 'đạt', 'normal');
      if (node.on_failure) push(key, node.on_failure, 'on_failure', 'lỗi', 'failure');
      return;
    }
    if (node.next) push(key, node.next, undefined, undefined, 'normal');
  });

  return { nodes, edges };
}

/** Apply a canvas connection back onto the stored graph shape. */
export function applyConnection(
  graph: FlowGraph, source: string, target: string, sourceHandle?: string | null,
): FlowGraph {
  const next = structuredClone(graph);
  const node = next.nodes[source];
  if (!node) return graph;

  if (sourceHandle?.startsWith('route:')) {
    const intent = sourceHandle.slice('route:'.length);
    node.routes = { ...(node.routes ?? {}), [intent]: target };
  } else if (sourceHandle?.startsWith('branch:')) {
    const idx = Number(sourceHandle.slice('branch:'.length));
    const branches = [...(node.branches ?? [])];
    branches[idx] = target;
    node.branches = branches;
  } else if (sourceHandle === 'on_success') {
    node.on_success = target;
  } else if (sourceHandle === 'on_failure') {
    node.on_failure = target;
  } else {
    node.next = target;
  }
  return next;
}

/** Remove whatever edge a canvas edge id represents. */
export function removeConnection(graph: FlowGraph, edgeId: string): FlowGraph {
  const [left, target] = edgeId.split('->');
  const [source, handle] = left.split(':').length > 2
    ? [left.split(':')[0], left.slice(left.indexOf(':') + 1)]
    : left.split(':');
  const next = structuredClone(graph);
  const node = next.nodes[source];
  if (!node) return graph;

  if (handle?.startsWith('route:')) {
    const intent = handle.slice('route:'.length);
    const routes = { ...(node.routes ?? {}) };
    delete routes[intent];
    node.routes = routes;
  } else if (handle?.startsWith('branch:')) {
    const idx = Number(handle.slice('branch:'.length));
    node.branches = (node.branches ?? []).filter((_, i) => i !== idx);
  } else if (handle === 'on_success') {
    node.on_success = null;
  } else if (handle === 'on_failure') {
    node.on_failure = null;
  } else if (node.next === target) {
    node.next = null;
  }
  return next;
}

/**
 * Left-to-right layered layout.
 *
 * `onlyMissing` is the default for load: an author who arranged their canvas
 * must find it unchanged. A full re-layout only happens when they ask for it.
 */
export function autoLayout(
  graph: FlowGraph, opts: { onlyMissing?: boolean } = {},
): Record<string, { x: number; y: number }> {
  const existing: Record<string, { x: number; y: number }> = {};
  Object.entries(graph.nodes).forEach(([k, n]) => {
    if (n.position) existing[k] = { x: n.position.x, y: n.position.y };
  });
  if (opts.onlyMissing && Object.keys(existing).length === Object.keys(graph.nodes).length) {
    return existing;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 96, marginx: 32, marginy: 32 });
  g.setDefaultEdgeLabel(() => ({}));
  Object.keys(graph.nodes).forEach((k) => g.setNode(k, { width: NODE_W, height: NODE_H }));
  Object.entries(graph.nodes).forEach(([k, n]) => {
    const targets = [
      n.next, n.on_success, n.on_failure,
      ...Object.values(n.routes ?? {}), ...(n.branches ?? []),
    ].filter((t): t is string => !!t && !!graph.nodes[t]);
    Array.from(new Set(targets)).forEach((t) => g.setEdge(k, t));
  });
  dagre.layout(g);

  const out: Record<string, { x: number; y: number }> = {};
  Object.keys(graph.nodes).forEach((k) => {
    if (opts.onlyMissing && existing[k]) {
      out[k] = existing[k];
      return;
    }
    const n = g.node(k);
    out[k] = n
      ? { x: Math.round(n.x - NODE_W / 2), y: Math.round(n.y - NODE_H / 2) }
      : { x: 0, y: 0 };
  });
  return out;
}

/** Write canvas positions back into the graph so they persist with the draft. */
export function withPositions(
  graph: FlowGraph, positions: Record<string, { x: number; y: number }>,
): FlowGraph {
  const next = structuredClone(graph);
  Object.entries(positions).forEach(([k, p]) => {
    if (next.nodes[k]) next.nodes[k].position = { x: Math.round(p.x), y: Math.round(p.y) };
  });
  return next;
}

/** A fresh node of the given type, with the defaults that make it valid-ish. */
export function blankNode(type: string, label: string): FlowNode {
  const base: FlowNode = { type, display_name: label, config: {} };
  switch (type) {
    case 'agent':
      return { ...base, agent: null, tools: [], config: { writable_state_fields: ['answer'] } };
    case 'legacy':
      return {
        ...base,
        config: { mode: 'auto', writable_state_fields: ['answer', 'usd', 'tool_calls', 'model_calls'] },
      };
    case 'function':
      return { ...base, handler: 'noop', on_success: null, on_failure: null };
    case 'verify':
      return {
        ...base, handler: 'verify_claims', on_success: null, on_failure: null,
        config: { writable_state_fields: ['verification'], on_fail: 'flag' },
      };
    case 'condition':
      return { ...base, when: 'intent == lookup', on_success: null, on_failure: null };
    case 'context':
      return { ...base, config: { sources: ['metric', 'caveat', 'verified_qa'], max_tokens: 2000 } };
    case 'route':
      return { ...base, routes: { '*': '' } };
    case 'parallel':
      return { ...base, branches: [], reducer: 'merge_findings' };
    case 'clarify':
      return { ...base, config: { question_template: '', resume_node: null } };
    case 'end':
      return { type: 'end', display_name: label };
    default:
      return base;
  }
}
