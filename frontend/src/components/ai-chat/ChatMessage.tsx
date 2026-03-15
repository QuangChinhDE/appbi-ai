'use client';

/**
 * Renders a single chat message bubble (user or AI).
 * AI messages can contain markdown text, embedded charts, and tool call badges.
 */
import React from 'react';
import { Bot, User, Wrench, CheckCircle2 } from 'lucide-react';
import type { ChartRoleConfig } from '@/components/explore/ExploreChartConfig';
import { EmbeddedChart } from './EmbeddedChart';
import { ThinkingIndicator } from './ThinkingIndicator';
import type { ChatMessageData } from './types';

interface ChatMessageProps {
  message: ChatMessageData;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

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
        {/* Tool call badges */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1">
            {message.toolCalls.map((tc, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                  tc.done
                    ? 'bg-green-50 border-green-200 text-green-700'
                    : 'bg-blue-50 border-blue-200 text-blue-700 animate-pulse'
                }`}
              >
                {tc.done
                  ? <CheckCircle2 className="h-3 w-3" />
                  : <Wrench className="h-3 w-3" />}
                {tc.label}
              </span>
            ))}
          </div>
        )}

        {/* Thinking indicator */}
        {message.isThinking && (
          <div className="px-4 py-3 rounded-2xl bg-gray-100 text-gray-600">
            <ThinkingIndicator content={message.thinkingContent} />
          </div>
        )}

        {/* Text content */}
        {message.text && (
          <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? 'bg-blue-500 text-white rounded-tr-sm'
              : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
          }`}>
            {renderTextWithBold(message.text)}
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
      </div>
    </div>
  );
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
