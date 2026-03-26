'use client';

import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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
  Info,
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
  DEFAULT_BRIEF_SECTIONS,
  getBriefPresets,
  getBriefSectionMeta,
  getStepMeta,
  makeInitialBriefState,
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
import { useI18n } from '@/providers/LanguageProvider';
import { SelectTablesStep } from '@/components/ai-reports/steps/SelectTablesStep';
import { BriefStep } from '@/components/ai-reports/steps/BriefStep';
import { ReviewPlanStep } from '@/components/ai-reports/steps/ReviewPlanStep';
import { BuildStep } from '@/components/ai-reports/steps/BuildStep';
import { CollapsibleGuideCard } from '@/components/ai-reports/steps/shared/CollapsibleGuideCard';
import { WizardRenderErrorBoundary } from '@/components/ai-reports/WizardRenderErrorBoundary';

type PlanWorkspaceTab = 'overview' | 'reasoning' | 'sections' | 'charts';
type BriefDockTab = 'summary' | 'scope' | 'agent';
type ProcessPhaseStatus = 'done' | 'active' | 'pending' | 'error';


function buildPhaseSummary(
  events: Array<{ phase: string; type: string }>,
  phaseOrder: string[],
): Array<{ phase: string; status: ProcessPhaseStatus }> {
  const phaseSet = new Set(events.map((event) => event.phase));
  const activePhase = [...events]
    .reverse()
    .find((event) => event.type !== 'done' && event.type !== 'error' && phaseOrder.includes(event.phase))
    ?.phase;
  const hasError = events.some((event) => event.type === 'error');

  return phaseOrder.map((phase) => {
    if (hasError && phase === activePhase) return { phase, status: 'error' };
    if (phase === activePhase) return { phase, status: 'active' };
    if (phaseSet.has(phase)) return { phase, status: 'done' };
    return { phase, status: 'pending' };
  });
}

function getProcessPhaseStatusClass(status: ProcessPhaseStatus) {
  switch (status) {
    case 'done':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'active':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    default:
      return 'border-gray-200 bg-gray-50 text-gray-500';
  }
}

function getProcessPhaseStatusLabel(status: ProcessPhaseStatus, language: 'en' | 'vi') {
  switch (status) {
    case 'done':
      return language === 'vi' ? 'Hoàn tất' : 'Done';
    case 'active':
      return language === 'vi' ? 'Đang chạy' : 'Active';
    case 'error':
      return language === 'vi' ? 'Lỗi' : 'Error';
    default:
      return language === 'vi' ? 'Chờ' : 'Pending';
  }
}

function formatProcessPhaseLabel(phase: string, language: 'en' | 'vi') {
  if (language === 'vi') {
    const phaseLabels: Record<string, string> = {
      parse_brief: 'Phân tích brief',
      collect_context: 'Thu thập ngữ cảnh',
      profile_tables: 'Profile dữ liệu',
      dataset_fit: 'Đánh giá độ phù hợp',
      quality_gate: 'Chốt chất lượng dữ liệu',
      analysis_plan: 'Lập logic phân tích',
      report_strategy: 'Dựng chiến lược report',
      chart_candidates: 'Đề xuất chart',
      plan_review: 'Rà soát draft',
      create_dashboard: 'Tạo dashboard',
      build_charts: 'Build chart',
      validate_charts: 'Kiểm tra chart',
      generate_insights: 'Tạo insight',
      compose_report: 'Soạn report',
      finalize: 'Hoàn tất',
      building_dashboard: 'Build dashboard',
      generating_insights: 'Tạo insight',
      composing_report: 'Soạn report',
      queued: 'Đang chờ',
      done: 'Hoàn tất',
    };
    return phaseLabels[phase] ?? phase.replace(/_/g, ' ');
  }
  return phase.replace(/_/g, ' ');
}

function getPlanWorkspaceTabs(language: 'en' | 'vi'): Array<{
  key: PlanWorkspaceTab;
  label: string;
  caption: string;
}> {
  if (language === 'vi') {
    return [
      { key: 'overview', label: 'Tổng quan', caption: 'Kiểm tra nhanh draft' },
      { key: 'reasoning', label: 'Suy luận', caption: 'Xem AI đã suy luận ra sao' },
      { key: 'sections', label: 'Phần', caption: 'Tinh chỉnh narrative flow' },
      { key: 'charts', label: 'Biểu đồ', caption: 'Giữ, đổi tên hoặc bỏ chart' },
    ];
  }
  return [
    { key: 'overview', label: 'Overview', caption: 'Sanity-check the draft' },
    { key: 'reasoning', label: 'Reasoning', caption: 'See how the Agent thought' },
    { key: 'sections', label: 'Sections', caption: 'Refine narrative flow' },
    { key: 'charts', label: 'Charts', caption: 'Keep, rename, or skip charts' },
  ];
}

function getBriefSectionFocus(language: 'en' | 'vi'): Record<
  BriefSectionKey,
  { title: string; description: string; bullets: string[] }
> {
  if (language === 'vi') {
    return {
      essentials: {
        title: 'Những gì AI cần trước tiên',
        description: 'Các trường này quyết định chất lượng bản draft đầu tiên. Chúng là ranh giới giữa một report hữu ích và một report chung chung.',
        bullets: [
          'Hãy viết mục tiêu nghiệp vụ bằng ngôn ngữ đời thường, không chỉ liệt kê metric.',
          'Nêu rõ audience để AI biết nên viết theo giọng executive hay operational.',
          'Nên có ít nhất một KPI và một câu hỏi bắt buộc phải trả lời trước khi generate draft.',
        ],
      },
      intent: {
        title: 'Cách phần này đổi hình dáng report',
        description: 'Các điều khiển ở đây ảnh hưởng tới logic so sánh, thứ tự section và độ quyết đoán của narrative cuối cùng.',
        bullets: [
          'Dùng comparison period khi người đọc kỳ vọng phân tích xu hướng hoặc thay đổi.',
          'Must-have sections cho AI biết phần nào tuyệt đối không được bỏ sót.',
          'Planning mode đặt ở đây vì nó thay đổi mức độ suy luận của Agent.',
        ],
      },
      dataset: {
        title: 'Nơi ngữ cảnh bổ sung có ích nhất',
        description: 'Hãy dùng khu vực này khi tên bảng, tên cột hoặc ý nghĩa nghiệp vụ còn mơ hồ.',
        bullets: [
          'Role hints giúp AI hiểu bảng nào là tín hiệu chính và bảng nào là ngữ cảnh hỗ trợ.',
          'Glossary giảm rủi ro AI diễn giải sai ý nghĩa nghiệp vụ.',
          'Known issues và columns to avoid giúp AI tránh viết quá tự tin trên dữ liệu yếu.',
        ],
      },
      narrative: {
        title: 'Mức độ phân tích bằng văn bản sẽ đi kèm',
        description: 'Các thiết lập này ảnh hưởng đến lớp text quanh dashboard, không chỉ cơ chế chart thô.',
        bullets: [
          'Insight depth quyết định narrative sẽ ngắn gọn hay dày hơn.',
          'Recommendation và confidence modes ảnh hưởng tới mức độ mạnh tay của kết luận.',
          'Narrative toggles cho AI biết có nên thêm prose, action và data quality caveat hay không.',
        ],
      },
      advanced: {
        title: 'Chỉ dùng cho trường hợp đặc biệt',
        description: 'Chỉ nên dùng Advanced khi report có những chỉ dẫn đặc biệt không nằm ở các phần trên.',
        bullets: [
          'Dùng notes cho caveat, rule nội bộ hoặc constraint đặc biệt.',
          'Tránh lặp lại thông tin đã có trong brief.',
          'Nếu phần essentials đã mạnh, khu vực này có thể để trống.',
        ],
      },
    };
  }

  return {
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
}


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
  const { language } = useI18n();
  const isVietnamese = language === 'vi';
  const isPageMode = mode === 'page';
  const isActive = isPageMode || isOpen;
  const handleClose = () => {
    if (onClose) {
      onClose();
      return;
    }
    router.push(backHref);
  };
  const initialBrief = useMemo(() => makeInitialBriefState(language), [language]);
  const stepMeta = useMemo(() => getStepMeta(language), [language]);
  const briefSectionMeta = useMemo(() => getBriefSectionMeta(language), [language]);
  const briefPresets = useMemo(() => getBriefPresets(language), [language]);
  const planWorkspaceTabs = useMemo(() => getPlanWorkspaceTabs(language), [language]);
  const briefSectionFocus = useMemo(() => getBriefSectionFocus(language), [language]);
  const [step, setStep] = useState<WizardStep>('select');
  const [activeSpecId, setActiveSpecId] = useState<number | null>(initialSpecId);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState('');
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<number[]>([]);
  const [expandedBriefSections, setExpandedBriefSections] = useState<BriefSectionKey[]>(DEFAULT_BRIEF_SECTIONS);
  const [activeBriefSection, setActiveBriefSection] = useState<BriefSectionKey>('essentials');
  const [briefDockTab, setBriefDockTab] = useState<BriefDockTab>('summary');
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
  const [openGuides, setOpenGuides] = useState<Record<string, boolean>>({
    'select-guide': false,
    'brief-guide': false,
    'brief-presets': false,
    'brief-focus': false,
    'brief-progress': false,
    'overview-guide': false,
    'reasoning-guide': false,
    'sections-guide': false,
    'charts-guide': false,
    'build-guide': true,
    'planning-overlay-log': true,
  });
  const planAbortControllerRef = useRef<AbortController | null>(null);

  function toggleGuide(key: string) {
    setOpenGuides((prev) => ({ ...prev, [key]: !prev[key] }));
  }

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
      output_language: language,
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
      language,
    ],
  );

  const currentStepIndex = stepMeta.findIndex((item) => item.key === step);
  const currentStepMeta = stepMeta[currentStepIndex] ?? stepMeta[0];
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
  const wizardText = useMemo(
    () =>
      isVietnamese
        ? {
            title: 'Tạo AI report từ business brief',
            description:
              'Trong AI Reports: chọn bảng, tạo draft plan, duyệt và chỉnh sửa trước khi để Agent build dashboard và narrative report.',
            runtimeBadge: 'AI Agent runtime',
            runtimeUnavailable: 'Không tải được thông tin runtime',
            timeout: 'Timeout',
            deleteReport: 'Xóa report',
            backToReports: 'Quay l?i AI Reports',
            close: 'Đóng',
            back: 'Quay lại',
            backToBrief: 'Quay lại brief',
            backToPlan: 'Quay lại plan',
            continue: 'Tiếp tục',
            generatePlan: 'Tạo plan',
            regeneratePlan: 'Tạo lại plan',
            saveReport: 'Lưu report',
            saveAsReport: 'Lưu thành report',
            resetEdits: 'Reset chỉnh sửa',
            buildDashboard: 'Build dashboard',
            retryBuild: 'Thử build lại',
            selectedScope: 'Phạm vi đã chọn',
            selectedTables: 'Bảng đã chọn',
            selectedWorkspaces: 'Workspace đã chọn',
            questionsSupplied: 'Câu hỏi đã nhập',
            clearAll: 'Bỏ chọn tất cả',
            removeFromSelection: 'Bỏ khỏi phạm vi',
            chooseAtLeastOne: 'Hãy chọn ít nhất một bảng để tiếp tục.',
            businessGoalRequired: 'Mục tiêu nghiệp vụ là bắt buộc.',
            deleteSuccess: 'Đã xóa AI report.',
            planTitle: 'Đang tạo draft plan',
            planLocked: 'Form brief sẽ bị khóa trong lúc AI đang suy luận để tránh draft bị lệch input giữa chừng.',
            stop: 'Dừng',
            currentFocus: 'Đang tập trung vào',
            reasoningPhases: 'Các phase suy luận',
            recentThoughtTrail: 'Mạch suy nghĩ gần đây',
            rawPlanningStream: 'Luồng event planning chi tiết',
            waitingFirstPlanningEvent: 'Đang chờ event planning đầu tiên...',
            buildAgentRun: 'Tiến trình Agent',
            buildNowTitle: 'AI đang làm gì lúc này',
            currentThought: 'Suy nghĩ hiện tại',
            progressStream: 'Luồng tiến trình',
            waitingFirstBuildEvent: 'Đang chờ event build đầu tiên...',
            chooseTablesTitle: 'Chọn các bảng mà Agent được phép dùng',
            chooseTablesDesc:
              'Bản V1 chỉ sử dụng các bảng được chọn rõ ràng tại đây. AI sẽ không tự lấy thêm dataset ngoài phạm vi này.',
            whatHappensNext: 'Bước tiếp theo',
            nextSteps: [
              'Viết business brief.',
              'Duyệt draft dashboard được tạo ra.',
              'Chỉnh title, scope và chart giữ lại.',
              'Build dashboard cuối cùng khi draft đã ổn.',
            ],
            workspaces: 'Workspace',
            availableTables: 'Bảng khả dụng',
            searchPlaceholder: 'Tìm workspace hoặc bảng...',
            expandAll: 'Mở rộng tất cả',
            collapseAll: 'Thu gọn tất cả',
            loadingTables: 'Đang tải workspace và bảng...',
            noWorkspaceTables: 'Chưa có bảng nào trong workspace.',
            noWorkspaceTablesDesc: 'Cần có ít nhất một bảng trước khi dùng AI Reports.',
            noMatch: 'Không có bảng nào khớp với tìm kiếm hiện tại.',
            noMatchDesc: 'Thử tìm theo tên workspace, tên bảng hoặc loại nguồn.',
            selectionTipsTitle: 'Mẹo chọn phạm vi',
            selectionTipsDesc: 'Mở ra khi cần nhắc nhanh, hoặc thu gọn lại để nhường chỗ cho danh sách bảng.',
            selectionTipsBullets: [
              'Chỉ chọn các bảng report thực sự cần.',
              'Dùng tìm kiếm khi có nhiều workspace hoặc tên bảng gần nhau.',
              'Kiểm tra phạm vi đã chọn trước khi sang brief.',
            ],
            briefGuideTitle: 'Brief cho Agent như đang làm việc cùng một analyst',
            briefGuideDesc:
              'Tập trung vào quyết định cần hỗ trợ và kết quả mong đợi. Mở guide khi cần, rồi thu gọn để nhường canvas cho form.',
            requiredFirst: 'Ưu tiên phần bắt buộc',
            optionalLater: 'Bổ sung ngữ cảnh sau',
            previewUnderstanding: 'Xem AI đang hiểu brief ra sao',
            presetsTitle: 'Bắt đầu từ preset',
            presetsDesc: 'Dùng preset khi muốn có hướng đi hợp lý từ đầu, sau đó chỉ tinh chỉnh những phần quan trọng.',
            briefMap: 'Bản đồ brief',
            core: 'Cốt lõi',
            optional: 'Tùy chọn',
            ready: 'Sẵn sàng',
            inProgress: 'Đang bổ sung',
            whyThisMatters: 'Vì sao phần này quan trọng',
            liveBriefSummary: 'Tóm tắt brief hiện tại',
            planningProgress: 'Tiến trình planning',
            live: 'Đang chạy',
            recent: 'Gần đây',
            editableDraft: 'Draft dashboard có thể chỉnh sửa',
            dashboardTitle: 'Tên dashboard',
            dashboardSummary: 'Tóm tắt dashboard',
            strategySummary: 'Tóm tắt chiến lược',
            buildMode: 'Chế độ build',
            createNewDashboard: 'Tạo dashboard mới',
            createNewVersion: 'Tạo phiên bản mới',
            replaceLatestDashboard: 'Thay thế dashboard gần nhất',
            latestDashboard: 'Dashboard gần nhất',
            saveAndBuildFirst: 'Hãy lưu và build một lần để mở replace-existing mode.',
            recentRuns: 'Lần chạy gần đây',
            readReport: 'Đọc report',
            editInDashboard: 'Chỉnh trong dashboard',
            chartsBuilt: 'chart đã build',
            reviewWorkspace: 'Không gian duyệt draft',
            reviewWorkspaceDesc: 'Nên đọc theo thứ tự: overview trước, reasoning sau, rồi mới sửa sections và charts.',
          }
        : {
            title: 'Build an AI report from a business brief',
            description:
              'Inside AI Reports: choose the tables, generate a draft plan, review and edit it, then let the Agent build the dashboard and narrative report.',
            runtimeBadge: 'AI Agent runtime',
            runtimeUnavailable: 'Runtime info unavailable',
            timeout: 'Timeout',
            deleteReport: 'Delete report',
            backToReports: 'Back to AI reports',
            close: 'Close',
            back: 'Back',
            backToBrief: 'Back to brief',
            backToPlan: 'Back to plan',
            continue: 'Continue',
            generatePlan: 'Generate plan',
            regeneratePlan: 'Regenerate plan',
            saveReport: 'Save report',
            saveAsReport: 'Save as report',
            resetEdits: 'Reset edits',
            buildDashboard: 'Build dashboard',
            retryBuild: 'Retry build',
            selectedScope: 'Selected scope',
            selectedTables: 'Selected tables',
            selectedWorkspaces: 'Selected workspaces',
            questionsSupplied: 'Questions supplied',
            clearAll: 'Clear all',
            removeFromSelection: 'Remove from selection',
            chooseAtLeastOne: 'Choose at least one table before continuing.',
            businessGoalRequired: 'Mục tiêu nghiệp vụ là bắt buộc.',
            deleteSuccess: 'AI report deleted.',
            planTitle: 'Generating the draft plan',
            planLocked:
              'The brief is locked while the Agent is reasoning so the plan cannot drift away from the inputs mid-run.',
            stop: 'Stop',
            currentFocus: 'Current focus',
            reasoningPhases: 'Reasoning phases',
            recentThoughtTrail: 'Recent thought trail',
            rawPlanningStream: 'Raw planning event stream',
            waitingFirstPlanningEvent: 'Waiting for the first planning event...',
            buildAgentRun: 'Agent run',
            buildNowTitle: 'What the Agent is doing now',
            currentThought: 'Current thought',
            progressStream: 'Progress stream',
            waitingFirstBuildEvent: 'Waiting for first event...',
            chooseTablesTitle: 'Choose the tables the Agent may use',
            chooseTablesDesc:
              'V1 only uses the tables you explicitly select here. It will not pull extra datasets and it will not blend data across datasets.',
            whatHappensNext: 'What happens next',
            nextSteps: [
              'Write the business brief.',
              'Review the generated dashboard draft.',
              'Edit titles, scope, and included charts.',
              'Generate the final dashboard when the draft looks right.',
            ],
            workspaces: 'Workspaces',
            availableTables: 'Available tables',
            searchPlaceholder: 'Search workspaces or tables...',
            expandAll: 'Expand all',
            collapseAll: 'Collapse all',
            loadingTables: 'Loading workspaces and tables...',
            noWorkspaceTables: 'No workspace tables are available yet.',
            noWorkspaceTablesDesc: 'Add at least one workspace table before using AI Reports.',
            noMatch: 'No tables match your current search.',
            noMatchDesc: 'Try a workspace name, table name, or source type.',
            selectionTipsTitle: 'Selection tips',
            selectionTipsDesc: 'Keep this open when you need a quick reminder, or collapse it to leave more room for the table list.',
            selectionTipsBullets: [
              'Prefer only the tables the dashboard truly needs.',
              'Use search when you have many workspaces or similar table names.',
              'Review the selected scope on the right before moving to the brief.',
            ],
            briefGuideTitle: 'Brief the Agent like an analyst partner',
            briefGuideDesc:
              'Keep the focus on the decision and the expected outcome. Open this guide when you want help, then collapse it to leave the canvas for the form itself.',
            requiredFirst: 'Required first',
            optionalLater: 'Optional context later',
            previewUnderstanding: 'Preview what the Agent understands',
            presetsTitle: 'Start from a preset',
            presetsDesc: 'Use a preset when you want a sensible first direction, then only tune the parts that matter for this report.',
            briefMap: 'Brief map',
            core: 'Core',
            optional: 'Optional',
            ready: 'Ready',
            inProgress: 'In progress',
            whyThisMatters: 'Why this matters',
            liveBriefSummary: 'Live brief summary',
            planningProgress: 'Planning progress',
            live: 'Live',
            recent: 'Recent',
            editableDraft: 'Editable dashboard draft',
            dashboardTitle: 'Dashboard title',
            dashboardSummary: 'Dashboard summary',
            strategySummary: 'Strategy summary',
            buildMode: 'Build mode',
            createNewDashboard: 'Create a new dashboard',
            createNewVersion: 'Create a new version',
            replaceLatestDashboard: 'Replace the latest saved dashboard',
            latestDashboard: 'Latest dashboard',
            saveAndBuildFirst: 'Save and build once to enable replace-existing mode.',
            recentRuns: 'Recent runs',
            readReport: 'Read report',
            editInDashboard: 'Edit in dashboard',
            chartsBuilt: 'charts built',
            reviewWorkspace: 'Review workspace',
            reviewWorkspaceDesc: 'Read in order: overview first, reasoning second, then edit sections and charts.',
          },
    [isVietnamese],
  );
  const currentStepGuide = useMemo(() => {
    switch (step) {
      case 'select':
        return {
          title: isVietnamese ? 'Chốt phạm vi trước' : 'Set the scope first',
          description: isVietnamese
            ? 'Giữ phạm vi làm việc gọn để Agent tập trung hơn và bước review sau đáng tin cậy hơn.'
            : 'Keep the working set tight so the Agent stays focused and the review later is easier to trust.',
          bullets: [
            isVietnamese
              ? 'Chỉ chọn những workspace và bảng thực sự thuộc về report này.'
              : 'Pick only the workspaces and tables that truly belong in this report.',
            isVietnamese
              ? 'Dùng panel phạm vi đã chọn để sanity-check lần cuối trước khi sang bước tiếp.'
              : 'Use the selected scope panel as the final sanity check before moving on.',
          ],
          stats: [
            { label: wizardText.selectedTables, value: String(selectedTables.length) },
            { label: isVietnamese ? 'Workspace trong phạm vi' : 'Workspaces in scope', value: String(selectedWorkspaceCount) },
          ],
        };
      case 'brief':
        return {
          title: isVietnamese ? 'Viết brief trước khi tối ưu' : 'Brief before you optimize',
          description: isVietnamese
            ? 'Agent sẽ nhận được nhiều giá trị hơn từ một mục tiêu sắc nét và vài câu hỏi rõ ràng, thay vì điền hết tất cả trường một lúc.'
            : 'The Agent will get more value from a sharp goal and a few clear questions than from filling every field at once.',
          bullets: [
            isVietnamese
              ? 'Hoàn thành phần essentials trước, sau đó mới bổ sung ngữ cảnh ở những chỗ giảm được mơ hồ.'
              : 'Complete the essentials first, then add context only where it reduces ambiguity.',
            isVietnamese
              ? 'Dùng tóm tắt ở bên phải để xem brief hiện tại đã đúng ý chưa.'
              : 'Use the live summary on the right to see whether the brief already sounds right.',
          ],
          stats: [
            { label: isVietnamese ? 'C?u h?i' : 'Questions', value: String(briefQuestions.length) },
            { label: 'KPIs', value: String(briefKpis.length) },
          ],
        };
      case 'plan':
        return {
          title: isVietnamese ? 'Duyệt draft, rồi mới sửa' : 'Review, then edit',
          description: isVietnamese
            ? 'Đây là nơi để pressure-test bản draft trước khi commit vào một dashboard build.'
            : 'This is where we pressure-test the draft before committing to a dashboard build.',
          bullets: [
            isVietnamese
              ? 'Đọc overview trước, sau đó chỉ chuyển sang sections hoặc charts ở những chỗ bạn muốn sửa.'
              : 'Read the overview first, then switch into sections or charts only where you want to change the draft.',
            isVietnamese
              ? 'Tắt các chart yếu ngay bây giờ thay vì để đến lúc vào dashboard editor mới dẹp.'
              : 'Disable weak charts now instead of cleaning them up later in the dashboard editor.',
          ],
          stats: [
            { label: isVietnamese ? 'Chart đang bật' : 'Active charts', value: String(enabledChartCount) },
            { label: isVietnamese ? 'Section đang bật' : 'Active sections', value: String(enabledSectionCount) },
          ],
        };
      case 'building':
        return {
          title: isVietnamese ? 'Để Agent hoàn tất lần chạy' : 'Let the Agent finish the run',
          description: isVietnamese
            ? 'Bước này nên dễ đọc và dễ theo dõi, không nên trông như màn hình chờ trống rỗng.'
            : 'This step should feel readable, not like a blank waiting screen.',
          bullets: [
            isVietnamese
              ? 'Theo dõi current thought và phase timeline để hiểu AI đang làm gì.'
              : 'Watch the current thought and phase timeline to understand what the Agent is doing.',
            isVietnamese
              ? 'Nếu có gì đó không ổn, hãy quay lại draft thay vì cố build cho bằng được.'
              : 'If something looks off, go back to the draft instead of forcing the build through.',
          ],
          stats: [
            { label: wizardText.buildMode, value: buildMode.replace(/_/g, ' ') },
            { label: isVietnamese ? 'Event đang đến' : 'Live events', value: String(events.length) },
          ],
        };
      default:
        return {
          title: currentStepMeta.label,
          description: currentStepMeta.caption,
          bullets: [],
          stats: [],
        };
    }
  }, [
    briefKpis.length,
    briefQuestions.length,
    buildMode,
    currentStepMeta.caption,
    currentStepMeta.label,
    enabledChartCount,
    enabledSectionCount,
    events.length,
    selectedTables.length,
    selectedWorkspaceCount,
    step,
  ]);
  const briefDockTabs = useMemo(
    () => [
      {
        key: 'summary' as const,
        label: isVietnamese ? 'Tóm tắt' : 'Summary',
        caption: isVietnamese ? 'Độ sẵn sàng và trọng tâm' : 'Readiness and focus',
      },
      {
        key: 'scope' as const,
        label: isVietnamese ? 'Phạm vi' : 'Scope',
        caption: isVietnamese ? 'Bảng đã chọn' : 'Selected tables',
      },
      {
        key: 'agent' as const,
        label: isVietnamese ? 'AI hiểu gì' : 'Agent view',
        caption: isVietnamese ? 'Preview cách AI hiểu brief' : 'Preview how the Agent reads the brief',
      },
    ],
    [isVietnamese],
  );
  const visibleBriefSections = useMemo(
    () => briefSectionMeta.filter((section) => !section.optional || expandedBriefSections.includes(section.key)),
    [briefSectionMeta, expandedBriefSections],
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
    () => briefSectionFocus[activeBriefSectionMeta?.key ?? 'essentials'],
    [activeBriefSectionMeta?.key, briefSectionFocus],
  );
  const activeBriefProgress = briefSectionProgress[activeBriefSectionMeta?.key ?? 'essentials'];
  const readinessChecks = useMemo(
    () => [
      { label: isVietnamese ? 'Đã chọn bảng' : 'Tables selected', done: selectedTables.length > 0 },
      { label: isVietnamese ? 'Đã xác định mục tiêu nghiệp vụ' : 'Business goal defined', done: goal.trim().length > 0 },
      { label: isVietnamese ? 'Đã xác định audience' : 'Audience set', done: audience.trim().length > 0 },
      { label: isVietnamese ? 'Có ít nhất một KPI' : 'At least one KPI', done: briefKpis.length > 0 },
      { label: isVietnamese ? 'Có ít nhất một câu hỏi' : 'At least one question', done: briefQuestions.length > 0 },
    ],
    [audience, briefKpis.length, briefQuestions.length, goal, isVietnamese, selectedTables.length],
  );
  const readinessCount = readinessChecks.filter((item) => item.done).length;
  const agentUnderstandingPreview = useMemo(() => {
    const style = reportStyle || 'executive';
    const audienceLabel = audience.trim() || (isVietnamese ? 'đối tượng đọc mục tiêu' : 'your target audience');
    const primaryFocus = briefKpis[0] || briefQuestions[0] || (isVietnamese ? 'mục tiêu nghiệp vụ chính' : 'the main business outcome');
    const timeframeLabel = timeframe.trim() || (isVietnamese ? 'khoảng thời gian đã chọn' : 'the chosen timeframe');
    if (isVietnamese) {
      return `Agent sẽ draft một report kiểu ${style} cho ${audienceLabel}, tập trung vào ${primaryFocus}, sử dụng ${selectedTables.length} bảng đã chọn trong ${timeframeLabel}.`;
    }
    return `The Agent will draft a ${style} report for ${audienceLabel}, focused on ${primaryFocus}, using ${selectedTables.length} selected table${selectedTables.length === 1 ? '' : 's'} across ${timeframeLabel}.`;
  }, [audience, briefKpis, briefQuestions, isVietnamese, reportStyle, selectedTables.length, timeframe]);

  useEffect(() => {
    if (!isActive) {
      setStep('select');
      setActiveSpecId(initialSpecId);
      setSelectedKeys([]);
      setTableSearch('');
      setExpandedWorkspaceIds([]);
      setExpandedBriefSections(DEFAULT_BRIEF_SECTIONS);
      setActiveBriefSection('essentials');
      setBriefDockTab('summary');
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
  const planningPhaseSummary = useMemo(
    () =>
      buildPhaseSummary(planningEvents, [
        'parse_brief',
        'collect_context',
        'profile_tables',
        'dataset_fit',
        'quality_gate',
        'analysis_plan',
        'report_strategy',
        'chart_candidates',
        'plan_review',
      ]),
    [planningEvents],
  );
  const buildPhaseSummaryItems = useMemo(
    () =>
      buildPhaseSummary(events, [
        'validate',
        'preflight',
        'create_charts',
        'assemble_dashboard',
        'generating_insights',
        'composing_report',
      ]),
    [events],
  );
  const latestPlanningThought = planningEvents[planningEvents.length - 1] ?? null;
  const latestBuildThought = events[events.length - 1] ?? null;
  const recentPlanningThoughts = useMemo(() => [...planningEvents].slice(-4).reverse(), [planningEvents]);
  const recentBuildThoughts = useMemo(() => [...events].slice(-4).reverse(), [events]);

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
        ? (isVietnamese
            ? 'Xóa AI report này?\n\nThao tác này sẽ xóa brief đã lưu và lịch sử run, nhưng vẫn giữ dashboard đã liên kết trong Dashboards.'
            : 'Delete this AI report?\n\nThis removes the saved brief and run history, but keeps the linked dashboard in Dashboards.')
        : (isVietnamese
            ? 'Xóa AI report này?\n\nThao tác này sẽ xóa brief đã lưu và lịch sử run.'
            : 'Delete this AI report?\n\nThis removes the saved brief and run history.'),
    );
    if (!confirmed) return;

    try {
      await deleteSpecMutation.mutateAsync(activeSpecId);
      await refreshAgentReportViews(null);
      toast.success(wizardText.deleteSuccess);
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

  function applyBriefPreset(presetKey: (typeof briefPresets)[number]['key']) {
    const preset = briefPresets.find((item) => item.key === presetKey);
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
      toast.info(wizardText.businessGoalRequired);
      return;
    }
    if (briefPayload.selected_tables.length === 0) {
      toast.info(wizardText.chooseAtLeastOne);
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
            toast.success(
              isVietnamese
                ? 'AI report đã build xong. Đang mở dashboard để bạn tiếp tục chỉnh sửa.'
                : 'AI report built successfully. Opening the dashboard so you can continue editing there.',
            );
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
      title={wizardText.title}
      description={(
        <div className="space-y-2">
          <p>{wizardText.description}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
              {wizardText.runtimeBadge}
            </span>
            {agentHealthQuery.data?.provider && agentHealthQuery.data?.model ? (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600">
                {agentHealthQuery.data.provider} / {agentHealthQuery.data.model}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-500">
                {wizardText.runtimeUnavailable}
              </span>
            )}
            {typeof agentHealthQuery.data?.timeout_seconds === 'number' && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-500">
                {wizardText.timeout} {agentHealthQuery.data.timeout_seconds}s
              </span>
            )}
            {Object.entries(agentHealthQuery.data?.phase_models ?? {}).map(([phase, model]) => (
              <span
                key={phase}
                className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-500"
              >
                {phase}: {model}
              </span>
            ))}
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
      bodyClassName={isPageMode ? 'px-5 py-6 lg:px-8 2xl:px-10' : 'px-6 py-5'}
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
              {wizardText.deleteReport}
            </button>
          )}

          {step === 'select' && (
            <button
              onClick={handleClose}
              disabled={isInteractionLocked}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              {isPageMode ? wizardText.backToReports : wizardText.close}
            </button>
          )}

          {step === 'brief' && (
            <button
              onClick={() => setStep('select')}
              disabled={isInteractionLocked}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              {wizardText.back}
            </button>
          )}

          {step === 'plan' && (
            <button
              onClick={() => setStep('brief')}
              disabled={isInteractionLocked}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              {wizardText.backToBrief}
            </button>
          )}

          {step === 'building' && (
            <button
              onClick={() => setStep('plan')}
              disabled={isBuildRunning}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              {wizardText.backToPlan}
            </button>
          )}

          {step === 'select' && (
            <button
              onClick={() => {
                if (selectedTables.length === 0) {
                  toast.info(wizardText.chooseAtLeastOne);
                  return;
                }
                setStep('brief');
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
            >
              {wizardText.continue}
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
              {wizardText.generatePlan}
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
                {wizardText.regeneratePlan}
              </button>
              <button
                onClick={async () => {
                  if (!draftPlan) return;
                  try {
                    const specId = await persistCurrentSpec(draftPlan);
                    toast.success(
                      activeSpecId
                        ? isVietnamese
                          ? 'AI report đã được cập nhật.'
                          : 'AI report updated.'
                        : isVietnamese
                          ? `AI report đã được lưu (#${specId}).`
                          : `AI report saved (#${specId}).`,
                    );
                  } catch (error: any) {
                    setAgentError(error.message || 'Could not save the AI report.');
                  }
                }}
                disabled={!draftPlan || createSpecMutation.isPending || updateSpecMutation.isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                <FileText className="h-4 w-4" />
                {activeSpecId ? wizardText.saveReport : wizardText.saveAsReport}
              </button>
              <button
                onClick={resetPlanEdits}
                disabled={!hasPlanEdits}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCcw className="h-4 w-4" />
                {wizardText.resetEdits}
              </button>
              <button
                onClick={handleBuild}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
              >
                <Wand2 className="h-4 w-4" />
                {wizardText.buildDashboard}
              </button>
            </>
          )}

          {step === 'building' && !isBuildRunning && (
            <button
              onClick={handleBuild}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
            >
              <RefreshCcw className="h-4 w-4" />
              {wizardText.retryBuild}
            </button>
          )}
        </>
      )}
    >
      <div className="grid min-w-0 gap-6 2xl:grid-cols-[260px_minmax(0,1fr)] 2xl:items-start">
        <div className="space-y-4 2xl:sticky 2xl:top-0 2xl:self-start">
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="grid gap-3 md:grid-cols-4 2xl:grid-cols-1">
            {stepMeta.map((item, index) => {
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

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-gray-900">
              <Wand2 className="h-5 w-5 text-blue-600" />
              <h3 className="text-base font-semibold">{currentStepGuide.title}</h3>
            </div>
            <p className="text-sm leading-6 text-gray-600">{currentStepGuide.description}</p>
            {currentStepGuide.stats.length > 0 && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-1">
                {currentStepGuide.stats.map((item) => (
                  <div key={item.label} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{item.label}</p>
                    <p className="mt-2 text-sm font-semibold capitalize text-gray-900">{item.value}</p>
                  </div>
                ))}
              </div>
            )}
            {currentStepGuide.bullets.length > 0 && (
              <div className="mt-4 space-y-2 text-sm text-gray-600">
                {currentStepGuide.bullets.map((item) => (
                  <p key={item}>- {item}</p>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-6">
          {agentError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {agentError}
            </div>
          )}

        <WizardRenderErrorBoundary isVietnamese={isVietnamese}>
        {step === 'select' && (
          <SelectTablesStep
            isVietnamese={isVietnamese}
            wizardText={wizardText}
            workspaceDetailsQuery={workspaceDetailsQuery}
            tables={tables}
            tableSearch={tableSearch}
            setTableSearch={setTableSearch}
            setExpandedWorkspaceIds={setExpandedWorkspaceIds}
            workspaceSelectionGroups={workspaceSelectionGroups}
            normalizedTableSearch={normalizedTableSearch}
            visibleTableCount={visibleTableCount}
            toggleWorkspaceExpanded={toggleWorkspaceExpanded}
            setWorkspaceTableSelection={setWorkspaceTableSelection}
            selectedKeys={selectedKeys}
            toggleTable={toggleTable}
            selectedTableCards={selectedTableCards}
            clearSelectedTables={clearSelectedTables}
            selectedTables={selectedTables}
            selectedWorkspaceCount={selectedWorkspaceCount}
            setSelectedKeys={setSelectedKeys}
            openGuides={openGuides}
            toggleGuide={toggleGuide}
            expandedWorkspaceIds={expandedWorkspaceIds}
          />
        )}
        {step === 'brief' && (
          <BriefStep
            isVietnamese={isVietnamese}
            language={language}
            wizardText={wizardText}
            isPlanningLocked={isPlanningLocked}
            briefPresets={briefPresets}
            applyBriefPreset={applyBriefPreset}
            briefSectionMeta={briefSectionMeta}
            visibleBriefSections={visibleBriefSections}
            activeBriefSection={activeBriefSection}
            setActiveBriefSection={setActiveBriefSection}
            briefSectionProgress={briefSectionProgress}
            activeBriefSectionMeta={activeBriefSectionMeta}
            activeBriefFocus={activeBriefFocus}
            activeBriefProgress={activeBriefProgress}
            activeBriefSectionIndex={activeBriefSectionIndex}
            collapseOptionalBriefSections={collapseOptionalBriefSections}
            openAllBriefSections={openAllBriefSections}
            briefDockTabs={briefDockTabs}
            briefDockTab={briefDockTab}
            setBriefDockTab={setBriefDockTab}
            agentUnderstandingPreview={agentUnderstandingPreview}
            selectedTables={selectedTables}
            selectedTableCards={selectedTableCards}
            briefKpis={briefKpis}
            briefQuestions={briefQuestions}
            readinessCount={readinessCount}
            readinessChecks={readinessChecks}
            openGuides={openGuides}
            toggleGuide={toggleGuide}
            planMutation={planMutation}
            planningEvents={planningEvents}
            planningPhaseSummary={planningPhaseSummary}
            latestPlanningThought={latestPlanningThought}
            recentPlanningThoughts={recentPlanningThoughts}
            formatProcessPhaseLabel={formatProcessPhaseLabel}
            getProcessPhaseStatusClass={getProcessPhaseStatusClass}
            getProcessPhaseStatusLabel={getProcessPhaseStatusLabel}
            getPlanEventBadgeClass={getPlanEventBadgeClass}
            reportName={reportName}
            setReportName={setReportName}
            reportType={reportType}
            setReportType={setReportType}
            goal={goal}
            setGoal={setGoal}
            audience={audience}
            setAudience={setAudience}
            timeframe={timeframe}
            setTimeframe={setTimeframe}
            whyNow={whyNow}
            setWhyNow={setWhyNow}
            businessBackground={businessBackground}
            setBusinessBackground={setBusinessBackground}
            kpisText={kpisText}
            setKpisText={setKpisText}
            questionsText={questionsText}
            setQuestionsText={setQuestionsText}
            comparisonPeriod={comparisonPeriod}
            setComparisonPeriod={setComparisonPeriod}
            refreshFrequency={refreshFrequency}
            setRefreshFrequency={setRefreshFrequency}
            mustIncludeSectionsText={mustIncludeSectionsText}
            setMustIncludeSectionsText={setMustIncludeSectionsText}
            alertFocusText={alertFocusText}
            setAlertFocusText={setAlertFocusText}
            preferredGranularity={preferredGranularity}
            setPreferredGranularity={setPreferredGranularity}
            decisionContext={decisionContext}
            setDecisionContext={setDecisionContext}
            reportStyle={reportStyle}
            setReportStyle={setReportStyle}
            insightDepth={insightDepth}
            setInsightDepth={setInsightDepth}
            recommendationStyle={recommendationStyle}
            setRecommendationStyle={setRecommendationStyle}
            confidencePreference={confidencePreference}
            setConfidencePreference={setConfidencePreference}
            preferredDashboardStructure={preferredDashboardStructure}
            setPreferredDashboardStructure={setPreferredDashboardStructure}
            includeTextNarrative={includeTextNarrative}
            setIncludeTextNarrative={setIncludeTextNarrative}
            includeActionItems={includeActionItems}
            setIncludeActionItems={setIncludeActionItems}
            includeDataQualityNotes={includeDataQualityNotes}
            setIncludeDataQualityNotes={setIncludeDataQualityNotes}
            tableRolesHintText={tableRolesHintText}
            setTableRolesHintText={setTableRolesHintText}
            businessGlossaryText={businessGlossaryText}
            setBusinessGlossaryText={setBusinessGlossaryText}
            knownDataIssuesText={knownDataIssuesText}
            setKnownDataIssuesText={setKnownDataIssuesText}
            importantDimensionsText={importantDimensionsText}
            setImportantDimensionsText={setImportantDimensionsText}
            columnsToAvoidText={columnsToAvoidText}
            setColumnsToAvoidText={setColumnsToAvoidText}
            notes={notes}
            setNotes={setNotes}
            planningMode={planningMode}
            setPlanningMode={setPlanningMode}
          />
        )}
        {step === 'plan' && draftPlan && (
          <ReviewPlanStep
            draftPlan={draftPlan}
            setDraftPlan={setDraftPlan}
            activeSpecId={activeSpecId}
            activeSpec={activeSpec}
            recentRuns={recentRuns}
            router={router}
            isVietnamese={isVietnamese}
            wizardText={wizardText}
            enabledSectionCount={enabledSectionCount}
            enabledChartCount={enabledChartCount}
            buildMode={buildMode}
            setBuildMode={setBuildMode}
            planWorkspaceTabs={planWorkspaceTabs}
            planWorkspaceTab={planWorkspaceTab}
            setPlanWorkspaceTab={setPlanWorkspaceTab}
            describeChartConfig={describeChartConfig}
            sectionActiveCount={sectionActiveCount}
            openGuides={openGuides}
            toggleGuide={toggleGuide}
            updateSection={updateSection}
            updateChart={updateChart}
          />
        )}
        {step === 'building' && (
          <BuildStep
            wizardText={wizardText}
            isVietnamese={isVietnamese}
            enabledChartCount={enabledChartCount}
            enabledSectionCount={enabledSectionCount}
            latestBuildThought={latestBuildThought}
            buildPhaseSummaryItems={buildPhaseSummaryItems}
            getProcessPhaseStatusClass={getProcessPhaseStatusClass}
            formatProcessPhaseLabel={formatProcessPhaseLabel}
            language={language}
            getProcessPhaseStatusLabel={getProcessPhaseStatusLabel}
            recentBuildThoughts={recentBuildThoughts}
            getBuildEventBadgeClass={getBuildEventBadgeClass}
            events={events}
            agentError={agentError}
            isBuildRunning={isBuildRunning}
          />
        )}
        {isPlanningLocked && (
          <div className="fixed inset-0 z-[70] bg-slate-950/35 p-3 backdrop-blur-sm sm:p-4">
            <div className="flex h-full items-center justify-center">
            <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-2xl sm:max-h-[calc(100vh-3rem)]">
              <div className="border-b border-gray-200 px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-gray-900">
                      <Bot className="h-5 w-5 text-blue-600" />
                      <h3 className="text-lg font-semibold">{wizardText.planTitle}</h3>
                    </div>
                    <p className="mt-2 text-sm text-gray-500">
                      {wizardText.planLocked}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={stopPlanning}
                      className="inline-flex items-center gap-2 rounded-md border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
                    >
                      <X className="h-4 w-4" />
                      {wizardText.stop}
                    </button>
                    <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
                <div className="space-y-5">
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{wizardText.currentFocus}</p>
                  <p className="mt-2 text-sm text-blue-900">
                    {latestPlanningThought?.message || (isVietnamese
                      ? 'Agent đang phân tích brief và chuẩn bị planning context.'
                      : 'The Agent is parsing the brief and preparing the planning context.')}
                  </p>
                </div>

                  <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-gray-900">{wizardText.reasoningPhases}</h4>
                        <p className="mt-1 text-sm text-gray-500">
                          {isVietnamese
                            ? 'Mục này giúp quá trình suy nghĩ ngầm của AI dễ theo dõi hơn.'
                            : 'This makes the hidden thinking process easier to follow.'}
                        </p>
                      </div>
                      <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                        {planningEvents.length} event{planningEvents.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {planningPhaseSummary.map((item) => (
                        <div
                          key={item.phase}
                          className={`flex items-center justify-between rounded-lg border px-4 py-3 text-sm ${getProcessPhaseStatusClass(item.status)}`}
                        >
                          <span className="font-medium capitalize">{formatProcessPhaseLabel(item.phase, language)}</span>
                          <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                            {getProcessPhaseStatusLabel(item.status, language)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                  <div className="space-y-5">
                  <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="mb-3 flex items-center gap-2 text-gray-900">
                      <Sparkles className="h-5 w-5 text-blue-600" />
                      <h4 className="text-base font-semibold">{wizardText.recentThoughtTrail}</h4>
                    </div>
                    <div className="max-h-[28vh] space-y-3 overflow-y-auto pr-1 xl:max-h-[32vh]">
                      {recentPlanningThoughts.length === 0 ? (
                        <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500">
                          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                          {wizardText.waitingFirstPlanningEvent}
                        </div>
                      ) : (
                        recentPlanningThoughts.map((event, index) => (
                          <div key={`${event.phase}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-medium text-gray-900">{event.message}</p>
                                {event.error && <p className="mt-2 text-sm text-rose-600">{event.error}</p>}
                              </div>
                              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${getPlanEventBadgeClass(event)}`}>
                                {event.phase}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                <CollapsibleGuideCard
                  title={wizardText.rawPlanningStream}
                  description={isVietnamese
                    ? 'Mở mục này nếu bạn muốn xem log event chi tiết. Nếu không, phase view ở trên thường đã đủ dùng.'
                    : 'Open this if you want the detailed event-by-event log. Otherwise the phase view above is usually enough.'}
                  icon={<History className="h-5 w-5" />}
                  isOpen={openGuides['planning-overlay-log']}
                  onToggle={() => toggleGuide('planning-overlay-log')}
                  badge={isVietnamese ? 'Log đang chạy' : 'Live log'}
                >
                  <div className="max-h-[32vh] space-y-3 overflow-y-auto pr-1 xl:max-h-[42vh]">
                    {planningEvents.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                        {wizardText.waitingFirstPlanningEvent}
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
                </CollapsibleGuideCard>
                </div>
                </div>
              </div>
            </div>
            </div>
          </div>
        )}
        </WizardRenderErrorBoundary>
        </div>
      </div>
    </AppModalShell>
  );
}
