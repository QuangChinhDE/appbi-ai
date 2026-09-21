// The transform step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Input } from '@/components/ui/Input';
import { Field, Select } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, TransformNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function TransformEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'transform' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.transform` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as TransformNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
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
    </>
  );
}
