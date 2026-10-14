// The web step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Input, Textarea } from '@/components/ui/Input';
import { Field } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, WebNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function WebEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'web' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.web` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as WebNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
        <>
          <Field label={t('agentFlows.inspector.webQuery')}>
            <Textarea rows={3} value={node.query || ''}
              onChange={(e) => set({ query: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.allowedDomains')}
            hint={t('agentFlows.inspector.allowedDomainsHint')}>
            <Input
              value={(node.allowed_domains || []).join(', ')}
              onChange={(e) => set({
                allowed_domains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              } as Partial<FlowNode>)}
              placeholder="statista.com, thinkwithgoogle.com"
            />
          </Field>
          <p className="mt-2 rounded-md border border-warning/25 bg-warning/5 p-2 text-caption text-warning">
            {t('agentFlows.inspector.webGateHint')}
          </p>
        </>
    </>
  );
}
