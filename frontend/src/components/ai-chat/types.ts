/**
 * Shared types for AI chat components.
 */

export interface ToolCallBadge {
  label: string;
  done: boolean;
}

export interface ChartPayload {
  chart_id: number;
  chart_name: string;
  chart_type: string;
  data: Array<Record<string, any>>;
  role_config?: Record<string, any> | null;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  isThinking?: boolean;
  thinkingContent?: string;
  toolCalls?: ToolCallBadge[];
  charts?: ChartPayload[];
}
