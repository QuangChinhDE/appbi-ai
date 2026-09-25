// The Skill step's editor: which published Skill, and what goes into it.
//
// A Skill receives ONLY its declared inputs — nothing of this flow's variables
// or conversation — so the inputs are listed from the Skill's own contract and
// bound here, the same way a Tool step binds its arguments.
import React from 'react';
import { HintText } from '../../shared';
import { Field, Select } from '../fields';
import { BindingRows } from '../ToolPicker';
import { useI18n } from '@/providers/LanguageProvider';
import type { NodeEditorProps } from '../types';
import type { FlowNode, SkillNode } from '@/lib/agentFlows';

export function SkillEditor(props: NodeEditorProps) {
  const { t } = useI18n();
  const { set, skills } = props;
  const node = props.node as SkillNode;
  const skill = skills.find((s) => s.key === node.skill_key);
  const pinned = node.version ?? null;
  const newer = skill && pinned != null && skill.version > pinned;

  return (
    <>
      <Field label={t('agentFlows.inspector.skill.pick')}
        hint={t('agentFlows.inspector.skill.pickHint')}>
        <Select
          value={node.skill_key || ''}
          onChange={(v) => set({ skill_key: v, version: null, inputs: {} } as Partial<FlowNode>)}
          options={[
            { value: '', label: t('agentFlows.inspector.skill.none') },
            ...skills.map((s) => ({ value: s.key, label: `${s.name}  ·  v${s.version}` })),
          ]} />
      </Field>

      {node.skill_key && !skill && (
        <HintText>{t('agentFlows.inspector.skill.unavailable', { key: node.skill_key })}</HintText>
      )}

      {skill && (
        <>
          <p className="mb-2 text-caption leading-snug text-text-tertiary">{skill.contract.when_to_use}</p>
          {/* WHICH VERSION RUNS. A published flow is pinned to an exact Skill
              version at publish, so a newer Skill never changes it by itself —
              adopting it is a decision, taken here and then published. */}
          <p className="mb-2 text-caption text-text-tertiary">
            {pinned != null
              ? t('agentFlows.inspector.skill.pinned', { version: String(pinned) })
              : t('agentFlows.inspector.skill.unpinned', { version: String(skill.version) })}
            {newer && (
              <button type="button"
                className="ml-1.5 text-brand underline-offset-2 hover:underline"
                onClick={() => set({ version: skill.version } as Partial<FlowNode>)}>
                {t('agentFlows.inspector.skill.useNewer', { version: String(skill.version) })}
              </button>
            )}
          </p>
          {skill.contract.inputs.length ? (
            <BindingRows
              args={skill.contract.inputs.map((i) => [
                i.name, { type: i.type, required: i.required, description: i.description },
              ])}
              value={node.inputs || {}}
              onChange={(inputs) => set({ inputs } as Partial<FlowNode>)}
            />
          ) : (
            <HintText>{t('agentFlows.inspector.skill.noInputs')}</HintText>
          )}
        </>
      )}
      <HintText>{t('agentFlows.inspector.skill.hint')}</HintText>
    </>
  );
}
