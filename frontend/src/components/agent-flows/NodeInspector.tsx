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
  MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS, slugifyBrainKey,
  type Condition, type ConditionOp, type FlowNode, type FlowPath, type FlowType,
  type Attachable, type NodeSpec, type ProviderGroup, type SwitchCase,
  type ToolPack,
  previewStep,
  type StepPreview,
} from '@/lib/agentFlows';
import { SectionTitle, HintText, CostChip, COST_HINT_KEY, KnowledgeAttachments } from './shared';

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

/** A bounded number box that never emits a value outside its own bounds.
 *
 *  WHAT IT REPLACES, AND WHY IT IS A COMPONENT RATHER THAN EIGHT FIXES.
 *
 *  Every number field here was `value={x ?? 8}` with
 *  `onChange={(e) => set({ x: Number(e.target.value) })}`. `Number('')` is `0`, so
 *  the instant somebody selected the contents to type a new number the model
 *  received 0 — below every `min={1}` on this screen — and the flow went invalid
 *  mid-keystroke. The server said so, correctly, and the builder printed the
 *  refusal in its title bar. Eight boxes, one bug, so one component.
 *
 *  The text is held locally while it is being edited, which is what lets the box
 *  be empty without the model being wrong. Only a parse that lands inside
 *  [min, max] is committed; leaving the box snaps it back to the value that is
 *  actually in the flow, so what is on screen and what will be saved cannot
 *  disagree once focus moves on.
 */
function NumberField({
  value, min, max, step, onCommit, className,
}: {
  value: number;
  min: number;
  max: number;
  step?: string;
  onCommit: (n: number) => void;
  className?: string;
}) {
  const [text, setText] = React.useState(String(value));
  const [editing, setEditing] = React.useState(false);

  // Someone else changed it (undo, loading another step) — follow, unless the
  // author is mid-keystroke in this very box.
  React.useEffect(() => { if (!editing) setText(String(value)); }, [value, editing]);

  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      className={className}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === '') return;        // mid-edit, not a value yet
        const n = Number(next);
        if (Number.isFinite(n) && n >= min && n <= max) onCommit(n);
      }}
      onBlur={() => {
        setEditing(false);
        const n = Number(text);
        const ok = text.trim() !== '' && Number.isFinite(n);
        const clamped = ok ? Math.min(max, Math.max(min, n)) : value;
        setText(String(clamped));
        if (clamped !== value) onCommit(clamped);
      }}
    />
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
  /** Needed to ask the server what this step will hand the model. */
  brainKey: string;
  /** Which surface this flow is for. A chat flow has no report, so the preview
   *  must not ask for one — asking was what made this panel unusable there. */
  flowType: FlowType;
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
  const { node, spec, toolPacks, providers, isAnswerNode, onChange, onMakeAnswer,
    brainKey } = props;
  const set = (patch: Partial<FlowNode>) => onChange({ ...node, ...patch } as FlowNode);
  const [seeing, setSeeing] = React.useState(false);

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
              onChange={(v) => set({
                output_format: v as 'chat' | 'json' | 'choice',
              } as Partial<FlowNode>)}
              options={[
                { value: 'chat', label: t('agentFlows.inspector.output.chat') },
                { value: 'json', label: t('agentFlows.inspector.output.json') },
                { value: 'choice', label: t('agentFlows.inspector.output.choice') },
              ]}
            />
            <HintText>
              {t('agentFlows.inspector.outputHint')}
            </HintText>
          </Field>

          {/* THE CLASSIFIER, WHICH HAD NO UI AT ALL.
              `choice` is what makes a Switch work: the step emits exactly one value
              from this list and the runtime enforces it. The backend has supported it
              from the start and the dropdown offered only chat and json, so the node
              that governs every branching flow could be created by API and nowhere
              else — and a Switch whose value nothing produces matches nothing and
              still reports ok.

              THE HINT IS NOT DECORATION. Options are usually variable names, and a
              model asked to choose between variable names is guessing what they were
              meant to stand for. Measured on a full-coverage harness: with bare keys
              a plain lookup question was routed to the FORECAST branch and the
              lookup branch never fired once in four questions. */}
          {node.output_format === 'choice' && (
            <Field
              label={t('agentFlows.inspector.choices')}
              hint={t('agentFlows.inspector.choicesHint')}
            >
              <div className="space-y-1.5">
                {(node.choices || []).map((c, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <Input
                      className="w-[38%] font-mono text-tiny"
                      value={c}
                      placeholder={t('agentFlows.inspector.choiceValue')}
                      onChange={(e) => {
                        const next = [...(node.choices || [])];
                        const prev = next[i];
                        next[i] = e.target.value;
                        // Carry the description across a rename, or renaming a
                        // choice would silently orphan the words explaining it.
                        const hints = { ...(node.choice_hints || {}) };
                        if (prev && hints[prev] !== undefined) {
                          hints[e.target.value] = hints[prev];
                          delete hints[prev];
                        }
                        set({ choices: next, choice_hints: hints } as Partial<FlowNode>);
                      }}
                    />
                    <Input
                      className="flex-1"
                      value={(node.choice_hints || {})[c] || ''}
                      placeholder={t('agentFlows.inspector.choiceHint')}
                      onChange={(e) => set({
                        choice_hints: { ...(node.choice_hints || {}), [c]: e.target.value },
                      } as Partial<FlowNode>)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('common.delete')}
                      onClick={() => {
                        const next = (node.choices || []).filter((_, j) => j !== i);
                        const hints = { ...(node.choice_hints || {}) };
                        delete hints[c];
                        set({ choices: next, choice_hints: hints } as Partial<FlowNode>);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-1.5"
                onClick={() => set({
                  choices: [...(node.choices || []), ''],
                } as Partial<FlowNode>)}
              >
                <Plus className="h-3.5 w-3.5" /> {t('agentFlows.inspector.addChoice')}
              </Button>
              {/* Refused at save time by the contract, so it is said here first —
                  where the author is looking at the node rather than at a toast. */}
              {(node.choices || []).filter((c) => c.trim()).length < 2 && (
                <HintText>{t('agentFlows.inspector.choicesTooFew')}</HintText>
              )}
            </Field>
          )}
          <Advanced
            name="limits"
            title={t('agentFlows.inspector.maxToolCalls')}
            subtitle={t('agentFlows.adv.limitsSubtitle', { n: String(node.max_tool_calls ?? 8) })}
          >
            <NumberField min={1} max={MAX_TOOL_CALLS} value={node.max_tool_calls ?? 8}
              onCommit={(n) => set({ max_tool_calls: n } as Partial<FlowNode>)} />
          </Advanced>
          {/* PUT IT WHERE THE PROMPT IS, not in a menu. The question this answers
              — "will this step see what I think it sees" — is the one an author
              has while looking at the instructions they just typed. */}
          <Button
            size="sm"
            variant="secondary"
            className="mt-2 w-full"
            onClick={() => setSeeing(true)}
          >
            {t('agentFlows.seen.open')}
          </Button>
          {seeing && node && (
            <WhatTheAiSees
              brainKey={brainKey}
              flowType={props.flowType}
              nodeKey={node.key}
              nodeName={node.name || node.key}
              onClose={() => setSeeing(false)}
            />
          )}
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
          <Advanced
            name="model"
            title={t('agentFlows.inspector.model')}
            subtitle={t('agentFlows.adv.modelSubtitle')}
          >
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
          </Advanced>
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
            <NumberField min={1} max={5000} value={node.max_rows ?? 200}
              onCommit={(n) => set({ max_rows: n } as Partial<FlowNode>)} />
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
            <NumberField min={1} max={20} value={node.top_k ?? 5}
              onCommit={(n) => set({ top_k: n } as Partial<FlowNode>)} />
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

      {node.type === 'coordinate' && (
        <>
          <Field
            label={t('agentFlows.inspector.coordinatePrompt')}
            hint={t('agentFlows.inspector.coordinatePromptHint')}
          >
            <Textarea
              rows={2}
              value={node.prompt || ''}
              onChange={(e) => set({ prompt: e.target.value } as Partial<FlowNode>)}
              placeholder={t('agentFlows.inspector.coordinatePromptPlaceholder')}
            />
          </Field>
          <Field
            label={t('agentFlows.inspector.maxSpecialists')}
            hint={t('agentFlows.inspector.maxSpecialistsHint')}
          >
            <NumberField
              min={1} max={8}
              value={node.max_specialists ?? 3}
              onCommit={(n) => set({ max_specialists: n } as Partial<FlowNode>)}
            />
          </Field>

          {/* WHEN-TO-USE IS THE WHOLE INPUT TO THE ROUTING DECISION.
              A classifier handed bare keys sent a plain lookup down the forecast
              branch and never fired the lookup case once. So the field is edited
              here, beside the specialist's name, and a blank one is called out
              rather than left to fail quietly at run time. */}
          <div className="mt-3 space-y-2">
            {(node.specialists || []).map((sp, i) => (
              <div
                key={sp.key}
                className="rounded-lg border border-[rgb(var(--border-line))] p-2.5 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={sp.name || ''}
                    placeholder={t('agentFlows.inspector.specialistName')}
                    onChange={(e) => {
                      // THE KEY FOLLOWS THE NAME WHILE IT IS STILL THE DEFAULT.
                      //
                      // `chuyen_gia_1` is what the planner is shown beside each
                      // `when`, and what the run trace records as the pick —
                      // observed as `picked: ["chuyen_gia_1", "chuyen_gia_2"]`,
                      // which tells an author reading their own run nothing at
                      // all. There is no key field on purpose: two names for one
                      // thing is how they drift.
                      const name = e.target.value;
                      const auto = /^chuyen_gia_\d+$/.test(sp.key);
                      const slug = slugifyBrainKey(name);
                      const taken = new Set(
                        node.specialists.filter((_, j) => j !== i).map((x) => x.key));
                      const nextKey = auto && slug && !taken.has(slug) ? slug : sp.key;
                      set({
                        specialists: node.specialists.map((x, j) =>
                          j === i ? { ...x, name, key: nextKey } : x),
                      } as Partial<FlowNode>);
                    }}
                  />
                  <button
                    type="button"
                    title={t('agentFlows.inspector.removeSpecialist')}
                    className="shrink-0 rounded p-1 text-text-tertiary hover:text-danger disabled:opacity-40"
                    disabled={(node.specialists || []).length <= 2}
                    onClick={() => set({
                      specialists: node.specialists.filter((_, j) => j !== i),
                    } as Partial<FlowNode>)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <Textarea
                  rows={2}
                  value={sp.when || ''}
                  placeholder={t('agentFlows.inspector.specialistWhenPlaceholder')}
                  onChange={(e) => set({
                    specialists: node.specialists.map((x, j) =>
                      j === i ? { ...x, when: e.target.value } : x),
                  } as Partial<FlowNode>)}
                />
                {(sp.when || '').trim().length < 8 && (
                  <p className="text-[10px] leading-tight text-warning">
                    {t('agentFlows.inspector.specialistWhenRequired')}
                  </p>
                )}
              </div>
            ))}
          </div>
          <Button
            variant="secondary" size="xs" className="mt-2"
            onClick={() => set({
              specialists: [...(node.specialists || []), {
                key: `chuyen_gia_${(node.specialists || []).length + 1}`,
                name: '', when: '', body: [],
              }],
            } as Partial<FlowNode>)}
          >
            <Plus className="h-3 w-3" /> {t('agentFlows.inspector.addSpecialist')}
          </Button>
          <HintText>{t('agentFlows.inspector.coordinateHint')}</HintText>
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
            <NumberField min={1} max={MAX_LOOP_ITERATIONS} value={node.max_iterations ?? 10}
              onCommit={(n) => set({ max_iterations: n } as Partial<FlowNode>)} />
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
            <NumberField min={0} max={30} value={node.seconds ?? 1}
              onCommit={(n) => set({ seconds: n } as Partial<FlowNode>)} />
          </Field>
        </>
      )}

      {/* ── common ───────────────────────────────────────────────────────── */}
      <Advanced
        name="result"
        title={t('agentFlows.inspector.resultSection')}
        subtitle={t('agentFlows.adv.resultSubtitle')}
      >
        {/* `coordinate` joins `if`/`switch` here: what it publishes is a record of
            which lane ran, not a finding, and naming bookkeeping as a variable
            invites a later step to answer from it. `{{outputs.<key>}}` still
            reaches it for an author who deliberately wants the route. */}
        {node.type !== 'set_var' && node.type !== 'if' && node.type !== 'switch'
          && node.type !== 'coordinate' && (
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
      </Advanced>

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
            <NumberField min={1} max={5} value={node.retry.max_attempts}
              onCommit={(n) => set({ retry: { ...node.retry!, max_attempts: n } })} />
            <NumberField min={0} max={30} step="0.5" value={node.retry.backoff_seconds}
              onCommit={(n) => set({ retry: { ...node.retry!, backoff_seconds: n } })} />
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
/** A section an author opens when they need it, and never sees when they do not.
 *
 *  Measured before this existed: one AI step showed 59 controls across 11 sections
 *  on a flat 3.2-screen scroll, with nothing marking which four a first flow
 *  actually needs. The complaint this answers is not "too many settings" — the
 *  settings are all real — it is that a beginner and an expert were shown the same
 *  wall, so neither could tell where to start.
 *
 *  Open state is remembered per section name, not per step: an author who works in
 *  the model picker wants it open on the NEXT step too, and re-opening it for every
 *  node is the kind of small tax that makes a tool feel hostile.
 */
function Advanced({
  name, title, subtitle, children,
}: { name: string; title: string; subtitle?: string; children: React.ReactNode }) {
  const key = `appbi.flowinspector.adv.${name}`;
  const [open, setOpen] = React.useState(() => {
    try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const toggle = () => setOpen((v) => {
    try { window.localStorage.setItem(key, v ? '0' : '1'); } catch { /* private mode */ }
    return !v;
  });
  return (
    <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="min-w-0">
          <SectionTitle>{title}</SectionTitle>
          {!open && subtitle && (
            <span className="block text-tiny leading-snug text-text-tertiary">{subtitle}</span>
          )}
        </span>
        <span className="ml-2 flex-shrink-0 text-tiny text-text-tertiary">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Fold for searching: lowercase, accents removed, so "nguyen nhan" finds
 *  "nguyên nhân". An author who types without diacritics is the common case, and
 *  a search that fails them silently is worse than no search. */
function foldSearch(s: string) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** Everything about a tool an author might type at it.
 *
 *  `answers_vi` is in here and it is the point. Every tool carries example
 *  questions, and an author looking for a tool thinks in questions — "vì sao
 *  giảm", "top mấy" — long before they think in tool names. Matching names only
 *  would make the box work for people who already know the answer. */
function toolHaystack(tool: ToolPack['tools'][number]) {
  return foldSearch([
    tool.name, tool.label_vi, tool.label_en, tool.description_vi,
    ...(tool.answers_vi || []),
  ].filter(Boolean).join(' '));
}

function packHaystack(pack: ToolPack) {
  return foldSearch([pack.key, pack.label_vi, pack.label_en, pack.purpose_vi]
    .filter(Boolean).join(' '));
}

function ToolPicker({
  packs, granted, onToggle,
}: { packs: ToolPack[]; granted: string[]; onToggle: (name: string, on: boolean) => void }) {
  const { t, language } = useI18n();
  const [query, setQuery] = React.useState('');
  /* EVERY WORD, NOT THE WHOLE PHRASE.
   *
   *  This was one `includes(needle)` on the joined query, and driving the panel
   *  by hand found the hole immediately: `rank_values` carries the example
   *  question "Danh mục nào doanh thu cao nhất?", and typing "danh muc nao cao
   *  nhat" matched nothing — the words are all there, just not adjacent. An
   *  author paraphrasing their own question is the normal case, so a contiguous
   *  match makes the box work only for people who already know the wording.
   *
   *  AND across words rather than OR: two words should narrow, not widen. */
  const needles = foldSearch(query.trim()).split(/\s+/).filter(Boolean);
  const hits = (hay: string) => needles.filter((w) => hay.includes(w)).length;

  /* WHAT A SEARCH DOES TO A PACK, in three states rather than two.
   *
   *  A pack whose OWN name matches ("chẩn đoán") keeps all its tools: the author
   *  asked for the category, and hiding its contents behind a second match would
   *  answer a category question with a fragment. A pack where only some tools
   *  match shows those. A pack with neither disappears.
   *
   *  Grants survive filtering — a hidden tool stays granted. The box narrows what
   *  is VISIBLE, never what is on, because a search that silently revoked a grant
   *  would be the most expensive kind of surprise in this panel. */
  /* PRECISE WHEN IT CAN BE, FORGIVING WHEN IT CANNOT.
   *
   *  Requiring every word was right until a real paraphrase hit it. The coverage
   *  panel in the test drawer suggests "Số liệu cập nhật tới hôm nào?"; the tool
   *  that answers it carries "Số liệu tính đến khi nào?". Same question, three
   *  words in common, and an AND search found nothing — the product suggesting a
   *  question its own picker could not resolve.
   *
   *  So: if anything matches EVERY word, show only those, because the author was
   *  specific and deserves a short list. Otherwise fall back to whatever shares
   *  the most words. The second mode is what makes a paraphrase work, and it can
   *  only widen a result that would otherwise have been empty. */
  const scorePack = (pack: ToolPack, min: number) => {
    if (hits(packHaystack(pack)) >= min) return pack;
    const tools = pack.tools
      .map((tool) => ({ tool, n: hits(toolHaystack(tool)) }))
      .filter((x) => x.n >= min)
      .sort((a, b) => b.n - a.n)
      .map((x) => x.tool);
    return tools.length ? { ...pack, tools } : null;
  };
  const strict = needles.length
    ? packs.map((p) => scorePack(p, needles.length)).filter((p): p is ToolPack => p !== null)
    : packs;
  /* THE FALLBACK HAS TO CALIBRATE ITSELF.
   *
   *  A fixed floor of one word answered "so lieu cap nhat toi hom nao" with 35 of
   *  36 tools — every tool containing "so" or "nao" — which is not a search
   *  result, it is the list again. So the floor is the BEST score anything
   *  achieved: if the closest tool shares three words, only the three-word
   *  matches show. Short lists when the wording is close, and no tuning constant
   *  to go stale as the catalogue grows. */
  const best = needles.length
    ? Math.max(0, ...packs.flatMap((p) => [
        hits(packHaystack(p)), ...p.tools.map((tool) => hits(toolHaystack(tool))),
      ]))
    : 0;
  const shown = !needles.length || strict.length
    ? strict
    : best > 0
      ? packs.map((p) => scorePack(p, best)).filter((p): p is ToolPack => p !== null)
      : [];
  const hitCount = shown.reduce((n, p) => n + p.tools.length, 0);
  const loose = Boolean(needles.length) && !strict.length && hitCount > 0;

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          id="agent-flow-tool-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('agentFlows.toolPicker.searchPlaceholder')}
          aria-label={t('agentFlows.toolPicker.searchLabel')}
          className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface px-2 py-1.5 text-caption outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
        />
      </div>
      {needles.length > 0 && (
        <p className="px-0.5 text-micro text-text-tertiary">
          {hitCount === 0
            ? t('agentFlows.toolPicker.searchEmpty')
            : loose
              ? t('agentFlows.toolPicker.searchLoose', { count: String(hitCount) })
              : t('agentFlows.toolPicker.searchHits', { count: String(hitCount) })}
        </p>
      )}
      {shown.map((pack) => {
        const names = pack.tools.map((t) => t.name);
        /* A PACK WITH NOTHING GRANTED IS A HEADING, NOT A LIST.
         *
         * All eight packs rendered expanded, so the picker was 36 checkboxes tall
         * on every step — the single largest block in a panel that already ran 3.2
         * screens. Six of those eight are usually untouched, and an author scrolls
         * past ninety rows to reach the setting under them.
         *
         * Collapsed means one line that still says what the pack is FOR, so the
         * catalogue stays browsable; a search expands whatever matches, because a
         * search is the author saying they want to look inside. */
        const anyGranted = names.some((n) => granted.includes(n));
        // Counted over the tools ON SCREEN. While a search is active those are
        // the only ones "select all" can reach, so a badge counting the whole
        // pack would promise a bulk action the button does not perform.
        const onCount = names.filter((n) => granted.includes(n)).length;
        const allOn = onCount === names.length && names.length > 0;
        return (
          <PackBlock
            key={pack.key}
            openByDefault={anyGranted || needles.length > 0}
            header={({ open, toggle }) => (
            <div className="bg-surface-2/40 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  className="flex min-w-0 items-center gap-1.5 text-left"
                >
                  <span className="w-2 flex-shrink-0 text-tiny text-text-tertiary">
                    {open ? '−' : '+'}
                  </span>
                  <b className="text-caption font-strong">{toolPackLabel(pack, language)}</b>
                </button>
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
                <p className="mt-0.5 text-micro leading-snug text-text-tertiary">{toolPackPurpose(pack, language)}</p>
              )}
            </div>
            )}
          >
            <div className="p-1.5">
              {pack.tools.map((tool) => {
                const on = granted.includes(tool.name);
                const description = language === 'vi' ? tool.description_vi : '';
                const example = language === 'vi' ? tool.answers_vi?.[0] : undefined;
                const returns = language === 'vi' && tool.returns
                  ? Object.entries(tool.returns).map(([k, v]) => `${k}: ${v}`).join('\n')
                  : '';
                /* A CHIP MARKS AN EXCEPTION, NOT A PROPERTY.
                 *
                 * Every tool carried three chips, so one panel rendered 75 of
                 * them drawn from 9 distinct labels: "ready-to-use number" on 20
                 * rows, "query" on 18, "light" on 11. Measured over the
                 * catalogue, those are the NORMS — `cheap` + `data_query` is 81%
                 * of tools and `self_sufficient` is 56%, a majority. A badge on
                 * the majority distinguishes nothing; it only costs the author
                 * the attention they need for the row that IS unusual.
                 *
                 * So a chip survives only where it changes a decision: the call
                 * leaves AppBI, it runs several queries, its result is large, or
                 * its size grows with the report. Nothing is lost — every fact
                 * still reaches the author through the row's tooltip. */
                const facts = [
                  t(COST_HINT_KEY[tool.cost_class] || COST_HINT_KEY.cheap),
                  tool.payload ? t(PAYLOAD_HINT_KEY[tool.payload]) : '',
                  tool.self_sufficient ? t('agentFlows.toolPicker.selfSufficientTitle') : '',
                  returns ? t('agentFlows.toolPicker.returnsTitle', { returns }) : '',
                ].filter(Boolean).join('\n\n');
                const loud = tool.cost_class === 'external' || tool.cost_class === 'expensive';
                const bigPayload = tool.payload === 'large' || tool.payload === 'scales_with_report';
                return (
                  <label key={tool.name}
                    title={facts || undefined}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2">
                    <input type="checkbox" checked={on} className="mt-0.5"
                      onChange={(e) => onToggle(tool.name, e.target.checked)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1">
                        <b className="text-caption font-medium">{toolLabel(tool, language)}</b>
                        {loud && <CostChip cost={tool.cost_class} />}
                        {bigPayload && tool.payload && (
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
                      </span>
                      {description && (
                        <span className="block text-micro leading-snug text-text-tertiary">
                          {description}
                        </span>
                      )}
                      {example && (
                        <span className="block text-micro leading-snug text-text-tertiary/70">
                          {t('agentFlows.toolPicker.example', { example })}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </PackBlock>
        );
      })}
    </div>
  );
}

/** One tool pack: a heading that is always readable, and a body that is not always
 *  open. Controlled by the picker rather than self-managed, because "has a grant"
 *  and "matches the search" are the picker's facts — a self-opening block would
 *  need both passed in anyway, and would then disagree with them after a toggle. */
function PackBlock({
  header, openByDefault, children,
}: {
  header: (o: { open: boolean; toggle: () => void }) => React.ReactNode;
  openByDefault: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(openByDefault);
  const wasDefault = React.useRef(openByDefault);
  /* Follow the default when the REASON changes — a search starting, or the first
     grant landing in an untouched pack — but never fight a deliberate toggle. */
  React.useEffect(() => {
    if (wasDefault.current !== openByDefault) {
      wasDefault.current = openByDefault;
      setOpen(openByDefault);
    }
  }, [openByDefault]);
  return (
    <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
      {/* NOT a button around the header: the header already holds "select all",
          and nesting interactive elements makes the inner one unreachable — the
          kind of defect that passes a type-check and fails a keyboard. The
          disclosure control is passed INTO the header instead, so it sits beside
          that button rather than around it. */}
      <div className="border-b border-[rgb(var(--border-line))]">
        {header({ open, toggle: () => setOpen((v) => !v) })}
      </div>
      {open && children}
    </div>
  );
}

/** "What the AI sees" — the screen the builder never had.
 *
 *  An author configures eleven sections for one step and, until this, nothing
 *  showed the result. The rule that governs all of them lived in a single line of
 *  helper text: your instructions are APPENDED to a base prompt. So the model had
 *  to be inferred from field names, and the product's standing complaint is that
 *  nobody can tell how a flow will behave before running it.
 *
 *  The fact this screen exists to deliver is measurable and surprising: in the
 *  answering step of the demo flow the author's 438 characters sit inside 8,976 —
 *  five percent. In a specialist, 445 of 640 — seventy. Same product, same author,
 *  opposite writing problems, and no way to know which one you were in.
 *
 *  Nothing is called and nothing is spent: the backend assembles the inputs with
 *  the same three functions a run uses and stops.
 */
function WhatTheAiSees({
  brainKey, flowType, nodeKey, nodeName, onClose,
}: {
  brainKey: string; flowType: FlowType; nodeKey: string; nodeName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [question, setQuestion] = React.useState('Doanh thu tháng này bao nhiêu?');
  const [data, setData] = React.useState<StepPreview | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  /* The report the author already chose in Test. Reusing it beats a second
     picker: on a BOT flow the question "what does this step see" has no answer
     without a report, and making them choose one twice implies the two are
     different.

     A chat flow needs none of this. It is not a bot flow missing its report — it
     is a different surface, and the server assembles the preview from what the
     flow attached, exactly as a real chat turn does. */
  const needsReport = flowType === 'bot';
  const reportId = React.useMemo(() => {
    try {
      const raw = window.localStorage.getItem(`appbi.flowtest.${brainKey}`);
      const id = raw ? JSON.parse(raw)?.reportId : null;
      return typeof id === 'number' ? id : null;
    } catch { return null; }
  }, [brainKey]);

  const load = React.useCallback(async () => {
    if (needsReport && !reportId) return;
    setBusy(true);
    setError('');
    try {
      setData(await previewStep(brainKey, nodeKey, {
        ...(needsReport && reportId ? { dashboard_id: reportId } : {}),
        question,
      }));
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : t('agentFlows.seen.failed'));
    } finally {
      setBusy(false);
    }
  }, [brainKey, needsReport, nodeKey, question, reportId, t]);

  React.useEffect(() => { void load(); /* eslint-disable-next-line */ }, [reportId, needsReport]);

  const sp = data?.system_prompt;
  const yours = sp ? sp.this_step_chars : 0;
  const total = sp ? sp.this_step_chars + sp.shared_base_chars : 0;
  const pct = total ? Math.round((yours / total) * 100) : 0;

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-[rgb(8_9_10/0.12)] pt-10">
      <div className="flex max-h-[86vh] w-[min(880px,94vw)] flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
        <div className="flex flex-shrink-0 items-start justify-between border-b border-[rgb(var(--border-line))] px-4 py-3">
          <div>
            <h2 className="text-body font-strong">{t('agentFlows.seen.title')}</h2>
            <p className="text-tiny text-text-tertiary">
              {nodeName} · {t('agentFlows.seen.subtitle')}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </div>

        <div className="flex-shrink-0 border-b border-[rgb(var(--border-line))] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
              placeholder={t('agentFlows.seen.questionPlaceholder')}
              className="h-8 flex-1"
            />
            <Button size="sm" variant="secondary" onClick={() => void load()}
                    disabled={busy || (needsReport && !reportId)}>
              {busy ? t('agentFlows.seen.loading') : t('agentFlows.seen.refresh')}
            </Button>
          </div>
          {needsReport && !reportId && (
            <p className="mt-1.5 text-tiny text-warning">{t('agentFlows.seen.needReport')}</p>
          )}
          {!needsReport && (
            <p className="mt-1.5 text-tiny text-text-tertiary">{t('agentFlows.seen.chatNote')}</p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="text-tiny text-danger">{error}</p>}
          {data && sp && (
            <div className="space-y-4">
              {/* THE HEADLINE. One sentence and one bar: how much of what the model
                  reads is yours. Everything else on this screen is the evidence. */}
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                <p className="text-caption">
                  {t('agentFlows.seen.share', {
                    yours: String(yours), total: String(total), pct: String(pct),
                  })}
                </p>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-1">
                  <div className="bg-brand" style={{ width: `${Math.max(pct, 1)}%` }} />
                  <div className="flex-1 bg-[rgb(var(--border-line))]" />
                </div>
                <p className="mt-2 text-tiny text-text-tertiary">
                  {t(`agentFlows.seen.base.${sp.base_kind}`)}
                </p>
              </div>

              <SeenSection title={t('agentFlows.seen.systemPrompt')} defaultOpen>
                {/* The author's own words marked inside the whole, because the
                    proportion is the lesson and a wall of text hides it. */}
                <PromptWithYours full={sp.full} yours={sp.this_step} />
              </SeenSection>

              <SeenSection
                title={t('agentFlows.seen.messages', { n: String(data.messages.length) })}
                defaultOpen
              >
                <div className="space-y-1.5">
                  {data.messages.map((m, i) => (
                    <div key={i} className="rounded-md border border-[rgb(var(--border-line))] p-2">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="rounded bg-surface-2 px-1.5 text-tiny uppercase tracking-wide text-text-tertiary">
                          {m.role}
                        </span>
                        <span className="text-tiny text-text-quaternary">{m.chars} ký tự</span>
                      </div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-tiny leading-relaxed text-text-secondary">
                        {m.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </SeenSection>

              <SeenSection title={t('agentFlows.seen.tools', { n: String(data.tools.length) })}>
                {data.tools.length === 0 ? (
                  <HintText>{t('agentFlows.seen.noTools')}</HintText>
                ) : (
                  <div className="space-y-1.5">
                    {data.tools.map((tool) => (
                      <div key={tool.name} className="rounded-md border border-[rgb(var(--border-line))] p-2">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <b className="font-mono text-tiny">{tool.name}</b>
                          {tool.required.length > 0 && (
                            <span className="rounded bg-warning/10 px-1.5 text-tiny text-warning">
                              {t('agentFlows.seen.requires', { args: tool.required.join(', ') })}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-tiny leading-snug text-text-tertiary">
                          {tool.description}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </SeenSection>

              {data.pending_upstream.length > 0 && (
                <SeenSection title={t('agentFlows.seen.pending')}>
                  <HintText>{t('agentFlows.seen.pendingHint')}</HintText>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {data.pending_upstream.map((v) => (
                      <span key={v} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-tiny">
                        {`{{${v}}}`}
                      </span>
                    ))}
                  </div>
                </SeenSection>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SeenSection({
  title, children, defaultOpen = false,
}: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <b className="text-caption font-strong">{title}</b>
        <span className="text-tiny text-text-tertiary">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-[rgb(var(--border-line))] p-3">{children}</div>}
    </div>
  );
}

/** The system prompt with the author's own instructions marked inside it.
 *
 *  Split rather than annotated: the backend hands back both the whole string and
 *  the author's part, so the seam is found by locating one in the other. When the
 *  step's prompt uses variables the resolved text will not match the raw one and
 *  the highlight is skipped — showing the prompt unmarked is right, guessing at a
 *  range is not. */
function PromptWithYours({ full, yours }: { full: string; yours: string }) {
  const at = yours.trim() ? full.indexOf(yours.trim()) : -1;
  if (at < 0) {
    return (
      <pre className="max-h-[38vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-tiny leading-relaxed text-text-secondary">
        {full}
      </pre>
    );
  }
  return (
    <pre className="max-h-[38vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-tiny leading-relaxed text-text-secondary">
      {full.slice(0, at)}
      <mark className="rounded bg-brand/15 text-text-primary">{full.slice(at, at + yours.trim().length)}</mark>
      {full.slice(at + yours.trim().length)}
    </pre>
  );
}

