// The agent step's own editor. Extracted verbatim from `NodeForm`; the
// registry in `../registry.ts` is what reaches it, so a new node type adds a
// file here instead of another branch in a 695-line switch.
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { HintText, SectionTitle } from '../../shared';
import { Advanced, Field, NumberField, Select } from '../fields';
import { ToolPicker } from '../ToolPicker';
import { WhatTheAiSees } from '../WhatTheAiSees';
import { useI18n } from '@/providers/LanguageProvider';
import { KnowledgeAttachments } from '../../shared';
import type { NodeEditorProps } from '../types';
import type {
  Condition, ConditionOp, FlowNode, FlowPath, SwitchCase, ToolInput, AgentNode,
} from '@/lib/agentFlows';
import { MAX_LOOP_ITERATIONS, MAX_TOOL_CALLS } from '@/lib/agentFlows';


export function AgentEditor(props: NodeEditorProps) {
  const { t, language } = useI18n();
  const { set, spec, toolPacks, providers, attachable, brainKey,
    flowType, isAnswerNode, seeing, setSeeing } = props;
  // NARROWED HERE, because the registry is what guarantees it. Inside the old
  // `NodeForm` the `node.type === 'agent' &&` guard narrowed the union for
  // free; a file reached only through `NODE_EDITORS.agent` has the same
  // guarantee from a different place, and says so once instead of per field.
  const node = props.node as AgentNode;
  void language; void spec; void toolPacks; void providers; void attachable;
  void brainKey; void flowType; void isAnswerNode; void seeing; void setSeeing;
  return (
    <>
        <>
          <Field label={t('agentFlows.inspector.agentPrompt')}
            hint={t('agentFlows.inspector.agentPromptHint')}>
            <Textarea rows={6} value={node.prompt}
              onChange={(e) => set({ prompt: e.target.value } as Partial<FlowNode>)} />
          </Field>
          <Field label={t('agentFlows.inspector.outputFormat')}>
            <Select
              value={node.output_format || 'chat'}
              onChange={(v) => set({
                output_format: v as 'chat' | 'json' | 'choice',
              } as Partial<FlowNode>)}
              options={[
                { value: 'chat', label: t('agentFlows.inspector.output.chat') },
                { value: 'json', label: t('agentFlows.inspector.output.json') },
                { value: 'choice', label: t('agentFlows.inspector.output.choice') },
              ]}
            />
            <HintText>
              {t('agentFlows.inspector.outputHint')}
            </HintText>
          </Field>

          {/* THE CLASSIFIER, WHICH HAD NO UI AT ALL.
              `choice` is what makes a Switch work: the step emits exactly one value
              from this list and the runtime enforces it. The backend has supported it
              from the start and the dropdown offered only chat and json, so the node
              that governs every branching flow could be created by API and nowhere
              else — and a Switch whose value nothing produces matches nothing and
              still reports ok.

              THE HINT IS NOT DECORATION. Options are usually variable names, and a
              model asked to choose between variable names is guessing what they were
              meant to stand for. Measured on a full-coverage harness: with bare keys
              a plain lookup question was routed to the FORECAST branch and the
              lookup branch never fired once in four questions. */}
          {node.output_format === 'choice' && (
            <Field
              label={t('agentFlows.inspector.choices')}
              hint={t('agentFlows.inspector.choicesHint')}
            >
              <div className="space-y-1.5">
                {(node.choices || []).map((c, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <Input
                      className="w-[38%] font-mono text-caption"
                      value={c}
                      placeholder={t('agentFlows.inspector.choiceValue')}
                      onChange={(e) => {
                        const next = [...(node.choices || [])];
                        const prev = next[i];
                        next[i] = e.target.value;
                        // Carry the description across a rename, or renaming a
                        // choice would silently orphan the words explaining it.
                        const hints = { ...(node.choice_hints || {}) };
                        if (prev && hints[prev] !== undefined) {
                          hints[e.target.value] = hints[prev];
                          delete hints[prev];
                        }
                        set({ choices: next, choice_hints: hints } as Partial<FlowNode>);
                      }}
                    />
                    <Input
                      className="flex-1"
                      value={(node.choice_hints || {})[c] || ''}
                      placeholder={t('agentFlows.inspector.choiceHint')}
                      onChange={(e) => set({
                        choice_hints: { ...(node.choice_hints || {}), [c]: e.target.value },
                      } as Partial<FlowNode>)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('common.delete')}
                      onClick={() => {
                        const next = (node.choices || []).filter((_, j) => j !== i);
                        const hints = { ...(node.choice_hints || {}) };
                        delete hints[c];
                        set({ choices: next, choice_hints: hints } as Partial<FlowNode>);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-1.5"
                onClick={() => set({
                  choices: [...(node.choices || []), ''],
                } as Partial<FlowNode>)}
              >
                <Plus className="h-3.5 w-3.5" /> {t('agentFlows.inspector.addChoice')}
              </Button>
              {/* Refused at save time by the contract, so it is said here first —
                  where the author is looking at the node rather than at a toast. */}
              {(node.choices || []).filter((c) => c.trim()).length < 2 && (
                <HintText>{t('agentFlows.inspector.choicesTooFew')}</HintText>
              )}
            </Field>
          )}
          <Advanced
            name="limits"
            title={t('agentFlows.inspector.maxToolCalls')}
            subtitle={t('agentFlows.adv.limitsSubtitle', { n: String(node.max_tool_calls ?? 8) })}
          >
            <NumberField min={1} max={MAX_TOOL_CALLS} value={node.max_tool_calls ?? 8}
              onCommit={(n) => set({ max_tool_calls: n } as Partial<FlowNode>)} />
          </Advanced>
          {/* PUT IT WHERE THE PROMPT IS, not in a menu. The question this answers
              — "will this step see what I think it sees" — is the one an author
              has while looking at the instructions they just typed. */}
          <Button
            size="sm"
            variant="secondary"
            className="mt-2 w-full"
            onClick={() => setSeeing(true)}
          >
            {t('agentFlows.seen.open')}
          </Button>
          {seeing && node && (
            <WhatTheAiSees
              brainKey={brainKey}
              flowType={props.flowType}
              nodeKey={node.key}
              nodeName={node.name || node.key}
              onClose={() => setSeeing(false)}
            />
          )}
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <SectionTitle>{t('agentFlows.inspector.grantedTools')}</SectionTitle>
            <ToolPicker
              packs={toolPacks}
              skills={props.skills}
              granted={(node.tools || []).map((t) => t.tool)}
              onToggle={(name, on) => set({
                tools: on
                  ? [...(node.tools || []), { tool: name }]
                  : (node.tools || []).filter((t) => t.tool !== name),
              } as Partial<FlowNode>)}
            />
            {isAnswerNode && (node.tools || []).length > 0 && (
              <p className="mt-2 rounded-md border border-warning/25 bg-warning/5 p-2 text-caption text-warning">
                {t('agentFlows.inspector.answerToolsWarning')}
              </p>
            )}
          </div>

          {/* An agent that may CALL tools may also LOOK THINGS UP. Both are reach,
              so they sit together rather than in two different mental places. */}
          <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3">
            <KnowledgeAttachments
              value={node.knowledge || []}
              options={attachable}
              onChange={(knowledge) => set({ knowledge } as Partial<FlowNode>)}
            />
          </div>
          <Advanced
            name="model"
            title={t('agentFlows.inspector.model')}
            subtitle={t('agentFlows.adv.modelSubtitle')}
          >
            <Select
              value={node.provider || 'inherit'}
              onChange={(v) => set({ provider: v as never, model: v === 'inherit' ? '' : node.model } as Partial<FlowNode>)}
              options={providers.map((p) => ({ value: p.provider, label: p.label }))}
            />
            {node.provider && node.provider !== 'inherit' && (
              <div className="mt-1.5">
                <Select
                  value={node.model || ''}
                  onChange={(v) => set({ model: v } as Partial<FlowNode>)}
                  options={[
                    { value: '', label: t('agentFlows.inspector.chooseModel') },
                    ...(providers.find((p) => p.provider === node.provider)?.models || [])
                      .map((m) => ({ value: m.model, label: m.label })),
                  ]}
                />
              </div>
            )}
            <HintText>
              {t('agentFlows.inspector.modelHint')}
            </HintText>
          </Advanced>
        </>
    </>
  );
}
