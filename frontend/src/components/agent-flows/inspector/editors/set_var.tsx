// The set_var step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Input, Textarea } from '@/components/ui/Input';
import { Field, Select } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, SetVarNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function SetVarEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'set_var' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.set_var` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as SetVarNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
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
    </>
  );
}
