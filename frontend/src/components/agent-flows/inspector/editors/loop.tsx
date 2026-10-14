// The loop step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Input } from '@/components/ui/Input';
import { Field, NumberField } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, LoopNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function LoopEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'loop' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.loop` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as LoopNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
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
    </>
  );
}
