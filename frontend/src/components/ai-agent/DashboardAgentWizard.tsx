'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  LayoutDashboard,
  ListChecks,
  Loader2,
  PencilLine,
  RefreshCcw,
  Search,
  Sparkles,
  Table2,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { AppModalShell } from '@/components/common/AppModalShell';
import { useWorkspaces, WorkspaceWithTables } from '@/hooks/use-dataset-workspaces';
import apiClient from '@/lib/api-client';
import { AI_AGENT_HTTP_URL } from '@/lib/ai-services';

interface DashboardAgentWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

type WizardStep = 'select' | 'brief' | 'plan' | 'building';

interface SelectedTableRef {
  workspace_id: number;
  table_id: number;
}

interface AgentBriefRequest {
  goal: string;
  audience?: string;
  timeframe?: string;
  kpis: string[];
  questions: string[];
  selected_tables: SelectedTableRef[];
}

interface AgentChartPlan {
  key: string;
  title: string;
  chart_type: string;
  workspace_id: number;
  workspace_table_id: number;
  workspace_name: string;
  table_name: string;
  rationale: string;
  config: Record<string, any>;
}

interface EditableAgentChartPlan extends AgentChartPlan {
  enabled: boolean;
}

interface AgentSectionPlan {
  title: string;
  workspace_id: number;
  workspace_table_id: number;
  workspace_name: string;
  table_name: string;
  intent: string;
  chart_keys: string[];
}

interface AgentPlanResponse {
  dashboard_title: string;
  dashboard_summary: string;
  sections: AgentSectionPlan[];
  charts: AgentChartPlan[];
  warnings: string[];
}

interface EditableAgentPlan extends Omit<AgentPlanResponse, 'charts'> {
  charts: EditableAgentChartPlan[];
}

interface BuildEvent {
  type: string;
  phase: string;
  message: string;
  chart_id?: number;
  dashboard_id?: number;
  dashboard_url?: string;
  error?: string;
}

const STEP_META: Array<{ key: WizardStep; label: string; caption: string }> = [
  { key: 'select', label: 'Choose tables', caption: 'Set the analysis scope' },
  { key: 'brief', label: 'Write the brief', caption: 'Describe the business goal' },
  { key: 'plan', label: 'Review the draft', caption: 'Edit before building' },
  { key: 'building', label: 'Build dashboard', caption: 'Create charts and layout' },
];

const INITIAL_GOAL = 'Build an executive dashboard that tracks core KPIs and highlights the biggest changes';
const INITIAL_AUDIENCE = 'Executive team';
const INITIAL_TIMEFRAME = 'Last 30 days';
const INITIAL_KPIS = 'Revenue\nOrder volume\nGrowth';
const INITIAL_QUESTIONS = 'What is the main trend?\nWhich segment contributes the most?\nWhat anomaly needs attention?';

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePlan(plan: AgentPlanResponse): EditableAgentPlan {
  return {
    dashboard_title: plan.dashboard_title,
    dashboard_summary: plan.dashboard_summary,
    sections: plan.sections.map((section) => ({ ...section, chart_keys: [...section.chart_keys] })),
    charts: plan.charts.map((chart) => ({
      ...chart,
      enabled: true,
      config: JSON.parse(JSON.stringify(chart.config ?? {})),
    })),
    warnings: [...plan.warnings],
  };
}

function cloneEditablePlan(plan: EditableAgentPlan): EditableAgentPlan {
  return {
    dashboard_title: plan.dashboard_title,
    dashboard_summary: plan.dashboard_summary,
    sections: plan.sections.map((section) => ({ ...section, chart_keys: [...section.chart_keys] })),
    charts: plan.charts.map((chart) => ({
      ...chart,
      enabled: chart.enabled,
      config: JSON.parse(JSON.stringify(chart.config ?? {})),
    })),
    warnings: [...plan.warnings],
  };
}

function toBuildPlan(plan: EditableAgentPlan): AgentPlanResponse {
  const activeCharts = plan.charts
    .filter((chart) => chart.enabled)
    .map(({ enabled: _enabled, ...chart }) => chart);
  const allowedKeys = new Set(activeCharts.map((chart) => chart.key));
  const sections = plan.sections
    .map((section) => ({
      ...section,
      chart_keys: section.chart_keys.filter((key) => allowedKeys.has(key)),
    }))
    .filter((section) => section.chart_keys.length > 0);

  return {
    dashboard_title: plan.dashboard_title.trim(),
    dashboard_summary: plan.dashboard_summary.trim(),
    sections,
    charts: activeCharts,
    warnings: [...plan.warnings],
  };
}

function describeChartConfig(chart: AgentChartPlan): string[] {
  const roleConfig = (chart.config?.roleConfig ?? {}) as Record<string, any>;
  const notes: string[] = [];

  const metrics = Array.isArray(roleConfig.metrics) ? roleConfig.metrics : [];
  if (metrics.length > 0) {
    const metric = metrics[0];
    if (metric?.field) {
      notes.push(`Metric: ${metric.field}${metric.agg ? ` (${metric.agg})` : ''}`);
    }
  }

  if (typeof roleConfig.dimension === 'string' && roleConfig.dimension) {
    notes.push(`Dimension: ${roleConfig.dimension}`);
  }

  if (typeof roleConfig.timeField === 'string' && roleConfig.timeField) {
    notes.push(`Time: ${roleConfig.timeField}`);
  }

  if (Array.isArray(roleConfig.selectedColumns) && roleConfig.selectedColumns.length > 0) {
    notes.push(`Columns: ${roleConfig.selectedColumns.length}`);
  }

  return notes.slice(0, 3);
}

function sectionActiveCount(section: AgentSectionPlan, charts: EditableAgentChartPlan[]): number {
  const enabledKeys = new Set(charts.filter((chart) => chart.enabled).map((chart) => chart.key));
  return section.chart_keys.filter((key) => enabledKeys.has(key)).length;
}

function getBuildEventBadgeClass(event: BuildEvent): string {
  if (event.type === 'error') {
    return 'bg-rose-50 text-rose-700 border border-rose-200';
  }
  if (event.type === 'done') {
    return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
  }
  return 'bg-blue-50 text-blue-700 border border-blue-200';
}

async function getAuthToken(): Promise<string> {
  const response = await fetch('/api/auth/token');
  if (!response.ok) {
    throw new Error('Could not retrieve the access token for AI Agent.');
  }
  const data = await response.json();
  return data.token;
}

export function DashboardAgentWizard({ isOpen, onClose }: DashboardAgentWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>('select');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState('');
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<number[]>([]);
  const [goal, setGoal] = useState(INITIAL_GOAL);
  const [audience, setAudience] = useState(INITIAL_AUDIENCE);
  const [timeframe, setTimeframe] = useState(INITIAL_TIMEFRAME);
  const [kpisText, setKpisText] = useState(INITIAL_KPIS);
  const [questionsText, setQuestionsText] = useState(INITIAL_QUESTIONS);
  const [generatedPlan, setGeneratedPlan] = useState<EditableAgentPlan | null>(null);
  const [draftPlan, setDraftPlan] = useState<EditableAgentPlan | null>(null);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isBuildRunning, setIsBuildRunning] = useState(false);

  const { data: workspaces = [] } = useWorkspaces();

  const workspaceDetailsQuery = useQuery<WorkspaceWithTables[]>({
    queryKey: ['agent-workspace-details', workspaces.map((workspace) => workspace.id).join('-')],
    enabled: isOpen && workspaces.length > 0,
    queryFn: async () => {
      const responses = await Promise.all(
        workspaces.map((workspace) => apiClient.get<WorkspaceWithTables>(`/dataset-workspaces/${workspace.id}`)),
      );
      return responses.map((response) => response.data);
    },
  });

  const tables = useMemo(() => {
    return (workspaceDetailsQuery.data ?? []).flatMap((workspace) =>
      (workspace.tables ?? []).map((table) => ({
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        table_id: table.id,
        table_name: table.display_name,
        source_kind: table.source_kind,
      })),
    );
  }, [workspaceDetailsQuery.data]);

  const selectedTables = useMemo(() => {
    return selectedKeys
      .map((key) => {
        const [workspaceId, tableId] = key.split(':').map(Number);
        return { workspace_id: workspaceId, table_id: tableId };
      })
      .filter((item) => Number.isFinite(item.workspace_id) && Number.isFinite(item.table_id));
  }, [selectedKeys]);

  const selectedTableCards = useMemo(() => {
    return selectedTables.map((item) => {
      const table = tables.find(
        (candidate) => candidate.workspace_id === item.workspace_id && candidate.table_id === item.table_id,
      );
      return {
        key: `${item.workspace_id}:${item.table_id}`,
        workspaceName: table?.workspace_name ?? `Workspace ${item.workspace_id}`,
        tableName: table?.table_name ?? `Table ${item.table_id}`,
      };
    });
  }, [selectedTables, tables]);

  const normalizedTableSearch = tableSearch.trim().toLowerCase();
  const workspaceSelectionGroups = useMemo(() => {
    return (workspaceDetailsQuery.data ?? [])
      .map((workspace) => {
        const workspaceMatch =
          workspace.name.toLowerCase().includes(normalizedTableSearch) ||
          (workspace.description ?? '').toLowerCase().includes(normalizedTableSearch);
        const visibleTables = (workspace.tables ?? []).filter((table) => {
          if (!normalizedTableSearch) return true;
          return (
            workspaceMatch ||
            table.display_name.toLowerCase().includes(normalizedTableSearch) ||
            table.source_kind.toLowerCase().includes(normalizedTableSearch) ||
            (table.source_table_name ?? '').toLowerCase().includes(normalizedTableSearch)
          );
        });
        const selectedCount = (workspace.tables ?? []).filter((table) =>
          selectedKeys.includes(`${workspace.id}:${table.id}`),
        ).length;
        const visibleSelectedCount = visibleTables.filter((table) =>
          selectedKeys.includes(`${workspace.id}:${table.id}`),
        ).length;

        return {
          workspace,
          visibleTables,
          totalTables: workspace.tables?.length ?? 0,
          selectedCount,
          visibleSelectedCount,
        };
      })
      .filter((group) => group.visibleTables.length > 0)
      .sort((left, right) => {
        if (right.selectedCount !== left.selectedCount) {
          return right.selectedCount - left.selectedCount;
        }
        return left.workspace.name.localeCompare(right.workspace.name);
      });
  }, [normalizedTableSearch, selectedKeys, workspaceDetailsQuery.data]);

  const selectedWorkspaceCount = useMemo(
    () => new Set(selectedTables.map((item) => item.workspace_id)).size,
    [selectedTables],
  );
  const visibleTableCount = useMemo(
    () => workspaceSelectionGroups.reduce((total, group) => total + group.visibleTables.length, 0),
    [workspaceSelectionGroups],
  );

  const briefPayload = useMemo<AgentBriefRequest>(
    () => ({
      goal: goal.trim(),
      audience: audience.trim() || undefined,
      timeframe: timeframe.trim() || undefined,
      kpis: splitLines(kpisText),
      questions: splitLines(questionsText),
      selected_tables: selectedTables,
    }),
    [audience, goal, kpisText, questionsText, selectedTables, timeframe],
  );

  const currentStepIndex = STEP_META.findIndex((item) => item.key === step);
  const buildPlan = useMemo(() => (draftPlan ? toBuildPlan(draftPlan) : null), [draftPlan]);
  const enabledChartCount = buildPlan?.charts.length ?? 0;
  const enabledSectionCount = buildPlan?.sections.length ?? 0;
  const hasPlanEdits = useMemo(() => {
    if (!generatedPlan || !draftPlan) return false;
    return JSON.stringify(generatedPlan) !== JSON.stringify(draftPlan);
  }, [draftPlan, generatedPlan]);

  useEffect(() => {
    if (!isOpen) {
      setStep('select');
      setTableSearch('');
      setExpandedWorkspaceIds([]);
      setGeneratedPlan(null);
      setDraftPlan(null);
      setEvents([]);
      setAgentError(null);
      setIsBuildRunning(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !workspaceDetailsQuery.data?.length) return;

    setExpandedWorkspaceIds((prev) => {
      const validIds = prev.filter((id) => workspaceDetailsQuery.data.some((workspace) => workspace.id === id));
      if (validIds.length > 0) {
        return validIds;
      }

      return workspaceDetailsQuery.data
        .slice(0, 3)
        .map((workspace) => workspace.id);
    });
  }, [isOpen, workspaceDetailsQuery.data]);

  const planMutation = useMutation({
    mutationFn: async () => {
      const token = await getAuthToken();
      const response = await fetch(`${AI_AGENT_HTTP_URL}/agent/plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(briefPayload),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || 'AI Agent could not generate a plan.');
      }

      return response.json() as Promise<AgentPlanResponse>;
    },
    onSuccess: (data) => {
      const editable = normalizePlan(data);
      setGeneratedPlan(editable);
      setDraftPlan(cloneEditablePlan(editable));
      setStep('plan');
      setAgentError(null);
    },
    onError: (error: Error) => {
      setAgentError(error.message);
    },
  });

  function toggleTable(workspaceId: number, tableId: number) {
    const key = `${workspaceId}:${tableId}`;
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  }

  function toggleWorkspaceExpanded(workspaceId: number) {
    setExpandedWorkspaceIds((prev) =>
      prev.includes(workspaceId) ? prev.filter((item) => item !== workspaceId) : [...prev, workspaceId],
    );
  }

  function setWorkspaceTableSelection(workspaceId: number, tableIds: number[], shouldSelect: boolean) {
    const keys = tableIds.map((tableId) => `${workspaceId}:${tableId}`);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((key) => {
        if (shouldSelect) {
          next.add(key);
        } else {
          next.delete(key);
        }
      });
      return Array.from(next);
    });
  }

  function clearSelectedTables() {
    setSelectedKeys([]);
  }

  function updateSection(index: number, patch: Partial<AgentSectionPlan>) {
    setDraftPlan((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      sections[index] = { ...sections[index], ...patch };
      return { ...prev, sections };
    });
  }

  function updateChart(key: string, patch: Partial<EditableAgentChartPlan>) {
    setDraftPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        charts: prev.charts.map((chart) => (chart.key === key ? { ...chart, ...patch } : chart)),
      };
    });
  }

  function resetPlanEdits() {
    if (!generatedPlan) return;
    setDraftPlan(cloneEditablePlan(generatedPlan));
    setAgentError(null);
  }

  function requestPlan() {
    if (!briefPayload.goal) {
      toast.info('Business goal is required.');
      return;
    }
    if (briefPayload.selected_tables.length === 0) {
      toast.info('Choose at least one table before generating a plan.');
      return;
    }
    setAgentError(null);
    planMutation.mutate();
  }

  async function handleBuild() {
    if (!draftPlan || !buildPlan) return;

    if (!buildPlan.dashboard_title) {
      toast.info('Give the dashboard draft a title before building.');
      return;
    }

    if (buildPlan.charts.length === 0) {
      toast.info('Keep at least one chart enabled before building.');
      return;
    }

    if (buildPlan.sections.length === 0) {
      toast.info('At least one section must keep an active chart.');
      return;
    }

    setStep('building');
    setEvents([]);
    setAgentError(null);
    setIsBuildRunning(true);

    try {
      const token = await getAuthToken();
      const response = await fetch(`${AI_AGENT_HTTP_URL}/agent/build/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ brief: briefPayload, plan: buildPlan }),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text();
        throw new Error(detail || 'AI Agent could not start the dashboard build.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let didFinish = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as BuildEvent;
          setEvents((prev) => [...prev, event]);
          if (event.type === 'error') {
            setAgentError(event.error || event.message);
          }
          if (event.type === 'done' && event.dashboard_url) {
            didFinish = true;
            setIsBuildRunning(false);
            toast.success('AI Agent finished building the dashboard.');
            onClose();
            router.push(event.dashboard_url);
            return;
          }
        }
      }

      if (!didFinish && !agentError) {
        setAgentError('AI Agent build ended unexpectedly before returning a final dashboard.');
      }
    } catch (error: any) {
      setAgentError(error.message || 'AI Agent build failed.');
    } finally {
      setIsBuildRunning(false);
    }
  }

  if (!isOpen) return null;

  return (
    <AppModalShell
      onClose={onClose}
      title="Build a dashboard from a business brief"
      description="Separate from AI Chat: choose the tables, generate a draft plan, review and edit it, then let the Agent build the dashboard."
      icon={<Wand2 className="h-5 w-5" />}
      maxWidthClass="max-w-6xl"
      panelClassName="h-[88vh] max-h-[90vh]"
      bodyClassName="px-6 py-5"
      closeDisabled={isBuildRunning}
      footer={(
        <>
        <div className="mr-auto text-sm text-gray-500">
          {selectedTables.length > 0 && `${selectedTables.length} table${selectedTables.length !== 1 ? 's' : ''} selected`}
          {step === 'plan' && draftPlan && ` | ${enabledChartCount} active chart${enabledChartCount !== 1 ? 's' : ''}`}
        </div>

          {step === 'select' && (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              Close
            </button>
          )}

          {step === 'brief' && (
            <button
              onClick={() => setStep('select')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          )}

          {step === 'plan' && (
            <button
              onClick={() => setStep('brief')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to brief
            </button>
          )}

          {step === 'building' && (
            <button
              onClick={() => setStep('plan')}
              disabled={isBuildRunning}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to plan
            </button>
          )}

          {step === 'select' && (
            <button
              onClick={() => {
                if (selectedTables.length === 0) {
                  toast.info('Choose at least one table before continuing.');
                  return;
                }
                setStep('brief');
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
            >
              Continue
              <ChevronRight className="h-4 w-4" />
            </button>
          )}

          {step === 'brief' && (
            <button
              onClick={requestPlan}
              disabled={planMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            >
              {planMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Generate plan
            </button>
          )}

          {step === 'plan' && (
            <>
              <button
                onClick={requestPlan}
                disabled={planMutation.isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                {planMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                Regenerate plan
              </button>
              <button
                onClick={resetPlanEdits}
                disabled={!hasPlanEdits}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCcw className="h-4 w-4" />
                Reset edits
              </button>
              <button
                onClick={handleBuild}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
              >
                <Wand2 className="h-4 w-4" />
                Build dashboard
              </button>
            </>
          )}

          {step === 'building' && !isBuildRunning && (
            <button
              onClick={handleBuild}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
            >
              <RefreshCcw className="h-4 w-4" />
              Retry build
            </button>
          )}
        </>
      )}
    >
      <div className="space-y-5">
        <div className="border-b border-gray-200 pb-5">
          <div className="grid gap-3 md:grid-cols-4">
            {STEP_META.map((item, index) => {
              const active = currentStepIndex === index;
              const complete = currentStepIndex > index;
              return (
                <div
                  key={item.key}
                  className={`rounded-lg border px-4 py-3 transition ${
                    active
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : complete
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-gray-200 bg-white text-gray-500'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {complete ? <CheckCircle2 className="h-4 w-4" /> : <span>{index + 1}</span>}
                    <span>{item.label}</span>
                  </div>
                  <p className={`mt-1 text-xs ${active ? 'text-blue-600' : complete ? 'text-emerald-600' : 'text-gray-400'}`}>
                    {item.caption}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {agentError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {agentError}
          </div>
        )}

        {step === 'select' && (
          <div className="space-y-6">
            <div className="grid gap-4 xl:grid-cols-[1.05fr_0.9fr_0.75fr]">
              <div className="rounded-xl border border-gray-200 bg-blue-50 p-6">
                <div className="mb-3 flex items-center gap-2 text-gray-900">
                  <Table2 className="h-5 w-5 text-blue-600" />
                  <h3 className="text-lg font-semibold">Choose the tables the Agent may use</h3>
                </div>
                <p className="text-sm text-gray-600">
                  V1 only uses the tables you explicitly select here. It will not pull extra datasets and it will not blend data across datasets.
                </p>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-3 flex items-center gap-2 text-gray-900">
                  <FileText className="h-5 w-5 text-gray-500" />
                  <h3 className="text-lg font-semibold">What happens next</h3>
                </div>
                <ol className="space-y-3 text-sm text-gray-600">
                  <li>1. Write the business brief.</li>
                  <li>2. Review the generated dashboard draft.</li>
                  <li>3. Edit titles, scope, and included charts.</li>
                  <li>4. Generate the final dashboard when the draft looks right.</li>
                </ol>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Workspaces</p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">{workspaceDetailsQuery.data?.length ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Available tables</p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">{tables.length}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Selected tables</p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedTables.length}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.18fr_0.82fr]">
              <div className="space-y-4">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        value={tableSearch}
                        onChange={(event) => setTableSearch(event.target.value)}
                        placeholder="Search workspaces or tables..."
                        className="w-full rounded-lg border border-gray-300 py-2.5 pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setExpandedWorkspaceIds(workspaceSelectionGroups.map((group) => group.workspace.id))}
                        disabled={Boolean(normalizedTableSearch)}
                        className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Expand all
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpandedWorkspaceIds([])}
                        disabled={Boolean(normalizedTableSearch)}
                        className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Collapse all
                      </button>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-gray-500">
                    Showing {workspaceSelectionGroups.length} workspace{workspaceSelectionGroups.length !== 1 ? 's' : ''} and {visibleTableCount} table{visibleTableCount !== 1 ? 's' : ''} in the current view.
                  </p>
                </div>

                {workspaceDetailsQuery.isLoading && (
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-5 text-gray-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading workspaces and tables...
                  </div>
                )}

                {!workspaceDetailsQuery.isLoading && tables.length === 0 && (
                  <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
                    <p className="text-base font-medium text-gray-900">No workspace tables are available yet.</p>
                    <p className="mt-2 text-sm text-gray-500">
                      Add at least one workspace table before using AI Agent on the dashboards page.
                    </p>
                  </div>
                )}

                {!workspaceDetailsQuery.isLoading && tables.length > 0 && workspaceSelectionGroups.length === 0 && (
                  <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
                    <p className="text-base font-medium text-gray-900">No tables match your current search.</p>
                    <p className="mt-2 text-sm text-gray-500">Try a workspace name, table name, or source type.</p>
                  </div>
                )}

                <div className="space-y-4">
                  {workspaceSelectionGroups.map((group) => {
                    const isExpanded = normalizedTableSearch ? true : expandedWorkspaceIds.includes(group.workspace.id);
                    const allVisibleSelected =
                      group.visibleTables.length > 0 && group.visibleSelectedCount === group.visibleTables.length;

                    return (
                      <div key={group.workspace.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                        <div className="flex flex-col gap-3 border-b border-gray-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
                          <button
                            type="button"
                            onClick={() => toggleWorkspaceExpanded(group.workspace.id)}
                            disabled={Boolean(normalizedTableSearch)}
                            className="flex items-start gap-3 text-left disabled:cursor-default"
                          >
                            <div className="mt-0.5 text-gray-400">
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </div>
                            <div>
                              <p className="text-xs uppercase tracking-[0.18em] text-gray-400">Workspace</p>
                              <h4 className="text-lg font-semibold text-gray-900">{group.workspace.name}</h4>
                              {group.workspace.description && (
                                <p className="mt-1 text-sm text-gray-500">{group.workspace.description}</p>
                              )}
                              <p className="mt-2 text-xs text-gray-500">
                                {group.selectedCount} of {group.totalTables} table{group.totalTables !== 1 ? 's' : ''} selected
                              </p>
                            </div>
                          </button>

                          <div className="flex flex-wrap items-center gap-2">
                            {group.selectedCount > 0 && (
                              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                                {group.selectedCount} selected
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                setWorkspaceTableSelection(
                                  group.workspace.id,
                                  group.visibleTables.map((table) => table.id),
                                  !allVisibleSelected,
                                )
                              }
                              className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-full hover:bg-gray-50 transition-colors"
                            >
                              {allVisibleSelected ? 'Clear shown' : 'Select shown'}
                            </button>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="mt-4 space-y-3">
                            {group.visibleTables.map((table) => {
                              const key = `${group.workspace.id}:${table.id}`;
                              const checked = selectedKeys.includes(key);
                              return (
                                <button
                                  key={table.id}
                                  onClick={() => toggleTable(group.workspace.id, table.id)}
                                  className={`flex w-full items-start justify-between rounded-lg border px-4 py-3 text-left transition ${
                                    checked
                                      ? 'border-blue-500 bg-blue-50 shadow-sm'
                                      : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/40'
                                  }`}
                                >
                                  <div>
                                    <p className="font-medium text-gray-900">{table.display_name}</p>
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-gray-600">
                                        {table.source_kind}
                                      </span>
                                      <span className="text-xs text-gray-400">Table ID {table.id}</span>
                                    </div>
                                  </div>
                                  <div
                                    className={`mt-1 flex h-5 w-5 items-center justify-center rounded-full border ${
                                      checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white'
                                    }`}
                                  >
                                    {checked && <CheckCircle2 className="h-3.5 w-3.5" />}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-4 xl:sticky xl:top-0 xl:self-start">
                <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">Selected scope</h3>
                      <p className="mt-1 text-sm text-gray-500">
                        Keep the scope tight. The Agent will only use these tables.
                      </p>
                    </div>
                    {selectedKeys.length > 0 && (
                      <button
                        type="button"
                        onClick={clearSelectedTables}
                        className="text-xs font-medium text-gray-600 hover:text-gray-900"
                      >
                        Clear all
                      </button>
                    )}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Selected tables</p>
                      <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedTables.length}</p>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Selected workspaces</p>
                      <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedWorkspaceCount}</p>
                    </div>
                  </div>

                  {selectedTableCards.length === 0 ? (
                    <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                      Choose at least one table to continue.
                    </div>
                  ) : (
                    <div className="mt-4 max-h-[420px] space-y-3 overflow-y-auto pr-1">
                      {selectedTableCards.map((item) => (
                        <div key={item.key} className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900">{item.tableName}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{item.workspaceName}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSelectedKeys((prev) => prev.filter((key) => key !== item.key))}
                            className="rounded-md p-1 text-gray-400 hover:bg-white hover:text-gray-700 transition-colors"
                            title="Remove from selection"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
                  <div className="mb-3 flex items-center gap-2 text-blue-900">
                    <Sparkles className="h-5 w-5" />
                    <h3 className="text-lg font-semibold">Selection tips</h3>
                  </div>
                  <ul className="space-y-2 text-sm text-blue-900/90">
                    <li>- Prefer only the tables the dashboard truly needs.</li>
                    <li>- Use search when you have many workspaces or similar table names.</li>
                    <li>- Review the selected scope on the right before moving to the brief.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 'brief' && (
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="space-y-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Business goal</label>
                  <textarea
                    value={goal}
                    onChange={(event) => setGoal(event.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">Audience</label>
                    <input
                      value={audience}
                      onChange={(event) => setAudience(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">Timeframe</label>
                    <input
                      value={timeframe}
                      onChange={(event) => setTimeframe(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">KPIs</label>
                  <textarea
                    value={kpisText}
                    onChange={(event) => setKpisText(event.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Questions the dashboard must answer</label>
                  <textarea
                    value={questionsText}
                    onChange={(event) => setQuestionsText(event.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
            </div>

            <div className="space-y-5">
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-3 flex items-center gap-2 text-gray-900">
                  <FileText className="h-5 w-5 text-gray-500" />
                    <h3 className="text-lg font-semibold">Selected scope</h3>
                </div>
                <div className="space-y-3 text-sm text-gray-700">
                  {selectedTableCards.map((item) => (
                    <div key={item.key} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                      <p className="font-medium text-gray-900">{item.tableName}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{item.workspaceName}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-blue-200 bg-blue-50 p-6">
                <div className="mb-3 flex items-center gap-2 text-blue-900">
                  <Sparkles className="h-5 w-5" />
                  <h3 className="text-lg font-semibold">Planning notes</h3>
                </div>
                <ul className="space-y-2 text-sm text-blue-900/90">
                  <li>- The richer the brief, the better the draft dashboard plan.</li>
                  <li>- You can review, rename, disable charts, and regenerate the draft before building.</li>
                  <li>- The final dashboard only uses the workspace tables selected in this flow.</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {step === 'plan' && draftPlan && (
          <div className="space-y-6">
            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2 text-gray-900">
                  <PencilLine className="h-5 w-5 text-blue-600" />
                    <h3 className="text-lg font-semibold">Editable dashboard draft</h3>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">Dashboard title</label>
                      <input
                        value={draftPlan.dashboard_title}
                        onChange={(event) => setDraftPlan((prev) => (prev ? { ...prev, dashboard_title: event.target.value } : prev))}
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">Dashboard summary</label>
                      <textarea
                        value={draftPlan.dashboard_summary}
                        onChange={(event) => setDraftPlan((prev) => (prev ? { ...prev, dashboard_summary: event.target.value } : prev))}
                        rows={4}
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                  </div>
                  {draftPlan.warnings.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      {draftPlan.warnings.join(' ')}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                  <div className="flex items-center gap-2 text-gray-900">
                    <LayoutDashboard className="h-5 w-5 text-blue-600" />
                      <span className="text-sm font-semibold">Sections</span>
                  </div>
                  <p className="mt-3 text-3xl font-semibold text-gray-900">{enabledSectionCount}</p>
                  <p className="mt-1 text-sm text-gray-500">sections will be built from your current draft</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                  <div className="flex items-center gap-2 text-gray-900">
                    <ListChecks className="h-5 w-5 text-blue-600" />
                      <span className="text-sm font-semibold">Active charts</span>
                  </div>
                  <p className="mt-3 text-3xl font-semibold text-gray-900">{enabledChartCount}</p>
                  <p className="mt-1 text-sm text-gray-500">charts currently enabled for build</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                  <div className="flex items-center gap-2 text-gray-900">
                    <Table2 className="h-5 w-5 text-blue-600" />
                      <span className="text-sm font-semibold">Selected tables</span>
                  </div>
                  <p className="mt-3 text-3xl font-semibold text-gray-900">{selectedTableCards.length}</p>
                  <p className="mt-1 text-sm text-gray-500">the Agent will stay inside this scope</p>
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[0.92fr_1.08fr]">
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-semibold text-gray-900">Sections</h4>
                      <p className="mt-1 text-sm text-gray-500">Refine the narrative structure before building.</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    {draftPlan.sections.map((section, index) => {
                      const activeCharts = sectionActiveCount(section, draftPlan.charts);
                      return (
                        <div key={`${section.workspace_id}:${section.workspace_table_id}`} className="rounded-lg border border-gray-200 p-4">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div>
                              <p className="text-xs uppercase tracking-[0.16em] text-gray-400">
                                {section.workspace_name} / {section.table_name}
                              </p>
                              <p className="mt-1 text-sm font-medium text-gray-900">{activeCharts} active chart{activeCharts !== 1 ? 's' : ''}</p>
                            </div>
                            <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-600">
                              Section
                            </span>
                          </div>

                          <div className="space-y-3">
                            <div>
                              <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">Title</label>
                              <input
                                value={section.title}
                                onChange={(event) => updateSection(index, { title: event.target.value })}
                                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">Intent</label>
                              <textarea
                                value={section.intent}
                                onChange={(event) => updateSection(index, { intent: event.target.value })}
                                rows={3}
                                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                              />
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {section.chart_keys.map((chartKey) => {
                                const chart = draftPlan.charts.find((item) => item.key === chartKey);
                                if (!chart) return null;
                                return (
                                  <span
                                    key={chartKey}
                                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                                      chart.enabled
                                        ? 'bg-blue-50 text-blue-700'
                                        : 'bg-gray-100 text-gray-400 line-through'
                                    }`}
                                  >
                                    {chart.title}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-semibold text-gray-900">Charts the Agent will build</h4>
                      <p className="mt-1 text-sm text-gray-500">You can rename, keep, or skip charts before building.</p>
                    </div>
                    <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                      Review mode
                    </span>
                  </div>
                  <div className="space-y-4">
                    {draftPlan.charts.map((chart) => {
                      const configNotes = describeChartConfig(chart);
                      return (
                      <div
                        key={chart.key}
                        className={`rounded-lg border p-4 transition ${
                          chart.enabled ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50'
                        }`}
                      >
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => updateChart(chart.key, { enabled: !chart.enabled })}
                              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                              chart.enabled
                                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                  : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                              }`}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              {chart.enabled ? 'Included in build' : 'Skipped for now'}
                            </button>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-600">
                                {chart.chart_type}
                              </span>
                              <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                                {chart.workspace_name}
                              </span>
                            </div>
                          </div>

                          <div className="space-y-3">
                            <div>
                              <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">Chart title</label>
                              <input
                                value={chart.title}
                                onChange={(event) => updateChart(chart.key, { title: event.target.value })}
                                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">Rationale</label>
                              <textarea
                                value={chart.rationale}
                                onChange={(event) => updateChart(chart.key, { rationale: event.target.value })}
                                rows={3}
                                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                              />
                            </div>
                            <div>
                              <p className="text-xs uppercase tracking-[0.16em] text-gray-400">
                                {chart.workspace_name} / {chart.table_name}
                              </p>
                              {configNotes.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {configNotes.map((note) => (
                                    <span key={note} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                                      {note}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
              </div>
            </div>
          </div>
        )}

        {step === 'building' && (
          <div className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="space-y-4">
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-6">
                <div className="mb-3 flex items-center gap-2 text-blue-900">
                  <Bot className="h-5 w-5" />
                  <h3 className="text-lg font-semibold">Agent run</h3>
                </div>
                <p className="text-sm text-blue-900/80">
                  The Agent is creating charts, checking their data, and assembling the dashboard from your approved draft.
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-blue-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Active charts</p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">{enabledChartCount}</p>
                  </div>
                  <div className="rounded-lg border border-blue-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Sections</p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">{enabledSectionCount}</p>
                  </div>
                </div>
              </div>

              {!isBuildRunning && agentError && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
                  <p className="font-semibold">You can go back, adjust the draft, and try again.</p>
                  <p className="mt-2 text-amber-800">
                    The current plan stays editable, so you can disable weak charts, update titles, or regenerate a fresh draft from the brief.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-lg font-semibold text-gray-900">Progress stream</h4>
                  <p className="mt-1 text-sm text-gray-500">Each event comes directly from the standalone AI Agent service.</p>
                </div>
                {isBuildRunning && <Loader2 className="h-5 w-5 animate-spin text-blue-500" />}
              </div>
              <div className="space-y-3">
                {events.length === 0 && (
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                    Waiting for first event...
                  </div>
                )}
                {events.map((event, index) => (
                  <div key={`${event.type}-${index}`} className="rounded-lg border border-gray-200 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-gray-900">{event.message}</p>
                        {event.error && <p className="mt-2 text-sm text-rose-600">{event.error}</p>}
                      </div>
                      <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${getBuildEventBadgeClass(event)}`}>
                        {event.phase}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        </div>

    </AppModalShell>
  );
}
