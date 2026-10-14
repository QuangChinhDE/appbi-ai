// The filter step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { HintText, SectionTitle } from '../../shared';
import { ConditionRows, Field, Select } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, FilterNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function FilterEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'filter' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.filter` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as FilterNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
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
    </>
  );
}
