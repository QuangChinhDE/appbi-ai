'use client';

/**
 * The inspector: everything about one node, and nothing about any other.
 *
 * TWO THINGS THAT ARE PROPERTIES HERE AND NOT NODES IN THE PALETTE
 * ---------------------------------------------------------------
 * `retry` and `on_error`. A "Retry node" has to name what it retries, which is a
 * second recording of the graph and a second thing to keep in step with the first.
 * Every node carries them, and this is where an author looks for them anyway.
 *
 * WHY `run_policy` IS A VISIBLE CONTROL
 * ------------------------------------
 * Reuse across turns could have been inferred ("the variable already has a value,
 * so skip"). That is control flow which never appears on the canvas and can only be
 * debugged by guessing. It is a setting, it is shown as a pill on the card, and the
 * trace records `reused` when it fires.
 */
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import {
  MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS,
  type Condition, type ConditionOp, type FlowNode, type FlowPath,
  type Attachable, type NodeSpec, type ProviderGroup, type SwitchCase,
  type ToolPack,
} from '@/lib/agentFlows';
import { SectionTitle, HintText, CostChip, KnowledgeAttachments } from './shared';

const OPS: { value: ConditionOp; labelKey?: string; label?: string }[] = [
  { value: 'contains', labelKey: 'agentFlows.inspector.op.contains' },
  { value: 'not_contains', labelKey: 'agentFlows.inspector.op.notContains' },
  { value: 'equals', labelKey: 'agentFlows.inspector.op.equals' },
  { value: 'not_equals', labelKey: 'agentFlows.inspector.op.notEquals' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'is_empty', labelKey: 'agentFlows.inspector.op.isEmpty' },
  { value: 'is_not_empty', labelKey: 'agentFlows.inspector.op.isNotEmpty' },
  { value: 'matches', labelKey: 'agentFlows.inspector.op.matches' },
  { value: 'in_list', labelKey: 'agentFlows.inspector.op.inList' },
];

const RUN_POLICY: { value: string; labelKey: string; hintKey: string }[] = [
  { value: 'every_turn', labelKey: 'agentFlows.inspector.runPolicy.everyTurn', hintKey: 'agentFlows.inspector.runPolicy.everyTurnHint' },
  { value: 'when_stale', labelKey: 'agentFlows.inspector.runPolicy.whenStale', hintKey: 'agentFlows.inspector.runPolicy.whenStaleHint' },
  { value: 'once_per_session', labelKey: 'agentFlows.inspector.runPolicy.oncePerSession', hintKey: 'agentFlows.inspector.runPolicy.oncePerSessionHint' },
];

const CONTEXT_POLICY: { value: string; labelKey: string }[] = [
  { value: 'none', labelKey: 'agentFlows.inspector.context.none' },
  { value: 'question', labelKey: 'agentFlows.inspector.context.question' },
  { value: 'last_3', labelKey: 'agentFlows.inspector.context.last3' },
  { value: 'full', labelKey: 'agentFlows.inspector.context.full' },
];

type TFn = (key: string, values?: Record<string, string | number>) => string;

function opOptions(t: TFn) {
  return OPS.map((o) => ({ value: o.value, label: o.labelKey ? t(o.labelKey) : o.label || o.value }));
}

function specLabel(spec: NodeSpec | undefined, language: 'en' | 'vi') {
  if (!spec) return '';
  return (language === 'vi' ? spec.label_vi : spec.label_en) || spec.label_vi || spec.label_en;
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <label className="mb-1 block text-caption font-medium text-text-secondary">{label}</label>
      {hint && <p className="mb-1 text-tiny leading-snug text-text-tertiary">{hint}</p>}
      {children}
    </div>
  );
}

function Select({
  value, onChange, options, className,
}: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-8 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption text-text-primary outline-none focus:border-brand',
        className,
      )}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Toggle({
  on, onChange, title, hint,
}: { on: boolean; onChange: (v: boolean) => void; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 border-t border-[rgb(var(--border-line))] py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <b className="block text-caption font-medium">{title}</b>
        {hint && <span className="mt-px block text-tiny text-text-tertiary">{hint}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cn(
          'h-[18px] w-[34px] flex-shrink-0 rounded-full p-0.5 transition',
          on ? 'bg-brand' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'block h-[14px] w-[14px] rounded-full bg-white shadow-linear-sm transition',
            on && 'translate-x-4',
          )}
        />
      </button>
    </div>
  );
}

function ConditionRows({
  conditions, onChange,
}: { conditions: Condition[]; onChange: (next: Condition[]) => void }) {
  const { t } = useI18n();
  const set = (i: number, patch: Partial<Condition>) =>
    onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  return (
    <div>
      {conditions.map((c, i) => {
        const unary = c.op === 'is_empty' || c.op === 'is_not_empty';
        return (
          <div key={i} className="mt-1.5 grid grid-cols-[1.2fr_0.8fr_1fr_28px] gap-1.5 first:mt-0">
            <Input value={c.left} onChange={(e) => set(i, { left: e.target.value })}
              placeholder="{{available_metrics}}" className="h-8 text-tiny" />
            <Select value={c.op} onChange={(v) => set(i, { op: v as ConditionOp })} options={opOptions(t)} />
            <Input
              value={c.right || ''}
              disabled={unary}
              onChange={(e) => set(i, { right: e.target.value })}
              placeholder={unary ? '-' : t('agentFlows.inspector.value')}
              className="h-8 text-tiny"
            />
            <button
              type="button"
              onClick={() => onChange(conditions.filter((_, idx) => idx !== i))}
              className="rounded-md text-text-tertiary hover:bg-surface-2 hover:text-danger"
              aria-label={t('agentFlows.inspector.deleteCondition')}
            >
              <Trash2 className="mx-auto h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <Button
        variant="secondary" size="xs" className="mt-2"
        onClick={() => onChange([...conditions, { left: '', op: 'equals', right: '' }])}
      >
        <Plus className="h-3 w-3" /> {t('agentFlows.inspector.addCondition')}
      </Button>
      <HintText>
        {t('agentFlows.inspector.conditionHintPrefix')} <code>{t('agentFlows.inspector.conditionVariableExample')}</code>.{' '}
        {t('agentFlows.inspector.conditionHintMiddle')} <code>revenue</code> {t('agentFlows.inspector.conditionHintMatch')}{' '}
        <code>table.total_revenue</code>).
      </HintText>
    </div>
  );
}

export interface InspectorProps {
  node: FlowNode | null;
  /** Set when the selection is a branch lane rather than a node. */
  path?: FlowPath | null;
  switchCase?: SwitchCase | null;
  isFallback?: boolean;
  spec?: NodeSpec;
  specs: Record<string, NodeSpec>;
  toolPacks: ToolPack[];
  providers: ProviderGroup[];
  /** Sources this author may point a step at. Server-supplied, so the picker is
   *  not the thing enforcing the permission rule. Null while it loads. */
  attachable: Attachable | null;
  isAnswerNode: boolean;
  onChange: (next: FlowNode) => void;
  onChangePath: (next: FlowPath) => void;
  onChangeCase: (next: SwitchCase) => void;
  onDelete: () => void;
  onMakeAnswer: () => void;
}

export function NodeInspector(props: InspectorProps) {
  const { t } = useI18n();
  const { node, path, switchCase, isFallback, attachable } = props;

  if (path) return <PathForm path={path} onChange={props.onChangePath} />;
  if (switchCase) return <CaseForm item={switchCase} onChange={props.onChangeCase} />;
  if (isFallback) {
    return (
      <div className="p-3">
        <SectionTitle>{t('agentFlows.inspector.fallbackBranch')}</SectionTitle>
        <HintText>
          {t('agentFlows.inspector.fallbackHint')}
        </HintText>
      </div>
    );
  }
  if (!node) {
    return (
      <div className="p-6 text-center text-caption text-text-tertiary">
        {t('agentFlows.inspector.noSelection')}
      </div>
    );
  }
  return <NodeForm {...props} node={node} />;
}

function PathForm({ path, onChange }: { path: FlowPath; onChange: (p: FlowPath) => void }) {
  const { t } = useI18n();
  return (
    <div className="p-3">
      <Field label={t('agentFlows.inspector.branchName')}>
        <Input value={path.name || ''} onChange={(e) => onChange({ ...path, name: e.target.value })} />
      </Field>
      <Field
        label={t('agentFlows.inspector.branchType')}
        hint={t('agentFlows.inspector.branchTypeHint')}
      >
        <Select
          value={path.kind}
          onChange={(v) => onChange({ ...path, kind: v as FlowPath['kind'] })}
          options={[
            { value: 'rules', label: t('agentFlows.inspector.branchType.rules') },
            { value: 'always', label: t('agentFlows.inspector.branchType.always') },
            { value: 'fallback', label: t('agentFlows.inspector.branchType.fallback') },
          ]}
        />
      </Field>
      {path.kind === 'rules' && (
        <>
          <Field label={t('agentFlows.inspector.matchMode')}>
            <Select
              value={path.match || 'all'}
              onChange={(v) => onChange({ ...path, match: v as 'all' | 'any' })}
              options={[{ value: 'all', label: t('agentFlows.inspector.matchAllConditions') }, { value: 'any', label: t('agentFlows.inspector.matchAnyCondition') }]}
            />
          </Field>
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>{t('agentFlows.inspector.conditions')}</SectionTitle>
            <ConditionRows
              conditions={path.conditions || []}
              onChange={(conditions) => onChange({ ...path, conditions })}
            />
          </div>
        </>
      )}
    </div>
  );
}

function CaseForm({ item, onChange }: { item: SwitchCase; onChange: (c: SwitchCase) => void }) {
  const { t } = useI18n();
  return (
    <div className="p-3">
      <Field label={t('agentFlows.inspector.caseLabel')}>
        <Input value={item.label || ''} onChange={(e) => onChange({ ...item, label: e.target.value })} />
      </Field>
      <Field label={t('agentFlows.inspector.compare')}>
        <div className="grid grid-cols-[0.9fr_1.1fr] gap-1.5">
          <Select
            value={item.op || 'equals'}
            onChange={(v) => onChange({ ...item, op: v as ConditionOp })}
            options={opOptions(t)}
          />
          <Input value={item.value || ''} onChange={(e) => onChange({ ...item, value: e.target.value })}
            placeholder={t('agentFlows.inspector.value')} />
        </div>
      </Field>
      <HintText>{t('agentFlows.inspector.caseHint')}</HintText>
    </div>
  );
}

function NodeForm(props: InspectorProps & { node: FlowNode }) {
  const { attachable } = props;
  const { t, language } = useI18n();
  const { node, spec, toolPacks, providers, isAnswerNode, onChange, onMakeAnswer } = props;
  const set = (patch: Partial<FlowNode>) => onChange({ ...node, ...patch } as FlowNode);

  return (
    <div className="p-3">
      <Field label={t('agentFlows.inspector.stepName')}>
        <Input value={node.name || ''} onChange={(e) => set({ name: e.target.value })}
          placeholder={specLabel(spec, language) || node.type} />
      </Field>

      {/* ── per-type ─────────────────────────────────────────────────────── */}
      {node.type === 'agent' && (
        <>
          <Field label={t('agentFlows.inspector.agentPrompt')}
            hint={t('agentFlows.inspector.agentPromptHint')}>
            <Textarea rows={6} value={node.prompt}
              onChange={(e) => set({ prompt: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.outputFormat')}>
            <Select
              value={node.output_format || 'chat'}
              onChange={(v) => set({ output_format: v as 'chat' | 'json' } as Partial<FlowNode>)}
              options={[
                { value: 'chat', label: t('agentFlows.inspector.output.chat') },
                { value: 'json', label: t('agentFlows.inspector.output.json') },
              ]}
            />
            <HintText>
              {t('agentFlows.inspector.outputHint')}
            </HintText>
          </Field>
          <Field label={t('agentFlows.inspector.maxToolCalls')}>
            <Input type="number" min={1} max={MAX_TOOL_CALLS} value={node.max_tool_calls ?? 8}
              onChange={(e) => set({ max_tool_calls: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>{t('agentFlows.inspector.grantedTools')}</SectionTitle>
            <ToolPicker
              packs={toolPacks}
              granted={(node.tools || []).map((t) => t.tool)}
              onToggle={(name, on) => set({
                tools: on
                  ? [...(node.tools || []), { tool: name }]
                  : (node.tools || []).filter((t) => t.tool !== name),
              } as Partial<FlowNode>)}
            />
            {isAnswerNode && (node.tools || []).length > 0 && (
              <p className="mt-2 rounded-md border border-warning/25 bg-warning/5 p-2 text-tiny text-warning">
                {t('agentFlows.inspector.answerToolsWarning')}
              </p>
            )}
          </div>

          {/* An agent that may CALL tools may also LOOK THINGS UP. Both are reach,
              so they sit together rather than in two different mental places. */}
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <KnowledgeAttachments
              value={node.knowledge || []}
              options={attachable}
              onChange={(knowledge) => set({ knowledge } as Partial<FlowNode>)}
            />
          </div>
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>{t('agentFlows.inspector.model')}</SectionTitle>
            <Select
              value={node.provider || 'inherit'}
              onChange={(v) => set({ provider: v as never, model: v === 'inherit' ? '' : node.model } as Partial<FlowNode>)}
              options={providers.map((p) => ({ value: p.provider, label: p.label }))}
            />
            {node.provider && node.provider !== 'inherit' && (
              <div className="mt-1.5">
                <Select
                  value={node.model || ''}
                  onChange={(v) => set({ model: v } as Partial<FlowNode>)}
                  options={[
                    { value: '', label: t('agentFlows.inspector.chooseModel') },
                    ...(providers.find((p) => p.provider === node.provider)?.models || [])
                      .map((m) => ({ value: m.model, label: m.label })),
                  ]}
                />
              </div>
            )}
            <HintText>
              {t('agentFlows.inspector.modelHint')}
            </HintText>
          </div>
        </>
      )}

      {node.type === 'report_read' && (
        <>
          <Field label={t('agentFlows.inspector.readWhat')}>
            <div className="rounded-lg border border-[rgb(var(--border-line))] px-2.5">
              <Toggle on={node.include_summary !== false} title={t('agentFlows.inspector.read.summary')}
                hint={t('agentFlows.inspector.read.summaryHint')}
                onChange={(v) => set({ include_summary: v } as Partial<FlowNode>)} />
              <Toggle on={node.include_data !== false} title={t('agentFlows.inspector.read.data')}
                hint={t('agentFlows.inspector.read.dataHint')}
                onChange={(v) => set({ include_data: v } as Partial<FlowNode>)} />
              <Toggle on={node.include_filters !== false} title={t('agentFlows.inspector.read.filters')}
                hint={t('agentFlows.inspector.read.filtersHint')}
                onChange={(v) => set({ include_filters: v } as Partial<FlowNode>)} />
            </div>
          </Field>
          <Field label={t('agentFlows.inspector.maxRows')}>
            <Input type="number" min={1} max={5000} value={node.max_rows ?? 200}
              onChange={(e) => set({ max_rows: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
          <HintText>
            {t('agentFlows.inspector.reportReadHint')}
          </HintText>
        </>
      )}

      {node.type === 'knowledge' && (
        <>
          <Field label={t('agentFlows.inspector.knowledgeQuery')} hint={t('agentFlows.inspector.queryHint')}>
            <Textarea rows={3} value={node.query || ''}
              onChange={(e) => set({ query: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.topK')}>
            <Input type="number" min={1} max={20} value={node.top_k ?? 5}
              onChange={(e) => set({ top_k: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
          {/* Attaching nothing is a real choice — it means "whatever this report is
              entitled to". The control sits under the query because an author picks
              what to search before narrowing where. */}
          <KnowledgeAttachments
            value={node.knowledge || []}
            options={attachable}
            onChange={(knowledge) => set({ knowledge } as Partial<FlowNode>)}
          />
        </>
      )}

      {node.type === 'web' && (
        <>
          <Field label={t('agentFlows.inspector.webQuery')}>
            <Textarea rows={3} value={node.query || ''}
              onChange={(e) => set({ query: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.allowedDomains')}
            hint={t('agentFlows.inspector.allowedDomainsHint')}>
            <Input
              value={(node.allowed_domains || []).join(', ')}
              onChange={(e) => set({
                allowed_domains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              } as Partial<FlowNode>)}
              placeholder="statista.com, thinkwithgoogle.com"
            />
          </Field>
          <p className="mt-2 rounded-md border border-warning/25 bg-warning/5 p-2 text-tiny text-warning">
            {t('agentFlows.inspector.webGateHint')}
          </p>
        </>
      )}

      {node.type === 'if' && (
        <HintText>
          {t('agentFlows.inspector.ifHint')}
        </HintText>
      )}

      {node.type === 'switch' && (
        <>
          <Field label={t('agentFlows.inspector.switchValue')}>
            <Input value={node.value} onChange={(e) => set({ value: e.target.value } as Partial<FlowNode>)}
              placeholder="{{severity}}" />
          </Field>
          <Field label={t('agentFlows.inspector.switchMode')}>
            <Select
              value={node.mode || 'first_match'}
              onChange={(v) => set({ mode: v as never } as Partial<FlowNode>)}
              options={[
                { value: 'first_match', label: t('agentFlows.inspector.switch.first') },
                { value: 'all_match', label: t('agentFlows.inspector.switch.all') },
              ]}
            />
          </Field>
          <div className="mt-3 rounded-lg border border-[rgb(var(--border-line))] px-2.5">
            <Toggle
              on={node.has_fallback !== false}
              title={t('agentFlows.inspector.hasFallback')}
              hint={t('agentFlows.inspector.hasFallbackHint')}
              onChange={(v) => set({ has_fallback: v } as Partial<FlowNode>)}
            />
          </div>
          <Button
            variant="secondary" size="xs" className="mt-2"
            onClick={() => set({
              cases: [...node.cases, {
                key: `case_${node.cases.length + 1}`,
                label: `CASE ${node.cases.length + 1}`,
                op: 'equals', value: '', body: [],
              }],
            } as Partial<FlowNode>)}
          >
            <Plus className="h-3 w-3" /> {t('agentFlows.inspector.addCase')}
          </Button>
        </>
      )}

      {node.type === 'loop' && (
        <>
          <Field label={t('agentFlows.inspector.loopOver')} hint={t('agentFlows.inspector.loopOverHint')}>
            <Input value={node.over} onChange={(e) => set({ over: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.itemVar')}>
            <Input value={node.item_var || 'item'}
              onChange={(e) => set({ item_var: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field
            label={t('agentFlows.inspector.maxIterations')}
            hint={t('agentFlows.inspector.maxIterationsHint')}
          >
            <Input type="number" min={1} max={MAX_LOOP_ITERATIONS} value={node.max_iterations ?? 10}
              onChange={(e) => set({ max_iterations: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.collectInto')}>
            <Input value={node.collect_into || ''}
              onChange={(e) => set({ collect_into: e.target.value } as Partial<FlowNode>)}
              placeholder="all_findings" />
          </Field>
        </>
      )}

      {node.type === 'filter' && (
        <>
          <Field label={t('agentFlows.inspector.matchMode')}>
            <Select
              value={node.match || 'all'}
              onChange={(v) => set({ match: v as 'all' | 'any' } as Partial<FlowNode>)}
              options={[{ value: 'all', label: t('agentFlows.inspector.matchAllConditions') }, { value: 'any', label: t('agentFlows.inspector.matchAnyCondition') }]}
            />
          </Field>
          <div className="mt-3">
            <SectionTitle>{t('agentFlows.inspector.continueConditions')}</SectionTitle>
            <ConditionRows
              conditions={node.conditions || []}
              onChange={(conditions) => set({ conditions } as Partial<FlowNode>)}
            />
          </div>
          <HintText>{t('agentFlows.inspector.filterHint')}</HintText>
        </>
      )}

      {node.type === 'set_var' && (
        <>
          <Field label={t('agentFlows.inspector.variableName')}>
            <Input value={node.var} onChange={(e) => set({ var: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.valueLabel')}>
            <Textarea rows={3} value={node.value || ''}
              onChange={(e) => set({ value: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.valueType')}>
            <Select
              value={node.value_type || 'text'}
              onChange={(v) => set({ value_type: v as never } as Partial<FlowNode>)}
              options={[
                { value: 'text', label: t('agentFlows.inspector.valueType.text') }, { value: 'number', label: t('agentFlows.inspector.valueType.number') },
                { value: 'list', label: t('agentFlows.inspector.valueType.list') }, { value: 'object', label: 'Object' },
                { value: 'bool', label: t('agentFlows.inspector.valueType.bool') },
              ]}
            />
          </Field>
        </>
      )}

      {node.type === 'transform' && (
        <>
          <Field label={t('agentFlows.inspector.operation')}>
            <Select
              value={node.operation}
              onChange={(v) => set({ operation: v as never } as Partial<FlowNode>)}
              options={[
                { value: 'append_to_list', label: t('agentFlows.inspector.operation.append') },
                { value: 'map_fields', label: t('agentFlows.inspector.operation.mapFields') },
                { value: 'format_object', label: t('agentFlows.inspector.operation.formatObject') },
                { value: 'join_text', label: t('agentFlows.inspector.operation.joinText') },
                { value: 'pick', label: t('agentFlows.inspector.operation.pick') },
              ]}
            />
          </Field>
          <Field label={t('agentFlows.inspector.source')}>
            <Input value={node.source || ''} onChange={(e) => set({ source: e.target.value } as Partial<FlowNode>)}
              placeholder="{{previous}}" />
          </Field>
          <Field label={t('agentFlows.inspector.writeToVariable')}>
            <Input value={node.target || ''} onChange={(e) => set({ target: e.target.value } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {node.type === 'stop' && (
        <>
          <Field label={t('agentFlows.inspector.returnAnswer')} hint={t('agentFlows.inspector.returnAnswerHint')}>
            <Textarea rows={4} value={node.message || ''}
              onChange={(e) => set({ message: e.target.value } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {node.type === 'delay' && (
        <>
          <Field
            label={t('agentFlows.inspector.delaySeconds')}
            hint={t('agentFlows.inspector.delayHint')}
          >
            <Input type="number" min={0} max={30} value={node.seconds ?? 1}
              onChange={(e) => set({ seconds: Number(e.target.value) } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {/* ── common ───────────────────────────────────────────────────────── */}
      <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
        <SectionTitle>{t('agentFlows.inspector.resultSection')}</SectionTitle>
        {node.type !== 'set_var' && node.type !== 'if' && node.type !== 'switch' && (
          <Field label="Output variable" hint={t('agentFlows.inspector.outputVariableHint')}>
            <Input value={node.output_var || ''}
              onChange={(e) => set({ output_var: e.target.value })} />
          </Field>
        )}
        <Field label={t('agentFlows.inspector.rerunEveryTurn')}>
          <Select
            value={node.run_policy || 'every_turn'}
            onChange={(v) => set({ run_policy: v as never })}
            options={RUN_POLICY.map((r) => ({ value: r.value, label: t(r.labelKey) }))}
          />
          <HintText>{t(RUN_POLICY.find((r) => r.value === (node.run_policy || 'every_turn'))?.hintKey || 'agentFlows.inspector.runPolicy.everyTurnHint')}</HintText>
        </Field>
        {node.type === 'agent' && (
          <Field label={t('agentFlows.inspector.contextPolicy')}
            hint={t('agentFlows.inspector.contextPolicyHint')}>
            <Select
              value={node.context_policy || 'question'}
              onChange={(v) => set({ context_policy: v as never })}
              options={CONTEXT_POLICY.map((r) => ({ value: r.value, label: t(r.labelKey) }))}
            />
          </Field>
        )}
      </div>

      <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
        <SectionTitle>{t('agentFlows.inspector.errorSection')}</SectionTitle>
        <Select
          value={node.on_error || 'continue'}
          onChange={(v) => set({ on_error: v as 'continue' | 'stop' })}
          options={[
            { value: 'continue', label: t('agentFlows.inspector.error.continue') },
            { value: 'stop', label: t('agentFlows.inspector.error.stop') },
          ]}
        />
        <div className="mt-2 rounded-lg border border-[rgb(var(--border-line))] px-2.5">
          <Toggle
            on={!!node.retry}
            title={t('agentFlows.inspector.retry')}
            hint={t('agentFlows.inspector.retryHint')}
            onChange={(v) => set({ retry: v ? { max_attempts: 2, backoff_seconds: 1, on: 'error' } : null })}
          />
        </div>
        {node.retry && (
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <Input type="number" min={1} max={5} value={node.retry.max_attempts}
              onChange={(e) => set({ retry: { ...node.retry!, max_attempts: Number(e.target.value) } })} />
            <Input type="number" min={0} max={30} step="0.5" value={node.retry.backoff_seconds}
              onChange={(e) => set({ retry: { ...node.retry!, backoff_seconds: Number(e.target.value) } })} />
          </div>
        )}
      </div>

      {!isAnswerNode && node.type === 'agent' && (
        <Button variant="secondary" size="xs" className="mt-4" onClick={onMakeAnswer}>
          {t('agentFlows.inspector.makeAnswer')}
        </Button>
      )}
    </div>
  );
}

/** How large a result is, in the words an author sizing a flow needs. `small` is
 *  intentionally absent: it is the default and labelling it would put a chip on
 *  almost every row to say "nothing to worry about here". */
const PAYLOAD_LABEL_KEY: Record<string, string> = {
  medium: 'agentFlows.payload.medium',
  large: 'agentFlows.payload.large',
  scales_with_report: 'agentFlows.payload.scalesWithReport',
};

const PAYLOAD_HINT_KEY: Record<string, string> = {
  medium: 'agentFlows.payloadHint.medium',
  large: 'agentFlows.payloadHint.large',
  scales_with_report: 'agentFlows.payloadHint.scalesWithReport',
};

function toolPackLabel(pack: ToolPack, language: 'en' | 'vi') {
  return (language === 'vi' ? pack.label_vi : pack.label_en) || pack.label_vi || pack.label_en;
}

function toolPackPurpose(pack: ToolPack, language: 'en' | 'vi') {
  return language === 'vi' ? pack.purpose_vi : undefined;
}

function toolLabel(tool: ToolPack['tools'][number], language: 'en' | 'vi') {
  return (language === 'vi' ? tool.label_vi : tool.label_en) || tool.label_vi || tool.label_en;
}

/** The tool picker.
 *
 *  Grouped by pack, because a pack is now a KIND of question rather than a file
 *  the bodies happened to share: understand the report, get a figure, compare,
 *  diagnose, project, look something up, leave the app. An author scanning for a
 *  comparison tool reads three, not eleven.
 *
 *  Three things are surfaced per tool that were not before, each because an
 *  author cannot make a good grant without it:
 *
 *  `CostChip`      — the picker was the one place a cost class was never shown,
 *                    so a step could be granted five `expensive` tools without
 *                    anything on screen saying so.
 *  "không cần AI"  — the tool answers on its own. Wiring one of these to a node
 *                    costs no tokens at all, and that is invisible from a name.
 *  `answers_vi`    — a real question it settles. Two tools whose names both sound
 *                    right are told apart by their examples far faster than by
 *                    their descriptions.
 *
 *  `returns` goes in the title attribute rather than on screen: it matters when
 *  wiring a result into the next node, which is a different moment from choosing
 *  what to grant, and putting it inline turned a scannable list into a datasheet.
 */
function ToolPicker({
  packs, granted, onToggle,
}: { packs: ToolPack[]; granted: string[]; onToggle: (name: string, on: boolean) => void }) {
  const { t, language } = useI18n();
  return (
    <div className="space-y-2">
      {packs.map((pack) => {
        const names = pack.tools.map((t) => t.name);
        const onCount = names.filter((n) => granted.includes(n)).length;
        const allOn = onCount === names.length && names.length > 0;
        return (
          <div key={pack.key} className="rounded-lg border border-[rgb(var(--border-line))]">
            <div className="border-b border-[rgb(var(--border-line))] bg-surface-2/40 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <b className="text-tiny font-strong">{toolPackLabel(pack, language)}</b>
                {onCount > 0 && (
                  <span className="rounded bg-accent/10 px-1 text-tiny text-accent">
                    {onCount}/{names.length}
                  </span>
                )}
                {pack.gated_by_link && (
                  <span title={language === 'vi' ? pack.gate_note_vi : t('agentFlows.toolPicker.byLink')}
                    className="rounded border border-warning/25 bg-warning/5 px-1 text-tiny text-warning">
                    {t('agentFlows.toolPicker.byLink')}
                  </span>
                )}
                <button type="button"
                  className="ml-auto text-tiny text-text-tertiary underline-offset-2 hover:underline"
                  onClick={() => names.forEach((n) => onToggle(n, !allOn))}>
                  {allOn ? t('agentFlows.toolPicker.clearAll') : t('agentFlows.toolPicker.selectAll')}
                </button>
              </div>
              {toolPackPurpose(pack, language) && (
                <p className="mt-0.5 text-tiny leading-snug text-text-tertiary">{toolPackPurpose(pack, language)}</p>
              )}
            </div>
            <div className="p-1.5">
              {pack.tools.map((tool) => {
                const on = granted.includes(tool.name);
                const description = language === 'vi' ? tool.description_vi : '';
                const example = language === 'vi' ? tool.answers_vi?.[0] : undefined;
                const returns = language === 'vi' && tool.returns
                  ? Object.entries(tool.returns).map(([k, v]) => `${k}: ${v}`).join('\n')
                  : '';
                return (
                  <label key={tool.name}
                    title={returns ? t('agentFlows.toolPicker.returnsTitle', { returns }) : undefined}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2">
                    <input type="checkbox" checked={on} className="mt-0.5"
                      onChange={(e) => onToggle(tool.name, e.target.checked)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1">
                        <b className="text-tiny font-medium">{toolLabel(tool, language)}</b>
                        <CostChip cost={tool.cost_class} />
                        {/* The payload axis, shown only when it is worth acting
                            on. A `small` result is the norm and a chip on every
                            row would be noise; a result that grows with the
                            report is the one an author has to size a flow
                            around, and it had no representation at all. */}
                        {tool.payload && tool.payload !== 'small' && (
                          <span
                            title={t(PAYLOAD_HINT_KEY[tool.payload])}
                            className={cn(
                              'rounded border px-1 text-tiny',
                              tool.payload === 'scales_with_report'
                                ? 'border-warning/25 bg-warning/5 text-warning'
                                : 'border-[rgb(var(--border-line))] text-text-tertiary',
                            )}>
                            {t(PAYLOAD_LABEL_KEY[tool.payload])}
                          </span>
                        )}
                        {tool.self_sufficient && (
                          <span
                            title={
                              t('agentFlows.toolPicker.selfSufficientTitle')
                            }
                            className="rounded border border-success/25 bg-success/5 px-1 text-tiny text-success">
                            {t('agentFlows.toolPicker.selfSufficient')}
                          </span>
                        )}
                      </span>
                      {description && (
                        <span className="block text-tiny leading-snug text-text-tertiary">
                          {description}
                        </span>
                      )}
                      {example && (
                        <span className="block text-tiny leading-snug text-text-tertiary/70">
                          {t('agentFlows.toolPicker.example', { example })}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
