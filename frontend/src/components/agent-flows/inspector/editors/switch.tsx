// The switch step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Plus } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Field, Select, Toggle } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, SwitchNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function SwitchEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'switch' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.switch` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as SwitchNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
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
    </>
  );
}
