'use client';

/**
 * Flow Builder — compose the AI's analysis procedure without writing code.
 *
 * Layout is deliberately three columns rather than a free canvas:
 *   palette (what can be added) │ flow (what runs, in order) │ inspector (the
 *   selected node's settings).
 *
 * A free-floating canvas looks impressive and reads badly: what an author needs
 * to answer is "what runs, in what order, and what does each step cost" — which
 * is a sequence, not a 2D layout. The middle column therefore renders the graph
 * as the execution path, follows branches, and marks every node the validator
 * complained about.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ChevronLeft, Copy, Play, Plus, Save, Trash2, Upload,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Textarea } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import {
  type FlowDetail, type FlowGraph, type FlowNode, type Palette, type ValidationResult,
  getFlow, publishFlow, saveFlow, validateGraph,
} from '@/lib/aiFlows';
import {
  EmptyHint, NODE_ICONS, NODE_TONE, Panel, StatusBadge, ValidationList,
  costBadge, useCanEdit, useCanPublish,
} from './shared';
import { PreviewPanel } from './PreviewPanel';

interface Props {
  flowKey: string;
  version: number;
  palette: Palette;
  agents: { ref: string; display_name: string; status: string }[];
  onBack: () => void;
  onChanged: () => void;
}

/** Walk the graph from the entrypoint so the middle column shows EXECUTION
 * order, not dictionary order. Nodes that are unreachable still get listed at
 * the end — hiding them would hide the very mistake the validator flags. */
function orderedNodes(graph: FlowGraph): { key: string; depth: number; reachable: boolean }[] {
  const out: { key: string; depth: number; reachable: boolean }[] = [];
  const seen = new Set<string>();
  const walk = (key: string, depth: number) => {
    if (!key || seen.has(key) || !graph.nodes[key]) return;
    seen.add(key);
    out.push({ key, depth, reachable: true });
    const n = graph.nodes[key];
    const succ = [n.next, n.on_success, n.on_failure, ...Object.values(n.routes ?? {})]
      .filter((s): s is string => !!s);
    const unique = Array.from(new Set(succ));
    unique.forEach((s, i) => walk(s, depth + (i > 0 ? 1 : 0)));
  };
  walk(graph.entrypoint, 0);
  Object.keys(graph.nodes).forEach((k) => {
    if (!seen.has(k)) out.push({ key: k, depth: 0, reachable: false });
  });
  return out;
}

function blankNode(type: string): FlowNode {
  const base: FlowNode = { type, config: {} };
  if (type === 'agent') return { ...base, agent: null, tools: [], config: { writable_state_fields: ['answer'] } };
  if (type === 'function') return { ...base, handler: 'verify_claims', on_success: null, on_failure: null };
  if (type === 'condition') return { ...base, when: 'intent == lookup', on_success: null, on_failure: null };
  if (type === 'legacy') return { ...base, config: { mode: 'auto', writable_state_fields: ['answer', 'usd', 'tool_calls', 'model_calls'] } };
  if (type === 'end') return { type: 'end' };
  return base;
}

export function FlowBuilder({ flowKey, version, palette, agents, onBack, onChanged }: Props) {
  const canEdit = useCanEdit();
  const canPublish = useCanPublish();

  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewRunNodes, setPreviewRunNodes] = useState<Record<string, string>>({});

  useEffect(() => {
    getFlow(flowKey, version)
      .then((f) => {
        setFlow(f);
        setGraph(f.graph);
        setName(f.display_name);
        setValidation(f.validation ?? null);
        setSelected(f.graph?.entrypoint ?? null);
        setDirty(false);
      })
      .catch(() => toast.error('Không tải được luồng'));
  }, [flowKey, version]);

  // Validate as the author edits — debounced, because every keystroke in the
  // inspector mutates the graph and the point is fast feedback, not a flood.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!graph) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      validateGraph(graph).then(setValidation).catch(() => undefined);
    }, 400);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [graph]);

  const errorsByNode = useMemo(() => {
    const m: Record<string, string[]> = {};
    (validation?.errors ?? []).forEach((e) => {
      if (e.node_key) (m[e.node_key] ??= []).push(e.message);
    });
    return m;
  }, [validation]);

  const mutate = useCallback((fn: (g: FlowGraph) => FlowGraph) => {
    setGraph((prev) => (prev ? fn(structuredClone(prev)) : prev));
    setDirty(true);
  }, []);

  const patchNode = useCallback((key: string, patch: Partial<FlowNode>) => {
    mutate((g) => {
      g.nodes[key] = { ...g.nodes[key], ...patch };
      return g;
    });
  }, [mutate]);

  const addNode = useCallback((type: string) => {
    mutate((g) => {
      let i = 1;
      let key = `${type}_${i}`;
      while (g.nodes[key]) key = `${type}_${++i}`;
      g.nodes[key] = blankNode(type);
      return g;
    });
    setTimeout(() => {
      const keys = Object.keys(graph?.nodes ?? {});
      setSelected(keys.length ? `${type}_1` : null);
    }, 0);
  }, [mutate, graph]);

  const removeNode = useCallback((key: string) => {
    mutate((g) => {
      delete g.nodes[key];
      // Also unhook every edge pointing at it — leaving dangling refs would
      // just produce validator noise the author did not create.
      Object.values(g.nodes).forEach((n) => {
        if (n.next === key) n.next = null;
        if (n.on_success === key) n.on_success = null;
        if (n.on_failure === key) n.on_failure = null;
        if (n.routes) {
          Object.entries(n.routes).forEach(([r, target]) => {
            if (target === key) delete n.routes![r];
          });
        }
      });
      return g;
    });
    setSelected(null);
  }, [mutate]);

  const onSave = useCallback(async () => {
    if (!graph) return;
    setSaving(true);
    try {
      const saved = await saveFlow({
        flow_key: flowKey,
        version: flow?.status === 'draft' ? version : null,
        display_name: name,
        graph,
      });
      setFlow(saved);
      setValidation(saved.validation ?? null);
      setDirty(false);
      onChanged();
      toast.success(
        saved.version !== version
          ? `Đã lưu thành phiên bản mới v${saved.version}`
          : 'Đã lưu bản nháp',
      );
    } catch (e) {
      toast.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Lưu thất bại');
    } finally {
      setSaving(false);
    }
  }, [graph, flowKey, version, name, flow, onChanged]);

  const onPublish = useCallback(async () => {
    if (!flow) return;
    try {
      const pub = await publishFlow(flow.flow_key, flow.version);
      setFlow(pub);
      onChanged();
      toast.success('Đã publish — luồng này bắt đầu phục vụ các trợ lý đang gán nó');
    } catch (e) {
      toast.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Publish thất bại');
    }
  }, [flow, onChanged]);

  if (!flow || !graph) {
    return <div className="px-8 py-10 text-caption text-text-tertiary">Đang tải luồng…</div>;
  }

  const nodeList = orderedNodes(graph);
  const sel = selected ? graph.nodes[selected] : null;
  const nodeKeys = Object.keys(graph.nodes);
  const readOnly = !canEdit || flow.is_builtin;

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[rgb(var(--border-line))] px-6 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> Danh sách
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              value={name}
              disabled={readOnly}
              onChange={(e) => { setName(e.target.value); setDirty(true); }}
              className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-body font-strong text-text-primary outline-none focus:ring-0 disabled:opacity-70"
            />
            <StatusBadge status={flow.status} />
            <Badge variant="subtle" size="xs">v{flow.version}</Badge>
            {flow.is_builtin && <Badge variant="info" size="xs">mẫu hệ thống</Badge>}
          </div>
          <p className="text-tiny text-text-tertiary">
            <code>{flow.flow_key}</code> · {nodeKeys.length} bước
            {validation?.limits_effective && (
              <> · trần {validation.limits_effective.max_model_calls} lượt AI ·
                {' '}{validation.limits_effective.deadline_seconds}s ·
                {' '}${validation.limits_effective.max_usd}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowPreview((v) => !v)}>
            <Play className="h-4 w-4" /> Chạy thử
          </Button>
          {!readOnly && (
            <Button variant="secondary" size="sm" onClick={onSave} disabled={saving || !dirty}>
              <Save className="h-4 w-4" /> {dirty ? 'Lưu nháp' : 'Đã lưu'}
            </Button>
          )}
          {canPublish && flow.status === 'draft' && (
            <Button
              variant="primary"
              size="sm"
              onClick={onPublish}
              disabled={dirty || !(validation?.ok ?? false)}
              title={dirty ? 'Lưu trước khi publish' : (!validation?.ok ? 'Còn lỗi cần sửa' : '')}
            >
              <Upload className="h-4 w-4" /> Publish
            </Button>
          )}
        </div>
      </div>

      {flow.is_builtin && (
        <div className="flex items-center gap-2 border-b border-warning/25 bg-warning/[0.06] px-6 py-2 text-tiny text-text-secondary">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          Đây là luồng mẫu của hệ thống — chỉ đọc. Bấm <b>Nhân bản</b> ở màn hình danh sách để tạo bản của bạn.
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── Palette ───────────────────────────────────────────────────── */}
        <aside className="w-56 flex-shrink-0 overflow-y-auto border-r border-[rgb(var(--border-line))] p-3">
          <div className="mb-2 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
            Thêm bước
          </div>
          <div className="space-y-1.5">
            {palette.node_types.filter((n) => !n.system || n.type === 'end').map((nt) => (
              <button
                key={nt.type}
                type="button"
                disabled={readOnly}
                onClick={() => addNode(nt.type)}
                title={nt.description_vi}
                className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${NODE_TONE[nt.type] ?? 'border-[rgb(var(--border-line))]'} hover:border-brand/40`}
              >
                <span className="mt-0.5 text-text-secondary">{NODE_ICONS[nt.type]}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1 text-caption font-emphasis text-text-primary">
                    {nt.label_vi}
                    {nt.llm && <Badge variant="warning" size="xs">AI</Badge>}
                  </span>
                  <span className="block text-tiny leading-tight text-text-tertiary">
                    {nt.description_vi}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <p className="mt-3 rounded-lg bg-surface-2 p-2 text-tiny leading-relaxed text-text-tertiary">
            Bước có nhãn <b>AI</b> tốn tiền model mỗi lần chạy. Bước xanh chạy bằng code, không tốn phí.
          </p>
        </aside>

        {/* ── Flow ──────────────────────────────────────────────────────── */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-surface-0 p-6">
          {validation && <div className="mb-4"><ValidationList errors={validation.errors} /></div>}

          {nodeList.length === 0 ? (
            <EmptyHint>Chưa có bước nào. Thêm từ cột trái.</EmptyHint>
          ) : (
            <div className="mx-auto max-w-2xl space-y-0">
              {nodeList.map((item, idx) => {
                const n = graph.nodes[item.key];
                const errs = errorsByNode[item.key] ?? [];
                const runState = previewRunNodes[item.key];
                return (
                  <div key={item.key}>
                    <button
                      type="button"
                      onClick={() => setSelected(item.key)}
                      style={{ marginLeft: item.depth * 20 }}
                      className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all
                        ${NODE_TONE[n.type] ?? 'border-[rgb(var(--border-line))] bg-surface-1'}
                        ${selected === item.key ? 'ring-2 ring-brand ring-offset-1 ring-offset-surface-0' : ''}
                        ${errs.length ? 'border-danger/60' : ''}
                        ${!item.reachable ? 'opacity-60' : ''}
                        hover:-translate-y-px hover:shadow-sm`}
                    >
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-surface-1 text-text-secondary">
                        {NODE_ICONS[n.type] ?? <Plus className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <code className="text-caption font-strong text-text-primary">{item.key}</code>
                          <Badge variant="subtle" size="xs">{n.type}</Badge>
                          {n.agent && <Badge variant="brand" size="xs">{n.agent}</Badge>}
                          {n.handler && <Badge variant="info" size="xs">{n.handler}</Badge>}
                          {!item.reachable && <Badge variant="danger" size="xs">không tới được</Badge>}
                          {runState === 'running' && <Badge variant="warning" size="xs">đang chạy…</Badge>}
                          {runState === 'ok' && <Badge variant="success" size="xs">✓</Badge>}
                          {runState === 'error' && <Badge variant="danger" size="xs">lỗi</Badge>}
                        </span>
                        {!!(n.tools?.length) && (
                          <span className="mt-0.5 block truncate text-tiny text-text-tertiary">
                            công cụ: {n.tools.join(', ')}
                          </span>
                        )}
                        {errs.length > 0 && (
                          <span className="mt-0.5 block text-tiny text-danger">{errs[0]}</span>
                        )}
                      </span>
                    </button>
                    {idx < nodeList.length - 1 && (
                      <div className="flex items-center gap-1 py-1 pl-4" style={{ marginLeft: item.depth * 20 }}>
                        <ArrowDown className="h-3.5 w-3.5 text-text-quaternary" />
                        <span className="text-tiny text-text-quaternary">
                          {n.routes && Object.keys(n.routes).length > 0
                            ? Object.entries(n.routes).map(([r, t]) => `${r} → ${t}`).join(' · ')
                            : (n.on_success || n.on_failure)
                              ? `đạt → ${n.on_success ?? '—'} · lỗi → ${n.on_failure ?? '—'}`
                              : (n.next ?? '')}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>

        {/* ── Inspector ─────────────────────────────────────────────────── */}
        <aside className="w-80 flex-shrink-0 overflow-y-auto border-l border-[rgb(var(--border-line))] p-4">
          {showPreview ? (
            <PreviewPanel
              flowKey={flow.flow_key}
              version={flow.version}
              onNodeState={(k, s) => setPreviewRunNodes((prev) => ({ ...prev, [k]: s }))}
              onReset={() => setPreviewRunNodes({})}
              onClose={() => setShowPreview(false)}
            />
          ) : !sel || !selected ? (
            <EmptyHint>Chọn một bước để chỉnh.</EmptyHint>
          ) : (
            <NodeInspector
              nodeKey={selected}
              node={sel}
              graph={graph}
              nodeKeys={nodeKeys}
              palette={palette}
              agents={agents}
              readOnly={readOnly}
              onPatch={(p) => patchNode(selected, p)}
              onDelete={() => removeNode(selected)}
              onLimits={(lim) => mutate((g) => ({ ...g, limits: { ...(g.limits ?? {}), ...lim } }))}
              onEntrypoint={() => mutate((g) => ({ ...g, entrypoint: selected }))}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ── Inspector ────────────────────────────────────────────────────────────────
function NodeInspector({
  nodeKey, node, graph, nodeKeys, palette, agents, readOnly,
  onPatch, onDelete, onLimits, onEntrypoint,
}: {
  nodeKey: string;
  node: FlowNode;
  graph: FlowGraph;
  nodeKeys: string[];
  palette: Palette;
  agents: { ref: string; display_name: string; status: string }[];
  readOnly: boolean;
  onPatch: (p: Partial<FlowNode>) => void;
  onDelete: () => void;
  onLimits: (l: Record<string, number>) => void;
  onEntrypoint: () => void;
}) {
  const targets = ['', ...nodeKeys.filter((k) => k !== nodeKey)];
  const isEntry = graph.entrypoint === nodeKey;
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const writable = (cfg.writable_state_fields as string[]) ?? [];

  const toggleTool = (name: string) => {
    const cur = node.tools ?? [];
    onPatch({ tools: cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-caption font-strong text-text-primary">{nodeKey}</div>
          <div className="text-tiny text-text-tertiary">{node.type}</div>
        </div>
        {!readOnly && node.type !== 'guard' && (
          <Button variant="ghost" size="xs" onClick={onDelete} title="Xoá bước">
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
        )}
      </div>

      {!isEntry && !readOnly && (
        <Button variant="subtle" size="xs" onClick={onEntrypoint}>Đặt làm bước bắt đầu</Button>
      )}
      {isEntry && <Badge variant="brand" size="xs">Bước bắt đầu</Badge>}

      {node.type === 'agent' && (
        <>
          <div>
            <Label>Chuyên gia AI</Label>
            <Select
              value={node.agent ?? ''}
              disabled={readOnly}
              onChange={(e) => onPatch({ agent: e.target.value || null })}
            >
              <option value="">— chọn —</option>
              {agents.filter((a) => a.status === 'published').map((a) => (
                <option key={a.ref} value={a.ref}>{a.display_name} ({a.ref})</option>
              ))}
            </Select>
            <p className="mt-1 text-tiny text-text-quaternary">
              Chỉ hiện chuyên gia đã publish. Sửa prompt ở tab “Chuyên gia AI”.
            </p>
          </div>
          <div>
            <Label>Công cụ được dùng</Label>
            <div className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] p-2">
              {palette.tools.map((t) => (
                <label key={t.name} className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={(node.tools ?? []).includes(t.name)}
                    onChange={() => toggleTool(t.name)}
                    className="mt-1"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-tiny font-emphasis text-text-primary">
                      {t.label_vi} {costBadge(t.cost_class)}
                    </span>
                    <span className="block text-tiny leading-tight text-text-tertiary">{t.description_vi}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      {node.type === 'legacy' && (
        <div>
          <Label>Độ sâu</Label>
          <Select
            value={(cfg.mode as string) ?? 'auto'}
            disabled={readOnly}
            onChange={(e) => onPatch({ config: { ...cfg, mode: e.target.value } })}
          >
            <option value="auto">Tự động (theo câu hỏi)</option>
            <option value="normal">Nhanh</option>
            <option value="thinking">Sâu</option>
          </Select>
          <p className="mt-1 text-tiny text-text-quaternary">
            “Tự động” giữ nguyên lựa chọn của người xem — an toàn nhất khi mới bắt đầu.
          </p>
        </div>
      )}

      {node.type === 'function' && (
        <div>
          <Label>Bước kiểm tra</Label>
          <Select
            value={node.handler ?? ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ handler: e.target.value || null })}
          >
            <option value="">— chọn —</option>
            {palette.handlers.map((h) => (
              <option key={h.name} value={h.name}>{h.label_vi}</option>
            ))}
          </Select>
          <p className="mt-1 text-tiny text-text-quaternary">
            {palette.handlers.find((h) => h.name === node.handler)?.description_vi}
          </p>
        </div>
      )}

      {node.type === 'condition' && (
        <div>
          <Label>Điều kiện</Label>
          <Input
            value={node.when ?? ''}
            disabled={readOnly}
            placeholder="intent == lookup"
            onChange={(e) => onPatch({ when: e.target.value })}
          />
          <p className="mt-1 text-tiny text-text-quaternary">
            Dạng <code>trường toán_tử giá_trị</code>. Trường cho phép: intent, model_calls,
            tool_calls, usd, status.
          </p>
        </div>
      )}

      {node.type === 'tool' && (
        <div>
          <Label>Công cụ</Label>
          <Select
            value={node.tool ?? ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ tool: e.target.value || null })}
          >
            <option value="">— chọn —</option>
            {palette.tools.map((t) => (
              <option key={t.name} value={t.name}>{t.label_vi}</option>
            ))}
          </Select>
        </div>
      )}

      {/* Routing */}
      {node.type !== 'end' && (
        <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] p-2">
          <div className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
            Đi tiếp
          </div>
          {(node.type === 'function' || node.type === 'condition') ? (
            <>
              <div>
                <Label>Khi đạt</Label>
                <Select value={node.on_success ?? ''} disabled={readOnly}
                        onChange={(e) => onPatch({ on_success: e.target.value || null })}>
                  {targets.map((t) => <option key={`s-${t}`} value={t}>{t || '—'}</option>)}
                </Select>
              </div>
              <div>
                <Label>Khi lỗi</Label>
                <Select value={node.on_failure ?? ''} disabled={readOnly}
                        onChange={(e) => onPatch({ on_failure: e.target.value || null })}>
                  {targets.map((t) => <option key={`f-${t}`} value={t}>{t || '—'}</option>)}
                </Select>
              </div>
            </>
          ) : (
            <div>
              <Label>Bước kế</Label>
              <Select value={node.next ?? ''} disabled={readOnly}
                      onChange={(e) => onPatch({ next: e.target.value || null })}>
                {targets.map((t) => <option key={`n-${t}`} value={t}>{t || '—'}</option>)}
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Writable state fields — the runtime refuses anything not listed. */}
      {(node.type === 'agent' || node.type === 'legacy' || node.type === 'function') && (
        <div>
          <Label>Bước này được ghi gì</Label>
          <div className="mt-1 flex flex-wrap gap-1">
            {palette.writable_state_fields.map((f) => {
              const on = writable.includes(f.field);
              return (
                <button
                  key={f.field}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onPatch({
                    config: {
                      ...cfg,
                      writable_state_fields: on
                        ? writable.filter((x) => x !== f.field)
                        : [...writable, f.field],
                    },
                  })}
                  className={`rounded-full border px-2 py-0.5 text-tiny transition-colors disabled:opacity-50 ${
                    on ? 'border-brand bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-tertiary'
                  }`}
                >
                  {f.label_vi}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-tiny text-text-quaternary">
            Bước ghi ra ngoài danh sách này sẽ bị hệ thống từ chối khi chạy.
          </p>
        </div>
      )}

      {/* Flow-level budget */}
      <div className="space-y-2 rounded-lg border border-[rgb(var(--border-line))] p-2">
        <div className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
          Trần của cả luồng
        </div>
        {([
          ['max_model_calls', 'Số lượt gọi AI'],
          ['max_tool_calls', 'Số lần gọi công cụ'],
          ['deadline_seconds', 'Thời gian tối đa (giây)'],
        ] as const).map(([k, label]) => (
          <div key={k}>
            <Label>{label}</Label>
            <Input
              type="number"
              disabled={readOnly}
              value={String((graph.limits as Record<string, number> | undefined)?.[k] ?? '')}
              onChange={(e) => onLimits({ [k]: Number(e.target.value) })}
            />
          </div>
        ))}
        <div>
          <Label>Chi phí tối đa mỗi lượt (USD)</Label>
          <Input
            type="number" step="0.01"
            disabled={readOnly}
            value={String((graph.limits as Record<string, number> | undefined)?.max_usd ?? '')}
            onChange={(e) => onLimits({ max_usd: Number(e.target.value) })}
          />
        </div>
        <p className="text-tiny text-text-quaternary">
          Hệ thống luôn kẹp các trần này về mức tối đa cho phép, kể cả khi bạn đặt cao hơn.
        </p>
      </div>
    </div>
  );
}
