'use client';

/**
 * The canvas.
 *
 * Everything that makes this a builder rather than a diagram lives here: drag a
 * step in from the palette, drag between ports to wire it, drop a step onto an
 * edge to splice it in, box-select, delete, and watch nodes light up during a
 * test run.
 *
 * Positions are the author's; the layout button is opt-in. Silently rearranging
 * someone's canvas on every load is how a builder stops feeling like theirs.
 */
import React, { useCallback, useMemo, useRef } from 'react';
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  addEdge, useReactFlow,
  type Connection, type Edge, type Node, type NodeChange, type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { FlowGraph, Palette, ValidationError } from '@/lib/aiFlows';
import { FlowNodeCard, type FlowNodeData } from './FlowNodeCard';
import {
  applyConnection, autoLayout, removeConnection, toReactFlow, withPositions,
} from './graphAdapter';
import { themeFor } from './nodeTheme';

const NODE_TYPES = { flowCard: FlowNodeCard };

export interface PreviewState {
  status: string;
  latencyMs?: number;
  usd?: number;
}

interface Props {
  graph: FlowGraph;
  palette: Palette | null;
  issues: ValidationError[];
  selected: string | null;
  previewStates?: Record<string, PreviewState>;
  readOnly?: boolean;
  focusNode?: string | null;
  onSelect: (nodeKey: string | null) => void;
  onSelectMany?: (keys: string[]) => void;
  onChange: (graph: FlowGraph) => void;
  onDropNode: (type: string, position: { x: number; y: number }, ontoEdge?: string) => void;
  onNodeMenu?: (nodeKey: string, el: HTMLElement) => void;
}

function CanvasInner({
  graph, palette, issues, selected, previewStates, readOnly, focusNode,
  onSelect, onSelectMany, onChange, onDropNode, onNodeMenu,
}: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();

  const { nodes, edges } = useMemo(
    () => toReactFlow({
      graph, palette, issues, previewStates, readOnly, onMenu: onNodeMenu,
    }),
    [graph, palette, issues, previewStates, readOnly, onNodeMenu],
  );

  const rfNodes = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selected })),
    [nodes, selected],
  );

  // Focus + zoom a node when the validation drawer asks for it. This is the
  // link that turns an error list into something actionable.
  React.useEffect(() => {
    if (!focusNode) return;
    const n = nodes.find((x) => x.id === focusNode);
    if (!n) return;
    rf.setCenter(n.position.x + 124, n.position.y + 66, { zoom: 1.1, duration: 400 });
  }, [focusNode, nodes, rf]);

  // Positions are persisted on drag STOP only. Writing them from
  // onNodesChange looks equivalent but is not: React Flow emits position
  // changes while it measures nodes on mount, which would rewrite the graph,
  // re-render the nodes, trigger another measure — an infinite loop
  // (React error #185).
  const handleNodeDragStop = useCallback((_: unknown, node: Node) => {
    if (readOnly) return;
    onChange(withPositions(graph, { [node.id]: node.position }));
  }, [graph, onChange, readOnly]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    if (readOnly) return;
    let removed: string[] = [];
    changes.forEach((c) => {
      if (c.type === 'remove') removed.push(c.id);
    });
    if (removed.length) {
      // Guard/End carry runtime guarantees; a delete gesture must not remove
      // them, and silently ignoring the gesture is clearer than an error toast.
      removed = removed.filter((k) => !['guard', 'end'].includes(graph.nodes[k]?.type ?? ''));
      if (removed.length) {
        const next = structuredClone(graph);
        removed.forEach((k) => {
          delete next.nodes[k];
          Object.values(next.nodes).forEach((n) => {
            if (n.next === k) n.next = null;
            if (n.on_success === k) n.on_success = null;
            if (n.on_failure === k) n.on_failure = null;
            if (n.routes) {
              Object.entries(n.routes).forEach(([r, t]) => {
                if (t === k) n.routes![r] = '';
              });
            }
            if (n.branches?.includes(k)) n.branches = n.branches.filter((b) => b !== k);
          });
        });
        onChange(next);
        onSelect(null);
      }
    }
  }, [graph, onChange, onSelect, readOnly]);

  const handleConnect = useCallback((c: Connection) => {
    if (readOnly || !c.source || !c.target) return;
    if (graph.nodes[c.source]?.type === 'end') return;   // End is terminal
    onChange(applyConnection(graph, c.source, c.target, c.sourceHandle));
  }, [graph, onChange, readOnly]);

  const handleEdgesDelete = useCallback((deleted: Edge[]) => {
    if (readOnly) return;
    let next = graph;
    deleted.forEach((e) => { next = removeConnection(next, e.id); });
    onChange(next);
  }, [graph, onChange, readOnly]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (readOnly) return;
    const type = event.dataTransfer.getData('application/appbi-node');
    if (!type) return;
    const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });

    // Dropping onto an edge splices the new step into that connection — the
    // fastest way to insert a Verify between an analyst and a composer.
    const target = event.target as HTMLElement;
    const edgeEl = target.closest('.react-flow__edge');
    const ontoEdge = edgeEl?.getAttribute('data-id') ?? undefined;
    onDropNode(type, position, ontoEdge);
  }, [onDropNode, readOnly, rf]);

  const handleSelectionChange = useCallback((p: OnSelectionChangeParams) => {
    const keys = p.nodes.map((n) => n.id);
    onSelectMany?.(keys);
    if (keys.length === 1) onSelect(keys[0]);
  }, [onSelect, onSelectMany]);

  return (
    <div ref={wrapper} className="h-full w-full">
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        onSelectionChange={handleSelectionChange}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        selectionOnDrag
        panOnScroll
        snapToGrid
        snapGrid={[16, 16]}
        minZoom={0.2}
        maxZoom={1.75}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        className="bg-[#F9FAFB]"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#D0D5DD" />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!rounded-lg !border !border-[#EAECF0] !bg-white !shadow-sm"
        />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          ariaLabel="flow minimap"
          style={{ width: 168, height: 112 }}
          maskColor="rgba(16,24,40,0.06)"
          className="!rounded-lg !border !border-[#EAECF0] !bg-white"
          nodeColor={(n) => {
            const d = n.data as FlowNodeData;
            const fam = themeFor(d?.type ?? '').family;
            return fam === 'agent' ? '#7047D7'
              : fam === 'data' ? '#0E9AA3'
              : fam === 'check' ? '#22A06B'
              : fam === 'control' ? '#E77713'
              : '#2459C4';
          }}
        />
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export { autoLayout };
