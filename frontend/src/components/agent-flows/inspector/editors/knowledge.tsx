// The knowledge step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Textarea } from '@/components/ui/Input';
import { Field, NumberField } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import { KnowledgeAttachments } from '../../shared';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, KnowledgeNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function KnowledgeEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'knowledge' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.knowledge` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as KnowledgeNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
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
    </>
  );
}
