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

import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';
import {
  MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS, slugifyBrainKey,
  type Condition, type ConditionOp, type FlowNode, type FlowPath, type FlowType,
  type Attachable, type NodeSpec, type ProviderGroup, type SwitchCase,
  type SkillSummary,
  type ToolPack,
  previewStep,
  type StepPreview,
  type ToolInput,
} from '@/lib/agentFlows';
import { SectionTitle, HintText } from './shared';
import {
  Field, Select, Toggle, NumberField, Advanced, PathForm, CaseForm,
  RUN_POLICY, CONTEXT_POLICY, specLabel,
} from './inspector/fields';
import { NODE_EDITORS } from './inspector/registry';

export interface InspectorProps {
  node: FlowNode | null;
  /** Set when the selection is a branch lane rather than a node. */
  path?: FlowPath | null;
  switchCase?: SwitchCase | null;
  isFallback?: boolean;
  spec?: NodeSpec;
  specs: Record<string, NodeSpec>;
  toolPacks: ToolPack[];
  /** Published Skills this author may attach (Agent grants and Skill steps). */
  skills?: SkillSummary[];
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


/** The shell: the fields EVERY step has, with the type-specific ones looked up.
 *
 *  It used to be one 695-line function holding fourteen `node.type === 'x' &&`
 *  branches, so an author adding a node type edited the same render as everyone
 *  else and a reader looking for one editor scrolled past thirteen. What is left
 *  here is only what is genuinely common: the name, the result/rerun block, the
 *  error block, and the answer-node action.
 */
function NodeForm(props: InspectorProps & { node: FlowNode }) {
  const { t, language } = useI18n();
  const { node, spec, toolPacks, providers, isAnswerNode, onChange, onMakeAnswer,
    brainKey, attachable, flowType, skills = [] } = props;
  const set = (patch: Partial<FlowNode>) => onChange({ ...node, ...patch } as FlowNode);
  const [seeing, setSeeing] = React.useState(false);
  const Editor = NODE_EDITORS[node.type];

  return (
    <div className="p-3">
      <Field label={t('agentFlows.inspector.stepName')}>
        <Input value={node.name || ''} onChange={(e) => set({ name: e.target.value })}
          placeholder={specLabel(spec, language) || node.type} />
      </Field>

      {/* ── per-type, from the registry ──────────────────────────────────── */}
      {Editor ? (
        <Editor
          node={node}
          set={set}
          spec={spec}
          toolPacks={toolPacks}
          skills={skills}
          providers={providers}
          attachable={attachable}
          brainKey={brainKey}
          flowType={flowType}
          isAnswerNode={isAnswerNode}
          seeing={seeing}
          setSeeing={setSeeing}
        />
      ) : null}


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
