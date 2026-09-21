/**
 * Undo/redo for the flow body.
 *
 * UNDO IS A STACK OF WHOLE BODIES, not a log of operations. A tree edit can touch
 * several places at once — dragging a branch moves a whole subtree, deleting an IF
 * takes its lanes with it — and an inverse-operation log has to be right about
 * every one of those. Snapshots are bigger and always correct, and a flow is a few
 * kilobytes.
 *
 * Extracted from `BrainBuilder` unchanged. It was four pieces of state and three
 * callbacks threaded through a 1,100-line component, and it is the one concern in
 * there with an invariant worth stating in one place: every tree edit goes through
 * `mutate`, so every tree edit is undoable.
 *
 * The stacks are refs and a counter forces the re-render, which is deliberate: the
 * buttons' disabled state reads `past.length`, and putting the stacks in state
 * would re-render the whole canvas on every snapshot.
 */
import React from 'react';

import type { FlowBody } from '@/lib/agentFlows';

/** How many snapshots back an author can go. Fifty is not a memory limit — a flow
 *  is kilobytes — it is the point past which "undo" stops being a thing anyone
 *  reasons about. */
const DEPTH = 49;

export interface FlowHistory {
  /** The only way a tree edit reaches the body. */
  mutate: (nodes: FlowNode[]) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

type FlowNode = FlowBody['nodes'][number];

export function useFlowHistory(
  setBody: React.Dispatch<React.SetStateAction<FlowBody>>,
  setDirty: (v: boolean) => void,
): FlowHistory {
  const past = React.useRef<FlowBody[]>([]);
  const future = React.useRef<FlowBody[]>([]);
  const [, tick] = React.useState(0);

  const mutate = React.useCallback((nodes: FlowNode[]) => {
    setBody((b) => {
      past.current = [...past.current.slice(-DEPTH), b];
      future.current = [];
      return { ...b, nodes };
    });
    setDirty(true);
    tick((n) => n + 1);
  }, [setBody, setDirty]);

  const undo = React.useCallback(() => {
    setBody((b) => {
      const prev = past.current.pop();
      if (!prev) return b;
      future.current = [...future.current, b];
      return prev;
    });
    setDirty(true);
    tick((n) => n + 1);
  }, [setBody, setDirty]);

  const redo = React.useCallback(() => {
    setBody((b) => {
      const next = future.current.pop();
      if (!next) return b;
      past.current = [...past.current, b];
      return next;
    });
    setDirty(true);
    tick((n) => n + 1);
  }, [setBody, setDirty]);

  return {
    mutate,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
