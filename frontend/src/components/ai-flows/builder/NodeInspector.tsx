'use client';

/**
 * The inspector — one panel per node type, edited in place.
 *
 * No modals for ordinary configuration: an author changing a tool list wants to
 * see the canvas react, not lose it behind a dialog. Everything writes straight
 * through to the graph, and the validator responds within a debounce.
 *
 * Technical settings sit behind "Advanced" so the first screen a newcomer meets
 * is the handful of choices that actually change behaviour.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Textarea } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';
import type {
  AgentVersion, FlowGraph, FlowLimits, FlowNode, Palette, ValidationResult,
} from '@/lib/aiFlows';
import { LOCKED_TYPES, themeFor } from '../canvas/nodeTheme';
import { CostBadge } from './NodePalette';

interface Props {
  nodeKey: string;
  node: FlowNode;
  graph: FlowGraph;
  palette: Palette | null;
  agents: AgentVersion[];
  validation: ValidationResult | null;
  readOnly?: boolean;
  onPatch: (patch: Partial<FlowNode>) => void;
  onRename: (nextKey: string) => void;
  onDelete: () => void;
  onSetEntry: () => void;
  onOpenAgent: (ref: string) => void;
}

function Section({ title, children, defaultOpen = true }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-tiny font-strong uppercase tracking-wide text-text-quaternary hover:bg-surface-2"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && <div className="space-y-2.5 border-t border-[rgb(var(--border-line))] p-2.5">{children}</div>}
    </div>
  );
}

export function NodeInspector({
  nodeKey, node, graph, palette, agents, validation, readOnly,
  onPatch, onRename, onDelete, onSetEntry, onOpenAgent,
}: Props) {
  const { t } = useI18n();
  const theme = themeFor(node.type);
  const locked = LOCKED_TYPES.has(node.type);
  const isEntry = graph.entrypoint === nodeKey;
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const targets = ['', ...Object.keys(graph.nodes).filter((k) => k !== nodeKey)];
  const issues = (validation?.issues ?? []).filter((i) => i.node_key === nodeKey);

  const patchCfg = (partial: Record<string, unknown>) =>
    onPatch({ config: { ...cfg, ...partial } });

  const nodeLabel = (k: string) => graph.nodes[k]?.display_name || k;

  return (
    <div className="space-y-3">
      {/* Identity */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`flex h-5 w-5 items-center justify-center rounded ${theme.iconBg} ${theme.iconFg}`}>
              <theme.icon className="h-3 w-3" />
            </span>
            <span className="truncate text-caption font-strong text-text-primary">
              {node.display_name || nodeKey}
            </span>
            {locked && <Lock className="h-3 w-3 text-text-quaternary" />}
          </div>
          <code className="text-[10px] text-text-tertiary">{nodeKey}</code>
        </div>
        {!readOnly && !locked && (
          <Button variant="ghost" size="xs" onClick={onDelete} title={t('aiFlows.common.delete')}>
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-danger/25 bg-danger/[0.04] p-2">
          {issues.slice(0, 3).map((i, idx) => (
            <li key={idx} className={`text-tiny ${i.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
              {i.message}
            </li>
          ))}
        </ul>
      )}

      <Section title={t('aiFlows.inspector.flowSettings')}>
        <div>
          <Label>{t('aiFlows.inspector.nodeName')}</Label>
          <Input
            value={node.display_name ?? ''}
            disabled={readOnly}
            placeholder={nodeKey}
            onChange={(e) => onPatch({ display_name: e.target.value })}
          />
        </div>
        <div>
          <Label>{t('aiFlows.inspector.nodeDescription')}</Label>
          <Textarea
            rows={2}
            value={node.description ?? ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ description: e.target.value })}
          />
        </div>
        {isEntry ? (
          <Badge variant="brand" size="xs">{t('aiFlows.inspector.isEntrypoint')}</Badge>
        ) : !readOnly && (
          <Button variant="subtle" size="xs" onClick={onSetEntry}>
            {t('aiFlows.inspector.setEntrypoint')}
          </Button>
        )}
        {!locked && (
          <label className="flex items-center gap-2 text-tiny text-text-secondary">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={!!node.disabled}
              onChange={(e) => onPatch({ disabled: e.target.checked })}
            />
            {t('aiFlows.inspector.disable')}
          </label>
        )}
      </Section>

      {/* ── Type-specific ─────────────────────────────────────────────── */}
      {node.type === 'agent' && (
        <Section title={t('aiFlows.inspector.agent')}>
          <div>
            <Select
              value={node.agent ?? ''}
              disabled={readOnly}
              onChange={(e) => onPatch({ agent: e.target.value || null })}
            >
              <option value="">— {t('aiFlows.common.none')} —</option>
              {agents.filter((a) => a.status === 'published').map((a) => (
                <option key={a.ref} value={a.ref}>{a.display_name} ({a.ref})</option>
              ))}
            </Select>
            <p className="mt-1 text-tiny text-text-quaternary">{t('aiFlows.inspector.agentHint')}</p>
            {node.agent && (
              <Button
                variant="link" size="xs" className="mt-1 !px-0"
                onClick={() => onOpenAgent(node.agent!)}
              >
                {t('aiFlows.inspector.openAgentEditor')} →
              </Button>
            )}
          </div>
          <ToolPicker
            palette={palette}
            selected={node.tools ?? []}
            readOnly={readOnly}
            onToggle={(name) => {
              const cur = node.tools ?? [];
              onPatch({ tools: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] });
            }}
          />
        </Section>
      )}

      {node.type === 'legacy' && (
        <Section title={t('aiFlows.inspector.depth')}>
          <Select
            value={(cfg.mode as string) ?? 'auto'}
            disabled={readOnly}
            onChange={(e) => patchCfg({ mode: e.target.value })}
          >
            <option value="auto">{t('aiFlows.inspector.depthAuto')}</option>
            <option value="normal">{t('aiFlows.inspector.depthNormal')}</option>
            <option value="thinking">{t('aiFlows.inspector.depthThinking')}</option>
          </Select>
          <p className="text-tiny text-text-quaternary">{t('aiFlows.inspector.depthHint')}</p>
        </Section>
      )}

      {node.type === 'context' && (
        <Section title={t('aiFlows.inspector.contextSources')}>
          <div className="space-y-1">
            {(palette?.context_sources ?? []).map((src) => {
              const sources = (cfg.sources as string[]) ?? [];
              const on = src.locked || sources.includes(src.key);
              return (
                <label key={src.key} className="flex items-center gap-2 text-tiny">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={readOnly || src.locked}
                    onChange={() => patchCfg({
                      sources: sources.includes(src.key)
                        ? sources.filter((x) => x !== src.key)
                        : [...sources, src.key],
                    })}
                  />
                  <span className={src.locked ? 'text-text-tertiary' : 'text-text-primary'}>
                    {src.label_vi}
                  </span>
                  {src.locked && (
                    <Badge variant="subtle" size="xs">{t('aiFlows.inspector.contextLocked')}</Badge>
                  )}
                </label>
              );
            })}
          </div>
          <div>
            <Label>{t('aiFlows.inspector.contextBudget')}</Label>
            <Input
              type="number"
              value={String(cfg.max_tokens ?? 2000)}
              disabled={readOnly}
              onChange={(e) => patchCfg({ max_tokens: Number(e.target.value) })}
            />
          </div>
        </Section>
      )}

      {node.type === 'route' && (
        <Section title={t('aiFlows.inspector.routing')}>
          <RouteTable
            routes={node.routes ?? {}}
            intents={palette?.intents ?? []}
            targets={targets}
            nodeLabel={nodeLabel}
            readOnly={readOnly}
            onChange={(routes) => onPatch({ routes })}
          />
        </Section>
      )}

      {(node.type === 'function' || node.type === 'verify') && (
        <Section title={t('aiFlows.inspector.handler')}>
          <Select
            value={node.handler ?? (node.type === 'verify' ? 'verify_claims' : '')}
            disabled={readOnly || node.type === 'verify'}
            onChange={(e) => onPatch({ handler: e.target.value || null })}
          >
            <option value="">— {t('aiFlows.common.none')} —</option>
            {(palette?.handlers ?? []).map((h) => (
              <option key={h.name} value={h.name}>{h.label_vi}</option>
            ))}
          </Select>
          <p className="text-tiny text-text-quaternary">
            {palette?.handlers.find(
              (h) => h.name === (node.handler ?? 'verify_claims'),
            )?.description_vi}
          </p>
          {node.type === 'verify' && (
            <div>
              <Label>{t('aiFlows.inspector.verifyOnFail')}</Label>
              <Select
                value={(cfg.on_fail as string) ?? 'flag'}
                disabled={readOnly}
                onChange={(e) => patchCfg({ on_fail: e.target.value })}
              >
                <option value="flag">{t('aiFlows.inspector.verifyFlag')}</option>
                <option value="repair">{t('aiFlows.inspector.verifyRepair')}</option>
                <option value="strip">{t('aiFlows.inspector.verifyStrip')}</option>
              </Select>
            </div>
          )}
        </Section>
      )}

      {node.type === 'tool' && (
        <Section title={t('aiFlows.inspector.tool')}>
          <Select
            value={node.tool ?? ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ tool: e.target.value || null })}
          >
            <option value="">— {t('aiFlows.common.none')} —</option>
            {(palette?.tools ?? []).map((x) => (
              <option key={x.name} value={x.name}>{x.label_vi}</option>
            ))}
          </Select>
        </Section>
      )}

      {node.type === 'condition' && (
        <Section title={t('aiFlows.inspector.condition')}>
          <ConditionBuilder
            when={node.when ?? ''}
            readOnly={readOnly}
            onChange={(when) => onPatch({ when })}
          />
        </Section>
      )}

      {node.type === 'parallel' && (
        <Section title={t('aiFlows.inspector.branches')}>
          <div className="space-y-1.5">
            {(node.branches ?? []).map((b, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Select
                  className="flex-1"
                  value={b}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...(node.branches ?? [])];
                    next[i] = e.target.value;
                    onPatch({ branches: next });
                  }}
                >
                  {targets.map((tk) => (
                    <option key={tk} value={tk}>{tk ? nodeLabel(tk) : '—'}</option>
                  ))}
                </Select>
                <Button
                  variant="ghost" size="xs" disabled={readOnly}
                  onClick={() => onPatch({ branches: (node.branches ?? []).filter((_, j) => j !== i) })}
                >
                  <Trash2 className="h-3 w-3 text-danger" />
                </Button>
              </div>
            ))}
            {!readOnly && (
              <Button
                variant="subtle" size="xs"
                onClick={() => onPatch({ branches: [...(node.branches ?? []), ''] })}
              >
                + {t('aiFlows.assistants.addRule')}
              </Button>
            )}
          </div>
          <div>
            <Label>{t('aiFlows.inspector.reducer')}</Label>
            <Select
              value={node.reducer ?? ''}
              disabled={readOnly}
              onChange={(e) => onPatch({ reducer: e.target.value || null })}
            >
              <option value="">— {t('aiFlows.common.none')} —</option>
              {(palette?.reducers ?? []).map((r) => (
                <option key={r.name} value={r.name}>{r.label_vi}</option>
              ))}
            </Select>
          </div>
        </Section>
      )}

      {node.type === 'clarify' && (
        <Section title={t('aiFlows.inspector.clarifyTemplate')}>
          <Textarea
            rows={3}
            value={(cfg.question_template as string) ?? ''}
            disabled={readOnly}
            onChange={(e) => patchCfg({ question_template: e.target.value })}
          />
          <div>
            <Label>{t('aiFlows.inspector.resumeNode')}</Label>
            <Select
              value={(cfg.resume_node as string) ?? ''}
              disabled={readOnly}
              onChange={(e) => patchCfg({ resume_node: e.target.value || null })}
            >
              {targets.map((tk) => (
                <option key={tk} value={tk}>{tk ? nodeLabel(tk) : '—'}</option>
              ))}
            </Select>
          </div>
        </Section>
      )}

      {/* ── Routing (non-route nodes) ─────────────────────────────────── */}
      {node.type !== 'end' && node.type !== 'route' && node.type !== 'parallel' && (
        <Section title={t('aiFlows.inspector.routing')}>
          {(node.type === 'function' || node.type === 'verify' || node.type === 'condition') ? (
            <>
              <div>
                <Label>{t('aiFlows.inspector.onSuccess')}</Label>
                <Select
                  value={node.on_success ?? ''}
                  disabled={readOnly}
                  onChange={(e) => onPatch({ on_success: e.target.value || null })}
                >
                  {targets.map((tk) => <option key={tk} value={tk}>{tk ? nodeLabel(tk) : '—'}</option>)}
                </Select>
              </div>
              <div>
                <Label>{t('aiFlows.inspector.onFailure')}</Label>
                <Select
                  value={node.on_failure ?? ''}
                  disabled={readOnly}
                  onChange={(e) => onPatch({ on_failure: e.target.value || null })}
                >
                  {targets.map((tk) => <option key={tk} value={tk}>{tk ? nodeLabel(tk) : '—'}</option>)}
                </Select>
              </div>
            </>
          ) : (
            <div>
              <Label>{t('aiFlows.inspector.next')}</Label>
              <Select
                value={node.next ?? ''}
                disabled={readOnly}
                onChange={(e) => onPatch({ next: e.target.value || null })}
              >
                {targets.map((tk) => <option key={tk} value={tk}>{tk ? nodeLabel(tk) : '—'}</option>)}
              </Select>
            </div>
          )}
        </Section>
      )}

      {/* ── State access ─────────────────────────────────────────────── */}
      {['agent', 'legacy', 'function', 'verify', 'context'].includes(node.type) && (
        <Section title={t('aiFlows.inspector.writes')} defaultOpen={false}>
          <div className="flex flex-wrap gap-1">
            {(palette?.writable_state_fields ?? []).map((f) => {
              const writes = (cfg.writable_state_fields as string[]) ?? [];
              const on = writes.includes(f.field);
              return (
                <button
                  key={f.field}
                  type="button"
                  disabled={readOnly}
                  onClick={() => patchCfg({
                    writable_state_fields: on
                      ? writes.filter((x) => x !== f.field)
                      : [...writes, f.field],
                  })}
                  className={`rounded-full border px-2 py-0.5 text-tiny transition-colors disabled:opacity-50 ${
                    on ? 'border-brand bg-brand/10 text-brand'
                       : 'border-[rgb(var(--border-line))] text-text-tertiary'
                  }`}
                >
                  {f.label_vi}
                </button>
              );
            })}
          </div>
          <p className="text-tiny text-text-quaternary">{t('aiFlows.inspector.writesHint')}</p>
        </Section>
      )}
    </div>
  );
}

// ── Route table ─────────────────────────────────────────────────────────────
function RouteTable({ routes, intents, targets, nodeLabel, readOnly, onChange }: {
  routes: Record<string, string>;
  intents: { key: string; label_vi: string }[];
  targets: string[];
  nodeLabel: (k: string) => string;
  readOnly?: boolean;
  onChange: (routes: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const rows = Object.entries(routes);
  return (
    <div className="space-y-1.5">
      {rows.map(([intent, target], i) => (
        <div key={`${intent}-${i}`} className="flex items-center gap-1">
          <Select
            className="w-[42%]"
            value={intent}
            disabled={readOnly || intent === '*'}
            onChange={(e) => {
              const next: Record<string, string> = {};
              rows.forEach(([k, v], j) => { next[j === i ? e.target.value : k] = v; });
              onChange(next);
            }}
          >
            {intents.map((x) => <option key={x.key} value={x.key}>{x.label_vi}</option>)}
          </Select>
          <span className="text-text-quaternary">→</span>
          <Select
            className="flex-1"
            value={target}
            disabled={readOnly}
            onChange={(e) => onChange({ ...routes, [intent]: e.target.value })}
          >
            {targets.map((tk) => <option key={tk} value={tk}>{tk ? nodeLabel(tk) : '—'}</option>)}
          </Select>
          {intent === '*' ? (
            <Lock className="h-3 w-3 flex-shrink-0 text-text-quaternary" />
          ) : (
            <Button
              variant="ghost" size="xs" disabled={readOnly}
              onClick={() => {
                const next = { ...routes };
                delete next[intent];
                onChange(next);
              }}
            >
              <Trash2 className="h-3 w-3 text-danger" />
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          variant="subtle" size="xs"
          onClick={() => {
            const unused = intents.find((x) => x.key !== '*' && !(x.key in routes));
            if (unused) onChange({ ...routes, [unused.key]: '' });
          }}
        >
          + {t('aiFlows.assistants.addRule')}
        </Button>
      )}
      <p className="text-tiny text-text-quaternary">{t('aiFlows.assistants.routingHint')}</p>
    </div>
  );
}

// ── Condition builder ───────────────────────────────────────────────────────
const COND_FIELDS = ['intent', 'model_calls', 'tool_calls', 'usd', 'status'];
const COND_OPS = ['==', '!=', '>', '<', '>=', '<='];

function ConditionBuilder({ when, readOnly, onChange }: {
  when: string; readOnly?: boolean; onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  const [field = 'intent', op = '==', ...rest] = when.split(/\s+/);
  const value = rest.join(' ');
  const emit = (f: string, o: string, v: string) => onChange(`${f} ${o} ${v}`.trim());

  return (
    <>
      <div className="flex items-center gap-1">
        <Select
          className="flex-1" value={field} disabled={readOnly}
          onChange={(e) => emit(e.target.value, op, value)}
        >
          {COND_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
        </Select>
        <Select
          className="w-16" value={op} disabled={readOnly}
          onChange={(e) => emit(field, e.target.value, value)}
        >
          {COND_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
        <Input
          className="flex-1" value={value} disabled={readOnly}
          onChange={(e) => emit(field, op, e.target.value)}
        />
      </div>
      <p className="text-tiny text-text-quaternary">{t('aiFlows.inspector.conditionHint')}</p>
    </>
  );
}

// ── Tool picker ─────────────────────────────────────────────────────────────
function ToolPicker({ palette, selected, readOnly, onToggle }: {
  palette: Palette | null;
  selected: string[];
  readOnly?: boolean;
  onToggle: (name: string) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const tools = (palette?.tools ?? []).filter(
    (x) => !q || `${x.label_vi} ${x.name}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div>
      <Label>{t('aiFlows.inspector.tools')}</Label>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('aiFlows.common.search')}
        className="mb-1"
      />
      <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] p-1.5">
        {tools.map((tool) => (
          <label
            key={tool.name}
            className="flex items-start gap-1.5 rounded px-1 py-0.5 hover:bg-surface-2"
          >
            <input
              type="checkbox"
              className="mt-1"
              disabled={readOnly}
              checked={selected.includes(tool.name)}
              onChange={() => onToggle(tool.name)}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate text-tiny font-emphasis text-text-primary">
                  {tool.label_vi}
                </span>
                <CostBadge cls={tool.cost_class} />
              </span>
              <span className="block text-[10px] leading-tight text-text-tertiary">
                {tool.description_vi}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Flow-level settings (shown when nothing is selected) ────────────────────
export function FlowSettingsPanel({ graph, validation, readOnly, onLimits, onMeta, meta }: {
  graph: FlowGraph;
  validation: ValidationResult | null;
  readOnly?: boolean;
  meta: { display_name: string; description?: string | null; tags?: string[] };
  onLimits: (patch: Partial<FlowLimits>) => void;
  onMeta: (patch: { display_name?: string; description?: string }) => void;
}) {
  const { t } = useI18n();
  const declared = (validation?.limits_declared ?? graph.limits ?? {}) as Record<string, number>;
  const effective = (validation?.limits_effective ?? {}) as Record<string, number>;
  const ceiling = (validation?.limits_ceiling ?? {}) as Record<string, number>;

  const rows: { key: keyof FlowLimits; label: string; step?: string }[] = [
    { key: 'max_model_calls', label: t('aiFlows.limits.modelCalls') },
    { key: 'max_tool_calls', label: t('aiFlows.limits.toolCalls') },
    { key: 'deadline_seconds', label: t('aiFlows.limits.deadline') },
    { key: 'max_usd', label: t('aiFlows.limits.maxUsd'), step: '0.01' },
  ];

  return (
    <div className="space-y-3">
      <Section title={t('aiFlows.inspector.flowSettings')}>
        <div>
          <Label>{t('aiFlows.create.name')}</Label>
          <Input
            value={meta.display_name}
            disabled={readOnly}
            onChange={(e) => onMeta({ display_name: e.target.value })}
          />
        </div>
        <div>
          <Label>{t('aiFlows.create.description')}</Label>
          <Textarea
            rows={3}
            value={meta.description ?? ''}
            disabled={readOnly}
            onChange={(e) => onMeta({ description: e.target.value })}
          />
        </div>
      </Section>

      <Section title={t('aiFlows.limits.title')}>
        {rows.map((r) => {
          const clamped = effective[r.key] != null && declared[r.key] > effective[r.key];
          return (
            <div key={r.key}>
              <Label>{r.label}</Label>
              <Input
                type="number"
                step={r.step}
                value={String(declared[r.key] ?? '')}
                disabled={readOnly}
                onChange={(e) => onLimits({ [r.key]: Number(e.target.value) } as Partial<FlowLimits>)}
              />
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-quaternary">
                <span>{t('aiFlows.limits.colGlobal')}: {ceiling[r.key] ?? '—'}</span>
                <span>{t('aiFlows.limits.colEffective')}: {effective[r.key] ?? '—'}</span>
              </div>
              {clamped && (
                <p className="mt-0.5 text-[10px] text-warning">{t('aiFlows.limits.clamped')}</p>
              )}
            </div>
          );
        })}
      </Section>
    </div>
  );
}
