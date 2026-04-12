/**
 * Shared types for AI chat components.
 */

export interface ActivityStep {
  id: string;
  type: 'thinking' | 'tool';
  label: string;
  detail?: string;
  status: 'running' | 'done';
}

export interface ChartPayload {
  chart_id: number;
  chart_name: string;
  chart_type: string;
  data: Array<Record<string, any>>;
  role_config?: Record<string, any> | null;
}

export type IntentType = 'LOOKUP' | 'EXPLORE' | 'INSIGHT' | 'CREATE' | 'VAGUE';

export interface MessageMetrics {
  message_id: string;
  latency_ms: number;
  model: string;
  provider: string;
  tool_calls: string[];
  tool_call_count: number;
  tool_errors: number;
  has_chart: boolean;
  has_data_backing: boolean;
  data_rows_analyzed: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  intent?: IntentType | null;
}

export interface MessageFeedback {
  rating: 'up' | 'down';
  comment?: string | null;
}

export interface ActiveResourceContext {
  type: 'dataset' | 'table' | 'chart' | 'dashboard';
  id: number | string;
  name?: string;
  dataset_id?: number;
  dataset_name?: string;
  table_id?: number;
  chart_type?: string;
  chart_count?: number;
}

export interface ChatSessionContext {
  dataset_id?: number;
  dataset_name?: string;
  active_resource?: ActiveResourceContext | null;
  [key: string]: any;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  isThinking?: boolean;
  activitySteps?: ActivityStep[];
  charts?: ChartPayload[];
  metrics?: MessageMetrics;
  feedback?: MessageFeedback;
  messageId?: string;            // server-assigned message_id for feedback
  userQuery?: string;            // The user question that prompted this AI response
}
