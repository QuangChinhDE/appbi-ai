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
import { useDatasets, DatasetWithTables } from '@/hooks/use-datasets';
import apiClient from '@/lib/api-client';
import { getAiAgentHttpUrl } from '@/lib/ai-services';
import {
  AgentBriefRequest,
  AgentBuildEvent as BuildEvent,
  AgentBuildMode,
  AgentDomainId,
  AgentPlanEvent,
  AgentPlanResponse,
  AgentReportSpecDetail,
  AgentSectionPlan,
} from '@/types/agent';
import {
  AGENT_DOMAIN_CATALOG,
  getDefaultDomainId,
  getDomainCatalogItem,
} from '@/components/ai-reports/domain-config';
import {
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
  toBuildPlan,
} from '@/components/ai-reports/wizard-helpers';
import {
  AIReportWizardProps,
  AgentHealthPayload,
  EditableAgentChartPlan,
  EditableAgentPlan,
  TableDescriptionCard,
  WizardStep,
} from '@/components/ai-reports/wizard-types';
import { useI18n } from '@/providers/LanguageProvider';
import { SelectTablesStep } from '@/components/ai-reports/steps/SelectTablesStep';
import { BriefStep } from '@/components/ai-reports/steps/BriefStep';
import { ReviewPlanStep } from '@/components/ai-reports/steps/ReviewPlanStep';
import { BuildStep } from '@/components/ai-reports/steps/BuildStep';
import { CollapsibleGuideCard } from '@/components/ai-reports/steps/shared/CollapsibleGuideCard';
import { WizardRenderErrorBoundary } from '@/components/ai-reports/WizardRenderErrorBoundary';

type PlanDatasetTab = 'plan' | 'sections' | 'charts';
type ProcessPhaseStatus = 'done' | 'active' | 'pending' | 'error';
const WIZARD_STEP_ORDER: WizardStep[] = ['select', 'brief', 'plan', 'building'];


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
      enrich_brief: 'Suy luận domain & KPI',
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

function getPlanDatasetTabs(language: 'en' | 'vi'): Array<{
  key: PlanDatasetTab;
  label: string;
  caption: string;
}> {
  if (language === 'vi') {
    return [
      { key: 'plan', label: 'Phân tích', caption: 'Luận điểm, giả thuyết và data' },
      { key: 'sections', label: 'Phần', caption: 'Tinh chỉnh narrative flow' },
      { key: 'charts', label: 'Biểu đồ', caption: 'Giữ, đổi tên hoặc bỏ chart' },
    ];
  }
  return [
    { key: 'plan', label: 'Analysis plan', caption: 'Thesis, hypotheses, and data fit' },
    { key: 'sections', label: 'Sections', caption: 'Refine narrative flow' },
    { key: 'charts', label: 'Charts', caption: 'Keep, rename, or skip charts' },
  ];
}

function formatAudienceChoice(value: string | undefined, language: 'en' | 'vi') {
  if (language === 'vi') {
    if (value === 'exec') return 'Ban điều hành';
    if (value === 'manager') return 'Manager';
    if (value === 'analyst') return 'Analyst';
    return 'chưa chọn audience';
  }
  if (value === 'exec') return 'Exec';
  if (value === 'manager') return 'Manager';
  if (value === 'analyst') return 'Analyst';
  return 'no audience selected';
}

function formatComparisonChoice(value: string | undefined, language: 'en' | 'vi') {
  if (language === 'vi') {
    if (value === 'previous_period') return 'Kỳ trước';
    if (value === 'same_period') return 'Cùng kỳ';
    if (value === 'none') return 'Không ép so sánh';
    return 'chưa chọn mốc so sánh';
  }
  if (value === 'previous_period') return 'Previous period';
  if (value === 'same_period') return 'Same period';
  if (value === 'none') return 'None';
  return 'no comparison selected';
}

function formatDetailChoice(value: string | undefined, language: 'en' | 'vi') {
  if (language === 'vi') {
    if (value === 'overview') return 'Tổng quan';
    if (value === 'detailed') return 'Chi tiết';
    return 'chưa chọn mức chi tiết';
  }
  if (value === 'overview') return 'Overview';
  if (value === 'detailed') return 'Detailed';
  return 'no detail level selected';
}

function normalizeAudienceChoice(value: unknown): '' | 'exec' | 'manager' | 'analyst' {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  if (['exec', 'executive', 'executive leadership', 'ban điều hành', 'ban dieu hanh'].includes(text)) return 'exec';
  if (['manager', 'managers', 'operations managers', 'quản lý', 'quan ly'].includes(text)) return 'manager';
  if (['analyst', 'analysts'].includes(text)) return 'analyst';
  return '';
}

function normalizeComparisonChoice(value: unknown): '' | 'previous_period' | 'same_period' | 'none' {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  if (['previous_period', 'previous period', 'kỳ trước', 'ky truoc'].includes(text)) return 'previous_period';
  if (['same_period', 'same period', 'cùng kỳ', 'cung ky'].includes(text)) return 'same_period';
  if (['none', 'no comparison', 'không so sánh', 'khong so sanh'].includes(text)) return 'none';
  return '';
}

function normalizeDetailChoice(value: unknown): '' | 'overview' | 'detailed' {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  if (['overview', 'tổng quan', 'tong quan'].includes(text)) return 'overview';
  if (['detailed', 'detail', 'chi tiết', 'chi tiet'].includes(text)) return 'detailed';
  return '';
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
  const planDatasetTabs = useMemo(() => getPlanDatasetTabs(language), [language]);
  const [step, setStep] = useState<WizardStep>('select');
  const [activeSpecId, setActiveSpecId] = useState<number | null>(initialSpecId);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState('');
  const [expandedDatasetIds, setExpandedDatasetIds] = useState<number[]>([]);
  const [planDatasetTab, setPlanDatasetTab] = useState<PlanDatasetTab>('plan');
  const [domainId, setDomainId] = useState<AgentDomainId>(initialBrief.domainId);
  const [goal, setGoal] = useState(initialBrief.goal);
  const [audience, setAudience] = useState(initialBrief.audience);
  const [timeframe, setTimeframe] = useState(initialBrief.timeframe);
  const [comparisonPeriod, setComparisonPeriod] = useState(initialBrief.comparisonPeriod);
  const [preferredGranularity, setPreferredGranularity] = useState(initialBrief.preferredGranularity);
  const [notes, setNotes] = useState(initialBrief.notes);
  const [generatedPlan, setGeneratedPlan] = useState<EditableAgentPlan | null>(null);
  const [draftPlan, setDraftPlan] = useState<EditableAgentPlan | null>(null);
  const [planningEvents, setPlanningEvents] = useState<AgentPlanEvent[]>([]);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isBuildRunning, setIsBuildRunning] = useState(false);
  const [buildMode, setBuildMode] = useState<AgentBuildMode>('new_dashboard');
  const [buildResult, setBuildResult] = useState<any>(null);
  const [buildDashboardUrl, setBuildDashboardUrl] = useState<string | null>(null);
  const [buildReportUrl, setBuildReportUrl] = useState<string | null>(null);
  const [tableDescriptions, setTableDescriptions] = useState<TableDescriptionCard[]>([]);
  const [openGuides, setOpenGuides] = useState<Record<string, boolean>>({
    'select-guide': false,
    'brief-guide': false,
    'brief-presets': false,
    'brief-focus': false,
    'brief-progress': false,
    'plan-guide': false,
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
  const { data: datasets = [] } = useDatasets();
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
      const response = await fetch(`${getAiAgentHttpUrl()}/agent/health`);
      if (!response.ok) {
        throw new Error('Could not load AI Agent health.');
      }
      return response.json();
    },
  });

  const datasetDetailsQuery = useQuery<DatasetWithTables[]>({
    queryKey: ['agent-dataset-details', datasets.map((dataset) => dataset.id).join('-')],
    enabled: isActive && datasets.length > 0,
    queryFn: async () => {
      const responses = await Promise.all(
        datasets.map((dataset) => apiClient.get<DatasetWithTables>(`/datasets/${dataset.id}`)),
      );
      return responses.map((response) => response.data);
    },
  });

  const tables = useMemo(() => {
    return (datasetDetailsQuery.data ?? []).flatMap((dataset) =>
      (dataset.tables ?? []).map((table) => ({
        dataset_id: dataset.id,
        dataset_name: dataset.name,
        table_id: table.id,
        table_name: table.display_name,
        source_kind: table.source_kind,
      })),
    );
  }, [datasetDetailsQuery.data]);

  const selectedTables = useMemo(() => {
    return selectedKeys
      .map((key) => {
        const [datasetId, tableId] = key.split(':').map(Number);
        return { dataset_id: datasetId, table_id: tableId };
      })
      .filter((item) => Number.isFinite(item.dataset_id) && Number.isFinite(item.table_id));
  }, [selectedKeys]);

  const selectedTableCards = useMemo(() => {
    return selectedTables.map((item) => {
      const table = tables.find(
        (candidate) => candidate.dataset_id === item.dataset_id && candidate.table_id === item.table_id,
      );
      return {
        key: `${item.dataset_id}:${item.table_id}`,
        datasetName: table?.dataset_name ?? `Dataset ${item.dataset_id}`,
        tableName: table?.table_name ?? `Table ${item.table_id}`,
      };
    });
  }, [selectedTables, tables]);

  const normalizedTableSearch = tableSearch.trim().toLowerCase();
  const datasetSelectionGroups = useMemo(() => {
    return (datasetDetailsQuery.data ?? [])
      .map((dataset) => {
        const datasetMatch =
          dataset.name.toLowerCase().includes(normalizedTableSearch) ||
          (dataset.description ?? '').toLowerCase().includes(normalizedTableSearch);
        const visibleTables = (dataset.tables ?? []).filter((table) => {
          if (!normalizedTableSearch) return true;
          return (
            datasetMatch ||
            table.display_name.toLowerCase().includes(normalizedTableSearch) ||
            table.source_kind.toLowerCase().includes(normalizedTableSearch) ||
            (table.source_table_name ?? '').toLowerCase().includes(normalizedTableSearch)
          );
        });
        const selectedCount = (dataset.tables ?? []).filter((table) =>
          selectedKeys.includes(`${dataset.id}:${table.id}`),
        ).length;
        const visibleSelectedCount = visibleTables.filter((table) =>
          selectedKeys.includes(`${dataset.id}:${table.id}`),
        ).length;

        return {
          dataset,
          visibleTables,
          totalTables: dataset.tables?.length ?? 0,
          selectedCount,
          visibleSelectedCount,
        };
      })
      .filter((group) => group.visibleTables.length > 0)
      .sort((left, right) => {
        if (right.selectedCount !== left.selectedCount) {
          return right.selectedCount - left.selectedCount;
        }
        return left.dataset.name.localeCompare(right.dataset.name);
      });
  }, [normalizedTableSearch, selectedKeys, datasetDetailsQuery.data]);

  const selectedDatasetCount = useMemo(
    () => new Set(selectedTables.map((item) => item.dataset_id)).size,
    [selectedTables],
  );
  const selectedDomain = useMemo(
    () => getDomainCatalogItem(domainId) ?? getDomainCatalogItem(getDefaultDomainId()),
    [domainId],
  );
  const visibleTableCount = useMemo(
    () => datasetSelectionGroups.reduce((total, group) => total + group.visibleTables.length, 0),
    [datasetSelectionGroups],
  );

  const briefPayload = useMemo<AgentBriefRequest>(
    () => ({
      domain_id: domainId,
      output_language: language,
      goal: goal.trim(),
      audience: normalizeAudienceChoice(audience) || undefined,
      timeframe: timeframe.trim() || undefined,
      comparison_period: normalizeComparisonChoice(comparisonPeriod) || undefined,
      detail_level: normalizeDetailChoice(preferredGranularity) || undefined,
      notes: notes.trim() || undefined,
      selected_tables: selectedTables,
    }),
    [
      audience,
      comparisonPeriod,
      goal,
      notes,
      preferredGranularity,
      selectedTables,
      timeframe,
      language,
      domainId,
    ],
  );

  const currentStepIndex = stepMeta.findIndex((item) => item.key === step);
  const currentStepMeta = stepMeta[currentStepIndex] ?? stepMeta[0];
  const activeSpec = activeSpecQuery.data as AgentReportSpecDetail | undefined;
  const persistedProgressStep = useMemo<WizardStep>(() => {
    if (activeSpec?.latest_dashboard_id || activeSpec?.current_step === 'building') {
      return 'building';
    }
    if (generatedPlan || draftPlan || activeSpec?.approved_plan_json) {
      return 'plan';
    }
    if (selectedTables.length > 0 || (activeSpec?.selected_tables_snapshot?.length ?? 0) > 0) {
      return 'brief';
    }
    return 'select';
  }, [
    activeSpec?.approved_plan_json,
    activeSpec?.current_step,
    activeSpec?.latest_dashboard_id,
    activeSpec?.selected_tables_snapshot?.length,
    draftPlan,
    generatedPlan,
    selectedTables.length,
  ]);
  // Track the highest step the user can revisit based on persisted progress plus current local navigation.
  const highestReachedIndex = useMemo(() => {
    const persistedIndex = WIZARD_STEP_ORDER.indexOf(persistedProgressStep);
    return Math.max(persistedIndex, currentStepIndex);
  }, [currentStepIndex, persistedProgressStep]);
  const buildPlan = useMemo(() => (draftPlan ? toBuildPlan(draftPlan) : null), [draftPlan]);
  const enabledChartCount = buildPlan?.charts.length ?? 0;
  const enabledSectionCount = buildPlan?.sections.length ?? 0;
  const recentRuns = useMemo(
    () =>
      [...(activeSpec?.runs ?? [])]
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
        .slice(0, 5),
    [activeSpec],
  );
  const hasBuiltOutput = useMemo(
    () =>
      Boolean(activeSpec?.latest_dashboard_id) ||
      recentRuns.some((run) => run.status === 'succeeded'),
    [activeSpec?.latest_dashboard_id, recentRuns],
  );
  const hasPlanEdits = useMemo(() => {
    if (!generatedPlan || !draftPlan) return false;
    return JSON.stringify(generatedPlan) !== JSON.stringify(draftPlan);
  }, [draftPlan, generatedPlan]);

  const selectedTableNamesPreview = useMemo(
    () => selectedTableCards.slice(0, 3).map((item) => item.tableName),
    [selectedTableCards],
  );
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
            selectedDatasets: 'Dataset đã chọn',
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
            datasets: 'Dataset',
            availableTables: 'Bảng khả dụng',
            searchPlaceholder: 'Tìm dataset hoặc bảng...',
            expandAll: 'Mở rộng tất cả',
            collapseAll: 'Thu gọn tất cả',
            loadingTables: 'Đang tải dataset và bảng...',
            noDatasetTables: 'Chưa có bảng nào trong dataset.',
            noDatasetTablesDesc: 'Cần có ít nhất một bảng trước khi dùng AI Reports.',
            noMatch: 'Không có bảng nào khớp với tìm kiếm hiện tại.',
            noMatchDesc: 'Thử tìm theo tên dataset, tên bảng hoặc loại nguồn.',
            selectionTipsTitle: 'Mẹo chọn phạm vi',
            selectionTipsDesc: 'Mở ra khi cần nhắc nhanh, hoặc thu gọn lại để nhường chỗ cho danh sách bảng.',
            selectionTipsBullets: [
              'Chỉ chọn các bảng report thực sự cần.',
              'Dùng tìm kiếm khi có nhiều dataset hoặc tên bảng gần nhau.',
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
            reviewDataset: 'Không gian duyệt draft',
            reviewDatasetDesc: 'Đọc Plan trước để nắm chiến lược, rồi chỉnh sửa sections và charts.',
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
            selectedDatasets: 'Selected datasets',
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
            datasets: 'Datasets',
            availableTables: 'Available tables',
            searchPlaceholder: 'Search datasets or tables...',
            expandAll: 'Expand all',
            collapseAll: 'Collapse all',
            loadingTables: 'Loading datasets and tables...',
            noDatasetTables: 'No dataset tables are available yet.',
            noDatasetTablesDesc: 'Add at least one dataset table before using AI Reports.',
            noMatch: 'No tables match your current search.',
            noMatchDesc: 'Try a dataset name, table name, or source type.',
            selectionTipsTitle: 'Selection tips',
            selectionTipsDesc: 'Keep this open when you need a quick reminder, or collapse it to leave more room for the table list.',
            selectionTipsBullets: [
              'Prefer only the tables the dashboard truly needs.',
              'Use search when you have many datasets or similar table names.',
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
            reviewDataset: 'Review dataset',
            reviewDatasetDesc: 'Review the Plan tab first to understand the strategy, then edit sections and charts.',
          },
    [isVietnamese],
  );
  const fallbackReportName = isVietnamese ? 'AI Report mới' : 'New AI Report';
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
              ? 'Chỉ chọn những dataset và bảng thực sự thuộc về report này.'
              : 'Pick only the datasets and tables that truly belong in this report.',
            isVietnamese
              ? 'Dùng panel phạm vi đã chọn để sanity-check lần cuối trước khi sang bước tiếp.'
              : 'Use the selected scope panel as the final sanity check before moving on.',
          ],
          stats: [
            { label: wizardText.selectedTables, value: String(selectedTables.length) },
            { label: isVietnamese ? 'Dataset trong phạm vi' : 'Datasets in scope', value: String(selectedDatasetCount) },
          ],
        };
      case 'brief':
        return {
          title: isVietnamese ? 'Giữ brief thật ngắn' : 'Keep the brief compact',
          description: isVietnamese
            ? 'Step này chỉ giữ domain và các trường brief cốt lõi để Agent tự phát triển hướng phân tích như một DA senior, thay vì bắt người dùng điền quá nhiều.'
            : 'This step now keeps the domain plus the core brief fields so the Agent can develop the analysis like a senior analyst without over-collecting inputs.',
          bullets: [
            isVietnamese
              ? 'Goal là trường bắt buộc duy nhất; các trường còn lại chỉ giúp Agent chọn đúng góc nhìn và độ sâu.'
              : 'The goal is the only required field; everything else just helps the Agent choose the right lens and depth.',
            isVietnamese
              ? 'Không còn KPI, question hay dataset context viết tay; Agent sẽ tự suy luận phần đó từ domain đã chọn, brief ngắn và mô tả bảng.'
              : 'There are no manual KPI, question, or dataset-context fields anymore; the Agent infers them from the chosen domain, the short brief, and the table descriptions.',
          ],
          stats: [
            { label: isVietnamese ? 'Domain' : 'Domain', value: selectedDomain?.label ?? 'Finance' },
            { label: isVietnamese ? 'Audience' : 'Audience', value: formatAudienceChoice(audience || undefined, language) },
            { label: isVietnamese ? 'Mức chi tiết' : 'Detail level', value: formatDetailChoice(preferredGranularity || undefined, language) },
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
    buildMode,
    currentStepMeta.caption,
    currentStepMeta.label,
    enabledChartCount,
    enabledSectionCount,
    events.length,
    selectedDomain?.label,
    selectedTables.length,
    selectedDatasetCount,
    step,
  ]);
  const readinessChecks = useMemo(
    () => [
      { label: isVietnamese ? 'Đã chọn bảng' : 'Tables selected', done: selectedTables.length > 0 },
      { label: isVietnamese ? 'Đã nêu quyết định cần hỗ trợ' : 'Decision goal defined', done: goal.trim().length > 0 },
      { label: isVietnamese ? 'Đã chọn audience' : 'Audience selected', done: audience.trim().length > 0 },
      { label: isVietnamese ? 'Đã chọn mốc so sánh' : 'Comparison selected', done: comparisonPeriod.trim().length > 0 },
      { label: isVietnamese ? 'Đã chọn mức chi tiết' : 'Detail level selected', done: preferredGranularity.trim().length > 0 },
    ],
    [audience, comparisonPeriod, goal, isVietnamese, preferredGranularity, selectedTables.length],
  );
  const readinessCount = readinessChecks.filter((item) => item.done).length;
  const agentUnderstandingPreview = useMemo(() => {
    const audienceLabel = formatAudienceChoice(audience.trim() || undefined, language);
    const comparisonLabel = formatComparisonChoice(comparisonPeriod.trim() || undefined, language);
    const detailLabel = formatDetailChoice(preferredGranularity.trim() || undefined, language);
    const timeframeLabel = timeframe.trim() || (isVietnamese ? '30 ngày gần nhất' : 'Last 30 days');
    const goalLabel = goal.trim() || (isVietnamese ? 'mục tiêu ra quyết định chính' : 'the main decision goal');
    const domainLabel = selectedDomain?.label ?? 'Finance';
    if (isVietnamese) {
      return `Agent sẽ đọc brief này như một DA senior theo domain ${domainLabel}, cho ${audienceLabel}, tập trung vào quyết định "${goalLabel}", dùng ${selectedTables.length} bảng đã chọn trong ${timeframeLabel}, so với ${comparisonLabel} và ở mức ${detailLabel}.`;
    }
    return `The Agent will read this as a ${domainLabel} specialist brief for ${audienceLabel}, focused on the decision "${goalLabel}", using ${selectedTables.length} selected table${selectedTables.length === 1 ? '' : 's'} across ${timeframeLabel}, compared with ${comparisonLabel}, at a ${detailLabel} read depth.`;
  }, [audience, comparisonPeriod, goal, isVietnamese, language, preferredGranularity, selectedDomain?.label, selectedTables.length, timeframe]);

  useEffect(() => {
    if (!isActive) {
      setStep('select');
      setActiveSpecId(initialSpecId);
      setSelectedKeys([]);
      setTableSearch('');
      setExpandedDatasetIds([]);
      setDomainId(initialBrief.domainId);
      setGoal(initialBrief.goal);
      setAudience(initialBrief.audience);
      setTimeframe(initialBrief.timeframe);
      setComparisonPeriod(initialBrief.comparisonPeriod);
      setPreferredGranularity(initialBrief.preferredGranularity);
      setNotes(initialBrief.notes);
      setGeneratedPlan(null);
      setDraftPlan(null);
      setPlanningEvents([]);
      setEvents([]);
      setAgentError(null);
      setIsBuildRunning(false);
      setBuildMode('new_dashboard');
      setPlanDatasetTab('plan');
    }
  }, [initialBrief, initialSpecId, isActive]);

  useEffect(() => {
    setActiveSpecId(initialSpecId);
  }, [initialSpecId]);

  useEffect(() => {
    if (!isActive || !datasetDetailsQuery.data?.length) return;

    setExpandedDatasetIds((prev) => {
      const validIds = prev.filter((id) => datasetDetailsQuery.data.some((dataset) => dataset.id === id));
      if (validIds.length > 0) {
        return validIds;
      }

      return datasetDetailsQuery.data
        .slice(0, 3)
        .map((dataset) => dataset.id);
    });
  }, [isActive, datasetDetailsQuery.data]);

  useEffect(() => {
    const spec = activeSpec;
    if (!isActive || !spec) return;

    const brief = spec.brief_json ?? {};
    const selected = Array.isArray(spec.selected_tables_snapshot) ? spec.selected_tables_snapshot : [];
    setSelectedKeys(
      selected
        .map((item) => `${item.dataset_id}:${item.table_id}`)
        .filter((item) => item !== 'undefined:undefined'),
    );
    const restoredDomainId = getDomainCatalogItem(
      (brief.domain_id ?? spec.domain_id ?? initialBrief.domainId) as AgentDomainId,
    )?.id ?? getDefaultDomainId();
    setDomainId(restoredDomainId);
    setGoal(String(brief.goal ?? initialBrief.goal));
    setAudience(normalizeAudienceChoice(brief.audience));
    setTimeframe(String(brief.timeframe ?? initialBrief.timeframe));
    setComparisonPeriod(normalizeComparisonChoice(brief.comparison_period));
    setPreferredGranularity(
      normalizeDetailChoice(brief.detail_level ?? brief.preferred_granularity),
    );
    setNotes(String(brief.notes ?? ''));

    const savedStep =
      WIZARD_STEP_ORDER.includes(spec.current_step as WizardStep)
        ? (spec.current_step as WizardStep)
        : 'select';
    const defaultStep = (() => {
      if (spec.latest_dashboard_id || savedStep === 'building') return 'building' as const;
      if (spec.approved_plan_json) return 'plan' as const;
      if (spec.selected_tables_snapshot?.length > 0) return 'brief' as const;
      return 'select' as const;
    })();
    const savedIdx = WIZARD_STEP_ORDER.indexOf(savedStep);
    const defaultIdx = WIZARD_STEP_ORDER.indexOf(defaultStep);
    const resolvedStep =
      savedIdx >= 0 ? WIZARD_STEP_ORDER[Math.max(savedIdx, defaultIdx)] : defaultStep;

    if (spec.approved_plan_json) {
      const editable = normalizePlan(spec.approved_plan_json as AgentPlanResponse);
      setGeneratedPlan(editable);
      setDraftPlan(cloneEditablePlan(editable));
      setBuildMode(spec.latest_dashboard_id ? 'replace_existing' : 'new_dashboard');
      setPlanDatasetTab('plan');
      setStep(resolvedStep);
      if (spec.status !== 'running') {
        setEvents([]);
        setIsBuildRunning(false);
      }
      // Restore build result from latest successful run when returning to building step
      if (resolvedStep === 'building' && spec.runs?.length) {
        const sortedRuns = [...spec.runs].sort(
          (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        const successRun = sortedRuns.find((r: any) => r.status === 'succeeded') ?? sortedRuns[0];
        if (successRun?.result_summary_json) {
          setBuildResult(successRun.result_summary_json);
        }
        if (spec.latest_dashboard_id) {
          setBuildDashboardUrl(`/dashboards/${spec.latest_dashboard_id}`);
        }
        setBuildReportUrl(`/ai-reports/${spec.id}`);
      }
    } else if (spec.selected_tables_snapshot?.length > 0) {
      setGeneratedPlan(null);
      setDraftPlan(null);
      setStep(resolvedStep);
      if (spec.status !== 'running') {
        setEvents([]);
        setIsBuildRunning(false);
      }
    } else {
      setGeneratedPlan(null);
      setDraftPlan(null);
      setStep('select');
      setEvents([]);
      setIsBuildRunning(false);
    }
    setAgentError(null);
  }, [activeSpec, initialBrief, isActive]);

  useEffect(() => {
    if (step !== 'building' && !isBuildRunning && events.length > 0) {
      setEvents([]);
    }
  }, [events.length, isBuildRunning, step]);

  const planMutation = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      planAbortControllerRef.current = controller;
      const token = await getAuthToken();
      try {
        const response = await fetch(`${getAiAgentHttpUrl()}/agent/plan/stream`, {
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
      setPlanDatasetTab('plan');
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
        'enrich_brief',
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
      name: plan.dashboard_title || activeSpec?.name || fallbackReportName,
      description: plan.dashboard_summary,
      selected_tables_snapshot: briefPayload.selected_tables,
      domain_id: domainId,
      domain_version: selectedDomain?.version,
      brief_json: briefPayload as unknown as Record<string, any>,
      approved_plan_json: plan as unknown as Record<string, any>,
      status: 'ready' as const,
      current_step: 'plan' as const,
    };

    if (activeSpecId) {
      await updateSpecMutation.mutateAsync({ id: activeSpecId, payload });
      return activeSpecId;
    }

    const created = await createSpecMutation.mutateAsync(payload);
    setActiveSpecId(created.id);
    return created.id;
  }

  async function ensureSpecCreated(): Promise<number> {
    if (activeSpecId) return activeSpecId;
    const payload = {
      name: activeSpec?.name || fallbackReportName,
      selected_tables_snapshot: briefPayload.selected_tables,
      domain_id: domainId,
      domain_version: selectedDomain?.version,
      brief_json: briefPayload as unknown as Record<string, any>,
      status: 'draft' as const,
      current_step: 'brief' as const,
    };
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

  function toggleTable(datasetId: number, tableId: number) {
    const key = `${datasetId}:${tableId}`;
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  }

  function toggleDatasetExpanded(datasetId: number) {
    setExpandedDatasetIds((prev) =>
      prev.includes(datasetId) ? prev.filter((item) => item !== datasetId) : [...prev, datasetId],
    );
  }

  function setDatasetTableSelection(datasetId: number, tableIds: number[], shouldSelect: boolean) {
    const keys = tableIds.map((tableId) => `${datasetId}:${tableId}`);
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
      toast.info(wizardText.businessGoalRequired);
      return;
    }
    if (briefPayload.selected_tables.length === 0) {
      toast.info(wizardText.chooseAtLeastOne);
      return;
    }
    // Persist brief data to spec before generating plan
    if (activeSpecId) {
      updateSpecMutation.mutate({
        id: activeSpecId,
        payload: {
          brief_json: briefPayload as unknown as Record<string, any>,
          selected_tables_snapshot: briefPayload.selected_tables,
          domain_id: domainId,
          domain_version: selectedDomain?.version,
          name: activeSpec?.name || fallbackReportName,
          current_step: 'brief',
        },
      });
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
          domain_id: domainId,
          domain_version: selectedDomain?.version,
          input_brief_json: briefPayload as unknown as Record<string, any>,
          plan_json: buildPlan as unknown as Record<string, any>,
          target_dashboard_id: targetDashboardId,
          status: 'queued',
        },
      });

      const token = await getAuthToken();
      const response = await fetch(`${getAiAgentHttpUrl()}/agent/build/stream`, {
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
            setBuildDashboardUrl(event.dashboard_url || null);
            setBuildReportUrl(event.report_url || (specId ? `/ai-reports/${specId}` : null));
            await refreshAgentReportViews(specId);
            // Fetch the run result for inline report display
            try {
              const specData: any = await queryClient.fetchQuery({ queryKey: agentReportSpecKeys.detail(specId) });
              const runs = [...(specData?.runs ?? [])].sort(
                (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
              );
              const latestRun = runs.find((r: any) => r.status === 'succeeded') ?? runs[0];
              if (latestRun?.result_summary_json) {
                setBuildResult(latestRun.result_summary_json);
              }
            } catch {
              // Non-critical — inline report just won't show
            }
            toast.success(
              isVietnamese
                ? 'AI report đã build xong! Xem kết quả bên dưới.'
                : 'AI report built successfully! See the results below.',
            );
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
              onClick={() => { setStep('select'); }}
              disabled={isInteractionLocked}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              {wizardText.back}
            </button>
          )}

          {step === 'plan' && (
            <button
              onClick={() => { setStep('brief'); }}
              disabled={isInteractionLocked}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              {wizardText.backToBrief}
            </button>
          )}

          {step === 'building' && (
            <button
              onClick={() => { setStep('plan'); }}
              disabled={isBuildRunning}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              {wizardText.backToPlan}
            </button>
          )}

          {step === 'select' && (
            <button
              onClick={async () => {
                if (selectedTables.length === 0) {
                  toast.info(wizardText.chooseAtLeastOne);
                  return;
                }
                try {
                  const specId = await ensureSpecCreated();
                  // Update URL so browser refresh resumes at this spec
                  if (isPageMode && !initialSpecId && specId) {
                    router.replace(`/ai-reports/${specId}/edit`);
                  }
                } catch {
                  // Continue even if spec creation fails — user can retry later
                }
                // Fetch table descriptions in parallel for the BriefStep sidebar
                Promise.allSettled(
                  selectedTables.map(async (ref: { dataset_id: number; table_id: number }) => {
                    try {
                      const { data } = await apiClient.get(
                        `/datasets/${ref.dataset_id}/tables/${ref.table_id}/description`,
                      );
                      const tbl = tables.find(
                        (t: { dataset_id: number; table_id: number }) => t.dataset_id === ref.dataset_id && t.table_id === ref.table_id,
                      );
                      return {
                        key: `${ref.dataset_id}:${ref.table_id}`,
                        datasetId: ref.dataset_id,
                        tableId: ref.table_id,
                        datasetName: tbl?.dataset_name ?? `Dataset ${ref.dataset_id}`,
                        tableName: tbl?.table_name ?? `Table ${ref.table_id}`,
                        autoDescription: data?.auto_description ?? null,
                        columnDescriptions: data?.column_descriptions ?? null,
                        commonQuestions: data?.common_questions ?? null,
                      } satisfies TableDescriptionCard;
                    } catch {
                      return null;
                    }
                  }),
                ).then((results: PromiseSettledResult<TableDescriptionCard | null>[]) => {
                  const cards = results
                    .filter((r: PromiseSettledResult<TableDescriptionCard | null>): r is PromiseFulfilledResult<TableDescriptionCard | null> => r.status === 'fulfilled')
                    .map((r: PromiseFulfilledResult<TableDescriptionCard | null>) => r.value)
                    .filter((v: TableDescriptionCard | null): v is TableDescriptionCard => v !== null);
                  setTableDescriptions(cards);
                });
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
              const isLastStep = index === stepMeta.length - 1;
              const complete = isLastStep
                ? hasBuiltOutput && !active
                : highestReachedIndex > index && !active;
              const canNavigate = index <= highestReachedIndex && !isInteractionLocked;
              return (
                <button
                  type="button"
                  key={item.key}
                  disabled={!canNavigate}
                  onClick={() => {
                    if (!canNavigate || active) return;
                    setStep(item.key);
                  }}
                  className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                    active
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : complete
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 cursor-pointer'
                        : 'border-gray-200 bg-white text-gray-500 cursor-default'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {complete ? <CheckCircle2 className="h-4 w-4" /> : <span>{index + 1}</span>}
                    <span>{item.label}</span>
                  </div>
                  <p className={`mt-1 text-xs ${active ? 'text-blue-600' : complete ? 'text-emerald-600' : 'text-gray-400'}`}>
                    {item.caption}
                  </p>
                </button>
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
            datasetDetailsQuery={datasetDetailsQuery}
            tables={tables}
            tableSearch={tableSearch}
            setTableSearch={setTableSearch}
            setExpandedDatasetIds={setExpandedDatasetIds}
            datasetSelectionGroups={datasetSelectionGroups}
            normalizedTableSearch={normalizedTableSearch}
            visibleTableCount={visibleTableCount}
            toggleDatasetExpanded={toggleDatasetExpanded}
            setDatasetTableSelection={setDatasetTableSelection}
            selectedKeys={selectedKeys}
            toggleTable={toggleTable}
            selectedTableCards={selectedTableCards}
            clearSelectedTables={clearSelectedTables}
            selectedTables={selectedTables}
            selectedDatasetCount={selectedDatasetCount}
            setSelectedKeys={setSelectedKeys}
            openGuides={openGuides}
            toggleGuide={toggleGuide}
            expandedDatasetIds={expandedDatasetIds}
          />
        )}
        {step === 'brief' && (
          <BriefStep
            isVietnamese={isVietnamese}
            language={language}
            isPlanningLocked={isPlanningLocked}
            domainId={domainId}
            setDomainId={setDomainId}
            domains={AGENT_DOMAIN_CATALOG}
            agentUnderstandingPreview={agentUnderstandingPreview}
            selectedTables={selectedTables}
            selectedTableCards={selectedTableCards}
            readinessCount={readinessCount}
            readinessChecks={readinessChecks}
            openGuides={openGuides}
            toggleGuide={toggleGuide}
            planMutation={planMutation}
            planningEvents={planningEvents}
            planningPhaseSummary={planningPhaseSummary}
            recentPlanningThoughts={recentPlanningThoughts}
            formatProcessPhaseLabel={formatProcessPhaseLabel}
            getProcessPhaseStatusClass={getProcessPhaseStatusClass}
            getProcessPhaseStatusLabel={getProcessPhaseStatusLabel}
            getPlanEventBadgeClass={getPlanEventBadgeClass}
            goal={goal}
            setGoal={setGoal}
            audience={audience}
            setAudience={setAudience}
            timeframe={timeframe}
            setTimeframe={setTimeframe}
            comparisonPeriod={comparisonPeriod}
            setComparisonPeriod={setComparisonPeriod}
            preferredGranularity={preferredGranularity}
            setPreferredGranularity={setPreferredGranularity}
            notes={notes}
            setNotes={setNotes}
            tableDescriptions={tableDescriptions}
          />
        )}
        {step === 'plan' && draftPlan && (
          <ReviewPlanStep
            draftPlan={draftPlan}
            setDraftPlan={setDraftPlan}
            selectedDomain={selectedDomain}
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
            planDatasetTabs={planDatasetTabs}
            planDatasetTab={planDatasetTab}
            setPlanDatasetTab={setPlanDatasetTab}
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
            hasBuiltOutput={hasBuiltOutput}
            buildResult={buildResult}
            buildDashboardUrl={buildDashboardUrl}
            buildReportUrl={buildReportUrl}
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
