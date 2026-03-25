'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  FileText,
  History,
  LayoutDashboard,
  ListChecks,
  Loader2,
  PencilLine,
  RefreshCcw,
  Search,
  Sparkles,
  Table2,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { AppModalShell } from '@/components/common/AppModalShell';
import {
  agentReportSpecKeys,
  useDeleteAgentReportSpec,
  useAgentReportSpec,
  useCreateAgentReportRun,
  useCreateAgentReportSpec,
  useUpdateAgentReportSpec,
} from '@/hooks/use-agent-report-specs';
import { useWorkspaces, WorkspaceWithTables } from '@/hooks/use-dataset-workspaces';
import apiClient from '@/lib/api-client';
import { AI_AGENT_HTTP_URL } from '@/lib/ai-services';
import {
  AgentBriefRequest,
  AgentBuildEvent as BuildEvent,
  AgentBuildMode,
  AgentPlanEvent,
  AgentPlanResponse,
  AgentReportSpecDetail,
  AgentSectionPlan,
} from '@/types/agent';
import {
  ALL_BRIEF_SECTIONS,
  BRIEF_PRESETS,
  BRIEF_SECTION_META,
  DEFAULT_BRIEF_SECTIONS,
  makeInitialBriefState,
  STEP_META,
} from '@/components/ai-reports/wizard-config';
import {
  briefToMultiline,
  cloneEditablePlan,
  describeChartConfig,
  getBuildEventBadgeClass,
  getPlanEventBadgeClass,
  normalizePlan,
  sectionActiveCount,
  splitLines,
  toBuildPlan,
} from '@/components/ai-reports/wizard-helpers';
import {
  AIReportWizardProps,
  AgentHealthPayload,
  BriefSectionKey,
  EditableAgentChartPlan,
  EditableAgentPlan,
  WizardStep,
} from '@/components/ai-reports/wizard-types';

type PlanWorkspaceTab = 'overview' | 'reasoning' | 'sections' | 'charts';

const PLAN_WORKSPACE_TABS: Array<{
  key: PlanWorkspaceTab;
  label: string;
  caption: string;
}> = [
  { key: 'overview', label: 'Overview', caption: 'Sanity-check the draft' },
  { key: 'reasoning', label: 'Reasoning', caption: 'See how the Agent thought' },
  { key: 'sections', label: 'Sections', caption: 'Refine narrative flow' },
  { key: 'charts', label: 'Charts', caption: 'Keep, rename, or skip charts' },
];

const BRIEF_SECTION_FOCUS: Record<
  BriefSectionKey,
  { title: string; description: string; bullets: string[] }
> = {
  essentials: {
    title: 'What the Agent needs first',
    description: 'These fields shape the first good draft. They are the difference between a useful report and a generic one.',
    bullets: [
      'State the business goal in plain language, not just the metric list.',
      'Name the audience so the Agent knows whether to sound executive or operational.',
      'Give at least one KPI and one must-answer question before generating the draft.',
    ],
  },
  intent: {
    title: 'How this changes the report shape',
    description: 'These controls influence comparison logic, section order, and how assertive the final narrative should feel.',
    bullets: [
      'Use comparison period when the reader expects trend or change analysis.',
      'Must-have sections tell the Agent what should never be omitted.',
      'Planning mode belongs here because it changes how hard the Agent reasons.',
    ],
  },
  dataset: {
    title: 'Where extra context helps most',
    description: 'Use this area when table names, field names, or business meaning are ambiguous.',
    bullets: [
      'Role hints help the Agent understand which table is the core signal vs supporting context.',
      'Glossary items reduce the risk of writing the wrong business interpretation.',
      'Known issues and columns to avoid prevent overconfident insights on weak data.',
    ],
  },
  narrative: {
    title: 'How much written analysis to ship',
    description: 'These settings shape the text layer around the dashboard rather than the raw chart mechanics.',
    bullets: [
      'Insight depth controls how dense the commentary should feel.',
      'Recommendation and confidence modes affect how bold the written output becomes.',
      'Narrative toggles tell the Agent whether to add prose, actions, and quality caveats.',
    ],
  },
  advanced: {
    title: 'Reserve this for edge cases',
    description: 'Only use Advanced when the report has special instructions that do not fit the sections above.',
    bullets: [
      'Use notes for caveats, internal rules, or special constraints.',
      'Avoid repeating information already covered in the brief.',
      'If the essentials are strong, this section can be left blank.',
    ],
  },
};


async function getAuthToken(): Promise<string> {
  const response = await fetch('/api/auth/token');
  if (!response.ok) {
    throw new Error('Could not retrieve the access token for AI Agent.');
  }
  const data = await response.json();
  return data.token;
}

export function AIReportWizard({
  isOpen = true,
  onClose,
  initialSpecId = null,
  mode = 'modal',
  backHref = '/ai-reports',
}: AIReportWizardProps) {
  const router = useRouter();
  const isPageMode = mode === 'page';
  const isActive = isPageMode || isOpen;
  const handleClose = () => {
    if (onClose) {
      onClose();
      return;
    }
    router.push(backHref);
  };
  const initialBrief = useMemo(() => makeInitialBriefState(), []);
  const [step, setStep] = useState<WizardStep>('select');
  const [activeSpecId, setActiveSpecId] = useState<number | null>(initialSpecId);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState('');
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<number[]>([]);
  const [expandedBriefSections, setExpandedBriefSections] = useState<BriefSectionKey[]>(DEFAULT_BRIEF_SECTIONS);
  const [activeBriefSection, setActiveBriefSection] = useState<BriefSectionKey>('essentials');
  const [planWorkspaceTab, setPlanWorkspaceTab] = useState<PlanWorkspaceTab>('overview');
  const [reportName, setReportName] = useState(initialBrief.reportName);
  const [reportType, setReportType] = useState(initialBrief.reportType);
  const [goal, setGoal] = useState(initialBrief.goal);
  const [audience, setAudience] = useState(initialBrief.audience);
  const [timeframe, setTimeframe] = useState(initialBrief.timeframe);
  const [whyNow, setWhyNow] = useState(initialBrief.whyNow);
  const [businessBackground, setBusinessBackground] = useState(initialBrief.businessBackground);
  const [kpisText, setKpisText] = useState(initialBrief.kpisText);
  const [questionsText, setQuestionsText] = useState(initialBrief.questionsText);
  const [comparisonPeriod, setComparisonPeriod] = useState(initialBrief.comparisonPeriod);
  const [refreshFrequency, setRefreshFrequency] = useState(initialBrief.refreshFrequency);
  const [mustIncludeSectionsText, setMustIncludeSectionsText] = useState(initialBrief.mustIncludeSectionsText);
  const [alertFocusText, setAlertFocusText] = useState(initialBrief.alertFocusText);
  const [preferredGranularity, setPreferredGranularity] = useState(initialBrief.preferredGranularity);
  const [decisionContext, setDecisionContext] = useState(initialBrief.decisionContext);
  const [reportStyle, setReportStyle] = useState(initialBrief.reportStyle);
  const [insightDepth, setInsightDepth] = useState(initialBrief.insightDepth);
  const [recommendationStyle, setRecommendationStyle] = useState(initialBrief.recommendationStyle);
  const [confidencePreference, setConfidencePreference] = useState(initialBrief.confidencePreference);
  const [preferredDashboardStructure, setPreferredDashboardStructure] = useState(initialBrief.preferredDashboardStructure);
  const [includeTextNarrative, setIncludeTextNarrative] = useState(initialBrief.includeTextNarrative);
  const [includeActionItems, setIncludeActionItems] = useState(initialBrief.includeActionItems);
  const [includeDataQualityNotes, setIncludeDataQualityNotes] = useState(initialBrief.includeDataQualityNotes);
  const [tableRolesHintText, setTableRolesHintText] = useState(initialBrief.tableRolesHintText);
  const [businessGlossaryText, setBusinessGlossaryText] = useState(initialBrief.businessGlossaryText);
  const [knownDataIssuesText, setKnownDataIssuesText] = useState(initialBrief.knownDataIssuesText);
  const [importantDimensionsText, setImportantDimensionsText] = useState(initialBrief.importantDimensionsText);
  const [columnsToAvoidText, setColumnsToAvoidText] = useState(initialBrief.columnsToAvoidText);
  const [notes, setNotes] = useState(initialBrief.notes);
  const [planningMode, setPlanningMode] = useState<'quick' | 'deep'>(initialBrief.planningMode);
  const [generatedPlan, setGeneratedPlan] = useState<EditableAgentPlan | null>(null);
  const [draftPlan, setDraftPlan] = useState<EditableAgentPlan | null>(null);
  const [planningEvents, setPlanningEvents] = useState<AgentPlanEvent[]>([]);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isBuildRunning, setIsBuildRunning] = useState(false);
  const [buildMode, setBuildMode] = useState<AgentBuildMode>('new_dashboard');
  const planAbortControllerRef = useRef<AbortController | null>(null);

  const queryClient = useQueryClient();
  const { data: workspaces = [] } = useWorkspaces();
  const activeSpecQuery = useAgentReportSpec(activeSpecId);
  const createSpecMutation = useCreateAgentReportSpec();
  const updateSpecMutation = useUpdateAgentReportSpec();
  const deleteSpecMutation = useDeleteAgentReportSpec();
  const createRunMutation = useCreateAgentReportRun();
  const agentHealthQuery = useQuery<AgentHealthPayload>({
    queryKey: ['ai-agent-health'],
    enabled: isActive,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch(`${AI_AGENT_HTTP_URL}/health`);
      if (!response.ok) {
        throw new Error('Could not load AI Agent health.');
      }
      return response.json();
    },
  });

  const workspaceDetailsQuery = useQuery<WorkspaceWithTables[]>({
    queryKey: ['agent-workspace-details', workspaces.map((workspace) => workspace.id).join('-')],
    enabled: isActive && workspaces.length > 0,
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
      report_name: reportName.trim() || undefined,
      report_type: reportType || undefined,
      goal: goal.trim(),
      audience: audience.trim() || undefined,
      timeframe: timeframe.trim() || undefined,
      why_now: whyNow.trim() || undefined,
      business_background: businessBackground.trim() || undefined,
      kpis: splitLines(kpisText),
      questions: splitLines(questionsText),
      comparison_period: comparisonPeriod.trim() || undefined,
      refresh_frequency: refreshFrequency.trim() || undefined,
      must_include_sections: splitLines(mustIncludeSectionsText),
      alert_focus: splitLines(alertFocusText),
      preferred_granularity: preferredGranularity.trim() || undefined,
      decision_context: decisionContext.trim() || undefined,
      report_style: reportStyle.trim() || undefined,
      insight_depth: insightDepth.trim() || undefined,
      recommendation_style: recommendationStyle.trim() || undefined,
      confidence_preference: confidencePreference.trim() || undefined,
      preferred_dashboard_structure: preferredDashboardStructure.trim() || undefined,
      include_text_narrative: includeTextNarrative,
      include_action_items: includeActionItems,
      include_data_quality_notes: includeDataQualityNotes,
      table_roles_hint: splitLines(tableRolesHintText),
      business_glossary: splitLines(businessGlossaryText),
      known_data_issues: splitLines(knownDataIssuesText),
      important_dimensions: splitLines(importantDimensionsText),
      columns_to_avoid: splitLines(columnsToAvoidText),
      notes: notes.trim() || undefined,
      planning_mode: planningMode,
      selected_tables: selectedTables,
    }),
    [
      alertFocusText,
      audience,
      businessBackground,
      businessGlossaryText,
      comparisonPeriod,
      confidencePreference,
      columnsToAvoidText,
      decisionContext,
      goal,
      importantDimensionsText,
      includeActionItems,
      includeDataQualityNotes,
      includeTextNarrative,
      insightDepth,
      kpisText,
      knownDataIssuesText,
      mustIncludeSectionsText,
      notes,
      planningMode,
      preferredGranularity,
      preferredDashboardStructure,
      questionsText,
      recommendationStyle,
      refreshFrequency,
      reportName,
      reportStyle,
      reportType,
      selectedTables,
      tableRolesHintText,
      timeframe,
      whyNow,
    ],
  );

  const currentStepIndex = STEP_META.findIndex((item) => item.key === step);
  const buildPlan = useMemo(() => (draftPlan ? toBuildPlan(draftPlan) : null), [draftPlan]);
  const enabledChartCount = buildPlan?.charts.length ?? 0;
  const enabledSectionCount = buildPlan?.sections.length ?? 0;
  const activeSpec = activeSpecQuery.data as AgentReportSpecDetail | undefined;
  const recentRuns = useMemo(
    () =>
      [...(activeSpec?.runs ?? [])]
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
        .slice(0, 5),
    [activeSpec],
  );
  const hasPlanEdits = useMemo(() => {
    if (!generatedPlan || !draftPlan) return false;
    return JSON.stringify(generatedPlan) !== JSON.stringify(draftPlan);
  }, [draftPlan, generatedPlan]);

  const selectedTableNamesPreview = useMemo(
    () => selectedTableCards.slice(0, 3).map((item) => item.tableName),
    [selectedTableCards],
  );
  const briefKpis = useMemo(() => splitLines(kpisText), [kpisText]);
  const briefQuestions = useMemo(() => splitLines(questionsText), [questionsText]);
  const briefKnownIssues = useMemo(() => splitLines(knownDataIssuesText), [knownDataIssuesText]);
  const briefGlossary = useMemo(() => splitLines(businessGlossaryText), [businessGlossaryText]);
  const briefRoleHints = useMemo(() => splitLines(tableRolesHintText), [tableRolesHintText]);
  const briefImportantDimensions = useMemo(() => splitLines(importantDimensionsText), [importantDimensionsText]);
  const visibleBriefSections = useMemo(
    () => BRIEF_SECTION_META.filter((section) => !section.optional || expandedBriefSections.includes(section.key)),
    [expandedBriefSections],
  );
  const briefSectionProgress = useMemo<Record<BriefSectionKey, { filled: number; total: number; ready: boolean }>>(
    () => ({
      essentials: {
        filled: [
          Boolean(reportName.trim()),
          Boolean(goal.trim()),
          Boolean(audience.trim()),
          briefKpis.length > 0,
          briefQuestions.length > 0,
        ].filter(Boolean).length,
        total: 5,
        ready: Boolean(goal.trim()) && Boolean(audience.trim()) && briefKpis.length > 0 && briefQuestions.length > 0,
      },
      intent: {
        filled: [
          Boolean(decisionContext.trim()),
          Boolean(reportStyle.trim()),
          Boolean(comparisonPeriod.trim()),
          Boolean(refreshFrequency.trim()),
          splitLines(mustIncludeSectionsText).length > 0,
        ].filter(Boolean).length,
        total: 5,
        ready:
          Boolean(decisionContext.trim()) &&
          Boolean(reportStyle.trim()) &&
          Boolean(comparisonPeriod.trim()) &&
          splitLines(mustIncludeSectionsText).length > 0,
      },
      dataset: {
        filled: [briefRoleHints.length > 0, briefGlossary.length > 0, briefKnownIssues.length > 0, briefImportantDimensions.length > 0, splitLines(columnsToAvoidText).length > 0].filter(Boolean).length,
        total: 5,
        ready: briefRoleHints.length + briefGlossary.length + briefKnownIssues.length + briefImportantDimensions.length + splitLines(columnsToAvoidText).length > 0,
      },
      narrative: {
        filled: [
          Boolean(insightDepth.trim()),
          Boolean(recommendationStyle.trim()),
          Boolean(confidencePreference.trim()),
          includeTextNarrative || includeActionItems || includeDataQualityNotes,
        ].filter(Boolean).length,
        total: 4,
        ready: Boolean(insightDepth.trim()) && Boolean(recommendationStyle.trim()),
      },
      advanced: {
        filled: [Boolean(reportType.trim()), Boolean(preferredGranularity.trim()), Boolean(notes.trim()), planningMode === 'deep'].filter(Boolean).length,
        total: 4,
        ready: Boolean(reportType.trim()) || Boolean(notes.trim()),
      },
    }),
    [
      audience,
      briefGlossary.length,
      briefImportantDimensions.length,
      briefKpis.length,
      briefKnownIssues.length,
      briefQuestions.length,
      briefRoleHints.length,
      columnsToAvoidText,
      comparisonPeriod,
      confidencePreference,
      decisionContext,
      goal,
      includeActionItems,
      includeDataQualityNotes,
      includeTextNarrative,
      insightDepth,
      mustIncludeSectionsText,
      notes,
      planningMode,
      preferredGranularity,
      recommendationStyle,
      refreshFrequency,
      reportName,
      reportStyle,
      reportType,
    ],
  );
  const activeBriefSectionMeta = useMemo(
    () => visibleBriefSections.find((section) => section.key === activeBriefSection) ?? visibleBriefSections[0],
    [activeBriefSection, visibleBriefSections],
  );
  const activeBriefSectionIndex = useMemo(
    () => visibleBriefSections.findIndex((section) => section.key === activeBriefSectionMeta?.key),
    [activeBriefSectionMeta?.key, visibleBriefSections],
  );
  const activeBriefFocus = useMemo(
    () => BRIEF_SECTION_FOCUS[activeBriefSectionMeta?.key ?? 'essentials'],
    [activeBriefSectionMeta?.key],
  );
  const activeBriefSnapshot = useMemo(() => {
    switch (activeBriefSectionMeta?.key) {
      case 'intent':
        return [
          { label: 'Report style', value: reportStyle || 'Not set' },
          { label: 'Must-have sections', value: String(splitLines(mustIncludeSectionsText).length) },
          { label: 'Comparison set', value: comparisonPeriod.trim() || 'Not set' },
        ];
      case 'dataset':
        return [
          { label: 'Role hints', value: String(briefRoleHints.length) },
          { label: 'Glossary terms', value: String(briefGlossary.length) },
          { label: 'Known issues', value: String(briefKnownIssues.length) },
        ];
      case 'narrative':
        return [
          { label: 'Insight depth', value: insightDepth || 'Balanced' },
          { label: 'Recommendations', value: recommendationStyle || 'Not set' },
          {
            label: 'Narrative enabled',
            value: includeTextNarrative ? 'Yes' : 'No',
          },
        ];
      case 'advanced':
        return [
          { label: 'Notes added', value: notes.trim() ? 'Yes' : 'No' },
          { label: 'Planning mode', value: planningMode === 'deep' ? 'Deep draft' : 'Quick draft' },
          { label: 'Constraints', value: notes.trim() ? `${notes.trim().length} chars` : 'None' },
        ];
      case 'essentials':
      default:
        return [
          { label: 'Selected tables', value: String(selectedTables.length) },
          { label: 'KPIs supplied', value: String(briefKpis.length) },
          { label: 'Questions supplied', value: String(briefQuestions.length) },
        ];
    }
  }, [
    activeBriefSectionMeta?.key,
    briefGlossary.length,
    briefKpis.length,
    briefKnownIssues.length,
    briefQuestions.length,
    briefRoleHints.length,
    comparisonPeriod,
    includeTextNarrative,
    insightDepth,
    mustIncludeSectionsText,
    notes,
    planningMode,
    recommendationStyle,
    reportStyle,
    selectedTables.length,
  ]);
  const readinessChecks = useMemo(
    () => [
      { label: 'Tables selected', done: selectedTables.length > 0 },
      { label: 'Business goal defined', done: goal.trim().length > 0 },
      { label: 'Audience set', done: audience.trim().length > 0 },
      { label: 'At least one KPI', done: briefKpis.length > 0 },
      { label: 'At least one question', done: briefQuestions.length > 0 },
    ],
    [audience, briefKpis.length, briefQuestions.length, goal, selectedTables.length],
  );
  const readinessCount = readinessChecks.filter((item) => item.done).length;
  const agentUnderstandingPreview = useMemo(() => {
    const style = reportStyle || 'executive';
    const audienceLabel = audience.trim() || 'your target audience';
    const primaryFocus = briefKpis[0] || briefQuestions[0] || 'the main business outcome';
    const timeframeLabel = timeframe.trim() || 'the chosen timeframe';
    return `The Agent will draft a ${style} report for ${audienceLabel}, focused on ${primaryFocus}, using ${selectedTables.length} selected table${selectedTables.length === 1 ? '' : 's'} across ${timeframeLabel}.`;
  }, [audience, briefKpis, briefQuestions, reportStyle, selectedTables.length, timeframe]);

  useEffect(() => {
    if (!isActive) {
      setStep('select');
      setActiveSpecId(initialSpecId);
      setSelectedKeys([]);
      setTableSearch('');
      setExpandedWorkspaceIds([]);
      setExpandedBriefSections(DEFAULT_BRIEF_SECTIONS);
      setActiveBriefSection('essentials');
      setReportName(initialBrief.reportName);
      setReportType(initialBrief.reportType);
      setGoal(initialBrief.goal);
      setAudience(initialBrief.audience);
      setTimeframe(initialBrief.timeframe);
      setWhyNow(initialBrief.whyNow);
      setBusinessBackground(initialBrief.businessBackground);
      setKpisText(initialBrief.kpisText);
      setQuestionsText(initialBrief.questionsText);
      setComparisonPeriod(initialBrief.comparisonPeriod);
      setRefreshFrequency(initialBrief.refreshFrequency);
      setMustIncludeSectionsText(initialBrief.mustIncludeSectionsText);
      setAlertFocusText(initialBrief.alertFocusText);
      setPreferredGranularity(initialBrief.preferredGranularity);
      setDecisionContext(initialBrief.decisionContext);
      setReportStyle(initialBrief.reportStyle);
      setInsightDepth(initialBrief.insightDepth);
      setRecommendationStyle(initialBrief.recommendationStyle);
      setConfidencePreference(initialBrief.confidencePreference);
      setPreferredDashboardStructure(initialBrief.preferredDashboardStructure);
      setIncludeTextNarrative(initialBrief.includeTextNarrative);
      setIncludeActionItems(initialBrief.includeActionItems);
      setIncludeDataQualityNotes(initialBrief.includeDataQualityNotes);
      setTableRolesHintText(initialBrief.tableRolesHintText);
      setBusinessGlossaryText(initialBrief.businessGlossaryText);
      setKnownDataIssuesText(initialBrief.knownDataIssuesText);
      setImportantDimensionsText(initialBrief.importantDimensionsText);
      setColumnsToAvoidText(initialBrief.columnsToAvoidText);
      setNotes(initialBrief.notes);
      setPlanningMode(initialBrief.planningMode);
      setGeneratedPlan(null);
      setDraftPlan(null);
      setPlanningEvents([]);
      setEvents([]);
      setAgentError(null);
      setIsBuildRunning(false);
      setBuildMode('new_dashboard');
      setPlanWorkspaceTab('overview');
    }
  }, [initialBrief, initialSpecId, isActive]);

  useEffect(() => {
    setActiveSpecId(initialSpecId);
  }, [initialSpecId]);

  useEffect(() => {
    if (!isActive || !workspaceDetailsQuery.data?.length) return;

    setExpandedWorkspaceIds((prev) => {
      const validIds = prev.filter((id) => workspaceDetailsQuery.data.some((workspace) => workspace.id === id));
      if (validIds.length > 0) {
        return validIds;
      }

      return workspaceDetailsQuery.data
        .slice(0, 3)
        .map((workspace) => workspace.id);
    });
  }, [isActive, workspaceDetailsQuery.data]);

  useEffect(() => {
    const spec = activeSpec;
    if (!isActive || !spec) return;

    const brief = spec.brief_json ?? {};
    const selected = Array.isArray(spec.selected_tables_snapshot) ? spec.selected_tables_snapshot : [];
    setSelectedKeys(
      selected
        .map((item) => `${item.workspace_id}:${item.table_id}`)
        .filter((item) => item !== 'undefined:undefined'),
    );
    setReportName(String(brief.report_name ?? spec.name ?? '').trim());
    setReportType(String(brief.report_type ?? 'executive_tracking'));
    setGoal(String(brief.goal ?? initialBrief.goal));
    setAudience(String(brief.audience ?? ''));
    setTimeframe(String(brief.timeframe ?? ''));
    setWhyNow(String(brief.why_now ?? ''));
    setBusinessBackground(String(brief.business_background ?? ''));
    setKpisText(briefToMultiline(brief.kpis));
    setQuestionsText(briefToMultiline(brief.questions));
    setComparisonPeriod(String(brief.comparison_period ?? ''));
    setRefreshFrequency(String(brief.refresh_frequency ?? ''));
    setMustIncludeSectionsText(briefToMultiline(brief.must_include_sections));
    setAlertFocusText(briefToMultiline(brief.alert_focus));
    setPreferredGranularity(String(brief.preferred_granularity ?? ''));
    setDecisionContext(String(brief.decision_context ?? ''));
    setReportStyle(String(brief.report_style ?? 'executive'));
    setInsightDepth(String(brief.insight_depth ?? 'balanced'));
    setRecommendationStyle(String(brief.recommendation_style ?? 'suggested_actions'));
    setConfidencePreference(String(brief.confidence_preference ?? 'include_tentative_with_caveats'));
    setPreferredDashboardStructure(String(brief.preferred_dashboard_structure ?? 'summary_first'));
    setIncludeTextNarrative(Boolean(brief.include_text_narrative ?? true));
    setIncludeActionItems(Boolean(brief.include_action_items ?? true));
    setIncludeDataQualityNotes(Boolean(brief.include_data_quality_notes ?? true));
    setTableRolesHintText(briefToMultiline(brief.table_roles_hint));
    setBusinessGlossaryText(briefToMultiline(brief.business_glossary));
    setKnownDataIssuesText(briefToMultiline(brief.known_data_issues));
    setImportantDimensionsText(briefToMultiline(brief.important_dimensions));
    setColumnsToAvoidText(briefToMultiline(brief.columns_to_avoid));
    setNotes(String(brief.notes ?? ''));
    setPlanningMode(brief.planning_mode === 'quick' ? 'quick' : 'deep');

    if (spec.approved_plan_json) {
      const editable = normalizePlan(spec.approved_plan_json as AgentPlanResponse);
      setGeneratedPlan(editable);
      setDraftPlan(cloneEditablePlan(editable));
      setBuildMode(spec.latest_dashboard_id ? 'replace_existing' : 'new_dashboard');
      setPlanWorkspaceTab('overview');
      setStep('plan');
    } else {
      setGeneratedPlan(null);
      setDraftPlan(null);
      setActiveBriefSection('essentials');
      setStep('brief');
    }
    setAgentError(null);
  }, [activeSpec, initialBrief, isActive]);

  useEffect(() => {
    if (!activeBriefSectionMeta) return;
    if (activeBriefSection !== activeBriefSectionMeta.key) {
      setActiveBriefSection(activeBriefSectionMeta.key);
    }
  }, [activeBriefSection, activeBriefSectionMeta]);

  const planMutation = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      planAbortControllerRef.current = controller;
      const token = await getAuthToken();
      try {
        const response = await fetch(`${AI_AGENT_HTTP_URL}/agent/plan/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(briefPayload),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text();
          throw new Error(detail || 'AI Agent could not generate a plan.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalPlan: AgentPlanResponse | null = null;
        setPlanningEvents([]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as AgentPlanEvent;
            setPlanningEvents((prev) => [...prev, event]);
            if (event.type === 'error') {
              throw new Error(event.error || event.message || 'AI Agent planning failed.');
            }
            if (event.type === 'done' && event.plan) {
              finalPlan = event.plan;
            }
          }
        }

        if (!finalPlan) {
          throw new Error('AI Agent did not return a final plan.');
        }
        return finalPlan;
      } finally {
        planAbortControllerRef.current = null;
      }
    },
    onSuccess: async (data) => {
      const editable = normalizePlan(data);
      setGeneratedPlan(editable);
      setDraftPlan(cloneEditablePlan(editable));
      setPlanWorkspaceTab('overview');
      setStep('plan');
      setAgentError(null);
      if (activeSpecId) {
        try {
          await persistCurrentSpec(editable);
          await refreshAgentReportViews(activeSpecId);
        } catch (error: any) {
          setAgentError(error.message || 'Updated draft generated, but the saved report could not be refreshed.');
        }
      }
    },
    onError: (error: Error) => {
      if (error.name === 'AbortError') {
        setAgentError(null);
        setPlanningEvents((prev) =>
          prev.length > 0
            ? [...prev, { type: 'stopped', phase: 'stopped', message: 'Draft generation stopped by user.' }]
            : [{ type: 'stopped', phase: 'stopped', message: 'Draft generation stopped by user.' }],
        );
        toast.info('Draft generation stopped.');
        return;
      }
      setAgentError(error.message);
    },
  });
  const isPlanningLocked = planMutation.isPending;
  const isInteractionLocked = isBuildRunning || isPlanningLocked;

  useEffect(() => {
    if (!isPlanningLocked) return;
    if (typeof document === 'undefined') return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  }, [isPlanningLocked]);

  useEffect(() => {
    return () => {
      planAbortControllerRef.current?.abort();
    };
  }, []);

  async function persistCurrentSpec(plan: EditableAgentPlan | AgentPlanResponse): Promise<number> {
    const payload = {
      name: briefPayload.report_name || plan.dashboard_title,
      description: plan.dashboard_summary,
      selected_tables_snapshot: briefPayload.selected_tables,
      brief_json: briefPayload as unknown as Record<string, any>,
      approved_plan_json: plan as unknown as Record<string, any>,
      status: 'ready' as const,
    };

    if (activeSpecId) {
      await updateSpecMutation.mutateAsync({ id: activeSpecId, payload });
      return activeSpecId;
    }

    const created = await createSpecMutation.mutateAsync(payload);
    setActiveSpecId(created.id);
    return created.id;
  }

  async function refreshAgentReportViews(specId: number | null | undefined) {
    await queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.lists() });
    if (specId) {
      await queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.detail(specId) });
      await queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.runs(specId) });
    }
  }

  async function handleDeleteReport() {
    if (!activeSpecId || isInteractionLocked) return;
    const confirmed = window.confirm(
      activeSpec?.latest_dashboard_id
        ? `Delete this AI report?\n\nThis removes the saved brief and run history, but keeps the linked dashboard in Dashboards.`
        : 'Delete this AI report?\n\nThis removes the saved brief and run history.',
    );
    if (!confirmed) return;

    try {
      await deleteSpecMutation.mutateAsync(activeSpecId);
      await refreshAgentReportViews(null);
      toast.success('AI report deleted.');
      if (isPageMode) {
        router.push(backHref);
      } else {
        handleClose();
      }
    } catch (error: any) {
      setAgentError(error.message || 'Could not delete the AI report.');
    }
  }

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

  function openAllBriefSections() {
    setExpandedBriefSections(ALL_BRIEF_SECTIONS);
  }

  function collapseOptionalBriefSections() {
    setExpandedBriefSections(DEFAULT_BRIEF_SECTIONS);
  }

  function applyBriefPreset(presetKey: (typeof BRIEF_PRESETS)[number]['key']) {
    const preset = BRIEF_PRESETS.find((item) => item.key === presetKey);
    if (!preset) return;

    setGoal(preset.goal);
    setAudience(preset.audience);
    setReportStyle(preset.reportStyle);
    setReportType(preset.reportType);
    setComparisonPeriod(preset.comparisonPeriod);
    setRefreshFrequency(preset.refreshFrequency);
    setMustIncludeSectionsText(preset.mustIncludeSectionsText);
    setAlertFocusText(preset.alertFocusText);
    setInsightDepth(preset.insightDepth);
    setRecommendationStyle(preset.recommendationStyle);
    setPreferredDashboardStructure(preset.preferredDashboardStructure);
    openAllBriefSections();
    toast.success(`${preset.title} preset applied.`);
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

  function stopPlanning() {
    if (!isPlanningLocked) return;
    planAbortControllerRef.current?.abort();
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
    let persistedSpecId: number | null = activeSpecId;

    try {
      const specId = await persistCurrentSpec(draftPlan);
      persistedSpecId = specId;
      const targetDashboardId =
        buildMode === 'replace_existing'
          ? activeSpec?.latest_dashboard_id ?? null
          : null;
      if (buildMode === 'replace_existing' && !targetDashboardId) {
        throw new Error('This report does not have an existing dashboard to replace yet.');
      }
      const run = await createRunMutation.mutateAsync({
        id: specId,
        payload: {
          build_mode: buildMode,
          input_brief_json: briefPayload as unknown as Record<string, any>,
          plan_json: buildPlan as unknown as Record<string, any>,
          target_dashboard_id: targetDashboardId,
          status: 'queued',
        },
      });

      const token = await getAuthToken();
      const response = await fetch(`${AI_AGENT_HTTP_URL}/agent/build/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          brief: briefPayload,
          plan: buildPlan,
          build_mode: buildMode,
          report_spec_id: specId,
          report_run_id: run.id,
          target_dashboard_id: targetDashboardId,
        }),
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
            await refreshAgentReportViews(specId);
            toast.success('AI report built successfully. Opening the dashboard so you can continue editing there.');
            if (!isPageMode) {
              handleClose();
            }
            const destination = event.dashboard_url || event.report_url || (specId ? `/ai-reports/${specId}` : null);
            if (destination) {
              router.push(destination);
            }
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
      await refreshAgentReportViews(persistedSpecId);
      setIsBuildRunning(false);
    }
  }

  if (!isActive && !isPageMode) return null;

  return (
    <AppModalShell
      variant={isPageMode ? 'page' : 'modal'}
      onClose={handleClose}
      title="Build an AI report from a business brief"
      description={(
        <div className="space-y-2">
          <p>
            Inside AI Reports: choose the tables, generate a draft plan, review and edit it, then let the Agent build the dashboard and narrative report.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
              AI Agent runtime
            </span>
            {agentHealthQuery.data?.provider && agentHealthQuery.data?.model ? (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600">
                {agentHealthQuery.data.provider} / {agentHealthQuery.data.model}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-500">
                Runtime info unavailable
              </span>
            )}
            {typeof agentHealthQuery.data?.timeout_seconds === 'number' && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-500">
                Timeout {agentHealthQuery.data.timeout_seconds}s
              </span>
            )}
          </div>
        </div>
      )}
      icon={<Wand2 className="h-5 w-5" />}
      maxWidthClass={isPageMode ? 'max-w-none' : 'max-w-6xl'}
      panelClassName={
        isPageMode
          ? 'min-h-[calc(100vh-5rem)] rounded-none border-0 shadow-none'
          : 'h-[88vh] max-h-[90vh]'
      }
      bodyClassName={isPageMode ? 'px-4 py-5 lg:px-6 xl:px-8' : 'px-6 py-5'}
      closeDisabled={isInteractionLocked}
      footer={(
        <>
        <div className="mr-auto text-sm text-gray-500">
          {selectedTables.length > 0 && `${selectedTables.length} table${selectedTables.length !== 1 ? 's' : ''} selected`}
          {step === 'plan' && draftPlan && ` | ${enabledChartCount} active chart${enabledChartCount !== 1 ? 's' : ''}`}
        </div>

          {activeSpecId && (
            <button
              onClick={handleDeleteReport}
              disabled={isInteractionLocked || deleteSpecMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-rose-700 bg-white border border-rose-200 rounded-md hover:bg-rose-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete report
            </button>
          )}

          {step === 'select' && (
            <button
              onClick={handleClose}
              disabled={isInteractionLocked}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              {isPageMode ? 'Back to AI reports' : 'Close'}
            </button>
          )}

          {step === 'brief' && (
            <button
              onClick={() => setStep('select')}
              disabled={isInteractionLocked}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          )}

          {step === 'plan' && (
            <button
              onClick={() => setStep('brief')}
              disabled={isInteractionLocked}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
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
                onClick={async () => {
                  if (!draftPlan) return;
                  try {
                    const specId = await persistCurrentSpec(draftPlan);
                    toast.success(activeSpecId ? 'AI report updated.' : `AI report saved (#${specId}).`);
                  } catch (error: any) {
                    setAgentError(error.message || 'Could not save the AI report.');
                  }
                }}
                disabled={!draftPlan || createSpecMutation.isPending || updateSpecMutation.isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                <FileText className="h-4 w-4" />
                {activeSpecId ? 'Save report' : 'Save as report'}
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
          <fieldset disabled={isPlanningLocked} className={isPlanningLocked ? 'pointer-events-none' : ''}>
          <div className="space-y-6">
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <div className="mb-3 flex items-center gap-2 text-blue-900">
                    <Bot className="h-5 w-5" />
                    <h3 className="text-lg font-semibold">Brief the Agent like an analyst partner</h3>
                  </div>
                  <p className="text-sm leading-6 text-blue-900/90">
                    Start with the essentials, then layer in optional context only where it helps. The brief below now makes it clearer why each group exists, so you can move faster without feeling like every field is mandatory.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-blue-700">Required first</span>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-blue-700">Optional context later</span>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-blue-700">Preview what the Agent understands</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={openAllBriefSections}
                    className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-100"
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    onClick={collapseOptionalBriefSections}
                    className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-100"
                  >
                    Essentials only
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-2 text-gray-900">
                <Sparkles className="h-5 w-5 text-blue-600" />
                <h3 className="text-lg font-semibold">Start from a preset</h3>
              </div>
              <p className="mb-4 text-sm text-gray-500">
                Use a preset to prefill the brief in a sensible direction, then fine-tune only the parts that matter for this report.
              </p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {BRIEF_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => applyBriefPreset(preset.key)}
                    className="rounded-xl border border-gray-200 bg-white p-4 text-left transition hover:border-blue-300 hover:bg-blue-50/40"
                  >
                    <p className="font-semibold text-gray-900">{preset.title}</p>
                    <p className="mt-2 text-sm text-gray-600">{preset.summary}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
              <div className="grid gap-5 xl:grid-cols-[260px_minmax(0,1fr)]">
                <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
                  <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="mb-3 flex items-center gap-2 text-gray-900">
                      <ListChecks className="h-5 w-5 text-blue-600" />
                      <h3 className="text-lg font-semibold">Brief map</h3>
                    </div>
                    <div className="space-y-3">
                      {visibleBriefSections.map((section) => {
                        const active = activeBriefSection === section.key;
                        const progress = briefSectionProgress[section.key];
                        return (
                          <button
                            key={section.key}
                            type="button"
                            onClick={() => setActiveBriefSection(section.key)}
                            className={`w-full rounded-xl border p-4 text-left transition ${
                              active
                                ? 'border-blue-300 bg-blue-50 shadow-sm'
                                : 'border-gray-200 bg-white hover:border-blue-200 hover:bg-blue-50/40'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-semibold text-gray-900">{section.title}</p>
                                <p className="mt-1 text-sm text-gray-500">{section.description}</p>
                              </div>
                              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
                                section.optional ? 'bg-gray-100 text-gray-600' : 'bg-blue-100 text-blue-700'
                              }`}>
                                {section.optional ? 'Optional' : 'Core'}
                              </span>
                            </div>
                            <div className="mt-3 flex items-center justify-between text-xs">
                              <span className="text-gray-400">{progress.filled}/{progress.total} signals</span>
                              <span className={progress.ready ? 'text-emerald-600' : 'text-gray-400'}>
                                {progress.ready ? 'Ready' : 'In progress'}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="space-y-5">
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-base font-semibold text-blue-900">{activeBriefSectionMeta.title}</h4>
                    <p className="mt-1 text-sm text-blue-900/80">{activeBriefSectionMeta.description}</p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                    {activeBriefSectionMeta.optional ? 'Optional' : 'Core'}
                  </span>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.16em] text-blue-700">Why this matters</p>
                <p className="mt-1 text-sm text-blue-900/80">{activeBriefSectionMeta.helper}</p>
              </div>

              {activeBriefSection === 'essentials' && (
                <>
              <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Report name</label>
                  <input
                    value={reportName}
                    onChange={(event) => setReportName(event.target.value)}
                    placeholder="Executive KPI watch"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Good first draft checklist</p>
                  <div className="mt-3 space-y-2 text-sm text-gray-600">
                    <p>- Goal: what the reader should decide.</p>
                    <p>- Audience: who this report is speaking to.</p>
                    <p>- KPI + question: what the dashboard must explain.</p>
                  </div>
                </div>
              </div>
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
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Why now</label>
                  <textarea
                    value={whyNow}
                    onChange={(event) => setWhyNow(event.target.value)}
                    rows={3}
                    placeholder="Why this report matters right now"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Business background</label>
                  <textarea
                    value={businessBackground}
                    onChange={(event) => setBusinessBackground(event.target.value)}
                    rows={3}
                    placeholder="Short domain context, current initiative, or operational backdrop"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
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
                </>
              )}
              {activeBriefSection === 'intent' && (
                <>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-base font-semibold text-gray-900">Report intent</h4>
                    <p className="mt-1 text-sm text-gray-600">Tell the Agent what kind of report you want and how it should reason.</p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-gray-600">
                    Core
                  </span>
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.16em] text-gray-400">Why this matters</p>
                <p className="mt-1 text-sm text-gray-500">This influences chart selection, comparison logic, section structure, and the tone of the narrative.</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Comparison period</label>
                  <input
                    value={comparisonPeriod}
                    onChange={(event) => setComparisonPeriod(event.target.value)}
                    placeholder="Previous period / YoY / WoW"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Refresh frequency</label>
                  <input
                    value={refreshFrequency}
                    onChange={(event) => setRefreshFrequency(event.target.value)}
                    placeholder="Daily / Weekly / Monthly"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Report style</label>
                  <select
                    value={reportStyle}
                    onChange={(event) => setReportStyle(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="executive">Executive</option>
                    <option value="operational">Operational</option>
                    <option value="investigative">Investigative</option>
                      <option value="monitoring">Monitoring</option>
                  </select>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Planning mode</label>
                  <select
                    value={planningMode}
                    onChange={(event) => setPlanningMode(event.target.value as 'quick' | 'deep')}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="deep">Deep draft</option>
                    <option value="quick">Quick draft</option>
                  </select>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Preferred granularity</label>
                  <input
                    value={preferredGranularity}
                    onChange={(event) => setPreferredGranularity(event.target.value)}
                    placeholder="day / week / month"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Report type</label>
                  <input
                    value={reportType}
                    onChange={(event) => setReportType(event.target.value)}
                    placeholder="executive_tracking / anomaly_watch"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Must-have sections</label>
                  <textarea
                    value={mustIncludeSectionsText}
                    onChange={(event) => setMustIncludeSectionsText(event.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Alert focus</label>
                  <textarea
                    value={alertFocusText}
                    onChange={(event) => setAlertFocusText(event.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">Decision context</label>
                <textarea
                  value={decisionContext}
                  onChange={(event) => setDecisionContext(event.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
                </>
              )}
              {activeBriefSection === 'dataset' && expandedBriefSections.includes('dataset') && (
                <>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-gray-900">Dataset context</h4>
                        <p className="mt-1 text-sm text-gray-600">Optional hints when your data needs extra business interpretation.</p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-gray-600">
                        Optional
                      </span>
                    </div>
                    <p className="mt-3 text-xs uppercase tracking-[0.16em] text-gray-400">Why this matters</p>
                    <p className="mt-1 text-sm text-gray-500">This reduces guessing when table names, fields, or known data issues are ambiguous.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Table role hints</label>
                      <textarea
                        value={tableRolesHintText}
                        onChange={(event) => setTableRolesHintText(event.target.value)}
                        rows={3}
                        placeholder="Example: Data Lake - Segment = activity inventory"
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Business glossary</label>
                      <textarea
                        value={businessGlossaryText}
                        onChange={(event) => setBusinessGlossaryText(event.target.value)}
                        rows={3}
                        placeholder="Define KPI names, business terms, or internal abbreviations"
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Known data issues</label>
                      <textarea
                        value={knownDataIssuesText}
                        onChange={(event) => setKnownDataIssuesText(event.target.value)}
                        rows={3}
                        placeholder="Missing owners, stale timestamps, duplicated rows..."
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Important dimensions</label>
                      <textarea
                        value={importantDimensionsText}
                        onChange={(event) => setImportantDimensionsText(event.target.value)}
                        rows={3}
                        placeholder="Region, department, status..."
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Columns to avoid</label>
                      <textarea
                        value={columnsToAvoidText}
                        onChange={(event) => setColumnsToAvoidText(event.target.value)}
                        rows={3}
                        placeholder="Low-trust fields or columns that should not drive the report"
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                  </div>
                </>
              )}
              {activeBriefSection === 'narrative' && expandedBriefSections.includes('narrative') && (
                <>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-gray-900">Narrative output</h4>
                        <p className="mt-1 text-sm text-gray-600">Optional controls for how much written analysis the Agent should ship.</p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-gray-600">
                        Optional
                      </span>
                    </div>
                    <p className="mt-3 text-xs uppercase tracking-[0.16em] text-gray-400">Why this matters</p>
                    <p className="mt-1 text-sm text-gray-500">This affects summary depth, confidence wording, and whether the Agent should suggest actions.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Insight depth</label>
                      <select
                        value={insightDepth}
                        onChange={(event) => setInsightDepth(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      >
                        <option value="concise">Concise</option>
                        <option value="balanced">Balanced</option>
                        <option value="deep">Deep</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Recommendations</label>
                      <select
                        value={recommendationStyle}
                        onChange={(event) => setRecommendationStyle(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      >
                        <option value="none">None</option>
                        <option value="suggested_actions">Suggested actions</option>
                        <option value="priority_actions">Priority actions</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">Confidence mode</label>
                      <select
                        value={confidencePreference}
                        onChange={(event) => setConfidencePreference(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      >
                        <option value="high_confidence_only">High confidence only</option>
                        <option value="include_tentative_with_caveats">Include tentative insights with caveats</option>
                      </select>
                    </div>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-900">Narrative output preferences</h4>
                    <p className="mt-1 text-xs text-gray-500">Tell the Agent how much text analysis should ship with the dashboard.</p>
                  </div>
                  <select
                    value={preferredDashboardStructure}
                    onChange={(event) => setPreferredDashboardStructure(event.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="summary_first">Summary first</option>
                    <option value="section_by_issue">Section by issue</option>
                    <option value="section_by_team">Section by team</option>
                  </select>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={includeTextNarrative}
                      onChange={(event) => setIncludeTextNarrative(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>
                      <span className="block font-medium text-gray-900">Include narrative text</span>
                      Executive summary and section write-up alongside the charts.
                    </span>
                  </label>
                  <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={includeActionItems}
                      onChange={(event) => setIncludeActionItems(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>
                      <span className="block font-medium text-gray-900">Include action items</span>
                      Ask the Agent to suggest next actions where evidence supports them.
                    </span>
                  </label>
                  <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={includeDataQualityNotes}
                      onChange={(event) => setIncludeDataQualityNotes(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>
                      <span className="block font-medium text-gray-900">Include quality notes</span>
                      Keep caveats visible when data quality weakens confidence.
                    </span>
                  </label>
                </div>
                  </div>
                </>
              )}
              {activeBriefSection === 'advanced' && expandedBriefSections.includes('advanced') && (
                <>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-gray-900">Advanced</h4>
                        <p className="mt-1 text-sm text-gray-600">Use this for extra analyst notes, constraints, and edge-case instructions.</p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-gray-600">
                        Optional
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">Additional notes</label>
                    <textarea
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      rows={3}
                      className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                  </div>
                </>
              )}
              <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  disabled={activeBriefSectionIndex <= 0}
                  onClick={() => {
                    const previous = visibleBriefSections[activeBriefSectionIndex - 1];
                    if (previous) setActiveBriefSection(previous.key);
                  }}
                  className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Previous area
                </button>
                <button
                  type="button"
                  disabled={activeBriefSectionIndex >= visibleBriefSections.length - 1}
                  onClick={() => {
                    const next = visibleBriefSections[activeBriefSectionIndex + 1];
                    if (next) setActiveBriefSection(next.key);
                  }}
                  className="inline-flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next area
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
              </div>

            <div className="space-y-5 xl:sticky xl:top-6 xl:self-start">
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="mb-3 flex items-center gap-2 text-gray-900">
                      <Eye className="h-5 w-5 text-blue-600" />
                      <h3 className="text-lg font-semibold">Live brief summary</h3>
                    </div>
                    <p className="text-sm leading-6 text-gray-700">{agentUnderstandingPreview}</p>
                  </div>
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                    {readinessCount}/{readinessChecks.length} ready
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">{reportStyle || 'executive'}</span>
                  {briefKpis.slice(0, 2).map((item) => (
                    <span key={item} className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">{item}</span>
                  ))}
                </div>
                <div className="mt-5 space-y-3">
                  {readinessChecks.map((item) => (
                    <div key={item.label} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                      <span className="text-sm text-gray-700">{item.label}</span>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
                        item.done ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {item.done ? 'Ready' : 'Missing'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-3 flex items-center gap-2 text-gray-900">
                  <Sparkles className="h-5 w-5 text-blue-600" />
                  <h3 className="text-lg font-semibold">{activeBriefFocus.title}</h3>
                </div>
                <p className="text-sm leading-6 text-gray-600">{activeBriefFocus.description}</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                  {activeBriefSnapshot.map((item) => (
                    <div key={item.label} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{item.label}</p>
                      <p className="mt-2 text-sm font-semibold text-gray-900">{item.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-4 space-y-3 text-sm text-gray-600">
                  {activeBriefFocus.bullets.map((item) => (
                    <p key={item}>- {item}</p>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-3 flex items-center gap-2 text-gray-900">
                  <FileText className="h-5 w-5 text-gray-500" />
                  <h3 className="text-lg font-semibold">Selected scope</h3>
                </div>
                <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Selected tables</p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedTables.length}</p>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Questions supplied</p>
                    <p className="mt-2 text-2xl font-semibold text-gray-900">{briefQuestions.length}</p>
                  </div>
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

              {(planMutation.isPending || planningEvents.length > 0) && (
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-semibold text-gray-900">Planning progress</h4>
                      <p className="mt-1 text-sm text-gray-500">The Agent is reasoning through the selected scope.</p>
                    </div>
                    {planMutation.isPending && <Loader2 className="h-5 w-5 animate-spin text-blue-500" />}
                  </div>
                  <div className="space-y-3">
                    {planningEvents.map((event, index) => (
                      <div key={`${event.phase}-${index}`} className="rounded-lg border border-gray-200 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-gray-900">{event.message}</p>
                            {event.error && <p className="mt-2 text-sm text-rose-600">{event.error}</p>}
                          </div>
                          <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${getPlanEventBadgeClass(event)}`}>
                            {event.phase}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>
          </fieldset>
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
                  {draftPlan.strategy_summary && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Strategy summary</p>
                      <p className="mt-2">{draftPlan.strategy_summary}</p>
                    </div>
                  )}
                  {draftPlan.warnings.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      {draftPlan.warnings.join(' ')}
                    </div>
                  )}
                  {activeSpecId && (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                      Editing saved AI report #{activeSpecId}. You can keep refining this draft and rerun it later.
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
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
                    <Sparkles className="h-5 w-5 text-blue-600" />
                    <span className="text-sm font-semibold">Quality score</span>
                  </div>
                  <p className="mt-3 text-3xl font-semibold text-gray-900">{Math.round((draftPlan.quality_score ?? 0) * 100)}%</p>
                  <div className="mt-3 grid gap-2 text-xs text-gray-500">
                    {Object.entries(draftPlan.quality_breakdown ?? {}).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between">
                        <span className="capitalize">{key.replace(/_/g, ' ')}</span>
                        <span>{Math.round((value ?? 0) * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <label className="mb-2 block text-sm font-medium text-gray-700">Build mode</label>
                  <select
                    value={buildMode}
                    onChange={(event) => setBuildMode(event.target.value as AgentBuildMode)}
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="new_dashboard">Create a new dashboard</option>
                    <option value="new_version">Create a new version</option>
                    <option value="replace_existing" disabled={!activeSpec?.latest_dashboard_id}>Replace the latest saved dashboard</option>
                  </select>
                  <p className="mt-2 text-xs text-gray-500">
                    {activeSpec?.latest_dashboard_id
                      ? `Latest dashboard: #${activeSpec.latest_dashboard_id}`
                      : 'Save and build once to enable replace-existing mode.'}
                  </p>
                </div>
                {recentRuns.length > 0 && (
                  <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="mb-3 flex items-center gap-2 text-gray-900">
                      <History className="h-5 w-5 text-blue-600" />
                      <span className="text-sm font-semibold">Recent runs</span>
                    </div>
                    <div className="space-y-3">
                      {recentRuns.map((run) => (
                        <div key={run.id} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-gray-900">
                                Run #{run.id} · {run.build_mode.replace(/_/g, ' ')}
                              </p>
                              <p className="mt-1 text-xs text-gray-500">
                                {new Date(run.created_at).toLocaleString('vi-VN')}
                              </p>
                            </div>
                            <span
                              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                                run.status === 'succeeded'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : run.status === 'failed'
                                    ? 'bg-rose-50 text-rose-700'
                                    : 'bg-blue-50 text-blue-700'
                              }`}
                            >
                              {run.status}
                            </span>
                          </div>
                          {run.error && (
                            <p className="mt-2 text-xs text-rose-600">{run.error}</p>
                          )}
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => router.push(`/ai-reports/${activeSpecId}`)}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              Read report
                            </button>
                            {run.dashboard_id && (
                              <button
                                type="button"
                                onClick={() => router.push(`/dashboards/${run.dashboard_id}`)}
                                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                Edit in dashboard
                              </button>
                            )}
                            {run.result_summary_json?.created_chart_count != null && (
                              <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-gray-600">
                                {run.result_summary_json.created_chart_count} charts built
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h4 className="text-lg font-semibold text-gray-900">Review workspace</h4>
                  <p className="mt-1 text-sm text-gray-500">Read in order: overview first, reasoning second, then edit sections and charts.</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {PLAN_WORKSPACE_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setPlanWorkspaceTab(tab.key)}
                      className={`rounded-lg border px-4 py-3 text-left transition ${
                        planWorkspaceTab === tab.key
                          ? 'border-blue-300 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-blue-200 hover:bg-blue-50/40'
                      }`}
                    >
                      <p className="text-sm font-semibold">{tab.label}</p>
                      <p className={`mt-1 text-xs ${planWorkspaceTab === tab.key ? 'text-blue-600' : 'text-gray-400'}`}>
                        {tab.caption}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {(planWorkspaceTab === 'overview' || planWorkspaceTab === 'reasoning') && (
            <div className="grid gap-6 xl:grid-cols-2">
              {draftPlan.parsed_brief && planWorkspaceTab === 'overview' && (
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center gap-2 text-gray-900">
                    <Bot className="h-5 w-5 text-blue-600" />
                    <h4 className="text-lg font-semibold">How the Agent understood your brief</h4>
                  </div>
                  <div className="space-y-4 text-sm text-gray-700">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Business goal</p>
                      <p className="mt-2 text-gray-900">{draftPlan.parsed_brief.business_goal}</p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-gray-400">Audience</p>
                        <p className="mt-2 font-medium text-gray-900">{draftPlan.parsed_brief.target_audience || 'General business audience'}</p>
                      </div>
                      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-gray-400">Report style</p>
                        <p className="mt-2 font-medium capitalize text-gray-900">{(draftPlan.parsed_brief.report_style || 'executive').replace(/_/g, ' ')}</p>
                      </div>
                    </div>
                    {draftPlan.parsed_brief.success_criteria?.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Success criteria</p>
                        <ul className="mt-2 space-y-2 text-gray-700">
                          {draftPlan.parsed_brief.success_criteria.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {draftPlan.parsed_brief.explicit_assumptions?.length > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">Assumptions</p>
                        <ul className="mt-2 space-y-2 text-sm">
                          {draftPlan.parsed_brief.explicit_assumptions.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {draftPlan.quality_gate_report && planWorkspaceTab === 'overview' && (
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center gap-2 text-gray-900">
                    <CheckCircle2 className="h-5 w-5 text-blue-600" />
                    <h4 className="text-lg font-semibold">Data quality gate</h4>
                  </div>
                  <div className="space-y-4 text-sm text-gray-700">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                        {draftPlan.quality_gate_report.overall_status.replace(/_/g, ' ')}
                      </span>
                      <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                        {Object.keys(draftPlan.quality_gate_report.confidence_penalties ?? {}).length} table-level penalty flag{Object.keys(draftPlan.quality_gate_report.confidence_penalties ?? {}).length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="text-gray-900">{draftPlan.quality_gate_report.quality_summary}</p>
                    {draftPlan.quality_gate_report.blockers.length > 0 && (
                      <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-rose-800">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-700">Blockers</p>
                        <ul className="mt-2 space-y-2 text-sm">
                          {draftPlan.quality_gate_report.blockers.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {draftPlan.quality_gate_report.warnings.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Warnings</p>
                        <ul className="mt-2 space-y-2">
                          {draftPlan.quality_gate_report.warnings.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {draftPlan.dataset_fit_report && draftPlan.dataset_fit_report.length > 0 && planWorkspaceTab === 'reasoning' && (
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm xl:col-span-2">
                  <div className="mb-4 flex items-center gap-2 text-gray-900">
                    <Table2 className="h-5 w-5 text-blue-600" />
                    <h4 className="text-lg font-semibold">Why the Agent is using these tables</h4>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {draftPlan.dataset_fit_report.map((item) => (
                      <div key={`${item.workspace_id}:${item.table_id}`} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{item.workspace_name}</p>
                            <p className="mt-1 text-base font-semibold text-gray-900">{item.table_name}</p>
                          </div>
                          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                            {Math.round(item.fit_score * 100)}% fit
                          </span>
                        </div>
                        <p className="mt-3 text-sm text-gray-700">
                          Suggested role: <span className="font-medium capitalize text-gray-900">{item.suggested_role.replace(/_/g, ' ')}</span>
                        </p>
                        {item.notes && <p className="mt-2 text-sm text-gray-600">{item.notes}</p>}
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Good for</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {item.good_for.map((note) => (
                                <span key={note} className="rounded-full bg-white px-3 py-1 text-xs text-gray-700">{note}</span>
                              ))}
                            </div>
                          </div>
                          {item.metadata_risk && item.metadata_risk !== 'low' && (
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Metadata risk</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">{item.metadata_risk}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {draftPlan.analysis_plan && planWorkspaceTab === 'reasoning' && (
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center gap-2 text-gray-900">
                    <ListChecks className="h-5 w-5 text-blue-600" />
                    <h4 className="text-lg font-semibold">Analysis logic</h4>
                  </div>
                  <div className="space-y-4 text-sm text-gray-700">
                    <p className="text-gray-900">{draftPlan.analysis_plan.business_thesis}</p>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Priority checks</p>
                      <ul className="mt-2 space-y-2">
                        {draftPlan.analysis_plan.priority_checks.map((item) => (
                          <li key={item}>- {item}</li>
                        ))}
                      </ul>
                    </div>
                    {draftPlan.analysis_plan.question_map.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Question mapping</p>
                        <div className="mt-2 space-y-3">
                          {draftPlan.analysis_plan.question_map.map((item) => (
                            <div key={item.question} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                              <p className="font-medium text-gray-900">{item.question}</p>
                              <p className="mt-1 text-xs uppercase tracking-[0.14em] text-gray-500">{item.suggested_method}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {draftPlan.profiling_report && draftPlan.profiling_report.length > 0 && planWorkspaceTab === 'reasoning' && (
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center gap-2 text-gray-900">
                    <Sparkles className="h-5 w-5 text-blue-600" />
                    <h4 className="text-lg font-semibold">What the Agent found in the data</h4>
                  </div>
                  <div className="space-y-3">
                    {draftPlan.profiling_report.map((item) => (
                      <div key={`${item.workspace_id}:${item.table_id}`} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-gray-900">{item.table_name}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{item.workspace_name}</p>
                          </div>
                          <span className="rounded-full bg-white px-3 py-1 text-xs text-gray-600">{item.table_grain}</span>
                        </div>
                        <p className="mt-2 text-sm text-gray-700">{item.semantic_summary || 'The Agent extracted candidate metrics, dimensions, and data shape from the sampled rows.'}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {item.candidate_metrics.slice(0, 3).map((metric) => (
                            <span key={metric} className="rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-700">{metric}</span>
                          ))}
                          {item.candidate_dimensions.slice(0, 3).map((dimension) => (
                            <span key={dimension} className="rounded-full bg-white px-3 py-1 text-xs text-gray-700">{dimension}</span>
                          ))}
                          {item.null_risk_columns.slice(0, 2).map((risk) => (
                            <span key={risk} className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">{risk}</span>
                          ))}
                          {item.risk_flags.slice(0, 2).map((risk) => (
                            <span key={risk} className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">{risk}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            )}

            {planWorkspaceTab === 'sections' && (
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
                            {section.why_this_section && (
                              <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-900">
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Why this section</p>
                                <p className="mt-2">{section.why_this_section}</p>
                              </div>
                            )}
                            {section.questions_covered?.length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {section.questions_covered.map((question) => (
                                  <span key={question} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                                    {question}
                                  </span>
                                ))}
                              </div>
                            )}
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

              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-semibold text-gray-900">Section review notes</h4>
                      <p className="mt-1 text-sm text-gray-500">Tighten section titles and intent first. Chart edits can wait until the next tab.</p>
                    </div>
                  </div>
                  <div className="space-y-3 text-sm text-gray-600">
                    <p>- Keep section titles outcome-oriented, not field-oriented.</p>
                    <p>- Use the intent box to say what each section should help the reader decide.</p>
                    <p>- Leave charts for the dedicated charts tab so this screen stays focused.</p>
                  </div>
              </div>
            </div>
            )}

            {planWorkspaceTab === 'charts' && (
            <div className="grid gap-6 lg:grid-cols-[0.32fr_0.68fr]">
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-semibold text-gray-900">Chart review notes</h4>
                      <p className="mt-1 text-sm text-gray-500">This is the last pass before build, so only keep charts that clearly earn their place.</p>
                    </div>
                  </div>
                  <div className="space-y-3 text-sm text-gray-600">
                    <p>- Disable charts that repeat the same signal.</p>
                    <p>- Rename charts so a reader understands them without opening the config.</p>
                    <p>- Use confidence and rationale to spot weak charts before you build.</p>
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
                            {chart.why_this_chart && (
                              <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-900">
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Why this chart</p>
                                <p className="mt-2">{chart.why_this_chart}</p>
                              </div>
                            )}
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                                <p className="text-xs uppercase tracking-[0.14em] text-gray-400">Confidence</p>
                                <p className="mt-2 text-sm font-semibold text-gray-900">{Math.round((chart.confidence ?? 0) * 100)}%</p>
                              </div>
                              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                                <p className="text-xs uppercase tracking-[0.14em] text-gray-400">Expected signal</p>
                                <p className="mt-2 text-sm text-gray-700">{chart.expected_signal || 'General performance signal'}</p>
                              </div>
                              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                                <p className="text-xs uppercase tracking-[0.14em] text-gray-400">Alternative considered</p>
                                <p className="mt-2 text-sm text-gray-700">{chart.alternative_considered || 'None noted'}</p>
                              </div>
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
            )}
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
        {isPlanningLocked && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm">
            <div className="w-full max-w-2xl rounded-2xl border border-gray-200 bg-white shadow-2xl">
              <div className="border-b border-gray-200 px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-gray-900">
                      <Bot className="h-5 w-5 text-blue-600" />
                      <h3 className="text-lg font-semibold">Generating the draft plan</h3>
                    </div>
                    <p className="mt-2 text-sm text-gray-500">
                      The brief is locked while the Agent is reasoning so the plan cannot drift away from the inputs mid-run.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={stopPlanning}
                      className="inline-flex items-center gap-2 rounded-md border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
                    >
                      <X className="h-4 w-4" />
                      Stop
                    </button>
                    <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                  </div>
                </div>
              </div>
              <div className="space-y-5 px-6 py-5">
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Current focus</p>
                  <p className="mt-2 text-sm text-blue-900">
                    {planningEvents[planningEvents.length - 1]?.message || 'The Agent is parsing the brief and preparing the planning context.'}
                  </p>
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-base font-semibold text-gray-900">Planning flow</h4>
                      <p className="mt-1 text-sm text-gray-500">Watch the Agent move through the reasoning steps in order.</p>
                    </div>
                    <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                      {planningEvents.length} event{planningEvents.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
                    {planningEvents.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                        Waiting for the first planning event...
                      </div>
                    ) : (
                      planningEvents.map((event, index) => (
                        <div key={`${event.phase}-${index}`} className="rounded-lg border border-gray-200 px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-gray-900">{event.message}</p>
                              {event.error && <p className="mt-2 text-sm text-rose-600">{event.error}</p>}
                            </div>
                            <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${getPlanEventBadgeClass(event)}`}>
                              {event.phase}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

    </AppModalShell>
  );
}
