'use client';

/**
 * AI Studio shell.
 *
 * Four tabs, in the order the job is actually done:
 *   Trợ lý     → which chatbot serves which report (the outcome)
 *   Luồng      → the procedures a chatbot can run
 *   Chuyên gia → the individual AI roles a procedure is built from
 *   Lượt chạy  → what actually happened, with cost and evidence
 *
 * Assistants come FIRST on purpose: "which report gets which bot" is the thing
 * a newcomer understands, and it is the last step of building — opening on the
 * outcome rather than the parts.
 *
 * The four editors (flow, specialist, assistant, run) are full SCREENS, not
 * modals. Each is a job with its own tabs and its own unsaved state; a dialog
 * that can be dismissed by a stray click on the backdrop is the wrong container
 * for work that takes twenty minutes.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Command, GitBranch, ListTree, Plus, Trash2, Upload, Users } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { toast } from '@/lib/toast';
import {
  type AgentVersion, type Assistant, type AssistantBinding, type FlowSummary,
  type Palette, type RunRow, type Surfaces,
  deleteAssistant, getPalette, getSurfaces, listAgents, listAssistants, listFlows,
  listRuns, publishAgent, saveAssistant,
} from '@/lib/aiFlows';
import { useI18n } from '@/providers/LanguageProvider';
import { AgentEditor } from './agents/AgentEditor';
import { AssistantPage } from './assistants/AssistantPage';
import { FlowBuilderV2 } from './builder/FlowBuilderV2';
import { CommandPalette, ShortcutSheet, type Command as Cmd, useCommandPalette } from './CommandPalette';
import { FlowsTab } from './FlowsTab';
import { RunDetail } from './runs/RunDetail';
import {
  EmptyHint, Panel, StatusBadge, errText, timeAgo, useCanEdit, useCanPublish,
} from './shared';

type TabKey = 'assistants' | 'flows' | 'agents' | 'runs';

/** Which full-screen editor is open, if any. */
type Screen =
  | { kind: 'flow'; key: string; version: number }
  | { kind: 'agent'; key: string | null }
  | { kind: 'assistant'; key: string }
  | { kind: 'run'; id: string };

function countBadge(n: number): React.ReactNode {
  return n > 0 ? <Badge variant="subtle" size="xs">{n}</Badge> : undefined;
}

export function StudioPage() {
  const { t } = useI18n();
  const canEdit = useCanEdit();
  const canPublish = useCanPublish();

  const [tab, setTab] = useState<TabKey>('assistants');
  const [screen, setScreen] = useState<Screen | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [agents, setAgents] = useState<AgentVersion[]>([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [surfaces, setSurfaces] = useState<Surfaces | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);

  const { paletteOpen, setPaletteOpen, helpOpen, setHelpOpen } = useCommandPalette();

  const reload = useCallback(() => {
    listFlows().then(setFlows).catch(() => undefined);
    listAgents().then(setAgents).catch(() => undefined);
    listAssistants().then(setAssistants).catch(() => undefined);
    getSurfaces().then(setSurfaces).catch(() => undefined);
    listRuns({ limit: 50 }).then(setRuns).catch(() => undefined);
  }, []);

  useEffect(() => {
    getPalette().then(setPalette).catch(() => undefined);
    reload();
  }, [reload]);

  const back = () => { setScreen(null); reload(); };

  const commands = useMemo<Cmd[]>(() => {
    const go = t('aiFlows.cmd.groupGo');
    const doGroup = t('aiFlows.cmd.groupDo');
    const flowGroup = t('aiFlows.cmd.groupFlows');
    const list: Cmd[] = [
      { id: 'go-assistants', group: go, label: t('aiFlows.tab.assistants'), run: () => { setScreen(null); setTab('assistants'); } },
      { id: 'go-flows', group: go, label: t('aiFlows.tab.flows'), run: () => { setScreen(null); setTab('flows'); } },
      { id: 'go-agents', group: go, label: t('aiFlows.tab.agents'), run: () => { setScreen(null); setTab('agents'); } },
      { id: 'go-runs', group: go, label: t('aiFlows.tab.runs'), run: () => { setScreen(null); setTab('runs'); } },
    ];
    if (canEdit) {
      list.push({
        id: 'new-agent', group: doGroup, label: t('aiFlows.agents.create'),
        run: () => setScreen({ kind: 'agent', key: null }),
      });
    }
    flows.forEach((f) => list.push({
      id: `flow-${f.flow_key}-${f.version}`,
      group: flowGroup,
      label: f.display_name,
      hint: `${f.flow_key} · v${f.version}`,
      run: () => setScreen({ kind: 'flow', key: f.flow_key, version: f.version }),
    }));
    return list;
  }, [canEdit, flows, t]);

  const overlays = (
    <>
      {paletteOpen && (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      )}
      {helpOpen && <ShortcutSheet onClose={() => setHelpOpen(false)} />}
    </>
  );

  if (screen?.kind === 'flow') {
    return (
      <>
        <FlowBuilderV2
          flowKey={screen.key}
          version={screen.version}
          palette={palette}
          agents={agents}
          onBack={back}
          onChanged={reload}
          onOpenAgent={(agentRef) => setScreen({
            kind: 'agent',
            key: agentRef ? String(agentRef).split('@')[0] : null,
          })}
        />
        {overlays}
      </>
    );
  }

  if (screen?.kind === 'agent') {
    return (
      <>
        <AgentEditor
          agentKey={screen.key}
          palette={palette}
          onBack={back}
          onChanged={reload}
        />
        {overlays}
      </>
    );
  }

  if (screen?.kind === 'assistant') {
    const found = assistants.find((a) => a.key === screen.key);
    if (found) {
      return (
        <>
          <AssistantPage
            assistant={found}
            flows={flows}
            surfaces={surfaces}
            palette={palette}
            onBack={back}
            onChanged={reload}
          />
          {overlays}
        </>
      );
    }
  }

  if (screen?.kind === 'run') {
    return (
      <>
        <RunDetail runId={screen.id} palette={palette} onBack={back} />
        {overlays}
      </>
    );
  }

  return (
    <div className="px-8 py-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-strong text-text-primary">{t('aiFlows.page.title')}</h1>
          <p className="mt-1 max-w-3xl text-caption text-text-secondary">
            {t('aiFlows.page.subtitle')}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(true)}>
          <Command className="h-4 w-4" /> {t('aiFlows.cmd.hint', { keys: 'Ctrl K' })}
        </Button>
      </header>

      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        items={[
          // Counts go through <Badge> rather than as bare numbers: two adjacent
          // text nodes collapse into one anonymous flex item, so a raw count
          // renders glued to the label ("Flows3").
          { key: 'assistants', label: t('aiFlows.tab.assistants'), icon: <Users className="h-3.5 w-3.5" />, badge: countBadge(assistants.length) },
          { key: 'flows', label: t('aiFlows.tab.flows'), icon: <GitBranch className="h-3.5 w-3.5" />, badge: countBadge(flows.length) },
          { key: 'agents', label: t('aiFlows.tab.agents'), icon: <Bot className="h-3.5 w-3.5" />, badge: countBadge(agents.length) },
          { key: 'runs', label: t('aiFlows.tab.runs'), icon: <ListTree className="h-3.5 w-3.5" />, badge: countBadge(runs.length) },
        ]}
      />

      {tab === 'assistants' && (
        <AssistantsTab
          assistants={assistants}
          flows={flows}
          surfaces={surfaces}
          canEdit={canEdit}
          onOpen={(key) => setScreen({ kind: 'assistant', key })}
          onChanged={reload}
        />
      )}
      {tab === 'flows' && (
        <FlowsTab
          flows={flows}
          canEdit={canEdit}
          canPublish={canPublish}
          onOpen={(key, version) => setScreen({ kind: 'flow', key, version })}
          onChanged={reload}
        />
      )}
      {tab === 'agents' && (
        <AgentsTab
          agents={agents}
          canEdit={canEdit}
          canPublish={canPublish}
          onOpen={(key) => setScreen({ kind: 'agent', key })}
          onChanged={reload}
        />
      )}
      {tab === 'runs' && (
        <RunsTab
          runs={runs}
          onRefresh={reload}
          onOpen={(id) => setScreen({ kind: 'run', id })}
        />
      )}

      {overlays}
    </div>
  );
}

// ── Assistants list ──────────────────────────────────────────────────────────
function AssistantsTab({ assistants, flows, surfaces, canEdit, onOpen, onChanged }: {
  assistants: Assistant[];
  flows: FlowSummary[];
  surfaces: Surfaces | null;
  canEdit: boolean;
  onOpen: (key: string) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const published = flows.filter((f) => f.status === 'published');

  const createNew = async () => {
    const key = `assistant_${Date.now().toString(36)}`;
    try {
      await saveAssistant({
        key,
        display_name: t('aiFlows.assistants.create'),
        status: 'draft',
        routing: published.length
          ? [{ when_intent: ['*'], flow: published[0].flow_key }]
          : [],
        budget: { max_usd_per_day: 5 },
      });
      onChanged();
      onOpen(key);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-caption text-text-tertiary">
          {t('aiFlows.assistants.subtitle')}
        </p>
        {canEdit && (
          <Button variant="primary" size="sm" onClick={createNew}>
            <Plus className="h-4 w-4" /> {t('aiFlows.assistants.create')}
          </Button>
        )}
      </div>

      {assistants.length === 0 ? (
        <EmptyHint>{t('aiFlows.assistants.empty')}</EmptyHint>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {assistants.map((a) => (
            <Panel
              key={a.key}
              title={
                <span className="flex items-center gap-2">
                  {a.display_name}
                  <Badge variant={a.status === 'published' ? 'success' : 'warning'} size="xs">
                    {a.status === 'published'
                      ? t('aiFlows.assistants.statusPublished')
                      : t('aiFlows.status.draft')}
                  </Badge>
                </span>
              }
              sub={<code>{a.key}</code>}
              action={canEdit && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="xs" onClick={() => onOpen(a.key)}>
                    {t('aiFlows.assistants.open')}
                  </Button>
                  <Button
                    variant="ghost" size="xs"
                    onClick={async () => {
                      if (!confirm(t('aiFlows.assistants.deleteConfirm', { name: a.display_name }))) return;
                      try {
                        await deleteAssistant(a.key);
                        onChanged();
                        toast.success(t('aiFlows.common.saved'));
                      } catch (e) { toast.error(errText(e)); }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-danger" />
                  </Button>
                </div>
              )}
            >
              <div className="space-y-2">
                <div>
                  <div className="mb-1 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
                    {t('aiFlows.assistants.routing')}
                  </div>
                  {a.routing.length === 0 ? (
                    <span className="text-tiny text-warning">
                      {t('aiFlows.assistants.wildcardMissing')}
                    </span>
                  ) : (
                    <ol className="space-y-0.5">
                      {a.routing.map((r, i) => (
                        <li key={i} className="text-tiny text-text-secondary">
                          <span className="mr-1 text-text-quaternary">{i + 1}.</span>
                          <code className="rounded bg-surface-2 px-1">
                            {(r.when_intent ?? []).join(', ')}
                          </code>
                          {' → '}
                          <code className="rounded bg-brand/10 px-1 text-brand">{r.flow}</code>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-tiny font-strong uppercase tracking-wide text-text-quaternary">
                    {t('aiFlows.assistants.serving')}
                  </div>
                  {a.bindings.length === 0 ? (
                    <span className="text-tiny text-text-tertiary">
                      {t('aiFlows.assistants.notServing')}
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {a.bindings.map((b) => (
                        <Badge key={`${b.surface}-${b.surface_ref}`} variant="info" size="xs">
                          {labelForBinding(b, surfaces, t)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function labelForBinding(
  b: AssistantBinding, surfaces: Surfaces | null, t: (k: string) => string,
): string {
  if (b.surface === 'global') return t('aiFlows.assistants.surfaceGlobal');
  if (b.surface === 'dashboard') {
    const d = surfaces?.dashboards.find((x) => String(x.id) === b.surface_ref);
    return `${t('aiFlows.assistants.surfaceDashboard')}: ${d?.name ?? b.surface_ref}`;
  }
  const l = surfaces?.public_links.find((x) => x.token === b.surface_ref);
  return `${t('aiFlows.assistants.surfaceLink')}: ${l?.dashboard_name ?? (b.surface_ref ?? '').slice(0, 10)}`;
}

// ── Specialists list ─────────────────────────────────────────────────────────
function AgentsTab({ agents, canEdit, canPublish, onOpen, onChanged }: {
  agents: AgentVersion[];
  canEdit: boolean;
  canPublish: boolean;
  onOpen: (key: string | null) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-caption text-text-tertiary">
          {t('aiFlows.agents.subtitle')}
        </p>
        {canEdit && (
          <Button variant="primary" size="sm" onClick={() => onOpen(null)}>
            <Plus className="h-4 w-4" /> {t('aiFlows.agents.create')}
          </Button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {agents.map((a) => (
          <Panel
            key={`${a.agent_key}-${a.version}`}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {a.display_name}
                <StatusBadge status={a.status} />
                {a.is_builtin && (
                  <Badge variant="info" size="xs">{t('aiFlows.status.builtin')}</Badge>
                )}
              </span>
            }
            sub={<><code>{a.ref}</code> · {a.model_policy}</>}
            action={
              <div className="flex gap-1">
                <Button variant="ghost" size="xs" onClick={() => onOpen(a.agent_key)}>
                  {t('aiFlows.agents.open')}
                </Button>
                {canPublish && a.status === 'draft' && (
                  <Button
                    variant="ghost" size="xs" title={t('aiFlows.agents.publish')}
                    onClick={async () => {
                      try {
                        await publishAgent(a.agent_key, a.version);
                        toast.success(t('aiFlows.common.saved'));
                        onChanged();
                      } catch (e) { toast.error(errText(e)); }
                    }}
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            }
          >
            <p className="line-clamp-3 whitespace-pre-wrap text-tiny leading-relaxed text-text-secondary">
              {a.prompt_template || t('aiFlows.agents.noPrompt')}
            </p>
            {a.tool_allowlist.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {a.tool_allowlist.slice(0, 6).map((name) => (
                  <Badge key={name} variant="subtle" size="xs">{name}</Badge>
                ))}
                {a.tool_allowlist.length > 6 && (
                  <Badge variant="subtle" size="xs">+{a.tool_allowlist.length - 6}</Badge>
                )}
              </div>
            )}
          </Panel>
        ))}
      </div>
    </div>
  );
}

// ── Runs list ────────────────────────────────────────────────────────────────
function RunsTab({ runs, onRefresh, onOpen }: {
  runs: RunRow[];
  onRefresh: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-caption text-text-tertiary">
          {t('aiFlows.runs.subtitle')}
        </p>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          {t('aiFlows.runs.refresh')}
        </Button>
      </div>

      {runs.length === 0 ? (
        <EmptyHint>{t('aiFlows.runs.empty')}</EmptyHint>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[rgb(var(--border-line))]">
          <table className="w-full text-caption">
            <thead className="bg-surface-2 text-tiny uppercase tracking-wide text-text-quaternary">
              <tr>
                <th className="px-3 py-2 text-left">{t('aiFlows.runs.colQuestion')}</th>
                <th className="px-3 py-2 text-left">{t('aiFlows.runs.colFlow')}</th>
                <th className="px-3 py-2 text-left">{t('aiFlows.runs.colVerification')}</th>
                <th className="px-3 py-2 text-right">{t('aiFlows.runs.colCost')}</th>
                <th className="px-3 py-2 text-right">{t('aiFlows.runs.colLatency')}</th>
                <th className="px-3 py-2 text-left">{t('aiFlows.runs.colTime')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => onOpen(r.id)}
                  className="cursor-pointer border-t border-[rgb(var(--border-line))] hover:bg-surface-2"
                >
                  <td className="max-w-xs truncate px-3 py-2 text-text-primary">
                    {r.question || '—'}
                    {r.mode === 'preview' && (
                      <Badge variant="subtle" size="xs" className="ml-1">
                        {t('aiFlows.runs.modePreview')}
                      </Badge>
                    )}
                    {r.error_code && (
                      <Badge variant="danger" size="xs" className="ml-1">{r.error_code}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2"><code className="text-tiny">{r.flow_key}</code></td>
                  <td className="px-3 py-2">
                    {r.verification_coverage == null ? (
                      <span className="text-tiny text-text-quaternary">—</span>
                    ) : (
                      <Badge
                        variant={r.verification_coverage >= 0.999 ? 'success' : 'warning'}
                        size="xs"
                      >
                        {Math.round(r.verification_coverage * 100)}%
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-text-secondary">
                    ${r.usd.toFixed(4)}
                  </td>
                  <td className="px-3 py-2 text-right text-text-secondary">
                    {r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)}s` : '—'}
                  </td>
                  <td className="px-3 py-2 text-tiny text-text-tertiary">
                    {timeAgo(r.started_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
