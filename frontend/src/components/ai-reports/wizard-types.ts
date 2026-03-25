import {
  AgentBuildEvent as BuildEvent,
  AgentChartPlan,
  AgentPlanEvent,
  AgentPlanResponse,
} from '@/types/agent';

export type WizardStep = 'select' | 'brief' | 'plan' | 'building';
export type BriefSectionKey = 'essentials' | 'intent' | 'dataset' | 'narrative' | 'advanced';

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
  reportStyle: string;
  reportType: string;
  comparisonPeriod: string;
  refreshFrequency: string;
  mustIncludeSectionsText: string;
  alertFocusText: string;
  insightDepth: string;
  recommendationStyle: string;
  preferredDashboardStructure: string;
}

export type BuildEventBadgeInput = BuildEvent;
export type PlanEventBadgeInput = AgentPlanEvent;
