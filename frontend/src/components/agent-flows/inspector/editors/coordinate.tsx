// The coordinate step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { HintText } from '../../shared';
import { Field, NumberField } from '../fields';
import { useI18n } from '@/providers/LanguageProvider';
import { slugifyBrainKey } from '@/lib/agentFlows';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, CoordinateNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function CoordinateEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'coordinate' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.coordinate` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as CoordinateNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
        <>
          <Field
            label={t('agentFlows.inspector.coordinatePrompt')}
            hint={t('agentFlows.inspector.coordinatePromptHint')}
          >
            <Textarea
              rows={2}
              value={node.prompt || ''}
              onChange={(e) => set({ prompt: e.target.value } as Partial<FlowNode>)}
              placeholder={t('agentFlows.inspector.coordinatePromptPlaceholder')}
            />
          </Field>
          <Field
            label={t('agentFlows.inspector.maxSpecialists')}
            hint={t('agentFlows.inspector.maxSpecialistsHint')}
          >
            <NumberField
              min={1} max={8}
              value={node.max_specialists ?? 3}
              onCommit={(n) => set({ max_specialists: n } as Partial<FlowNode>)}
            />
          </Field>

          {/* WHEN-TO-USE IS THE WHOLE INPUT TO THE ROUTING DECISION.
              A classifier handed bare keys sent a plain lookup down the forecast
              branch and never fired the lookup case once. So the field is edited
              here, beside the specialist's name, and a blank one is called out
              rather than left to fail quietly at run time. */}
          <div className="mt-3 space-y-2">
            {(node.specialists || []).map((sp, i) => (
              <div
                key={sp.key}
                className="rounded-lg border border-[rgb(var(--border-line))] p-2.5 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={sp.name || ''}
                    placeholder={t('agentFlows.inspector.specialistName')}
                    onChange={(e) => {
                      // THE KEY FOLLOWS THE NAME WHILE IT IS STILL THE DEFAULT.
                      //
                      // `chuyen_gia_1` is what the planner is shown beside each
                      // `when`, and what the run trace records as the pick —
                      // observed as `picked: ["chuyen_gia_1", "chuyen_gia_2"]`,
                      // which tells an author reading their own run nothing at
                      // all. There is no key field on purpose: two names for one
                      // thing is how they drift.
                      const name = e.target.value;
                      const auto = /^chuyen_gia_\d+$/.test(sp.key);
                      const slug = slugifyBrainKey(name);
                      const taken = new Set(
                        node.specialists.filter((_, j) => j !== i).map((x) => x.key));
                      const nextKey = auto && slug && !taken.has(slug) ? slug : sp.key;
                      set({
                        specialists: node.specialists.map((x, j) =>
                          j === i ? { ...x, name, key: nextKey } : x),
                      } as Partial<FlowNode>);
                    }}
                  />
                  <button
                    type="button"
                    title={t('agentFlows.inspector.removeSpecialist')}
                    className="shrink-0 rounded p-1 text-text-tertiary hover:text-danger disabled:opacity-40"
                    disabled={(node.specialists || []).length <= 2}
                    onClick={() => set({
                      specialists: node.specialists.filter((_, j) => j !== i),
                    } as Partial<FlowNode>)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <Textarea
                  rows={2}
                  value={sp.when || ''}
                  placeholder={t('agentFlows.inspector.specialistWhenPlaceholder')}
                  onChange={(e) => set({
                    specialists: node.specialists.map((x, j) =>
                      j === i ? { ...x, when: e.target.value } : x),
                  } as Partial<FlowNode>)}
                />
                {(sp.when || '').trim().length < 8 && (
                  <p className="text-[10px] leading-tight text-warning">
                    {t('agentFlows.inspector.specialistWhenRequired')}
                  </p>
                )}
              </div>
            ))}
          </div>
          <Button
            variant="secondary" size="xs" className="mt-2"
            onClick={() => set({
              specialists: [...(node.specialists || []), {
                key: `chuyen_gia_${(node.specialists || []).length + 1}`,
                name: '', when: '', body: [],
              }],
            } as Partial<FlowNode>)}
          >
            <Plus className="h-3 w-3" /> {t('agentFlows.inspector.addSpecialist')}
          </Button>
          <HintText>{t('agentFlows.inspector.coordinateHint')}</HintText>
        </>
    </>
  );
}
