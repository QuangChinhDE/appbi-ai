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
  AlertTriangle, ArrowLeft, Check, Loader2, Maximize2, Minus, Play, Plus,
  Redo2, Save, Send, Undo2, X,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import React from 'react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  blankNode, branchCoverage, brainImpact, canDropInto, findNode, getBrain, insertNode,
  listAttachable, listNodeSpecs, listProviders, listToolPacks, moveNode,
  publishBrain, removeNode,
  listTestTargetReports, testFlowOnReport,
  type TestTargetReport, type ReportTestResult,
  replaceNode, saveBrain, testFlow, validateFlow, walkNodes,
  type FlowBody, type FlowLinkUsage, type FlowNode, type FlowPath, type InsertTarget,
  type Attachable, type NodeSpec, type NodeType, type ProviderGroup,
  type SwitchCase, type ToolPack,
  type ValidateResult,
} from '@/lib/agentFlows';

import { ActivityTab } from './ActivityTab';
import { FlowCanvas } from './FlowCanvas';
import { NodeInspector } from './NodeInspector';
import { NodeLibrary } from './NodeLibrary';
import { Minimap, type MiniRect } from './Minimap';
import { RunsTab } from './RunsTab';
import { StatusBadge } from './shared';

type Mode = 'design' | 'runs' | 'activity';

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
  const mode: Mode = (rawTab === 'runs' || rawTab === 'activity') ? rawTab : 'design';
  const setMode = React.useCallback((next: Mode) => {
    const q = new URLSearchParams(searchParams?.toString() || '');
    if (next === 'design') q.delete('tab'); else q.set('tab', next);
    router.replace(`${pathname}?${q.toString()}`);
  }, [router, pathname, searchParams]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [version, setVersion] = React.useState(0);
  const [status, setStatus] = React.useState<'draft' | 'published' | 'archived'>('draft');
  const [publishedVersion, setPublishedVersion] = React.useState<number | null>(null);
  const [body, setBody] = React.useState<FlowBody>({ nodes: [] });

  const [specs, setSpecs] = React.useState<Record<string, NodeSpec>>({});
  const [specList, setSpecList] = React.useState<NodeSpec[]>([]);
  const [toolPacks, setToolPacks] = React.useState<ToolPack[]>([]);
  const [providers, setProviders] = React.useState<ProviderGroup[]>([]);
  // What this author may point a step at. Null until it arrives, so the picker
  // can say "loading" rather than "nothing to attach" — the two look identical
  // in an empty dropdown and mean opposite things.
  const [attachable, setAttachable] = React.useState<Attachable | null>(null);
  const [coverage, setCoverage] = React.useState<Record<string, number>>({});

  const [selected, setSelected] = React.useState<string | null>(null);
  const [insertAt, setInsertAt] = React.useState<InsertTarget | null>(null);
  const [validation, setValidation] = React.useState<ValidateResult | null>(null);

  // UNDO IS A STACK OF WHOLE BODIES, not a log of operations.
  //
  // A tree edit can touch several places at once — dragging a branch moves a whole
  // subtree, deleting an IF takes its lanes with it — and an inverse-operation log
  // has to be right about every one of those. Snapshots are bigger and always
  // correct, and a flow is a few kilobytes.
  const past = React.useRef<FlowBody[]>([]);
  const future = React.useRef<FlowBody[]>([]);
  const [, setHistoryTick] = React.useState(0);

  const [zoom, setZoom] = React.useState(1);
  const [miniRects, setMiniRects] = React.useState<MiniRect[]>([]);
  const [viewport, setViewport] = React.useState({ top: 0, height: 1 });
  const canvasRef = React.useRef<HTMLElement | null>(null);

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
      setName(detail.name);
      setDescription(detail.description || '');
      setVersion(detail.version);
      setStatus(detail.status);
      setPublishedVersion(detail.published_version ?? null);
      setBody(detail.body || { nodes: [] });
      setSpecList(nodeSpecs);
      setSpecs(Object.fromEntries(nodeSpecs.map((s) => [s.type, s])));
      setToolPacks(packs);
      setProviders(provs);
      setDirty(false);
      brainImpact(brainKey).then((i) => setLinks(i.links)).catch(() => undefined);
      branchCoverage(brainKey).then(setCoverage).catch(() => undefined);
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
      validateFlow({ brain_key: brainKey, name: name || brainKey, body })
        .then(setValidation)
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [body, brainKey, name]);

  // ── tree edits ────────────────────────────────────────────────────────────
  /** Every tree edit goes through here, so every tree edit is undoable. */
  const mutate = (nodes: FlowNode[]) => {
    setBody((b) => {
      past.current = [...past.current.slice(-49), b];
      future.current = [];
      return { ...b, nodes };
    });
    setDirty(true);
    setHistoryTick((n) => n + 1);
  };

  const undo = React.useCallback(() => {
    setBody((b) => {
      const prev = past.current.pop();
      if (!prev) return b;
      future.current = [...future.current, b];
      return prev;
    });
    setDirty(true);
    setHistoryTick((n) => n + 1);
  }, []);

  const redo = React.useCallback(() => {
    setBody((b) => {
      const next = future.current.pop();
      if (!next) return b;
      past.current = [...past.current, b];
      return next;
    });
    setDirty(true);
    setHistoryTick((n) => n + 1);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal Ctrl+Z from a field the author is typing in — the text field's
      // own undo is the one they mean there.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

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

  const onMoveNode = (key: string, target: InsertTarget) => {
    const next = moveNode(body.nodes, key, target);
    if (next !== body.nodes) mutate(next);
  };

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
    return { node: findNode(body.nodes, ownerKey) };
  }, [selected, body.nodes]) as {
    node: FlowNode | null; owner?: FlowNode; path?: FlowPath | null;
    switchCase?: SwitchCase | null; isFallback?: boolean;
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
    branches: all.filter((n) => n.type === 'if' || n.type === 'switch').length,
    loops: all.filter((n) => n.type === 'loop').length,
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* topbar */}
      <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" /> {t('agentFlows.title')}
        </button>
        <span className="text-text-quaternary">/</span>
        <Input
          value={name}
          disabled={!canEdit}
          onChange={(e) => { setName(e.target.value); setDirty(true); }}
          // Narrower than it was: the row now carries the tabs too, and the name
          // is the one element that can give up width without losing meaning.
          className="h-7 w-[150px] flex-shrink border-transparent bg-transparent px-1.5 text-caption font-medium hover:border-[rgb(var(--border-line))] xl:w-[240px]"
        />
        <StatusBadge status={status} version={version} size="xs" />
        {publishedVersion != null && publishedVersion !== version && (
          <span className="text-tiny text-text-tertiary">· {t('agentFlows.builder.runningVersion', { version: publishedVersion })}</span>
        )}
        <span className="hidden text-tiny text-text-tertiary lg:inline">· {links.length} {t(links.length === 1 ? 'agentFlows.common.link' : 'agentFlows.common.links')}</span>

        {/* TABS AND CHIPS LIVE ON THE HEADER ROW, not a second bar below it.
            Two stacked bars cost 40px of every screen beneath them, and the
            screens beneath them — the canvas and the run inspector — are the
            ones that need the height. The chips are the first thing dropped as
            the window narrows: they are context, while the tabs are navigation
            and the validation badge is a warning. */}
        <div className="ml-2 inline-flex flex-shrink-0 items-center gap-0.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          {([
            ['design', 'agentFlows.builder.tab.design'],
            ['runs', 'agentFlows.builder.tab.runs'],
            ['activity', 'agentFlows.builder.tab.activity'],
          ] as const).map(([key, labelKey]) => (
            <button key={key} type="button" onClick={() => setMode(key as Mode)}
              className={cn('h-6 rounded-md px-2.5 text-caption font-medium transition',
                mode === key ? 'bg-surface-1 text-brand shadow-linear-sm' : 'text-text-tertiary')}>
              {t(labelKey)}
            </button>
          ))}
        </div>

        <div className="hidden items-center gap-1.5 xl:flex">
          <Badge size="xs" variant="neutral">{counts.nodes} {t(counts.nodes === 1 ? 'agentFlows.common.step' : 'agentFlows.common.steps')}</Badge>
          {counts.branches > 0 && <Badge size="xs" variant="neutral">{counts.branches} {t(counts.branches === 1 ? 'agentFlows.common.branch' : 'agentFlows.common.branches')}</Badge>}
          {counts.loops > 0 && <Badge size="xs" variant="neutral">{counts.loops} loop</Badge>}
          {validation?.estimate && (
            <span
              title={t('agentFlows.builder.estimateTitle')}
              className="cursor-help rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-px text-tiny text-text-tertiary"
            >
              ≤ {validation.estimate.max_llm_calls} {t('agentFlows.common.modelCallPerQuestion')}
            </span>
          )}
        </div>

        <div className="flex-1" />

        {validation && (
          validation.ok
            ? <Badge size="xs" variant="success" dot>{t('agentFlows.builder.valid')}</Badge>
            : <Badge size="xs" variant="danger">{validation.errors[0] || t('agentFlows.builder.invalid')}</Badge>
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
            <IconBtn onClick={undo} label={t('agentFlows.builder.undo')} disabled={!past.current.length}>
              <Undo2 className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn onClick={redo} label={t('agentFlows.builder.redo')} disabled={!future.current.length}>
              <Redo2 className="h-3.5 w-3.5" />
            </IconBtn>
          </div>
        )}
        <Button variant="secondary" size="xs" onClick={() => setTestOpen(true)}>
          <Play className="h-3 w-3" /> {t('agentFlows.builder.test')}
        </Button>
        {canEdit && (
          <Button variant="secondary" size="xs" onClick={save} loading={saving} disabled={!dirty}>
            <Save className="h-3 w-3" /> {t('agentFlows.builder.saveDraft')}
          </Button>
        )}
        {canPublish && (
          <Button size="xs" onClick={() => setPublishOpen(true)} disabled={dirty}>
            <Send className="h-3 w-3" /> {t('agentFlows.builder.publish')}
          </Button>
        )}
      </div>

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
                selectedKey={selected}
                answerKey={answerKey}
                onSelect={setSelected}
                onInsert={onInsert}
                coverage={coverage}
                zoom={zoom}
                onMove={canEdit ? onMoveNode : undefined}
                canDropInto={dropGuard}
                onLayout={handleLayout}
              />

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
            <aside className="flex w-[400px] flex-shrink-0 flex-col overflow-hidden border-l border-[rgb(var(--border-line))] bg-surface-1">
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
                  providers={providers}
                  attachable={attachable}
                  isAnswerNode={sel.node?.key === answerKey}
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

        {mode === 'runs' && <RunsTab brainKey={brainKey} />}
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
          links={links}
          problems={validation?.blocking_problems || []}
          onCancel={() => setPublishOpen(false)}
          onConfirm={doPublish}
          busy={saving}
        />
      )}

      {testOpen && (
        <TestDialog
          brainKey={brainKey}
          links={links}
          version={version}
          // The dialog reads the flow to offer its branches as test targets, so it
          // is handed the live draft rather than the saved version: the branch you
          // just added is the one you want to try.
          nodes={body.nodes}
          onOpenRun={(runId) => {
            setTestOpen(false);
            const q = new URLSearchParams(searchParams?.toString() || '');
            q.set('tab', 'runs');
            q.set('run', String(runId));
            router.replace(`${pathname}?${q.toString()}`);
          }}
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
  version, links, problems, onCancel, onConfirm, busy,
}: {
  version: number; links: FlowLinkUsage[];
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
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.22)]">
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
              {t('agentFlows.publish.noLinks')}
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
          <Button size="sm" onClick={() => onConfirm(accepted)} loading={busy} disabled={blocked}>
            {t('agentFlows.builder.publish')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One alternative a branching node can take, as something testable.
 *
 *  A flow's branches are the part authors get wrong, and they are invisible in a
 *  free-text test box: you type a question, read a plausible answer, and never
 *  learn that it came down the fallback lane. So the dialog reads the flow and
 *  offers its branches directly — with the label the RUNTIME will push onto the
 *  path, which is what makes the after-the-fact comparison exact rather than a
 *  guess at string matching.
 */
type BranchProbe = {
  nodeKey: string;
  nodeName: string;
  /** The label `state.path` receives when this branch runs — `name or key` for an
   *  IF path, `label or key` for a switch case, the literal `fallback` otherwise.
   *  Mirrors `executor._run_if` / `_run_switch`; if those change, this follows. */
  pathLabel: string;
  /** A question likely to reach this branch, when the flow says enough to build
   *  one. A switch case comparing against "doanh thu" tells us; an IF comparing
   *  two variables does not, and then the author writes their own. */
  hint: string;
};

function branchProbes(nodes: FlowNode[]): BranchProbe[] {
  const out: BranchProbe[] = [];
  for (const n of walkNodes(nodes || [])) {
    const nodeName = n.name || n.key;
    if (n.type === 'switch') {
      for (const c of n.cases || []) {
        out.push({
          nodeKey: n.key, nodeName,
          pathLabel: c.label || c.key,
          // The compared-against value IS the phrase that reaches this case when
          // the switch reads the question or a classifier's answer.
          hint: (c.value || '').trim(),
        });
      }
      if (n.has_fallback && (n.fallback || []).length) {
        out.push({ nodeKey: n.key, nodeName, pathLabel: 'fallback', hint: '' });
      }
    } else if (n.type === 'if') {
      for (const p of n.paths || []) {
        out.push({
          nodeKey: n.key, nodeName,
          pathLabel: p.name || p.key,
          // `right` is the compared-against side — a literal when the author typed
          // one, which is exactly the phrase that reaches this path.
          hint: (p.conditions || []).map((c) => String(c.right ?? '')).find(Boolean) || '',
        });
      }
    }
  }
  return out;
}

/** Try the flow on a REPORT, before any link exists.
 *
 *  This dialog used to demand a link, and that made the button useless exactly when
 *  it was needed: an author with an unfinished flow had to assign it to a live
 *  public link to find out whether it worked. A flow serves one report or many, so
 *  the thing you pick here is the report — and the list is the same one the
 *  Dashboards module would show you, because a test reads real figures and is
 *  therefore exactly as sensitive as opening the report itself.
 *
 *  Testing against a LINK is still offered when the flow has any: two links resolve
 *  their requirements differently, so late in the build "does it work on THAT link"
 *  is the sharper question. Report first because it is the one you ask more often.
 *
 *  WHAT IT KNOWS BESIDES THE QUESTION.
 *    · The flow's branches, offered as chips, so a test can target a PATH instead
 *      of hoping to hit one — and the result then says whether the flow went there.
 *      An answer that reads fine down the wrong lane is the defect a textbox hides.
 *    · Which reports the flow already serves, floated to the top: those are the
 *      ones a regression would be noticed on.
 *    · The last report and question used, per flow, so re-testing after an edit is
 *      one click. Building is a loop of edit-and-retry; re-picking every round was
 *      friction the dialog itself added.
 *    · What the test cost, and the history row it wrote — the trace here is a
 *      summary, and the Runs tab holds the full one, marked as a test.
 */
function TestDialog({
  brainKey, links, version, nodes, onOpenRun, onClose,
}: {
  brainKey: string; links: FlowLinkUsage[]; version: number;
  nodes: FlowNode[];
  /** Jump to this run in the Runs tab. Passed in rather than routed from here so
   *  the dialog does not need to know how the builder addresses its tabs. */
  onOpenRun: (runId: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const memKey = `appbi.flowtest.${brainKey}`;
  const [target, setTarget] = React.useState<'report' | 'link'>('report');
  const [question, setQuestion] = React.useState(t('agentFlows.test.initialQuestion'));
  const [intended, setIntended] = React.useState<BranchProbe | null>(null);
  const [reports, setReports] = React.useState<TestTargetReport[] | null>(null);
  const [reportId, setReportId] = React.useState<number | null>(null);
  const [reportFilter, setReportFilter] = React.useState('');
  const [reportError, setReportError] = React.useState<string | null>(null);
  const [linkId, setLinkId] = React.useState<number | null>(links[0]?.link_id ?? null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ReportTestResult | null>(null);

  const probes = React.useMemo(() => branchProbes(nodes), [nodes]);
  /** Reports this flow is attached to. A test on one of these exercises what
   *  viewers actually see, so they lead the list. */
  const servedIds = React.useMemo(
    () => new Set(links.map((l) => l.dashboard_id)), [links],
  );

  React.useEffect(() => {
    let alive = true;
    // What was tested last time, restored before the list arrives so the pick is
    // not overwritten by the default when it does.
    let remembered: { reportId?: number; question?: string } = {};
    try {
      remembered = JSON.parse(window.localStorage.getItem(memKey) || '{}') || {};
    } catch { /* a corrupt entry is not worth a broken dialog */ }
    if (remembered.question) setQuestion(remembered.question);

    listTestTargetReports()
      .then((rs) => {
        if (!alive) return;
        const ordered = [...rs].sort((a, b) => {
          const sa = servedIds.has(a.id) ? 0 : 1;
          const sb = servedIds.has(b.id) ? 0 : 1;
          return sa - sb || a.name.localeCompare(b.name);
        });
        setReports(ordered);
        // Remembered pick first, but only if it is still one this account may see.
        const kept = remembered.reportId
          && ordered.some((r) => r.id === remembered.reportId)
          ? remembered.reportId : null;
        setReportId((cur) => cur ?? kept ?? ordered[0]?.id ?? null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // A 403 here is the honest answer, not a failure to load: this account has
        // no Dashboards permission, so there is no report it may test against.
        const status = (e as { response?: { status?: number } })?.response?.status;
        setReports([]);
        setReportError(
          status === 403
            ? t('agentFlows.test.noReportAccess')
            : t('agentFlows.test.reportsFailed'),
        );
      });
    return () => { alive = false; };
  }, [t, memKey, servedIds]);

  const pickProbe = (p: BranchProbe) => {
    setIntended(p);
    setResult(null);
    if (p.hint) setQuestion(p.hint);
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      if (target === 'report') {
        if (!reportId) return;
        setResult(await testFlowOnReport(brainKey, {
          dashboard_id: reportId, question, version,
        }));
        try {
          window.localStorage.setItem(memKey, JSON.stringify({ reportId, question }));
        } catch { /* private mode: remembering is a convenience, not a requirement */ }
      } else {
        if (!linkId) return;
        const res = await testFlow(brainKey, { question, link_id: linkId, version });
        setResult({ envelope: res.envelope, run_row_id: res.run_row_id });
      }
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail || t('agentFlows.test.failed'));
    } finally { setBusy(false); }
  };

  const env = result?.envelope as {
    status?: string;
    trace?: { path: string; steps: { key: string; name: string; type: string; status: string; ms: number; branch?: string }[] };
    answer?: { blocks: { type: string; markdown?: string }[] };
    notices?: { code: string; text: string }[];
    usage?: { llm_calls?: number; tool_calls?: number; prompt_tokens?: number; completion_tokens?: number };
  } | undefined;

  const rd = result?.readiness;
  // Only the ERRORS. A flow mid-build carries advisory warnings by definition, and
  // listing those under "what a real link would still have to answer" told authors
  // a working flow was broken.
  const gaps = rd?.errors || [];
  const rep = result?.report;
  const partialRead =
    rep && rep.charts_total != null && rep.charts_read != null
    && rep.charts_read < rep.charts_total;

  /** Did it go where the author aimed? The path is the labels the runtime pushed,
   *  joined — so containment is an exact test, not a heuristic. */
  const wentElsewhere = Boolean(
    intended && env && !(env.trace?.path || '')
      .split(' · ').map((x) => x.trim()).includes(intended.pathLabel),
  );

  const tokens = (env?.usage?.prompt_tokens || 0) + (env?.usage?.completion_tokens || 0);
  const visible = (reports || []).filter(
    (r) => !reportFilter.trim()
      || r.name.toLowerCase().includes(reportFilter.trim().toLowerCase()),
  );
  const canRun = target === 'report' ? Boolean(reportId) : Boolean(linkId);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.22)]">
      <div className="flex max-h-[84vh] w-[580px] flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] p-3.5">
          <b className="text-body font-strong">{t('agentFlows.test.title')}</b>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded p-1 text-text-tertiary hover:bg-surface-2">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3.5">
          {/* Only offered when there is a choice to make. One tab is not a tab. */}
          {!!links.length && (
            <div className="mb-3 flex gap-1 rounded-lg bg-surface-2 p-1">
              {([
                ['report', t('agentFlows.test.onReport')],
                ['link', t('agentFlows.test.onLink')],
              ] as const).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setTarget(m); setResult(null); }}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-caption transition',
                    target === m ? 'bg-surface-1 font-medium shadow-sm' : 'text-text-tertiary',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {target === 'report' ? (
            <>
              <label className="mb-1 block text-caption font-medium text-text-secondary">
                {t('agentFlows.test.report')}
              </label>
              {reports === null ? (
                <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
              ) : reportError ? (
                <p className="rounded-lg border border-warning/25 bg-warning/5 p-2.5 text-caption leading-relaxed text-warning">
                  {reportError}
                </p>
              ) : !reports.length ? (
                <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2.5 text-caption text-text-tertiary">
                  {t('agentFlows.test.noReports')}
                </p>
              ) : (
                <>
                  {/* A dropdown is fine for six reports and useless for sixty, and
                      an account with Dashboards access usually has sixty. */}
                  {reports.length > 6 && (
                    <Input
                      value={reportFilter}
                      onChange={(e) => setReportFilter(e.target.value)}
                      placeholder={t('agentFlows.test.searchReports')}
                      className="mb-1.5 h-8"
                    />
                  )}
                  <div className="max-h-[142px] overflow-auto rounded-lg border border-[rgb(var(--border-line))]">
                    {!visible.length ? (
                      <p className="px-2.5 py-2 text-caption text-text-tertiary">
                        {t('agentFlows.test.noMatch')}
                      </p>
                    ) : visible.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => { setReportId(r.id); setResult(null); }}
                        className={cn(
                          'flex w-full items-center gap-2 border-t border-[rgb(var(--border-line))] px-2.5 py-1.5 text-left text-caption first:border-t-0',
                          reportId === r.id ? 'bg-accent/10 font-medium' : 'hover:bg-surface-2',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        {servedIds.has(r.id) && (
                          <Badge size="xs" variant="info">{t('agentFlows.test.inUse')}</Badge>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="mt-1.5 text-tiny leading-5 text-text-tertiary">
                {t('agentFlows.test.reportHint')}
              </p>
            </>
          ) : (
            <>
              <label className="mb-1 block text-caption font-medium text-text-secondary">
                {t('agentFlows.test.link')}
              </label>
              <select
                value={linkId ?? ''}
                onChange={(e) => { setLinkId(Number(e.target.value)); setResult(null); }}
                className="h-8 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption"
              >
                {links.map((l) => <option key={l.link_id} value={l.link_id}>{l.link_name}</option>)}
              </select>
            </>
          )}

          {/* AIM AT A PATH, NOT JUST AT THE FLOW.
              Each chip is one branch the flow can take. Picking one both fills a
              question aimed there and records the aim, which is what lets the
              result below say "it went somewhere else" — the failure a free-text
              box cannot report because nothing knew what you intended. */}
          {!!probes.length && (
            <>
              <label className="mb-1 mt-3 block text-caption font-medium text-text-secondary">
                {t('agentFlows.test.probeLabel')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {probes.map((p) => (
                  <button
                    key={`${p.nodeKey}:${p.pathLabel}`}
                    type="button"
                    title={p.nodeName}
                    onClick={() => pickProbe(p)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-tiny transition',
                      intended?.nodeKey === p.nodeKey && intended?.pathLabel === p.pathLabel
                        ? 'border-accent bg-accent/10 font-medium text-accent'
                        : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2',
                    )}
                  >
                    {p.pathLabel}
                  </button>
                ))}
                {intended && (
                  <button
                    type="button"
                    onClick={() => setIntended(null)}
                    className="rounded-full px-2 py-1 text-tiny text-text-tertiary hover:bg-surface-2"
                  >
                    {t('agentFlows.test.clearProbe')}
                  </button>
                )}
              </div>
            </>
          )}

          <label className="mb-1 mt-3 block text-caption font-medium text-text-secondary">
            {t('agentFlows.test.question')}
          </label>
          <Textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
          <Button className="mt-3 w-full" size="sm" onClick={run} loading={busy} disabled={!canRun}>
            <Play className="h-3.5 w-3.5" /> {t('agentFlows.test.run')}
          </Button>

          {/* WHAT A REAL LINK WOULD STILL HAVE TO ANSWER.
              Shown next to the answer rather than instead of it: a flow being built
              normally has unresolved requirements, and refusing to run would put
              this dialog back where it started. */}
          {!!gaps.length && (
            <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 p-2.5">
              <b className="block text-caption text-warning">{t('agentFlows.test.gapsTitle')}</b>
              <ul className="mt-1 space-y-1">
                {gaps.map((g, i) => (
                  <li key={i} className="text-caption leading-relaxed text-warning">• {g.message}</li>
                ))}
              </ul>
            </div>
          )}

          {env && (
            <div className="mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge size="xs" variant={env.status === 'ok' ? 'success' : env.status === 'failed' ? 'danger' : 'warning'}>
                  {env.status}
                </Badge>
                <span className="text-tiny text-text-tertiary">{env.trace?.path}</span>
                {!!tokens && (
                  <span className="text-tiny text-text-tertiary">
                    {t('agentFlows.test.cost', {
                      tokens: tokens.toLocaleString(),
                      calls: env.usage?.llm_calls || 0,
                      tools: env.usage?.tool_calls || 0,
                    })}
                  </span>
                )}
                {partialRead && (
                  <span className="text-tiny text-text-tertiary">
                    {t('agentFlows.test.chartsRead', {
                      read: rep!.charts_read!, total: rep!.charts_total!,
                    })}
                  </span>
                )}
                {!!result?.run_row_id && (
                  <button
                    type="button"
                    onClick={() => onOpenRun(result.run_row_id!)}
                    className="ml-auto text-tiny text-accent underline-offset-2 hover:underline"
                  >
                    {t('agentFlows.test.openRun')}
                  </button>
                )}
              </div>

              {/* THE ANSWER CAN BE FINE AND THE ROUTING STILL WRONG.
                  Said before the answer, because an author who reads a good answer
                  first stops reading. */}
              {wentElsewhere && (
                <p className="mt-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-caption leading-relaxed text-warning">
                  {t('agentFlows.test.wrongPath', {
                    intended: intended!.pathLabel,
                    actual: env.trace?.path || t('agentFlows.test.noPath'),
                  })}
                </p>
              )}

              <div className="mt-2 overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                {(env.trace?.steps || []).map((s, i) => (
                  <div key={i} className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] px-2.5 py-1.5 text-tiny first:border-t-0">
                    <span className={cn('h-1.5 w-1.5 rounded-full',
                      s.status === 'ok' ? 'bg-success'
                        : s.status === 'error' ? 'bg-danger'
                        : s.status === 'reused' ? 'bg-info' : 'bg-surface-3')} />
                    <span className="flex-1 truncate">{s.name || s.key}</span>
                    {/* Which lane this step ran in. Only shown when the flow has
                        lanes, where "did my branch run" is the actual question. */}
                    {!!s.branch && (
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 text-text-tertiary">{s.branch}</span>
                    )}
                    <span className="text-text-quaternary">{s.status} · {s.ms}ms</span>
                  </div>
                ))}
              </div>

              {/* The run's own notices. `branch_unmatched`, a truncated read, a reset
                  memory — each one explains an answer that would otherwise look
                  unexplained, which is the whole reason they exist. */}
              {!!(env.notices || []).length && (
                <ul className="mt-2 space-y-1">
                  {env.notices!.map((n, i) => (
                    <li key={i} className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1.5 text-tiny leading-5 text-text-secondary">
                      {n.text}
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-2 whitespace-pre-wrap rounded-lg border border-success/20 bg-success/5 p-2.5 text-caption leading-relaxed">
                {(env.answer?.blocks || []).map((b) => b.markdown).filter(Boolean).join('\n\n') || '—'}
              </p>
            </div>
          )}
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
