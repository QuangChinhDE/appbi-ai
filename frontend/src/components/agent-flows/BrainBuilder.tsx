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

  const doPublish = async () => {
    setSaving(true);
    try {
      const res = await publishBrain(brainKey, version);
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
          onCancel={() => setPublishOpen(false)}
          onConfirm={doPublish}
          busy={saving}
        />
      )}

      {testOpen && (
        <TestDialog brainKey={brainKey} links={links} onClose={() => setTestOpen(false)} />
      )}
    </div>
  );
}

/** Publishing changes every link at once, so the dialog names them.
 *  A link that would break is PINNED, not broken — stated up front so publishing
 *  stops being a thing authors avoid. */
function PublishDialog({
  version, links, onCancel, onConfirm, busy,
}: {
  version: number; links: FlowLinkUsage[];
  onCancel: () => void; onConfirm: () => void; busy: boolean;
}) {
  const { t } = useI18n();
  const needsReview = links.filter((l) => l.status === 'needs_review');
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
          <Button size="sm" onClick={onConfirm} loading={busy}>{t('agentFlows.builder.publish')}</Button>
        </div>
      </div>
    </div>
  );
}

/** Test runs against a real BINDING, not a bare dashboard.
 *  "Does this flow work" is a question about a flow ON A LINK: two links resolve the
 *  same requirements to different fields, so a test without one tests nothing. */
function TestDialog({
  brainKey, links, onClose,
}: { brainKey: string; links: FlowLinkUsage[]; onClose: () => void }) {
  const { t } = useI18n();
  const [question, setQuestion] = React.useState(t('agentFlows.test.initialQuestion'));
  const [linkId, setLinkId] = React.useState<number | null>(links[0]?.link_id ?? null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null);

  const run = async () => {
    if (!linkId) return;
    setBusy(true);
    try {
      const res = await testFlow(brainKey, { question, link_id: linkId });
      setResult(res.envelope as unknown as Record<string, unknown>);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail || t('agentFlows.test.failed'));
    } finally { setBusy(false); }
  };

  const env = result as unknown as {
    status?: string; trace?: { path: string; steps: { key: string; name: string; type: string; status: string; ms: number }[] };
    answer?: { blocks: { type: string; markdown?: string }[] };
  } | null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.22)]">
      <div className="flex max-h-[80vh] w-[560px] flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] p-3.5">
          <b className="text-body font-strong">{t('agentFlows.test.title')}</b>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded p-1 text-text-tertiary hover:bg-surface-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3.5">
          {!links.length ? (
            <p className="rounded-lg border border-warning/25 bg-warning/5 p-3 text-caption leading-relaxed text-warning">
              {t('agentFlows.test.noLinks')}
            </p>
          ) : (
            <>
              <label className="mb-1 block text-caption font-medium text-text-secondary">{t('agentFlows.test.link')}</label>
              <select
                value={linkId ?? ''}
                onChange={(e) => setLinkId(Number(e.target.value))}
                className="h-8 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption"
              >
                {links.map((l) => <option key={l.link_id} value={l.link_id}>{l.link_name}</option>)}
              </select>
              <label className="mb-1 mt-3 block text-caption font-medium text-text-secondary">{t('agentFlows.test.question')}</label>
              <Textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
              <Button className="mt-3 w-full" size="sm" onClick={run} loading={busy}>
                <Play className="h-3.5 w-3.5" /> {t('agentFlows.test.run')}
              </Button>

              {env && (
                <div className="mt-4">
                  <div className="flex items-center gap-2">
                    <Badge size="xs" variant={env.status === 'ok' ? 'success' : 'warning'}>
                      {env.status}
                    </Badge>
                    <span className="text-tiny text-text-tertiary">{env.trace?.path}</span>
                  </div>
                  <div className="mt-2 overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
                    {(env.trace?.steps || []).map((s, i) => (
                      <div key={i} className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] px-2.5 py-1.5 text-tiny first:border-t-0">
                        <span className={cn('h-1.5 w-1.5 rounded-full',
                          s.status === 'ok' ? 'bg-success'
                            : s.status === 'error' ? 'bg-danger'
                            : s.status === 'reused' ? 'bg-info' : 'bg-surface-3')} />
                        <span className="flex-1 truncate">{s.name || s.key}</span>
                        <span className="text-text-quaternary">{s.status} · {s.ms}ms</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap rounded-lg border border-success/20 bg-success/5 p-2.5 text-caption leading-relaxed">
                    {(env.answer?.blocks || []).map((b) => b.markdown).filter(Boolean).join('\n\n') || '—'}
                  </p>
                </div>
              )}
            </>
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
