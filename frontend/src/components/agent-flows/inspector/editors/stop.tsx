// The stop step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Textarea } from '@/components/ui/Input';
import { Field } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, StopNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function StopEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'stop' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.stop` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as StopNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
        <>
          <Field label={t('agentFlows.inspector.returnAnswer')} hint={t('agentFlows.inspector.returnAnswerHint')}>
            <Textarea rows={4} value={node.message || ''}
              onChange={(e) => set({ message: e.target.value } as Partial<FlowNode>)} />
          </Field>
        </>
    </>
  );
}
