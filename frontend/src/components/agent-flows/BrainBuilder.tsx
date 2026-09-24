'use client';

/**
 * The flow bench: canvas on the left, one node's settings on the right, and the two
 * other things an author needs about a live flow — what it did (Runs) and who
 * changed it (Hoạt động) — as peers of the design surface rather than modals.
 *
 * SAVING NO LONGER MINTS A VERSION.
 * Editing writes to the open draft. The version number in the title bar stays put
 * while you work, and only Publish moves what viewers get. The previous build cut a
 * new version on every save: twenty prompt edits, twenty rows, and a version number
 * that changed under the author's hands.
 *
 * VALIDITY IS CHECKED WITHOUT SAVING.
 * The badge in the sub-bar comes from `POST /validate`, so "is this flow sound"
 * stopped being a question you could only answer by committing to the answer.
 */
import {
  AlertTriangle, ArrowLeft, Check, LayoutDashboard, Loader2, Maximize2,
  MessagesSquare, Minus, Play, Plus, Puzzle, Redo2, Save, Send, Trash2, Undo2, X,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FlowActivation } from './FlowActivation';
import React from 'react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  blankNode, branchCoverage, brainImpact, canDropInto, findNode, getBrain, insertNode,
  isBranching, isContainer,
  listAttachable, listNodeSpecs, listProviders, listSkills, listToolPacks, moveNode,
  publishBrain, removeNode,
  replaceNode, saveBrain, setFlowType, validateFlow, walkNodes,
  type FlowBody, type FlowLinkUsage, type FlowNode, type FlowPath, type FlowType,
  type InsertTarget,
  type Attachable, type NodeSpec, type NodeType, type ProviderGroup,
  type SkillContract, type SkillInput, type SkillSummary,
  type Specialist, type SwitchCase, type ToolPack, type ToolSpec,
  type ValidateResult,
} from '@/lib/agentFlows';

import { ActivityTab } from './ActivityTab';
import { FlowCanvas } from './FlowCanvas';
import { NodeInspector } from './NodeInspector';
import { NodeLibrary } from './NodeLibrary';
import { Minimap, type MiniRect } from './Minimap';
import { FeedbackTab } from './FeedbackTab';
import { RunsTab } from './RunsTab';
import { TestChat } from './TestChat';
import { StatusBadge } from './shared';


type Mode = 'design' | 'runs' | 'feedback' | 'activity';

import { useFlowHistory } from './builder/useFlowHistory';
import { useInspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX } from './builder/useInspectorWidth';

export function BrainBuilder({
  brainKey, onBack, canEdit, canPublish,
}: {
  brainKey: string; onBack: () => void; canEdit: boolean; canPublish: boolean;
}) {
  const { t, language } = useI18n();
  // The open tab is addressable too, for the same reason the open flow is: a run
  // worth showing somebody is on the Runs tab, and a link that lands on Design
  // makes the reader hunt for it again. `replace` rather than `push` so flipping
  // tabs does not fill the Back button with steps nobody wants to retrace —
  // Back should leave the flow, which is what opening it pushed.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams?.get('tab');
  const mode: Mode = (rawTab === 'runs' || rawTab === 'feedback' || rawTab === 'activity')
    ? rawTab : 'design';
  /** Move to a tab, optionally carrying what to open there.
   *
   *  One helper rather than a URLSearchParams dance per call site: the test panel,
   *  the feedback list and the tab strip all navigate, and three hand-rolled copies
   *  is how one of them ends up forgetting to clear a stale `run=`. */
  const goTab = React.useCallback((next: Mode, extra?: Record<string, string>) => {
    const q = new URLSearchParams(searchParams?.toString() || '');
    if (next === 'design') q.delete('tab'); else q.set('tab', next);
    // Landing on a tab means landing on ONE thing there. Whatever the previous
    // visit had open is not what was just asked for.
    q.delete('run');
    q.delete('conversation');
    for (const [k, v] of Object.entries(extra || {})) q.set(k, v);
    router.replace(`${pathname}?${q.toString()}`);
  }, [router, pathname, searchParams]);
  const setMode = React.useCallback((next: Mode) => goTab(next), [goTab]);
  const openRun = React.useCallback(
    (runId: number) => goTab('runs', { run: String(runId) }), [goTab],
  );
  /** Runs -> the node that produced a trace step, open in the Builder.
   *
   *  Closes the debugging loop: an author reading "which step went wrong" had to
   *  find that node again by eye. Built on `goTab` and the existing `selected`
   *  state rather than a second navigation model — the only new thing is one URL
   *  parameter. */
  const openNodeInBuilder = React.useCallback(
    (nodeKey: string) => goTab('design', { node: nodeKey }), [goTab],
  );
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  // UNSAVED WORK IS NEVER DROPPED SILENTLY. Every way out of the builder asks
  // first while there are edits: the back arrow, a reload or tab close
  // (`beforeunload`, the pattern workboard settings use), and any in-app link —
  // the sidebar is a client-side navigation `beforeunload` never sees, so a
  // capture-phase click guard asks before the router moves.
  const dirtyRef = React.useRef(false);
  dirtyRef.current = dirty;
  const confirmLeave = React.useCallback(
    () => !dirtyRef.current || window.confirm(t('agentFlows.builder.leaveUnsaved')), [t],
  );
  React.useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(t('agentFlows.builder.leaveUnsaved'))) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, t]);
  const leave = React.useCallback(() => { if (confirmLeave()) onBack(); }, [confirmLeave, onBack]);

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [version, setVersion] = React.useState(0);
  const [status, setStatus] = React.useState<'draft' | 'published' | 'archived'>('draft');
  const [publishedVersion, setPublishedVersion] = React.useState<number | null>(null);
  const [body, setBody] = React.useState<FlowBody>({ nodes: [] });

  const [specs, setSpecs] = React.useState<Record<string, NodeSpec>>({});
  const [specList, setSpecList] = React.useState<NodeSpec[]>([]);
  const [toolPacks, setToolPacks] = React.useState<ToolPack[]>([]);
  /** Flattened tool catalogue, so the canvas can name a Tool step.
   *
   *  Derived from the packs already loaded for the inspector rather than fetched
   *  again — one request, one source, and no window in which the card and the
   *  panel beside it disagree about what a tool is called. */
  const toolSpecsByName = React.useMemo(() => {
    const out: Record<string, ToolSpec> = {};
    for (const pack of toolPacks) for (const tool of pack.tools) out[tool.name] = tool;
    return out;
  }, [toolPacks]);
  const [providers, setProviders] = React.useState<ProviderGroup[]>([]);
  // What this author may point a step at. Null until it arrives, so the picker
  // can say "loading" rather than "nothing to attach" — the two look identical
  // in an empty dropdown and mean opposite things.
  const [attachable, setAttachable] = React.useState<Attachable | null>(null);
  /** Published Skills this author may attach — server-side, like `attachable`. */
  const [skills, setSkills] = React.useState<SkillSummary[]>([]);
  // RUN COUNTS per node, not question coverage. Two different product
  // concepts were both called `coverage`: this one counts how often a branch
  // ran, and the one on the Test tab is which question CLASSES the flow can
  // answer. A reader of either screen had to know which was meant.
  const [runCounts, setRunCounts] = React.useState<Record<string, number>>({});

  const [selected, setSelected] = React.useState<string | null>(null);
  // ?node=<key> selects it, once. Consumed rather than kept: leaving it in the URL
  // would fight every later click, and a stale parameter re-selecting a node on
  // refresh is the kind of ghost that gets blamed on the canvas.
  const nodeParam = searchParams?.get('node') || '';
  React.useEffect(() => {
    if (!nodeParam) return;
    setSelected(nodeParam);
    const q = new URLSearchParams(searchParams?.toString() || '');
    q.delete('node');
    router.replace(q.toString() ? `${pathname}?${q.toString()}` : pathname);
  }, [nodeParam, router, pathname, searchParams]);
  const [insertAt, setInsertAt] = React.useState<InsertTarget | null>(null);
  const [validation, setValidation] = React.useState<ValidateResult | null>(null);
  // Which surface this flow was built for. Held here rather than read off `detail`
  // each render because changing it is a round trip that can be REFUSED, and the
  // header must not show the new value until the server has accepted it.
  const [flowType, setType] = React.useState<FlowType>('bot');
  const [typeOpen, setTypeOpen] = React.useState(false);
  const [typeBusy, setTypeBusy] = React.useState(false);

  // Undo/redo lives in `useFlowHistory`, with the snapshot-not-oplog reasoning
  // that goes with it. `mutate` is still the only way a tree edit reaches the
  // body, which is what makes every tree edit undoable.
  const { mutate, undo, redo, canUndo, canRedo } = useFlowHistory(setBody, setDirty);

  const [zoom, setZoom] = React.useState(1);
  const [miniRects, setMiniRects] = React.useState<MiniRect[]>([]);
  const [viewport, setViewport] = React.useState({ top: 0, height: 1 });
  const canvasRef = React.useRef<HTMLElement | null>(null);

  const inspector = useInspectorWidth();
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [links, setLinks] = React.useState<FlowLinkUsage[]>([]);
  const [testOpen, setTestOpen] = React.useState(false);

  // ── load ──────────────────────────────────────────────────────────────────
  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [detail, nodeSpecs, packs, provs] = await Promise.all([
        getBrain(brainKey), listNodeSpecs(), listToolPacks(true), listProviders(),
      ]);
      // Fetched separately and non-blocking: a slow governance query must not
      // hold up opening the flow, and a step with nothing attached still works.
      listAttachable().then(setAttachable).catch(() => setAttachable(null));
      listSkills().then(setSkills).catch(() => setSkills([]));
      setName(detail.name);
      setDescription(detail.description || '');
      setVersion(detail.version);
      setStatus(detail.status);
      setPublishedVersion(detail.published_version ?? null);
      setType(detail.flow_type ?? 'bot');
      setBody(detail.body || { nodes: [] });
      setSpecList(nodeSpecs);
      setSpecs(Object.fromEntries(nodeSpecs.map((s) => [s.type, s])));
      setToolPacks(packs);
      setProviders(provs);
      setDirty(false);
      brainImpact(brainKey).then((i) => setLinks(i.links)).catch(() => undefined);
      branchCoverage(brainKey).then(setRunCounts).catch(() => undefined);
    } catch {
      toast.error(t('agentFlows.builder.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [brainKey, t]);

  React.useEffect(() => { load(); }, [load]);

  // Validate as the author works. Debounced, and never writes anything — the whole
  // point is that checking does not commit.
  React.useEffect(() => {
    if (!body.nodes.length) { setValidation(null); return; }
    const t = setTimeout(() => {
      // The type goes with it: the same flow is sound on one surface and broken on
      // the other, so a check that does not know which one is being built cannot
      // answer the question the badge is asking.
      validateFlow({ brain_key: brainKey, name: name || brainKey, body, flow_type: flowType })
        .then(setValidation)
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [body, brainKey, name, flowType]);

  /** Change which surface this flow is for.
   *
   *  The server is the one that decides — it re-reads the PUBLISHED shape and it
   *  refuses while the flow is still assigned to report links, neither of which
   *  the builder can see from the draft in front of it. So the local value only
   *  moves after the call returns, and a refusal is shown verbatim: the server's
   *  sentence names the links or the steps, and a generic "không đổi được" would
   *  throw that away.
   */
  const applyType = React.useCallback(async (next: FlowType, contract?: SkillContract) => {
    setTypeBusy(true);
    try {
      if (next === 'skill' && contract) {
        const nextBody = { ...body, skill: contract };
        const detail = await saveBrain({ brain_key: brainKey, name, description, body: nextBody });
        setVersion(detail.version);
        setStatus(detail.status);
        setBody(detail.body);
        setDirty(false);
      }
      if (next !== flowType) await setFlowType(brainKey, next);
      setType(next);
      setTypeOpen(false);
      toast.success(t('agentFlows.builder.type.changed'));
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(detail || t('agentFlows.builder.type.changeFailed'));
    } finally {
      setTypeBusy(false);
    }
  }, [body, brainKey, description, flowType, name, t]);

  // ── tree edits ────────────────────────────────────────────────────────────

  // Declared before the keyboard effect that uses it: Alt+Arrow reorders through
  // exactly this function, so the drop path and the keyboard path cannot drift.
  const onMoveNode = React.useCallback((key: string, target: InsertTarget) => {
    const next = moveNode(body.nodes, key, target);
    if (next !== body.nodes) mutate(next);
  }, [body.nodes, mutate]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal Ctrl+Z from a field the author is typing in — the text field's
      // own undo is the one they mean there.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      // ROVING FOCUS ON THE CANVAS.
      //
      // Every node card used to be a tab stop, so reaching step 40 of a long flow
      // meant tabbing past thirty-nine of them. Only the SELECTED card is a tab
      // stop now, and the arrows move between cards from there — the pattern a
      // toolbar or a tree view uses, and the reason the minimap can stay a
      // pointer convenience rather than pretending to be keyboard-operable.
      //
      // Scoped to a focused node card: plain arrows anywhere else are scrolling,
      // and stealing them would be worse than the problem.
      const onCard = target?.closest?.('[data-node-button]') as HTMLElement | null;
      if (onCard && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const order = walkNodes(body.nodes).map((n) => n.key);
        const here = order.indexOf(onCard.getAttribute('data-node-button') || '');
        if (here < 0) return;

        // ALT MOVES THE STEP; the bare arrow moves the selection. Drag has no
        // keyboard equivalent otherwise, and claiming the canvas is operable
        // without one would be claiming support that does not exist.
        const key = onCard.getAttribute('data-node-button') || '';

        // ALT MOVES THE STEP; the bare arrow moves the selection. Drag has no
        // keyboard equivalent otherwise, and a canvas whose only way to reorder
        // is a pointer is not operable — saying it is would be worse than the
        // gap.
        //
        // BOUNDED TO REORDERING AMONG TOP-LEVEL SIBLINGS, deliberately. Moving a
        // step INTO or OUT OF a branch is a different decision — which lane, at
        // what depth — and guessing it from an arrow key would move steps
        // somewhere the author did not ask for. It goes through the same
        // `moveNode` a drop uses; there is no second mutation path.
        if (e.altKey) {
          e.preventDefault();
          const top = body.nodes.findIndex((n) => n.key === key);
          if (top < 0) return;                     // nested: drag it, for now
          const to = top + (e.key === 'ArrowDown' ? 1 : -1);
          if (to < 0 || to >= body.nodes.length) return;
          onMoveNode(key, { containerPath: '', index: e.key === 'ArrowDown' ? to + 1 : to });
          // Same reason: focus follows the step that moved, immediately, so a
          // second Alt+Arrow keeps moving the same step.
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(`[data-node-button="${key}"]`)?.focus();
          });
          return;
        }

        e.preventDefault();
        const next = order[here + (e.key === 'ArrowDown' ? 1 : -1)];
        if (!next) return;
        setSelected(next);
        // FOCUS MOVES NOW, not on the next frame. Deferring it dropped keys held
        // down: the press after this one landed on a card that had just stopped
        // being the tab stop, so focus fell to the body and the rest of the run
        // went nowhere. Every card is rendered, so the element already exists;
        // only the scroll needs to wait for layout.
        const el = document.querySelector<HTMLElement>(`[data-node-button="${next}"]`);
        el?.focus();
        window.requestAnimationFrame(() => el?.scrollIntoView({ block: 'nearest' }));
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, body.nodes, onMoveNode]);

  const onInsert = (target: InsertTarget) => setInsertAt(target);

  const addNode = (type: NodeType) => {
    if (!insertAt) return;
    const node = blankNode(type, body.nodes, {
      agentPrompt: t('agentFlows.defaults.agentPrompt'),
      pathA: t('agentFlows.defaults.pathA'),
      pathB: t('agentFlows.defaults.pathB'),
    });
    mutate(insertNode(body.nodes, insertAt, node));
    setInsertAt(null);
    setSelected(node.key);
  };

  const dropGuard = React.useCallback(
    (key: string, containerPath: string) => canDropInto(body.nodes, key, containerPath),
    [body.nodes],
  );

  const stepZoom = (delta: number) =>
    setZoom((z) => Math.round(Math.max(0.5, Math.min(1.3, z + delta)) * 100) / 100);

  // Returns the SAME object when nothing moved. Without that, every measurement
  // produced a fresh `{top, height}`, React re-rendered, the canvas re-reported its
  // layout, and the two bounced off each other forever.
  const syncViewport = React.useCallback(() => {
    const el = canvasRef.current;
    if (!el || !el.scrollHeight) return;
    const next = {
      top: el.scrollTop / el.scrollHeight,
      height: Math.min(1, el.clientHeight / el.scrollHeight),
    };
    setViewport((prev) => (
      Math.abs(prev.top - next.top) < 0.001 && Math.abs(prev.height - next.height) < 0.001
        ? prev
        : next
    ));
  }, []);

  const handleLayout = React.useCallback((rects: MiniRect[]) => {
    setMiniRects(rects);
    syncViewport();
  }, [syncViewport]);

  const answerKey = body.answer_node || body.nodes[body.nodes.length - 1]?.key || '';

  // Selection is either a node key or a lane selector `node:group:key`.
  const sel = React.useMemo(() => {
    if (!selected) return { node: null as FlowNode | null };
    const [ownerKey, group, laneKey] = selected.split(':');
    if (!group) return { node: findNode(body.nodes, ownerKey) };
    const owner = findNode(body.nodes, ownerKey);
    if (owner?.type === 'if' && group === 'path') {
      return { owner, path: owner.paths.find((p) => p.key === laneKey) || null, node: null };
    }
    if (owner?.type === 'switch' && group === 'case') {
      return { owner, switchCase: owner.cases.find((c) => c.key === laneKey) || null, node: null };
    }
    if (owner?.type === 'switch' && group === 'fallback') {
      return { owner, isFallback: true, node: null };
    }
    if (owner?.type === 'coordinate' && group === 'specialist') {
      return {
        owner,
        specialist: (owner.specialists || []).find((s) => s.key === laneKey) || null,
        node: null,
      };
    }
    if (owner?.type === 'coordinate' && group === 'fallback') {
      return { owner, isFallback: true, node: null };
    }
    return { node: findNode(body.nodes, ownerKey) };
  }, [selected, body.nodes]) as {
    node: FlowNode | null; owner?: FlowNode; path?: FlowPath | null;
    switchCase?: SwitchCase | null; specialist?: Specialist | null;
    isFallback?: boolean;
  };

  const updateNode = (next: FlowNode) => mutate(replaceNode(body.nodes, next.key, next));

  const updatePath = (next: FlowPath) => {
    const owner = sel.owner;
    if (!owner || owner.type !== 'if') return;
    updateNode({ ...owner, paths: owner.paths.map((p) => (p.key === next.key ? next : p)) });
  };

  const updateCase = (next: SwitchCase) => {
    const owner = sel.owner;
    if (!owner || owner.type !== 'switch') return;
    updateNode({ ...owner, cases: owner.cases.map((c) => (c.key === next.key ? next : c)) });
  };

  const deleteSelected = () => {
    if (!sel.node) return;
    mutate(removeNode(body.nodes, sel.node.key));
    setSelected(null);
  };

  // ── save / publish ────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    try {
      const detail = await saveBrain({ brain_key: brainKey, name, description, body });
      setVersion(detail.version);
      setStatus(detail.status);
      setBody(detail.body);
      setDirty(false);
      toast.success(t('agentFlows.builder.savedDraft', { version: detail.version }));
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail || t('agentFlows.builder.saveFailed'));
    } finally { setSaving(false); }
  };

  const doPublish = async (acknowledgeProblems = false) => {
    setSaving(true);
    try {
      const res = await publishBrain(brainKey, version, acknowledgeProblems);
      setPublishOpen(false);
      setStatus('published');
      setPublishedVersion(version);
      const pinned = res.pinned_links || [];
      if (pinned.length) {
        // Not a failure. The links that would break are frozen at what they run
        // today, and saying which is the whole point of publishing being safe.
        toast.warning(
          t('agentFlows.builder.publishedPinned', { version, count: pinned.length }),
        );
      } else {
        toast.success(t('agentFlows.builder.published', { version }));
      }
      load();
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail || t('agentFlows.builder.publishFailed'));
    } finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
      </div>
    );
  }

  const all = walkNodes(body.nodes);
  const counts = {
    nodes: all.length,
    // A coordinator branches too — it just picks the lane with a model rather
    // than a condition. Left out, the chip under the title said "1 branch" for a
    // flow with three. Derived from the topology declaration now, so a fifteenth
    // branching type counts itself.
    branches: all.filter(isBranching).length,
    loops: all.filter((n) => isContainer(n) && !isBranching(n)).length,
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* topbar */}
      {/* THE HEADER SCROLLS; THE ACTIONS DO NOT.
          Measured at 1024×768 — a window size people genuinely build in — this row
          needed 1,104px inside a 958px container whose parent is `overflow-hidden`.
          Save draft and Publish were simply CUT OFF: not shrunk, not wrapped,
          gone, with nothing on screen to say a control existed. An author at that
          width could edit a flow and could not save it.

          Two changes, and only two. The row may scroll sideways, so nothing is
          ever unreachable; and the action cluster is pinned to the right edge, so
          the controls that matter most are the ones that never move. Shedding
          elements at breakpoints was the alternative and it is the wrong shape: it
          makes reachability depend on guessing every width in advance, which is
          how this row lost its buttons in the first place. */}
      <div className="flex h-11 flex-shrink-0 items-center gap-2 overflow-x-auto border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        {/* THE ARROW KEEPS ITS MEANING WITHOUT THE WORDS. At the declared 1280px
            minimum the row overflowed by ~124px even on a valid flow, and the
            tabs — navigation — scrolled under the sticky verdict group, leaving
            "Activity" unreachable at the width the product names as its floor.
            The label is the first thing on this row that costs width and carries
            no information the icon does not. */}
        <button type="button" onClick={leave} data-testid="builder-back" aria-label={t('agentFlows.title')}
          className="flex flex-shrink-0 items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" />
          {/* `2xl`, not `xl`: Tailwind's `xl` is min-width 1280, so it MATCHES at
              exactly 1280 — the label stayed visible at the one width that
              needed it gone, and the tabs stayed under the sticky group. */}
          <span className="hidden 2xl:inline">{t('agentFlows.title')}</span>
        </button>
        <span className="hidden text-text-quaternary 2xl:inline">/</span>
        <Input
          value={name}
          disabled={!canEdit}
          onChange={(e) => { setName(e.target.value); setDirty(true); }}
          // Narrower than it was: the row now carries the tabs too, and the name
          // is the one element that can give up width without losing meaning.
          // The 240px step moved from `xl` to `2xl` because Tailwind's `xl` is
          // min-width 1280 — it applied at exactly the declared minimum, and the
          // 90px it took was the whole of the header's overflow there, which put
          // the "Activity" tab under the sticky action group.
          className="h-7 w-[120px] flex-shrink-0 border-transparent bg-transparent px-1.5 text-caption font-medium hover:border-[rgb(var(--border-line))] lg:w-[150px] 2xl:w-[240px]"
        />
        <StatusBadge status={status} version={version} size="xs" />

        {/* WHAT THIS FLOW IS FOR, NEXT TO WHAT IT IS CALLED.
            It belongs in the identity cluster rather than beside the validity
            badge: the type is not a verdict on the flow, it is half of what the
            flow IS — it decides what the flow is handed, which picker lists it,
            and whether a "read the report" step makes sense at all. An author who
            cannot see it while building is the author who asks why their
            assistant never appears in Chat.

            It turns into a warning when the SHAPE has drifted out of the
            declaration, which is the one combination that silently produces a
            flow nobody can use. */}
        <FlowTypeChip
          flowType={flowType}
          blockers={validation?.chat_blockers ?? []}
          canEdit={canEdit}
          onOpen={() => setTypeOpen(true)}
        />

        {publishedVersion != null && publishedVersion !== version && (
          <span className="text-tiny text-text-tertiary">· {t('agentFlows.builder.runningVersion', { version: publishedVersion })}</span>
        )}
        {/* Pushed from `lg` to `2xl`: the type chip took the room, and of the two
            this is the one an author can also read on the Runs tab. Hidden entirely
            on a chat flow — "0 links" reads as "not deployed yet" on a flow that
            cannot have a link at all. */}
        {flowType === 'bot' && (
          <span className="hidden text-tiny text-text-tertiary 2xl:inline">· {links.length} {t(links.length === 1 ? 'agentFlows.common.link' : 'agentFlows.common.links')}</span>
        )}

        {/* TABS AND CHIPS LIVE ON THE HEADER ROW, not a second bar below it.
            Two stacked bars cost 40px of every screen beneath them, and the
            screens beneath them — the canvas and the run inspector — are the
            ones that need the height. The chips are the first thing dropped as
            the window narrows: they are context, while the tabs are navigation
            and the validation badge is a warning. */}
        {/* `order-last` below xl: when the row is tight the tabs move to the end,
            next to the sticky verdict group, so the thing that scrolls out of
            sight is the identity cluster — context — rather than navigation. */}
        <div className="ml-2 inline-flex flex-shrink-0 items-center gap-0.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          {([
            ['design', 'agentFlows.builder.tab.design'],
            ['runs', 'agentFlows.builder.tab.runs'],
            // Feedback sits next to Runs, not inside it: "what did it do" and "what
            // did people think of it" are separate questions, and burying the
            // second under a filter on the first is how it stayed unread.
            ['feedback', 'agentFlows.builder.tab.feedback'],
            ['activity', 'agentFlows.builder.tab.activity'],
          ] as const).map(([key, labelKey]) => (
            <button key={key} type="button" onClick={() => setMode(key as Mode)}
              className={cn('h-6 rounded-md px-2.5 text-caption font-medium transition',
                mode === key ? 'bg-surface-1 text-brand shadow-linear-sm' : 'text-text-tertiary')}>
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* SHOWN ONLY WHERE THERE IS ROOM FOR THEM.
            These chips are a glance at the flow's size, not a control, and at
            `xl` they did not fit: measured at 1440px the header overflowed by
            50px and the estimate chip — the one without `whitespace-nowrap` —
            absorbed the squeeze by wrapping into a four-line stack 64px tall,
            inside a 40px row. Hiding the group below 2xl makes the header fit
            exactly (measured: 50px of overflow to 0), and the nowrap below means
            it can never stack again if the row gets crowded another way. */}
        <div className="hidden items-center gap-1.5 2xl:flex">
          <Badge size="xs" variant="neutral">{counts.nodes} {t(counts.nodes === 1 ? 'agentFlows.common.step' : 'agentFlows.common.steps')}</Badge>
          {counts.branches > 0 && <Badge size="xs" variant="neutral">{counts.branches} {t(counts.branches === 1 ? 'agentFlows.common.branch' : 'agentFlows.common.branches')}</Badge>}
          {counts.loops > 0 && <Badge size="xs" variant="neutral">{counts.loops} loop</Badge>}
          {validation?.estimate && (
            <span
              title={t('agentFlows.builder.estimateTitle')}
              className="cursor-help whitespace-nowrap rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-px text-tiny text-text-tertiary"
            >
              ≤ {validation.estimate.max_llm_calls} {t('agentFlows.common.modelCallPerQuestion')}
            </span>
          )}
        </div>

        <div className="flex-1" />

        {/* Pinned to the right edge of the SCROLL PORT, not the row, so the verdict
            and the three buttons stay put while the identity and tabs scroll under
            them. `bg-surface-1` is required, not cosmetic: without it the scrolled
            row shows through. */}
        <div className="sticky right-0 flex flex-shrink-0 items-center gap-2 bg-surface-1 pl-2">
        {validation && (
          validation.ok
            ? (
              <Badge data-testid="flow-validity" size="xs" variant="success" dot>
                {t('agentFlows.builder.valid')}
              </Badge>
            )
            : (
              // BOUNDED. The verdict lives in the sticky right group, so a long
              // error — and validation messages name the step and the reason —
              // grew that group until it covered the tab strip, and "Activity"
              // became unreachable at 1280. The full sentence is still one hover
              // away, and the Design tab shows it in full beside the step.
              <Badge data-testid="flow-validity" size="xs" variant="danger" title={validation.errors[0] || ''}>
                <span className="block max-w-[200px] truncate 2xl:max-w-none">
                  {validation.errors[0] || t('agentFlows.builder.invalid')}
                </span>
              </Badge>
            )
        )}
        {!!validation?.warnings.length && (
          <span
            title={validation.warnings.join('\n\n')}
            className="flex cursor-help items-center gap-1 rounded-full border border-warning/25 bg-warning/5 px-2 py-px text-tiny text-warning"
          >
            <AlertTriangle className="h-3 w-3" /> {t('agentFlows.builder.warningCount', { count: validation.warnings.length })}
          </span>
        )}
        {dirty && (
          <span className="flex items-center gap-1.5 text-tiny font-medium text-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" /> {t('agentFlows.common.unsaved')}
          </span>
        )}
        {canEdit && (
          <div className="mr-1 flex items-center gap-0.5">
            <IconBtn onClick={undo} label={t('agentFlows.builder.undo')} disabled={!canUndo}>
              <Undo2 className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn onClick={redo} label={t('agentFlows.builder.redo')} disabled={!canRedo}>
              <Redo2 className="h-3.5 w-3.5" />
            </IconBtn>
          </div>
        )}
        <Button data-testid="builder-test" variant="secondary" size="xs" onClick={() => setTestOpen(true)}>
          <Play className="h-3 w-3" /> {t('agentFlows.builder.test')}
        </Button>
        {canEdit && (
          <Button data-testid="builder-save" variant="secondary" size="xs" onClick={save} loading={saving} disabled={!dirty}>
            <Save className="h-3 w-3" /> {t('agentFlows.builder.saveDraft')}
          </Button>
        )}
        {canPublish && (
          <Button data-testid="builder-publish" size="xs" onClick={() => setPublishOpen(true)} disabled={dirty}>
            <Send className="h-3 w-3" /> {t('agentFlows.builder.publish')}
          </Button>
        )}
        </div>
      </div>

      {/* WHERE IT ENDS UP, not just that it saved.
          Publish writes a version. It does NOT make the assistant reachable: a
          reader meets it only through a report's public link, configured on the
          dashboard. The builder used to say "· 1 link" in text that was not a
          link, not a button, and hidden below 2xl — so an author who had just
          published had no way to learn they were one step short, or where that
          step lives. The data was already fetched; only the answer was missing. */}
      {flowType === 'bot' && (
        <FlowActivation
          links={links}
          publishedVersion={publishedVersion}
          draftVersion={version}
        />
      )}

      {/* body */}
      <div className="relative min-h-0 flex-1">
        {mode === 'design' && (
          <div className="flex h-full">
            <main
              ref={(el) => { canvasRef.current = el; }}
              onScroll={syncViewport}
              className="relative min-w-0 flex-1 overflow-auto bg-[rgb(var(--surface-0))] [background-image:linear-gradient(rgb(var(--border-line)/.45)_1px,transparent_1px),linear-gradient(90deg,rgb(var(--border-line)/.45)_1px,transparent_1px)] [background-size:24px_24px]">
              <FlowCanvas
                nodes={body.nodes}
                specs={specs}
                toolSpecs={toolSpecsByName}
                selectedKey={selected}
                // The door into the roving list: with nothing selected the
                // FIRST step is the canvas's tab stop, so Tab reaches a step
                // and the arrows take it from there.
                focusKey={body.nodes[0]?.key ?? null}
                answerKey={answerKey}
                onSelect={setSelected}
                onInsert={onInsert}
                runCounts={runCounts}
                zoom={zoom}
                onMove={canEdit ? onMoveNode : undefined}
                canDropInto={dropGuard}
                onLayout={handleLayout}
              />

              {/* A POINTER CONVENIENCE, and marked as one. It drags to scroll and
                  has no keyboard operation; rather than bolt on a fake one, the
                  equivalent navigation lives on the canvas itself — arrows move
                  between steps from the selected card, which is reachable by
                  Tab. Announcing this to a screen reader would offer a control
                  that cannot be used. */}
              <div aria-hidden>
              <Minimap
                rects={miniRects.map((r) => ({ ...r, selected: r.key === `n:${selected}` }))}
                viewport={viewport}
                onJump={(f) => {
                  const el = canvasRef.current;
                  if (el) {
                    el.scrollTo({
                      top: f * el.scrollHeight - el.clientHeight / 2,
                      behavior: 'smooth',
                    });
                  }
                }}
              />
              </div>

              <div className="absolute bottom-4 left-4 z-30 flex items-center gap-0.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-0.5 shadow-linear-sm">
                <IconBtn onClick={() => stepZoom(-0.1)} label={t('agentFlows.builder.zoomOut')}>
                  <Minus className="h-3.5 w-3.5" />
                </IconBtn>
                <span className="w-11 text-center text-tiny tabular-nums text-text-tertiary">
                  {Math.round(zoom * 100)}%
                </span>
                <IconBtn onClick={() => stepZoom(0.1)} label={t('agentFlows.builder.zoomIn')}>
                  <Plus className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn onClick={() => setZoom(0.75)} label={t('agentFlows.builder.fit')}>
                  <Maximize2 className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            </main>
            {/* The grab handle sits in the gap, not inside either side, so neither
                the canvas nor the panel loses a column to it. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('agentFlows.builder.resizeInspector')}
              aria-valuenow={inspector.width}
              aria-valuemin={INSPECTOR_MIN}
              aria-valuemax={INSPECTOR_MAX}
              tabIndex={0}
              onPointerDown={inspector.onPointerDown}
              onKeyDown={inspector.onKeyDown}
              onDoubleClick={inspector.reset}
              title={t('agentFlows.builder.resizeInspector')}
              className="group relative w-1.5 flex-shrink-0 cursor-col-resize bg-[rgb(var(--border-line))] transition-colors hover:bg-brand focus:bg-brand focus:outline-none"
            >
              <span className="absolute inset-y-0 -left-1 -right-1" />
            </div>
            <aside
              style={{ width: inspector.width }}
              className="flex flex-shrink-0 flex-col overflow-hidden border-l border-[rgb(var(--border-line))] bg-surface-1"
            >
              <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-[rgb(var(--border-line))] px-3">
                <b className="truncate text-caption font-strong">
                  {sel.path ? t('agentFlows.builder.selection.branch', { name: sel.path.name || sel.path.key })
                    : sel.switchCase ? `${t('agentFlows.common.case')}: ${sel.switchCase.label || sel.switchCase.key}`
                    : sel.isFallback ? t('agentFlows.builder.selection.fallback')
                    : sel.node ? (sel.node.name
                      || (language === 'vi' ? specs[sel.node.type]?.label_vi : specs[sel.node.type]?.label_en)
                      || specs[sel.node.type]?.label_vi
                      || sel.node.key)
                    : t('agentFlows.builder.selection.none')}
                </b>
                <div className="flex-1" />
                {sel.node && canEdit && (
                  <Button variant="ghost" size="xs" onClick={deleteSelected}
                    className="text-danger hover:bg-danger/5">
                    {t('agentFlows.builder.deleteStep')}
                  </Button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <NodeInspector
                  node={sel.node}
                  path={sel.path}
                  switchCase={sel.switchCase}
                  isFallback={sel.isFallback}
                  spec={sel.node ? specs[sel.node.type] : undefined}
                  specs={specs}
                  toolPacks={toolPacks}
                  skills={skills}
                  providers={providers}
                  attachable={attachable}
                  isAnswerNode={sel.node?.key === answerKey}
                  brainKey={brainKey}
                  flowType={flowType}
                  onChange={updateNode}
                  onChangePath={updatePath}
                  onChangeCase={updateCase}
                  onDelete={deleteSelected}
                  onMakeAnswer={() => {
                    if (sel.node) { setBody((b) => ({ ...b, answer_node: sel.node!.key })); setDirty(true); }
                  }}
                />
              </div>
            </aside>
          </div>
        )}

        {mode === 'runs' && (
          <RunsTab brainKey={brainKey} onOpenNode={openNodeInBuilder} toolSpecs={toolSpecsByName} />
        )}
        {mode === 'feedback' && (
          <FeedbackTab
            brainKey={brainKey}
            onOpenRun={openRun}
            // Landing on the conversation rather than the turn, because a
            // complaint about turn five is not readable without turns one to four.
            onOpenConversation={(key) => goTab('runs', { conversation: key })}
          />
        )}
        {mode === 'activity' && <ActivityTab brainKey={brainKey} onReloaded={load} />}

        {insertAt && (
          <NodeLibrary
            specs={specList}
            positionLabel={insertAt.containerPath
              ? t('agentFlows.builder.position.inside', { name: insertAt.containerPath.split(':')[0] })
              : t('agentFlows.builder.position.root')}
            onPick={addNode}
            onClose={() => setInsertAt(null)}
          />
        )}
      </div>

      {publishOpen && (
        <PublishDialog
          version={version}
          flowType={flowType}
          links={links}
          problems={validation?.blocking_problems || []}
          onCancel={() => setPublishOpen(false)}
          onConfirm={doPublish}
          busy={saving}
        />
      )}

      {typeOpen && (
        <FlowTypeDialog
          current={flowType}
          contract={body.skill ?? null}
          blockers={validation?.chat_blockers ?? []}
          busy={typeBusy}
          onClose={() => setTypeOpen(false)}
          onPick={applyType}
        />
      )}

      {testOpen && (
        <TestChat
          brainKey={brainKey}
          brainName={name || brainKey}
          flowType={flowType}
          links={links}
          version={version}
          // Handed the live DRAFT, not the saved version: the branch you just added
          // is the one you want to try, and the panel reads the flow to offer its
          // branches as test targets.
          nodes={body.nodes}
          onOpenRun={(runId) => { setTestOpen(false); openRun(runId); }}
          onClose={() => setTestOpen(false)}
        />
      )}
    </div>
  );
}

/** Publishing changes every link at once, so the dialog names them.
 *  A link that would break is PINNED, not broken — stated up front so publishing
 *  stops being a thing authors avoid. */
function PublishDialog({
  version, flowType, links, problems, onCancel, onConfirm, busy,
}: {
  version: number; flowType: FlowType; links: FlowLinkUsage[];
  /** Defects the server will refuse on. Shown BEFORE the button: the check already
   *  existed and ran on every keystroke, and publishing was the one moment nobody
   *  consulted it — so a flow reading a variable no step writes went live and
   *  answered viewers from a prompt with a hole in it. */
  problems: string[];
  onCancel: () => void; onConfirm: (acknowledgeProblems?: boolean) => void; busy: boolean;
}) {
  const { t } = useI18n();
  const needsReview = links.filter((l) => l.status === 'needs_review');
  const [accepted, setAccepted] = React.useState(false);
  const blocked = problems.length > 0 && !accepted;
  return (
    <div data-testid="publish-dialog"
      className="absolute inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.22)]">
      <div className="w-[540px] rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="border-b border-[rgb(var(--border-line))] p-3.5">
          <b className="text-body font-strong">{t('agentFlows.publish.title', { version })}</b>
          <span className="mt-0.5 block text-caption text-text-tertiary">
            {t('agentFlows.publish.description', { count: links.length })}
          </span>
        </div>
        <div className="max-h-[320px] overflow-auto p-3.5">
          {links.map((l) => (
            <div key={l.binding_id}
              className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] py-2 text-caption first:border-t-0">
              <span className="min-w-0 flex-1 truncate">{l.link_name}</span>
              {l.pinned_version != null && (
                <Badge size="xs" variant="warning">{t('agentFlows.publish.pinned', { version: l.pinned_version })}</Badge>
              )}
              <Badge size="xs" variant={l.status === 'active' ? 'success' : l.status === 'broken' ? 'danger' : 'warning'}>
                {l.status === 'active'
                  ? t('agentFlows.publish.status.active')
                  : l.status === 'broken'
                    ? t('agentFlows.publish.status.broken')
                    : t('agentFlows.publish.status.needsReview')}
              </Badge>
            </div>
          ))}
          {!links.length && (
            <p className="py-4 text-center text-caption text-text-tertiary">
              {/* A chat flow has no links and is not waiting for one, so "no links
                  yet" would read as an unfinished setup. */}
              {t(flowType === 'chat'
                ? 'agentFlows.publish.chatOnly'
                : 'agentFlows.publish.noLinks')}
            </p>
          )}
          {!!problems.length && (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-2.5">
              <b className="block text-caption text-danger">
                {t('agentFlows.publish.problemsTitle')}
              </b>
              <ul className="mt-1.5 space-y-1">
                {problems.map((p, i) => (
                  <li key={i} className="text-caption leading-relaxed text-danger">• {p}</li>
                ))}
              </ul>
              <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-caption text-text-secondary">
                <input type="checkbox" className="mt-0.5" checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)} />
                <span>{t('agentFlows.publish.problemsAcknowledge')}</span>
              </label>
            </div>
          )}
          {!!needsReview.length && (
            <p className="mt-3 rounded-lg border border-warning/25 bg-warning/5 p-2.5 text-caption leading-relaxed text-warning">
              {t('agentFlows.publish.needsReviewPrefix', { count: needsReview.length })}{' '}
              <b>{t('agentFlows.publish.needsReviewPinned')}</b>{' '}
              {t('agentFlows.publish.needsReviewSuffix')}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[rgb(var(--border-line))] p-3">
          <Button variant="secondary" size="sm" onClick={onCancel}>{t('agentFlows.publish.cancel')}</Button>
          <Button data-testid="publish-confirm" size="sm" onClick={() => onConfirm(accepted)} loading={busy} disabled={blocked}>
            {t('agentFlows.builder.publish')}
          </Button>
        </div>
      </div>
    </div>
  );
}



/** A square icon button. Small enough that a label would double its width, so the
 *  name lives in the tooltip and in `aria-label` rather than nowhere. */
function IconBtn({
  onClick, label, disabled, children,
}: {
  onClick: () => void; label: string; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition',
        disabled ? 'cursor-default opacity-35' : 'hover:bg-surface-2 hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

/* ── which surface this flow is for ───────────────────────────────────────── */

const TYPE_ICON = { bot: LayoutDashboard, chat: MessagesSquare, skill: Puzzle } as const;

/** The header chip. States the type, and warns when the flow has drifted out of
 *  it — a chat flow that grew a report-reading step is still labelled Chat and can
 *  no longer be used there, and nothing else on the screen would say so. */
function FlowTypeChip({
  flowType, blockers, canEdit, onOpen,
}: {
  flowType: FlowType; blockers: string[]; canEdit: boolean; onOpen: () => void;
}) {
  const { t } = useI18n();
  const Icon = TYPE_ICON[flowType];
  const broken = flowType === 'chat' && blockers.length > 0;

  return (
    <button
      type="button"
      onClick={canEdit ? onOpen : undefined}
      disabled={!canEdit}
      aria-label={t('agentFlows.builder.type.' + flowType + '.chip')}
      title={broken ? blockers.join('\n\n') : t('agentFlows.builder.type.' + flowType + '.hint')}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-2 py-px text-tiny font-medium transition',
        broken
          ? 'border-warning/30 bg-warning/5 text-warning'
          : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary',
        canEdit ? 'hover:border-brand/40 hover:text-brand' : 'cursor-default',
      )}
    >
      {broken ? <AlertTriangle className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
      {/* The words go first when the row is tight. The icon differs per type and
          turns amber on drift, so the glance survives; `aria-label` carries the
          full name for anyone who is not glancing. */}
      <span className="hidden lg:inline">
        {t('agentFlows.builder.type.' + flowType + '.chip')}
      </span>
    </button>
  );
}

/** THE ONE SCREEN THAT EXPLAINS THE TWO SURFACES.
 *
 *  Both cards are always shown, each with a live verdict, because the question an
 *  author actually has is comparative — "which of these am I building" — and a
 *  dropdown of two labels answers a different, easier question. The Chat card
 *  carries its blockers inline, so "why can I not pick that" is answered where the
 *  picking happens rather than in a toast after a refusal.
 */
function FlowTypeDialog({
  current, contract, blockers, busy, onClose, onPick,
}: {
  current: FlowType;
  contract: SkillContract | null;
  blockers: string[];
  busy: boolean;
  onClose: () => void;
  onPick: (next: FlowType, contract?: SkillContract) => void;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = React.useState<FlowType>(current);
  /* A SKILL IS A PROMISE: what goes in, what comes out, when to reach for it.
   * Edited here, next to the choice that makes it a Skill, because the server
   * refuses a Skill without it and an agent is shown exactly these words. */
  const [draft, setDraft] = React.useState<SkillContract>(
    contract ?? { inputs: [{ name: 'question', type: 'text', required: true, description: '' }],
                  output: '', when_to_use: '' });
  const contractOk = draft.when_to_use.trim().length >= 12
    && draft.inputs.every((i) => /^[a-z][a-z0-9_]{0,39}$/.test(i.name));
  const contractChanged = JSON.stringify(draft) !== JSON.stringify(contract);
  const canApply = picked === 'skill'
    ? contractOk && (picked !== current || contractChanged)
    : picked !== current && !(picked === 'chat' && blockers.length > 0);

  return (
    <AppModalShell
      onClose={onClose}
      title={t('agentFlows.builder.type.dialogTitle')}
      description={t('agentFlows.builder.type.dialogDescription')}
      icon={<MessagesSquare className="h-4 w-4" />}
      maxWidthClass="max-w-lg"
      closeDisabled={busy}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            {t('agentFlows.list.create.cancel')}
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={!canApply}
            onClick={() => onPick(picked, picked === 'skill' ? draft : undefined)}
          >
            {t('agentFlows.builder.type.apply')}
          </Button>
        </div>
      )}
    >
      <div className="space-y-2">
        {(['bot', 'chat', 'skill'] as const).map((kind) => {
          const Icon = TYPE_ICON[kind];
          // A bot flow is never refused: a report hands a flow strictly more than
          // chat does, so anything that runs in Chat runs on a report.
          const stops = kind === 'chat' ? blockers : [];
          return (
            <button
              key={kind}
              type="button"
              onClick={() => setPicked(kind)}
              aria-pressed={picked === kind}
              className={cn(
                'block w-full rounded-lg border p-3 text-left transition',
                picked === kind
                  ? 'border-brand bg-brand/5'
                  : 'border-[rgb(var(--border-line))] hover:bg-surface-2',
              )}
            >
              <span className="flex items-center gap-1.5 text-caption font-strong">
                <Icon className="h-3.5 w-3.5 text-text-tertiary" />
                {t('agentFlows.list.create.type.' + kind + '.name')}
                {kind === current && (
                  <Badge size="xs" variant="neutral">{t('agentFlows.builder.type.currently')}</Badge>
                )}
              </span>
              <span className="mt-1 block text-tiny leading-snug text-text-tertiary">
                {t('agentFlows.list.create.type.' + kind + '.what')}
              </span>
              <span className="mt-1 block text-tiny leading-snug text-text-quaternary">
                {t('agentFlows.list.create.type.' + kind + '.gets')}
              </span>
              {stops.length > 0 && (
                <span className="mt-2 block rounded-md border border-warning/25 bg-warning/5 p-2 text-tiny leading-snug text-warning">
                  <span className="flex items-center gap-1 font-medium">
                    <AlertTriangle className="h-3 w-3" />
                    {t('agentFlows.builder.type.blockedHeading')}
                  </span>
                  <span className="mt-1 block">
                    {stops.map((r) => <span key={r} className="mt-0.5 block">· {r}</span>)}
                  </span>
                </span>
              )}
            </button>
          );
        })}
        {picked === 'skill' && (
          <SkillContractEditor value={draft} onChange={setDraft} />
        )}
      </div>
    </AppModalShell>
  );
}

/** The contract a Skill publishes. Inputs are the ONLY data that reaches a Skill,
 *  so each one is named here rather than inferred from the prompt. */
function SkillContractEditor({
  value, onChange,
}: { value: SkillContract; onChange: (v: SkillContract) => void }) {
  const { t } = useI18n();
  const setInput = (i: number, patch: Partial<SkillInput>) => onChange({
    ...value, inputs: value.inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)),
  });
  return (
    <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] p-3">
      <label className="block">
        <span className="text-caption font-strong">{t('agentFlows.builder.skill.whenToUse')}</span>
        <Textarea
          id="skill-when-to-use"
          rows={2}
          value={value.when_to_use}
          placeholder={t('agentFlows.builder.skill.whenToUsePlaceholder')}
          onChange={(e) => onChange({ ...value, when_to_use: e.target.value })} />
        <span className="mt-0.5 block text-tiny text-text-tertiary">{t('agentFlows.builder.skill.whenToUseHint')}</span>
      </label>
      <label className="block">
        <span className="text-caption font-strong">{t('agentFlows.builder.skill.output')}</span>
        <Input
          id="skill-output"
          value={value.output}
          placeholder={t('agentFlows.builder.skill.outputPlaceholder')}
          onChange={(e) => onChange({ ...value, output: e.target.value })} />
      </label>
      <div>
        <span className="text-caption font-strong">{t('agentFlows.builder.skill.inputs')}</span>
        <span className="block text-tiny text-text-tertiary">{t('agentFlows.builder.skill.inputsHint')}</span>
        <div className="mt-1 space-y-1.5">
          {value.inputs.map((inp, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                id={`skill-input-name-${i}`}
                className="h-8 w-32"
                value={inp.name}
                placeholder="ten_input"
                onChange={(e) => setInput(i, { name: e.target.value.trim() })} />
              <select
                id={`skill-input-type-${i}`}
                className="h-8 rounded-md border border-[rgb(var(--border-line))] bg-surface px-1 text-caption"
                value={inp.type}
                onChange={(e) => setInput(i, { type: e.target.value as SkillInput['type'] })}>
                {(['text', 'number', 'date', 'chart_ref'] as const).map((k) => (
                  <option key={k} value={k}>{t('agentFlows.builder.skill.type.' + k)}</option>
                ))}
              </select>
              <Input
                id={`skill-input-desc-${i}`}
                className="h-8 flex-1"
                value={inp.description || ''}
                placeholder={t('agentFlows.builder.skill.inputDescription')}
                onChange={(e) => setInput(i, { description: e.target.value })} />
              <label className="flex items-center gap-1 text-tiny text-text-tertiary">
                <input type="checkbox" checked={inp.required}
                  onChange={(e) => setInput(i, { required: e.target.checked })} />
                {t('agentFlows.builder.skill.required')}
              </label>
              <button type="button" aria-label={t('agentFlows.builder.skill.removeInput')}
                onClick={() => onChange({ ...value, inputs: value.inputs.filter((_, j) => j !== i) })}
                className="rounded p-1 text-text-tertiary hover:text-danger">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="xs" className="mt-1.5"
          onClick={() => onChange({ ...value, inputs: [...value.inputs,
            { name: '', type: 'text', required: false, description: '' }] })}>
          {t('agentFlows.builder.skill.addInput')}
        </Button>
      </div>
    </div>
  );
}
