'use client';

/**
 * Vector connectors for the canvas.
 *
 * WHY MEASURE INSTEAD OF DRAWING BORDERS
 * --------------------------------------
 * CSS pseudo-element lines can only connect things that are already adjacent in the
 * layout, so every branch needed its own bar, its own stub and its own set of
 * offsets — and the moment a card grew a line taller, the joins drifted. Here the
 * TREE says what connects to what and the DOM says where those things are; the path
 * is derived from both, so a node changing height moves its edges with it.
 *
 * The edge list is built from the same walk the canvas renders, so a connector can
 * never describe a shape the canvas is not showing.
 */
import React from 'react';

import type { FlowNode } from '@/lib/agentFlows';
import type { MiniRect } from './Minimap';

export type EdgeKind = 'line' | 'split' | 'merge';

export interface EdgeSpec {
  kind: EdgeKind;
  from: string[];
  to: string[];
  /** An insert button the line passes through, so the "+" sits ON the edge rather
   *  than beside it. */
  via?: string;
}

/** One element the router needs the position of. Ids are stable and structural:
 *  `n:<key>` a node card, `r:<node>:<lane>` a branch rule card,
 *  `box:<key>` a loop container, `i:<container>:<index>` an insert button. */
export const idNode = (key: string) => `n:${key}`;
export const idRule = (node: string, lane: string) => `r:${node}:${lane}`;
export const idBox = (key: string) => `box:${key}`;
export const idInsert = (containerPath: string, index: number) => `i:${containerPath}:${index}`;

interface Block { entry: string; exits: string[] }

/** Walk the tree, emitting the connectors the canvas will need. */
export function buildEdges(nodes: FlowNode[]): EdgeSpec[] {
  const edges: EdgeSpec[] = [];

  const joinTo = (exits: string[], entry: string, via?: string) => {
    if (!exits.length) return;
    if (exits.length === 1) edges.push({ kind: 'line', from: exits, to: [entry], via });
    else edges.push({ kind: 'merge', from: exits, to: [entry] });
  };

  const layoutBody = (body: FlowNode[], containerPath: string): Block | null => {
    if (!body?.length) return null;
    const blocks = body.map((n) => layoutNode(n));
    for (let i = 1; i < blocks.length; i += 1) {
      joinTo(blocks[i - 1].exits, blocks[i].entry, idInsert(containerPath, i));
    }
    return { entry: blocks[0].entry, exits: blocks[blocks.length - 1].exits };
  };

  const layoutNode = (n: FlowNode): Block => {
    if (n.type === 'if' || n.type === 'switch' || n.type === 'coordinate') {
      // A COORDINATOR'S LANES NEED THE SAME WIRES AS A SWITCH'S.
      //
      // `FlowCanvas` learned to DRAW the lanes and this did not learn to CONNECT
      // them, so the specialists rendered as two cards floating either side of a
      // line that ran straight past them — the picture said the flow ignores them,
      // which is the opposite of what the node does. The lanes and the edges are
      // computed in two places, and adding a branching node means teaching both.
      const lanes = n.type === 'coordinate'
        ? [
            ...(n.specialists || []).map((s) => ({
              key: s.key, body: s.body || [], path: `${n.key}:specialist:${s.key}`,
            })),
            ...((n.fallback || []).length
              ? [{ key: 'fallback', body: n.fallback || [], path: `${n.key}:fallback:` }]
              : []),
          ]
        : n.type === 'if'
        ? n.paths.map((p) => ({ key: p.key, body: p.body || [], path: `${n.key}:path:${p.key}` }))
        : [
            ...n.cases.map((c) => ({ key: c.key, body: c.body || [], path: `${n.key}:case:${c.key}` })),
            ...(n.has_fallback !== false
              ? [{ key: 'fallback', body: n.fallback || [], path: `${n.key}:fallback:` }]
              : []),
          ];
      const ruleIds = lanes.map((l) => idRule(n.key, l.key));
      if (ruleIds.length) edges.push({ kind: 'split', from: [idNode(n.key)], to: ruleIds });

      const exits: string[] = [];
      lanes.forEach((lane, i) => {
        const inner = layoutBody(lane.body, lane.path);
        if (inner) {
          edges.push({ kind: 'line', from: [ruleIds[i]], to: [inner.entry] });
          exits.push(...inner.exits);
        } else {
          // An empty lane still has to reach the merge, or the branch looks severed.
          exits.push(ruleIds[i]);
        }
      });
      return { entry: idNode(n.key), exits };
    }

    if (n.type === 'loop') {
      const box = idBox(n.key);
      edges.push({ kind: 'line', from: [idNode(n.key)], to: [box] });
      const inner = layoutBody(n.body || [], `${n.key}:body:`);
      if (inner) edges.push({ kind: 'line', from: [box], to: [inner.entry] });
      return { entry: idNode(n.key), exits: [box] };
    }

    return { entry: idNode(n.key), exits: [idNode(n.key)] };
  };

  const root = layoutBody(nodes, '');
  if (root) {
    edges.push({ kind: 'line', from: ['input'], to: [root.entry] });
    joinTo(root.exits, 'output', idInsert('', nodes.length));
  }
  return edges;
}

interface Rect { left: number; right: number; top: number; bottom: number; cx: number; cy: number }

/**
 * Measure the registered elements and turn the edge specs into SVG paths.
 *
 * Re-measured on anything that can move a card: the tree changing, the window
 * resizing, the inspector being dragged, the canvas zooming. A ResizeObserver on
 * the stage catches the rest (a prompt growing two lines taller is a layout change
 * nothing else reports).
 */
export function useFlowEdges(
  nodes: FlowNode[],
  zoom: number,
  deps: unknown[] = [],
): {
  register: (id: string) => (el: HTMLElement | null) => void;
  paths: { d: string; key: string }[];
  junctions: { x: number; y: number; key: string }[];
  /** Every measured card as a fraction of the stage — the minimap's whole input.
   *  Derived from the same measurement as the edges, so the map cannot disagree
   *  with the canvas it is a map of. */
  rects: MiniRect[];
  size: { w: number; h: number };
  stageRef: React.RefObject<HTMLDivElement>;
  remeasure: () => void;
} {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const els = React.useRef<Record<string, HTMLElement | null>>({});
  const [paths, setPaths] = React.useState<{ d: string; key: string }[]>([]);
  const [junctions, setJunctions] = React.useState<{ x: number; y: number; key: string }[]>([]);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const [rects, setRects] = React.useState<MiniRect[]>([]);

  const register = React.useCallback(
    (id: string) => (el: HTMLElement | null) => { els.current[id] = el; },
    [],
  );

  const specs = React.useMemo(() => buildEdges(nodes), [nodes]);

  const measure = React.useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const sr = stage.getBoundingClientRect();

    const rect = (id: string): Rect | null => {
      const el = els.current[id];
      if (!el || !el.isConnected) return null;
      const r = el.getBoundingClientRect();
      // Divided by zoom because the stage is CSS-scaled: the browser reports
      // rendered pixels, and the SVG draws in the stage's own coordinates.
      return {
        left: (r.left - sr.left) / zoom,
        right: (r.right - sr.left) / zoom,
        top: (r.top - sr.top) / zoom,
        bottom: (r.bottom - sr.top) / zoom,
        cx: (r.left + r.width / 2 - sr.left) / zoom,
        cy: (r.top + r.height / 2 - sr.top) / zoom,
      };
    };

    const out: { d: string; key: string }[] = [];
    const dots: { x: number; y: number; key: string }[] = [];
    const RAD = 8;

    /** Vertical, or an orthogonal dog-leg with rounded bends when the x differs. */
    const orth = (ax: number, ay: number, bx: number, by: number, midY?: number) => {
      if (Math.abs(ax - bx) < 1) return `M ${ax} ${ay} L ${bx} ${by}`;
      const dir = bx > ax ? 1 : -1;
      const m = Math.max(ay + 10, Math.min(by - 10, midY ?? (ay + by) / 2));
      return `M ${ax} ${ay} L ${ax} ${m - RAD} Q ${ax} ${m} ${ax + dir * RAD} ${m} `
        + `L ${bx - dir * RAD} ${m} Q ${bx} ${m} ${bx} ${m + RAD} L ${bx} ${by}`;
    };

    specs.forEach((spec, i) => {
      if (spec.kind === 'line') {
        const a = rect(spec.from[0]);
        const b = rect(spec.to[0]);
        if (!a || !b) return;
        const plus = spec.via ? rect(spec.via) : null;
        if (plus) {
          // Two segments so the "+" sits ON the line rather than covering it.
          out.push({ key: `e${i}a`, d: orth(a.cx, a.bottom, plus.cx, plus.top) });
          out.push({ key: `e${i}b`, d: orth(plus.cx, plus.bottom, b.cx, b.top) });
        } else {
          out.push({ key: `e${i}`, d: orth(a.cx, a.bottom, b.cx, b.top) });
        }
        return;
      }

      if (spec.kind === 'split') {
        const a = rect(spec.from[0]);
        const targets = spec.to.map(rect).filter(Boolean) as Rect[];
        if (!a || !targets.length) return;
        const y = a.bottom + 26;
        out.push({ key: `e${i}s`, d: `M ${a.cx} ${a.bottom} L ${a.cx} ${y}` });
        const xs = targets.map((t) => t.cx);
        out.push({ key: `e${i}bar`, d: `M ${Math.min(...xs)} ${y} L ${Math.max(...xs)} ${y}` });
        targets.forEach((t, k) => out.push({ key: `e${i}t${k}`, d: `M ${t.cx} ${y} L ${t.cx} ${t.top}` }));
        dots.push({ x: a.cx, y, key: `j${i}` });
        return;
      }

      // merge
      const sources = spec.from.map(rect).filter(Boolean) as Rect[];
      const b = rect(spec.to[0]);
      if (!sources.length || !b) return;
      const y = Math.max(...sources.map((s) => s.bottom)) + 28;
      sources.forEach((s, k) => out.push({ key: `e${i}m${k}`, d: `M ${s.cx} ${s.bottom} L ${s.cx} ${y}` }));
      const xs = sources.map((s) => s.cx);
      const min = Math.min(...xs);
      const max = Math.max(...xs);
      out.push({ key: `e${i}mbar`, d: `M ${min} ${y} L ${max} ${y}` });
      out.push({ key: `e${i}mdown`, d: orth((min + max) / 2, y, b.cx, b.top, y + 12) });
      dots.push({ x: (min + max) / 2, y, key: `jm${i}` });
    });

    const w = stage.offsetWidth || 1;
    const h = stage.scrollHeight || 1;
    const mini: MiniRect[] = [];
    Object.entries(els.current).forEach(([id, el]) => {
      if (!el || !el.isConnected || id.startsWith('i:')) return;
      const r = rect(id);
      if (!r) return;
      mini.push({
        key: id,
        x: r.left / w, y: r.top / h,
        w: (r.right - r.left) / w, h: (r.bottom - r.top) / h,
        kind: id.startsWith('r:') ? 'rule'
          : id.startsWith('box:') ? 'box'
          : (id === 'input' || id === 'output') ? 'system' : 'node',
      });
    });

    setPaths(out);
    setJunctions(dots);
    setRects(mini);
    setSize({ w, h });
  }, [specs, zoom]);

  React.useLayoutEffect(() => {
    measure();
    // A second pass on the next frame: fonts and wrapped text settle after the
    // first layout, and edges measured before that land a few pixels short.
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(stage);
    Array.from(stage.querySelectorAll('[data-edge-id]')).forEach((el) => ro.observe(el));
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure, nodes]);

  return { register, paths, junctions, rects, size, stageRef, remeasure: measure };
}
