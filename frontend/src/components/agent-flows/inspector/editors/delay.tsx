// The delay step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Field, NumberField } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, DelayNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function DelayEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'delay' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.delay` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as DelayNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
        <>
          <Field
            label={t('agentFlows.inspector.delaySeconds')}
            hint={t('agentFlows.inspector.delayHint')}
          >
            <NumberField min={0} max={30} value={node.seconds ?? 1}
              onCommit={(n) => set({ seconds: n } as Partial<FlowNode>)} />
          </Field>
        </>
    </>
  );
}
