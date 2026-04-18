'use client';

/**
 * Renders a single chat message bubble (user or AI).
 *
 * Phase UI improvements:
 * - Rich markdown renderer (headers, bullets, bold, inline code)
 * - Token usage display in metrics bar
 * - Intent badge on AI messages
 * - Better visual for INSIGHT (narrative) vs LOOKUP (bullets) responses
 */
import React, { useState } from 'react';
import {
  Bot, User, ThumbsUp, ThumbsDown, Clock, Database,
  BarChart3, Zap, MessageSquarePlus, Coins,
} from 'lucide-react';
import type { ChartRoleConfig } from '@/components/explore/ExploreChartConfig';
import { EmbeddedChart } from './EmbeddedChart';
import { ThinkingIndicator } from './ThinkingIndicator';
import { FeedbackModal } from './FeedbackModal';
import type { ChatMessageData, IntentType } from './types';

interface ChatMessageProps {
  message: ChatMessageData;
  sessionId?: string;
  onFeedback?: (msgId: string, messageId: string, rating: 'up' | 'down') => void;
}

// ── Intent badge ──────────────────────────────────────────────────────────────

const INTENT_BADGE: Record<IntentType, { label: string; cls: string }> = {
  LOOKUP:  { label: '🔍 Lookup',  cls: 'bg-brand/10 text-brand border-brand/30' },
  EXPLORE: { label: '🔬 Explore', cls: 'bg-brand/10 text-brand border-brand/30' },
  INSIGHT: { label: '💡 Insight', cls: 'bg-warning/10 text-warning border-warning/30' },
  CREATE:  { label: '🎨 Create',  cls: 'bg-success/10 text-success border-success/30' },
  VAGUE:   { label: '❓ Clarify', cls: 'bg-surface-2 text-text-tertiary border-[rgb(var(--border-line))]' },
};

// ── Markdown renderer ─────────────────────────────────────────────────────────

/**
 * Render inline markup: **bold**, `code`, plain text.
 */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="font-semibold text-text-primary">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="bg-surface-2 px-1 py-0.5 rounded text-[11px] font-mono text-brand border border-[rgb(var(--border-line))]">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/**
 * Full markdown renderer supporting:
 * # / ## / ### headings, - / • / * bullet lists, numbered lists,
 * **bold**, `code`, paragraph breaks.
 */
function renderMarkdown(text: string, isInsight: boolean): React.ReactNode {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listType: 'ul' | 'ol' = 'ul';
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    elements.push(
      listType === 'ul' ? (
        <ul key={key++} className="space-y-1 my-2">
          {listItems.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="text-brand mt-1 flex-shrink-0 text-xs">•</span>
              <span className="leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ol key={key++} className="space-y-1 my-2 list-none">
          {listItems.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="text-brand font-medium text-xs mt-1 w-4 flex-shrink-0">{i + 1}.</span>
              <span className="leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      )
    );
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine;

    // Headings
    if (line.startsWith('### ')) {
      flushList();
      elements.push(
        <h4 key={key++} className="font-bold text-sm text-text-primary mt-3 mb-1 pb-0.5 border-b border-[rgb(var(--border-line))]">
          {renderInline(line.slice(4))}
        </h4>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      flushList();
      elements.push(
        <h3 key={key++} className="font-bold text-sm text-text-primary mt-4 mb-1.5 pb-1 border-b border-[rgb(var(--border-line))]">
          {renderInline(line.slice(3))}
        </h3>
      );
      continue;
    }
    if (line.startsWith('# ')) {
      flushList();
      elements.push(
        <h2 key={key++} className="font-bold text-base text-text-primary mt-4 mb-2">
          {renderInline(line.slice(2))}
        </h2>
      );
      continue;
    }

    // Unordered list
    if (/^[•\-\*] /.test(line)) {
      listType = 'ul';
      listItems.push(line.replace(/^[•\-\*] /, ''));
      continue;
    }
    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      listType = 'ol';
      listItems.push(line.replace(/^\d+\.\s/, ''));
      continue;
    }

    // Empty line → paragraph break
    if (line.trim() === '') {
      flushList();
      if (elements.length > 0 && isInsight) {
        elements.push(<div key={key++} className="h-2" />);
      }
      continue;
    }

    // Regular paragraph line
    flushList();
    elements.push(
      <p key={key++} className={`leading-relaxed ${isInsight ? 'text-sm text-text-secondary' : 'text-sm'}`}>
        {renderInline(line)}
      </p>
    );
  }

  flushList();
  return <div className="space-y-0.5">{elements}</div>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChatMessage({ message, sessionId, onFeedback }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const metrics = message.metrics;
  const feedback = message.feedback;
  const intent = metrics?.intent ?? null;
  const isInsight = intent === 'INSIGHT';
  const [isCorrectModalOpen, setIsCorrectModalOpen] = useState(false);

  const cleanText = message.text?.replace(/\[CHART:\d+\]/g, '').trim() ?? '';

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
        isUser ? 'bg-brand' : 'bg-gradient-to-br from-blue-600 to-blue-700'
      }`}>
        {isUser
          ? <User className="h-4 w-4 text-white" />
          : <Bot className="h-4 w-4 text-white" />}
      </div>

      {/* Bubble */}
      <div className={`flex-1 max-w-[85%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>

        {/* ThinkingIndicator (AI only) */}
        {!isUser && (message.isThinking || (message.activitySteps && message.activitySteps.length > 0)) && (
          <ThinkingIndicator
            steps={message.activitySteps ?? []}
            isThinking={message.isThinking ?? false}
            hasText={!!cleanText}
            intent={intent}
          />
        )}

        {/* Text bubble */}
        {cleanText && (
          <div className={`px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-brand text-white rounded-2xl rounded-tr-sm'
              : isInsight
                ? 'bg-warning/10 border border-warning/20 text-text-primary rounded-2xl rounded-tl-sm shadow-linear-sm'
                : 'bg-surface-1 border border-[rgb(var(--border-line))] text-text-primary rounded-2xl rounded-tl-sm shadow-linear-sm'
          }`}>
            {isUser
              ? <span className="whitespace-pre-wrap">{cleanText}</span>
              : renderMarkdown(cleanText, isInsight)
            }
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

        {/* Metrics + feedback (AI only, after response done) */}
        {!isUser && metrics && !message.isThinking && (
          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">

              {/* Intent badge */}
              {intent && INTENT_BADGE[intent] && (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${INTENT_BADGE[intent].cls}`}>
                  {INTENT_BADGE[intent].label}
                </span>
              )}

              {/* Latency */}
              <MetricPill
                icon={<Clock className="h-3 w-3" />}
                label={formatLatency(metrics.latency_ms)}
              />

              {/* Tools used */}
              <MetricPill
                icon={<span className="text-[9px]">🔧</span>}
                label={`${metrics.tool_call_count}T`}
                warn={metrics.tool_call_count === 0 && metrics.has_data_backing === false}
                title={metrics.tool_calls.join(' → ') || 'No tools used'}
              />

              {/* Rows analyzed */}
              {metrics.data_rows_analyzed > 0 && (
                <MetricPill
                  icon={<Database className="h-3 w-3" />}
                  label={`${metrics.data_rows_analyzed}r`}
                  title={`${metrics.data_rows_analyzed} rows analyzed`}
                />
              )}

              {/* Token usage (now that we track it) */}
              {metrics.input_tokens != null && (
                <MetricPill
                  icon={<Coins className="h-3 w-3" />}
                  label={formatTokens((metrics.input_tokens ?? 0) + (metrics.output_tokens ?? 0))}
                  title={`Input: ${metrics.input_tokens} | Output: ${metrics.output_tokens}`}
                />
              )}

              {/* Chart indicator */}
              {metrics.has_chart && (
                <MetricPill icon={<BarChart3 className="h-3 w-3" />} label="chart" good />
              )}

              {/* Warnings */}
              {!metrics.has_data_backing && (
                <MetricPill icon={<Zap className="h-3 w-3" />} label="no data" warn />
              )}
              {metrics.tool_errors > 0 && (
                <MetricPill
                  icon={<Zap className="h-3 w-3" />}
                  label={`${metrics.tool_errors}err`}
                  warn
                />
              )}

              {/* Model name */}
              <span
                className="text-[10px] text-text-quaternary ml-0.5 cursor-default"
                title={`${metrics.provider} / ${metrics.model}`}
              >
                {metrics.model.split('/').pop()?.split('-').slice(0, 2).join('-')}
              </span>
            </div>

            {/* Feedback buttons */}
            <div className="flex items-center gap-0.5 ml-auto">
              <button
                onClick={() => message.messageId && onFeedback?.(message.id, message.messageId, 'up')}
                disabled={!!feedback}
                className={`p-1 rounded transition-colors ${
                  feedback?.rating === 'up'
                    ? 'text-success bg-success/10'
                    : 'text-text-quaternary hover:text-success hover:bg-success/10 disabled:opacity-30'
                }`}
                title="Hữu ích"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => message.messageId && onFeedback?.(message.id, message.messageId, 'down')}
                disabled={!!feedback}
                className={`p-1 rounded transition-colors ${
                  feedback?.rating === 'down'
                    ? 'text-danger bg-danger/10'
                    : 'text-text-quaternary hover:text-danger hover:bg-danger/10 disabled:opacity-30'
                }`}
                title="Chưa hữu ích"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
              {message.userQuery && (
                <button
                  onClick={() => setIsCorrectModalOpen(true)}
                  className="p-1 rounded transition-colors text-text-quaternary hover:text-brand hover:bg-brand/15"
                  title="Sửa câu trả lời"
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function MetricPill({
  icon, label, good, warn, title,
}: {
  icon: React.ReactNode;
  label: string;
  good?: boolean;
  warn?: boolean;
  title?: string;
}) {
  const color = warn
    ? 'text-warning bg-warning/10 border-warning/30'
    : good
    ? 'text-success bg-success/10 border-success/30'
    : 'text-text-tertiary bg-surface-2 border-[rgb(var(--border-line))]';
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border cursor-default ${color}`}
      title={title}
    >
      {icon}{label}
    </span>
  );
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatTokens(total: number): string {
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k tok`;
  return `${total} tok`;
}
