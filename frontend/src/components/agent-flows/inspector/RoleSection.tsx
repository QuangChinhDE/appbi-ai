// Specialized Agent role + "reads from" — the two things that make a multi-agent
// flow legible: what this step is FOR, and which earlier results it works from.
//
// The role list and every tool boundary come from the server (`roles.py`); this
// file only displays them. Changing a role here drops grants the new role does
// not allow and SAYS which — the server would refuse to save them anyway.
import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/providers/LanguageProvider';
import { applyRole, roleText, type AgentNode, type AgentRole, type FlowNode } from '@/lib/agentFlows';
import { HintText, SectionTitle } from '../shared';
import { Field, Select } from './fields';
import type { EarlierStep } from './types';

export function RoleSection({ node, roles, set, toolLabel }: {
  node: AgentNode;
  roles: AgentRole[];
  set: (patch: Partial<FlowNode>) => void;
  toolLabel: (name: string) => string;
}) {
  const { t, language } = useI18n();
  const [removed, setRemoved] = React.useState<string[]>([]);
  const role = roles.find((r) => r.key === node.role) || null;
  const unknown = !!node.role && !role && roles.length > 0;

  return (
    <div className="mb-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-2.5"
      data-testid="agent-role-section">
      <Field label={t('agentFlows.roles.field')} hint={t('agentFlows.roles.fieldHint')}>
        <Select
          value={node.role || ''}
          onChange={(v) => {
            const next = roles.find((r) => r.key === v) || null;
            const { patch, removed: dropped } = applyRole(
              node, next, roles, language, t('agentFlows.defaults.agentPrompt'));
            setRemoved(dropped);
            set(patch as Partial<FlowNode>);
          }}
          options={[
            { value: '', label: t('agentFlows.roles.custom') },
            ...roles.map((r) => ({ value: r.key, label: roleText(r, 'label', language) })),
          ]}
        />
      </Field>
      {unknown && (
        <p className="mt-1 text-caption text-danger">{t('agentFlows.roles.unknown', { role: node.role || '' })}</p>
      )}
      {role ? (
        <div className="mt-1 space-y-1 text-caption text-text-secondary" data-testid="agent-role-card">
          <p>{roleText(role, 'purpose', language)}</p>
          <p><b className="font-strong">{t('agentFlows.roles.consumes')}:</b> {roleText(role, 'consumes', language)}</p>
          <p><b className="font-strong">{t('agentFlows.roles.produces')}:</b> {roleText(role, 'produces', language)}</p>
          <p className="text-text-tertiary">{roleText(role, 'instead', language)}</p>
          <p className="text-tiny text-text-tertiary">
            {role.allowed_tools.length
              ? t('agentFlows.roles.boundary', { n: String(role.allowed_tools.length) })
              : t('agentFlows.roles.noToolsBoundary')}
          </p>
          {role.needs_knowledge && !(node.knowledge || []).length && (
            <p className="rounded-md border border-warning/25 bg-warning/5 p-1.5 text-warning"
              data-testid="agent-role-needs-knowledge">
              {t('agentFlows.roles.needsKnowledge')}
            </p>
          )}
        </div>
      ) : (
        <HintText>{t('agentFlows.roles.customHint')}</HintText>
      )}
      {removed.length > 0 && (
        <p className="mt-1.5 rounded-md border border-warning/25 bg-warning/5 p-1.5 text-caption text-warning"
          data-testid="agent-role-removed">
          {t('agentFlows.roles.removed', { tools: removed.map(toolLabel).join(', ') })}
        </p>
      )}
    </div>
  );
}

export function ReadsFromSection({ node, steps, set }: {
  node: AgentNode;
  steps: EarlierStep[];
  set: (patch: Partial<FlowNode>) => void;
}) {
  const { t } = useI18n();
  const chosen = node.reads_from || [];
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
  const free = steps.filter((s) => !chosen.includes(s.key));
  return (
    <div className="mt-4 border-t border-[rgb(var(--border-line))] pt-3" data-testid="agent-reads-from">
      <SectionTitle>{t('agentFlows.roles.readsFrom')}</SectionTitle>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {chosen.map((k) => (
          <span key={k}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption ${
              byKey[k] ? 'border-brand/25 bg-brand/5 text-brand' : 'border-danger/30 bg-danger/5 text-danger'}`}>
            {byKey[k]?.name || k}
            {!byKey[k] && <span className="text-tiny">({t('agentFlows.roles.notBefore')})</span>}
            <button type="button" aria-label={t('common.delete')}
              onClick={() => set({ reads_from: chosen.filter((x) => x !== k) } as Partial<FlowNode>)}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {!chosen.length && (
          <span className="text-caption text-text-tertiary">{t('agentFlows.roles.readsPrevious')}</span>
        )}
      </div>
      {free.length > 0 && (
        <div className="mt-1.5">
          <Select
            value=""
            onChange={(v) => v && set({ reads_from: [...chosen, v] } as Partial<FlowNode>)}
            options={[
              { value: '', label: t('agentFlows.roles.addInput') },
              ...free.map((s) => ({ value: s.key, label: `${s.name} (${s.type})` })),
            ]}
          />
        </div>
      )}
      <HintText>{t('agentFlows.roles.readsFromHint')}</HintText>
    </div>
  );
}
