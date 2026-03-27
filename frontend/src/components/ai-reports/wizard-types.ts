import {
  AgentBuildEvent as BuildEvent,
  AgentChartPlan,
  AgentPlanEvent,
  AgentPlanResponse,
} from '@/types/agent';

export type WizardStep = 'select' | 'brief' | 'plan' | 'building';
export type BriefSectionKey = 'brief' | 'dataset' | 'settings';

export interface AIReportWizardProps {
  isOpen?: boolean;
  onClose?: () => void;
  initialSpecId?: number | null;
  mode?: 'modal' | 'page';
  backHref?: string;
}

export interface AgentHealthPayload {
  status: string;
  service: string;
  provider?: string;
  model?: string;
  phase_models?: Record<string, string>;
  fallback_chain?: Array<{ provider: string; model: string }>;
  timeout_seconds?: number;
}

export interface EditableAgentChartPlan extends AgentChartPlan {
  enabled: boolean;
}

export interface EditableAgentPlan extends Omit<AgentPlanResponse, 'charts'> {
  charts: EditableAgentChartPlan[];
}

export interface StepMeta {
  key: WizardStep;
  label: string;
  caption: string;
}

export interface BriefSectionMeta {
  key: BriefSectionKey;
  title: string;
  description: string;
  helper: string;
  optional?: boolean;
}

export interface BriefPreset {
  key: 'executive' | 'operations' | 'quality' | 'investigative';
  title: string;
  summary: string;
  goal: string;
  audience: string;
  comparisonPeriod: string;
  mustIncludeSectionsText: string;
  alertFocusText: string;
}

export interface TableDescriptionCard {
  key: string;
  workspaceId: number;
  tableId: number;
  workspaceName: string;
  tableName: string;
  autoDescription: string | null;
  columnDescriptions: Record<string, string> | null;
  commonQuestions: string[] | null;
}

export type BuildEventBadgeInput = BuildEvent;
export type PlanEventBadgeInput = AgentPlanEvent;
