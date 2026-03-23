'use client';

/**
 * Renders a single chat message bubble (user or AI).
 * AI messages can contain markdown text, embedded charts, tool call badges,
 * quality metrics bar, and feedback buttons.
 */
import React, { useState } from 'react';
import { Bot, User, ThumbsUp, ThumbsDown, Clock, Database, BarChart3, Wrench, Zap, MessageSquarePlus } from 'lucide-react';
import type { ChartRoleConfig } from '@/components/explore/ExploreChartConfig';
import { EmbeddedChart } from './EmbeddedChart';
import { ThinkingIndicator } from './ThinkingIndicator';
import { FeedbackModal } from './FeedbackModal';
import type { ChatMessageData } from './types';

interface ChatMessageProps {
  message: ChatMessageData;
  sessionId?: string;
  onFeedback?: (msgId: string, messageId: string, rating: 'up' | 'down') => void;
}

export function ChatMessage({ message, sessionId, onFeedback }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const metrics = message.metrics;
  const feedback = message.feedback;
  const [isCorrectModalOpen, setIsCorrectModalOpen] = useState(false);

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
        isUser
          ? 'bg-blue-500'
          : 'bg-gradient-to-br from-purple-500 to-blue-500'
      }`}>
        {isUser
          ? <User className="h-4 w-4 text-white" />
          : <Bot className="h-4 w-4 text-white" />}
      </div>

      {/* Bubble */}
      <div className={`flex-1 max-w-[85%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        {/* Activity Panel — thinking steps + tool calls (AI only) */}
        {!isUser && (message.isThinking || (message.activitySteps && message.activitySteps.length > 0)) && (
          <ThinkingIndicator
            steps={message.activitySteps ?? []}
            isThinking={message.isThinking ?? false}
            hasText={!!(message.text)}
          />
        )}

        {/* Text content */}
        {message.text && message.text.replace(/\[CHART:\d+\]/g, '').trim() && (
          <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? 'bg-blue-500 text-white rounded-tr-sm'
              : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
          }`}>
            {renderTextWithBold(message.text.replace(/\[CHART:\d+\]/g, '').trim())}
          </div>
        )}

        {/* Embedded charts */}
        {message.charts && message.charts.map((chart, i) => (
          <div key={i} className="w-full">
            <EmbeddedChart
              chartId={chart.chart_id}
              chartName={chart.chart_name}
              chartType={chart.chart_type}
              data={chart.data}
              roleConfig={chart.role_config as ChartRoleConfig | null | undefined}
            />
          </div>
        ))}

        {/* Quality metrics bar + feedback (AI only, after text is done) */}
        {!isUser && metrics && !message.isThinking && (
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {/* Metrics pills */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <MetricPill icon={<Clock className="h-3 w-3" />} label={formatLatency(metrics.latency_ms)} />
              <MetricPill
                icon={<Wrench className="h-3 w-3" />}
                label={`${metrics.tool_call_count} tool${metrics.tool_call_count !== 1 ? 's' : ''}`}
                warn={metrics.tool_call_count === 0}
              />
              {metrics.data_rows_analyzed > 0 && (
                <MetricPill icon={<Database className="h-3 w-3" />} label={`${metrics.data_rows_analyzed} rows`} />
              )}
              {metrics.has_chart && (
                <MetricPill icon={<BarChart3 className="h-3 w-3" />} label="chart" good />
              )}
              {!metrics.has_data_backing && (
                <MetricPill icon={<Zap className="h-3 w-3" />} label="no data" warn />
              )}
              {metrics.tool_errors > 0 && (
                <MetricPill icon={<Zap className="h-3 w-3" />} label={`${metrics.tool_errors} error${metrics.tool_errors !== 1 ? 's' : ''}`} warn />
              )}
              <span className="text-[10px] text-gray-400 ml-0.5" title={metrics.model}>
                {metrics.model.split('/').pop()}
              </span>
            </div>

            {/* Feedback buttons */}
            <div className="flex items-center gap-0.5 ml-auto">
              <button
                onClick={() => message.messageId && onFeedback?.(message.id, message.messageId, 'up')}
                disabled={!!feedback}
                className={`p-1 rounded transition-colors ${
                  feedback?.rating === 'up'
                    ? 'text-green-600 bg-green-50'
                    : 'text-gray-400 hover:text-green-600 hover:bg-green-50 disabled:opacity-30'
                }`}
                title="Good response"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => message.messageId && onFeedback?.(message.id, message.messageId, 'down')}
                disabled={!!feedback}
                className={`p-1 rounded transition-colors ${
                  feedback?.rating === 'down'
                    ? 'text-red-600 bg-red-50'
                    : 'text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30'
                }`}
                title="Bad response"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
              {message.userQuery && (
                <button
                  onClick={() => setIsCorrectModalOpen(true)}
                  className="p-1 rounded transition-colors text-gray-400 hover:text-purple-600 hover:bg-purple-50"
                  title="Correct this response"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {isCorrectModalOpen && message.userQuery && (
          <FeedbackModal
            sessionId={sessionId ?? ''}
            messageId={message.messageId}
            userQuery={message.userQuery}
            onClose={() => setIsCorrectModalOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/** Small pill showing a single metric. */
function MetricPill({ icon, label, good, warn }: { icon: React.ReactNode; label: string; good?: boolean; warn?: boolean }) {
  const color = warn
    ? 'text-amber-600 bg-amber-50 border-amber-200'
    : good
    ? 'text-green-600 bg-green-50 border-green-200'
    : 'text-gray-500 bg-gray-50 border-gray-200';
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${color}`}>
      {icon}{label}
    </span>
  );
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Render **bold** markdown markers without a full markdown parser. */
function renderTextWithBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}
