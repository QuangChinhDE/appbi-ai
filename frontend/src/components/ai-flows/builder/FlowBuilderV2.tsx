'use client';

/**
 * Flow Builder — the five-zone workspace.
 *
 *   header · palette │ canvas │ inspector · drawer
 *
 * The header carries ONE primary action at a time, derived from where the flow
 * actually is in its lifecycle (check → test → release check → send for review
 * → publish). Showing five equally-weighted buttons would leave an author
 * guessing which one they are supposed to press next.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronLeft, LayoutGrid, Redo2, Save, Undo2, Upload,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  type AgentVersion, type EvalResult, type FlowDetail, type FlowDiff,
  type FlowGraph, type FlowLimits, type FlowNode, type Palette,
  type PreviewEvent, type Surfaces, type ValidationResult,
  getFlow, getFlowDiff, getSurfaces, publishFlow, runFlowEval, runPreview,
  saveFlow, setFlowStatus, validateGraph,
} from '@/lib/aiFlows';
import { FlowCanvas } from '../canvas/FlowCanvas';
import { autoLayout, blankNode, withPositions } from '../canvas/graphAdapter';
import { NodePalette } from './NodePalette';
import { FlowSettingsPanel, NodeInspector } from './NodeInspector';
import { BottomDrawer, type DrawerTab } from './BottomDrawer';
import { PublishDialog } from './PublishDialog';
import { useCanEdit, useCanPublish } from '../shared';

const HISTORY_LIMIT = 50;

interface Props {
  flowKey: string;
  version: number;
  palette: Palette | null;
  agents: AgentVersion[];
  onBack: () => void;
  onChanged: () => void;
  onOpenAgent: (ref: string) => void;
}

export function FlowBuilderV2({
  flowKey, version, palette, agents, onBack, onChanged, onOpenAgent,
}: Props) {
  const { t } = useI18n();
  const canEdit = useCanEdit();
  const canPublish = useCanPublish();

  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [meta, setMeta] = useState({ display_name: '', description: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('validation');

  // Preview
  const [surfaces, setSurfaces] = useState<Surfaces | null>(null);
  const [pvToken, setPvToken] = useState('');
  const [pvQuestion, setPvQuestion] = useState('Doanh thu tổng cộng là bao nhiêu?');
  const [pvRunning, setPvRunning] = useState(false);
  const [pvAnswer, setPvAnswer] = useState('');
  const [pvStatus, setPvStatus] = useState('');
  const [pvError, setPvError] = useState('');
  const [pvSummary, setPvSummary] = useState<PreviewEvent | null>(null);
  const [pvNodes, setPvNodes] = useState<Record<string, { status: string; latencyMs?: number; usd?: number }>>({});
  const [pvTrace, setPvTrace] = useState<{ node: string; ok: boolean; latencyMs?: number }[]>([]);
  const abort = useRef<AbortController | null>(null);

  // Eval / publish
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
  const [evalRunning, setEvalRunning] = useState(false);
  const [diff, setDiff] = useState<FlowDiff | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  // Undo/redo over graph snapshots. Cheap because a graph is small JSON, and it
  // is what makes experimenting on the canvas feel safe.
  const past = useRef<FlowGraph[]>([]);
  const future = useRef<FlowGraph[]>([]);

  const readOnly = !canEdit || !!flow?.is_builtin;

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    getFlow(flowKey, version)
      .then((f) => {
        if (!alive) return;
        setFlow(f);
        setGraph(f.graph);
        setMeta({ display_name: f.display_name, description: f.description ?? '' });
        setValidation(f.validation ?? null);
        setSelected(null);
        setDirty(false);
        past.current = [];
        future.current = [];
      })
      .catch(() => alive && setLoadError(t('aiFlows.error.loadFlow')));
    getSurfaces()
      .then((s) => {
        if (!alive) return;
        setSurfaces(s);
        if (s.public_links.length) setPvToken((cur) => cur || s.public_links[0].token);
      })
      .catch(() => undefined);
    getFlowDiff(flowKey, version).then(setDiff).catch(() => setDiff(null));
    return () => { alive = false; };
  }, [flowKey, version, t]);

  // ── Validation (debounced) ──────────────────────────────────────────────
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!graph) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      validateGraph(graph).then(setValidation).catch(() => undefined);
    }, 400);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [graph]);

  // ── Mutation with history ───────────────────────────────────────────────
  const commit = useCallback((next: FlowGraph) => {
    // History is pushed OUTSIDE the state updater: an updater can run twice
    // (StrictMode, concurrent re-render) and would duplicate undo entries.
    setGraph((prev) => {
      if (prev) {
        past.current = [...past.current.slice(-HISTORY_LIMIT), prev];
        future.current = [];
      }
      return next;
    });
    setDirty(true);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !graph) return;
    future.current = [graph, ...future.current];
    setGraph(prev);
    setDirty(true);
  }, [graph]);

  const redo = useCallback(() => {
    const [next, ...rest] = future.current;
    if (!next || !graph) return;
    past.current = [...past.current, graph];
    future.current = rest;
    setGraph(next);
    setDirty(true);
  }, [graph]);

  const patchNode = useCallback((key: string, patch: Partial<FlowNode>) => {
    if (!graph) return;
    const next = structuredClone(graph);
    next.nodes[key] = { ...next.nodes[key], ...patch };
    commit(next);
  }, [graph, commit]);

  const uniqueKey = useCallback((base: string) => {
    if (!graph) return base;
    let i = 1;
    let k = `${base}_${i}`;
    while (graph.nodes[k]) k = `${base}_${++i}`;
    return k;
  }, [graph]);

  const addNode = useCallback((
    type: string, position?: { x: number; y: number }, ontoEdge?: string,
  ) => {
    if (!graph || readOnly) return;
    const label = palette?.node_types.find((n) => n.type === type)?.label_vi ?? type;
    const key = uniqueKey(type);
    const next = structuredClone(graph);
    next.nodes[key] = {
      ...blankNode(type, label),
      position: position ?? { x: 200, y: 200 },
    };

    // Dropped onto an edge → splice in, preserving the connection.
    if (ontoEdge) {
      const [left, target] = ontoEdge.split('->');
      const [source] = left.split(':');
      const src = next.nodes[source];
      if (src) {
        if (src.next === target) src.next = key;
        else if (src.on_success === target) src.on_success = key;
        else if (src.on_failure === target) src.on_failure = key;
        else if (src.routes) {
          Object.entries(src.routes).forEach(([r, tgt]) => {
            if (tgt === target) src.routes![r] = key;
          });
        }
        next.nodes[key].next = target;
      }
    }
    commit(next);
    setSelected(key);
  }, [graph, readOnly, palette, uniqueKey, commit]);

  const deleteNode = useCallback((key: string) => {
    if (!graph || readOnly) return;
    if (['guard', 'end'].includes(graph.nodes[key]?.type)) return;
    const next = structuredClone(graph);
    delete next.nodes[key];
    Object.values(next.nodes).forEach((n) => {
      if (n.next === key) n.next = null;
      if (n.on_success === key) n.on_success = null;
      if (n.on_failure === key) n.on_failure = null;
      if (n.routes) {
        Object.entries(n.routes).forEach(([r, tgt]) => {
          if (tgt === key) n.routes![r] = '';
        });
      }
      if (n.branches?.includes(key)) n.branches = n.branches.filter((b) => b !== key);
    });
    commit(next);
    setSelected(null);
  }, [graph, readOnly, commit]);

  const doAutoLayout = useCallback(() => {
    if (!graph || readOnly) return;
    commit(withPositions(graph, autoLayout(graph, { onlyMissing: false })));
    toast.success(t('aiFlows.builder.autoLayout'));
  }, [graph, readOnly, commit, t]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void onSave();
      } else if (!mod && e.key.toLowerCase() === 'a') {
        doAutoLayout();
      } else if (!mod && e.key.toLowerCase() === 'p') {
        setDrawerTab('preview'); setDrawerOpen(true);
      } else if (!mod && e.key.toLowerCase() === 'v') {
        setDrawerTab('validation'); setDrawerOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, doAutoLayout, graph, meta]);

  // ── Save / publish ──────────────────────────────────────────────────────
  const onSave = useCallback(async () => {
    if (!graph || !flow || readOnly) return;
    setSaving(true);
    try {
      const saved = await saveFlow({
        flow_key: flowKey,
        version: flow.status === 'draft' ? version : null,
        display_name: meta.display_name,
        description: meta.description,
        graph,
      });
      setFlow(saved);
      setValidation(saved.validation ?? null);
      setDirty(false);
      onChanged();
      toast.success(
        saved.version !== version
          ? `${t('aiFlows.common.saved')} — v${saved.version}`
          : t('aiFlows.common.saved'),
      );
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  }, [graph, flow, readOnly, flowKey, version, meta, onChanged, t]);

  const onRunEval = useCallback(async () => {
    if (!flow) return;
    setEvalRunning(true);
    try {
      setEvalResult(await runFlowEval(flow.flow_key, flow.version));
      setDrawerTab('eval');
      setDrawerOpen(true);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setEvalRunning(false);
    }
  }, [flow]);

  const onSendReview = useCallback(async () => {
    if (!flow) return;
    try {
      const updated = await setFlowStatus(flow.flow_key, flow.version, 'in_review');
      setFlow(updated);
      onChanged();
      toast.success(t('aiFlows.review.sent'));
    } catch (e) {
      toast.error(errText(e));
    }
  }, [flow, onChanged, t]);

  const onPublish = useCallback(async () => {
    if (!flow) return;
    try {
      const pub = await publishFlow(flow.flow_key, flow.version);
      setFlow(pub);
      setPublishOpen(false);
      onChanged();
      toast.success(t('aiFlows.builder.published'));
    } catch (e) {
      toast.error(errText(e));
    }
  }, [flow, onChanged, t]);

  // ── Preview ─────────────────────────────────────────────────────────────
  const startPreview = useCallback(async () => {
    if (!flow || !pvToken) return;
    setPvRunning(true);
    setPvAnswer(''); setPvError(''); setPvSummary(null);
    setPvNodes({}); setPvTrace([]);
    setPvStatus('…');
    setDrawerTab('preview'); setDrawerOpen(true);
    abort.current = new AbortController();

    try {
      await runPreview(
        { flow_key: flow.flow_key, version: flow.version, token: pvToken, question: pvQuestion },
        (ev) => {
          switch (ev.type) {
            case 'node_started':
              if (ev.node) setPvNodes((s) => ({ ...s, [ev.node!]: { status: 'running' } }));
              setPvStatus(`${ev.node}…`);
              break;
            case 'node_completed':
              if (ev.node) {
                const ok = ev.ok !== false;
                setPvNodes((s) => ({
                  ...s,
                  [ev.node!]: {
                    status: ok ? 'completed' : 'failed',
                    latencyMs: ev.latency_ms,
                  },
                }));
                setPvTrace((tr) => [...tr, { node: ev.node!, ok, latencyMs: ev.latency_ms }]);
              }
              break;
            case 'status': if (ev.text) setPvStatus(ev.text); break;
            case 'text': if (ev.text) setPvAnswer((a) => a + ev.text); break;
            case 'error': setPvError((x) => x + (x ? '\n' : '') + (ev.text ?? '')); break;
            case 'preview_done': setPvSummary(ev); setPvStatus(''); break;
            default: break;
          }
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setPvError((e as Error).message);
    } finally {
      setPvRunning(false);
      setPvStatus('');
    }
  }, [flow, pvToken, pvQuestion]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const primary = useMemo(() => {
    if (!flow || readOnly) return null;
    if (!validation) return 'validate';
    if (!validation.ok) return 'validate';
    if (!pvSummary) return 'preview';
    if (!evalResult) return 'eval';
    if (flow.status === 'draft' || flow.status === 'ready') return 'review';
    if (flow.status === 'in_review' && canPublish) return 'publish';
    return null;
  }, [flow, readOnly, validation, pvSummary, evalResult, canPublish]);

  const overview = useMemo(() => {
    if (!graph) return '';
    const lim = (validation?.limits_effective ?? graph.limits ?? {}) as Partial<FlowLimits>;
    return t('aiFlows.builder.overview', {
      nodes: Object.keys(graph.nodes).length,
      ai: lim.max_model_calls ?? 0,
      tools: lim.max_tool_calls ?? 0,
      seconds: lim.deadline_seconds ?? 0,
      usd: lim.max_usd ?? 0,
    });
  }, [graph, validation, t]);

  if (loadError) {
    return (
      <div className="space-y-3 px-8 py-10">
        <p className="text-caption text-danger">{loadError}</p>
        <Button variant="secondary" size="sm" onClick={onBack}>{t('aiFlows.common.back')}</Button>
      </div>
    );
  }
  if (!flow || !graph) {
    return <div className="px-8 py-10 text-caption text-text-tertiary">{t('aiFlows.common.loading')}</div>;
  }

  const selNode = selected ? graph.nodes[selected] : null;

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col">
      {/* ── A. Header ──────────────────────────────────────────────────── */}
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> {t('aiFlows.common.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              value={meta.display_name}
              disabled={readOnly}
              onChange={(e) => { setMeta((m) => ({ ...m, display_name: e.target.value })); setDirty(true); }}
              className="min-w-0 max-w-md flex-1 truncate border-0 bg-transparent p-0 text-body font-strong text-text-primary outline-none focus:ring-0 disabled:opacity-70"
            />
            <Badge variant={statusTone(flow.status)} size="xs">
              {t(`aiFlows.status.${flow.status}`)}
            </Badge>
            <Badge variant="subtle" size="xs">v{flow.version}</Badge>
            {flow.is_builtin && <Badge variant="info" size="xs">{t('aiFlows.status.builtin')}</Badge>}
            {dirty && <Badge variant="warning" size="xs">{t('aiFlows.builder.unsaved')}</Badge>}
          </div>
          <p className="truncate text-tiny text-text-tertiary">
            <code>{flow.flow_key}</code> · {overview}
          </p>
        </div>

        <div className="flex items-center gap-1">
          {!readOnly && (
            <>
              <Button variant="ghost" size="sm" onClick={undo} title={t('aiFlows.builder.undo')}>
                <Undo2 className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={redo} title={t('aiFlows.builder.redo')}>
                <Redo2 className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={doAutoLayout} title={t('aiFlows.builder.autoLayout')}>
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button variant="secondary" size="sm" onClick={onSave} disabled={saving || !dirty}>
                <Save className="h-4 w-4" />
                {dirty ? t('aiFlows.common.saveDraft') : t('aiFlows.common.saved')}
              </Button>
            </>
          )}

          <PrimaryAction
            which={primary}
            onValidate={() => { setDrawerTab('validation'); setDrawerOpen(true); }}
            onPreview={() => { setDrawerTab('preview'); setDrawerOpen(true); }}
            onEval={onRunEval}
            onReview={() => setPublishOpen(true)}
            onPublish={() => setPublishOpen(true)}
            disabled={dirty}
            disabledHint={t('aiFlows.builder.publishBlockedDirty')}
          />
        </div>
      </header>

      {flow.is_builtin && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-warning/25 bg-warning/[0.06] px-4 py-1.5 text-tiny text-text-secondary">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          {t('aiFlows.builder.readOnly')}
        </div>
      )}

      {/* ── B/C/D ──────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[272px] flex-shrink-0 border-r border-[rgb(var(--border-line))] bg-surface-1 lg:block">
          <NodePalette palette={palette} agents={agents} readOnly={readOnly} onAdd={(type) => addNode(type)} />
        </aside>

        <main className="min-w-0 flex-1">
          <FlowCanvas
            graph={graph}
            palette={palette}
            issues={validation?.issues ?? []}
            selected={selected}
            previewStates={pvNodes}
            readOnly={readOnly}
            focusNode={focusNode}
            onSelect={(k) => { setSelected(k); setFocusNode(null); }}
            onChange={commit}
            onDropNode={(type, position, ontoEdge) => addNode(type, position, ontoEdge)}
          />
        </main>

        <aside className="hidden w-[352px] flex-shrink-0 overflow-y-auto border-l border-[rgb(var(--border-line))] bg-surface-1 p-3 xl:block">
          {selNode && selected ? (
            <NodeInspector
              nodeKey={selected}
              node={selNode}
              graph={graph}
              palette={palette}
              agents={agents}
              validation={validation}
              readOnly={readOnly}
              onPatch={(patch) => patchNode(selected, patch)}
              onRename={() => undefined}
              onDelete={() => deleteNode(selected)}
              onSetEntry={() => commit({ ...graph, entrypoint: selected })}
              onOpenAgent={onOpenAgent}
            />
          ) : (
            <FlowSettingsPanel
              graph={graph}
              validation={validation}
              readOnly={readOnly}
              meta={meta}
              onMeta={(patch) => { setMeta((m) => ({ ...m, ...patch })); setDirty(true); }}
              onLimits={(patch) => commit({ ...graph, limits: { ...(graph.limits ?? {}), ...patch } })}
            />
          )}
        </aside>
      </div>

      {/* ── E. Drawer ──────────────────────────────────────────────────── */}
      <BottomDrawer
        open={drawerOpen}
        tab={drawerTab}
        onTab={setDrawerTab}
        onToggle={() => setDrawerOpen((v) => !v)}
        validation={validation}
        onFocusNode={(k) => { setSelected(k); setFocusNode(k); }}
        surfaces={surfaces}
        previewToken={pvToken}
        previewQuestion={pvQuestion}
        previewRunning={pvRunning}
        previewAnswer={pvAnswer}
        previewStatus={pvStatus}
        previewError={pvError}
        previewSummary={pvSummary}
        previewTrace={pvTrace}
        onPreviewToken={setPvToken}
        onPreviewQuestion={setPvQuestion}
        onPreviewRun={startPreview}
        onPreviewStop={() => { abort.current?.abort(); setPvRunning(false); }}
        evalResult={evalResult}
        evalRunning={evalRunning}
        onRunEval={onRunEval}
        diff={diff}
        dirty={dirty}
      />

      {publishOpen && (
        <PublishDialog
          flow={flow}
          diff={diff}
          evalResult={evalResult}
          canPublish={canPublish}
          onClose={() => setPublishOpen(false)}
          onSendReview={onSendReview}
          onPublish={onPublish}
        />
      )}
    </div>
  );
}

function PrimaryAction({
  which, onValidate, onPreview, onEval, onReview, onPublish, disabled, disabledHint,
}: {
  which: string | null;
  onValidate: () => void; onPreview: () => void; onEval: () => void;
  onReview: () => void; onPublish: () => void;
  disabled: boolean; disabledHint: string;
}) {
  const { t } = useI18n();
  if (!which) return null;
  const map: Record<string, { label: string; fn: () => void; icon?: React.ReactNode }> = {
    validate: { label: t('aiFlows.builder.validate'), fn: onValidate },
    preview: { label: t('aiFlows.builder.preview'), fn: onPreview },
    eval: { label: t('aiFlows.builder.eval'), fn: onEval },
    review: { label: t('aiFlows.builder.sendReview'), fn: onReview },
    publish: { label: t('aiFlows.builder.publish'), fn: onPublish, icon: <Upload className="h-4 w-4" /> },
  };
  const a = map[which];
  const blocked = disabled && (which === 'review' || which === 'publish');
  return (
    <Button
      variant="primary" size="sm" onClick={a.fn}
      disabled={blocked} title={blocked ? disabledHint : undefined}
    >
      {a.icon} {a.label}
    </Button>
  );
}

function statusTone(status: string): 'success' | 'warning' | 'info' | 'subtle' {
  if (status === 'published') return 'success';
  if (status === 'in_review') return 'info';
  if (status === 'archived') return 'subtle';
  return 'warning';
}

function errText(e: unknown): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    || (e as Error)?.message || 'Có lỗi xảy ra';
}
