// The tool step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { HintText } from '../../shared';
import { Field, Select } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import { ToolArguments } from '../ToolPicker';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, ToolNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function ToolEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'tool' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.tool` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as ToolNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
        <>
          <Field label={t('agentFlows.inspector.tool.pick')}
            hint={t('agentFlows.inspector.tool.pickHint')}>
            <Select
              value={node.tool || ''}
              onChange={(v) => set({ tool: v, inputs: {} } as Partial<FlowNode>)}
              options={[
                { value: '', label: t('agentFlows.inspector.tool.none') },
                ...toolPacks.flatMap((p) => p.tools.map((tl) => ({
                  value: tl.name,
                  label: `${(language === 'vi' ? tl.label_vi : tl.label_en) || tl.name}  ·  ${tl.name}`,
                }))),
              ]} />
          </Field>

          {/* ARGUMENTS COME FROM THE TOOL, not from free text. Each one is bound
              to a variable or to a literal, and what is stored keeps its type —
              which is what lets a mismatch be caught when the flow is published
              rather than when a viewer is waiting. */}
          {node.tool ? (
            <ToolArguments
              tool={node.tool}
              packs={toolPacks}
              value={node.inputs || {}}
              onChange={(inputs) => set({ inputs } as Partial<FlowNode>)}
            />
          ) : (
            <HintText>{t('agentFlows.inspector.tool.pickFirst')}</HintText>
          )}

          <HintText>{t('agentFlows.inspector.tool.hint')}</HintText>
        </>
    </>
  );
}
