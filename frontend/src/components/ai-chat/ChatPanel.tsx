'use client';

/**
 * ChatPanel — full conversation UI for a specific session.
 * Connects to AI service via WebSocket, streams events, renders messages.
 * Restores history from the AI service on mount.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft, Bot, Sparkles, Share2 } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ShareDialog } from '@/components/common/ShareDialog';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getAiChatHttpUrl, getAiChatWsUrl } from '@/lib/ai-services';
import type { ActivityStep, ChatMessageData, ChartPayload, ChatSessionContext, MessageMetrics, MessageFeedback } from './types';

interface SuggestionChipsProps {
  suggestions: string[];
  onSelect: (s: string) => void;
  disabled: boolean;
}

function SuggestionChips({ suggestions, onSelect, disabled }: SuggestionChipsProps) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div className="px-4 py-2 border-t border-gray-100 bg-white/80">
      <p className="text-[10px] text-gray-400 mb-1.5">Câu hỏi tiếp theo:</p>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onSelect(s)}
            disabled={disabled}
            className="text-xs px-3 py-1.5 bg-blue-50 border border-blue-200 text-blue-700 rounded-full hover:bg-blue-100 hover:border-blue-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// Generic fallback prompts — used when no dataset is scoped or fetch fails
const GENERIC_PROMPTS = [
  'Dataset nào tôi đang có quyền truy cập?',
  'Tổng quan về dữ liệu trong hệ thống là gì?',
  'Tạo dashboard từ dữ liệu hiện có',
  'Dữ liệu có chart và báo cáo nào sẵn?',
  'Phân tích xu hướng theo thời gian',
  'Top 10 kết quả theo chỉ số quan trọng nhất',
];

interface ChatPanelProps {
  sessionId: string;
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('New Conversation');
  const [sessionContext, setSessionContext] = useState<ChatSessionContext | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [initialPrompts, setInitialPrompts] = useState<string[]>(GENERIC_PROMPTS);
  const [promptsLoading, setPromptsLoading] = useState(false);

  const { data: permData } = usePermissions();
  const canShare = hasPermission(permData?.permissions, 'ai_chat', 'edit');

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentAiMsgIdRef = useRef<string | null>(null);
  const tokenRef = useRef<string>('');

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setSuggestions([]);
    setSessionContext(null);
    setHistoryLoaded(false);

    async function init() {
      // Fetch token once — reused for loadHistory, handleFeedback, and WebSocket
      let token = '';
      try {
        const res = await fetch('/api/auth/token');
        if (res.ok) {
          const { token: t } = await res.json();
          token = t;
          tokenRef.current = t;
        }
      } catch { /* proceed without token */ }

      if (!cancelled) {
        await loadHistory(token);
        connectWs(token);
        // Fetch dataset-aware starter questions after session is loaded
        fetchInitialSuggestions(token);
      }
    }

    init();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function fetchInitialSuggestions(token?: string) {
    const t = token ?? tokenRef.current;
    setPromptsLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (t) headers['Authorization'] = `Bearer ${t}`;
      const res = await fetch(
        `${getAiChatHttpUrl()}/chat/initial-suggestions?session_id=${sessionId}`,
        { headers },
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          setInitialPrompts(data.suggestions);
        }
      }
    } catch {
      // Keep generic prompts on error
    } finally {
      setPromptsLoading(false);
    }
  }

  async function loadHistory(token?: string) {
    try {
      const headers: Record<string, string> = {};
      const t = token ?? tokenRef.current;
      if (t) headers['Authorization'] = `Bearer ${t}`;
      const res = await fetch(`${getAiChatHttpUrl()}/chat/sessions/${sessionId}`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      setSessionTitle(data.title ?? 'New Conversation');
      setSessionContext(data.context ?? null);
      const restored: ChatMessageData[] = (data.messages ?? []).map(
        (m: { role: string; content: string; message_id?: string; metrics?: MessageMetrics; feedback?: MessageFeedback; charts?: ChartPayload[]; userQuery?: string }) => ({
          id: uuidv4(),
          role: m.role as 'user' | 'assistant',
          text: m.content,
          toolCalls: [],
          charts: m.charts ?? [],
          messageId: m.message_id,
          metrics: m.metrics,
          feedback: m.feedback,
          userQuery: m.userQuery,  // restored so correction button appears
        })
      );
      setMessages(restored);
    } catch {
      // History unavailable — ignore
    } finally {
      setHistoryLoaded(true);
    }
  }

  async function connectWs(token?: string) {
    wsRef.current?.close();
    setWsError(null);

    // Use pre-fetched token if provided, otherwise fetch fresh
    let wsUrl = getAiChatWsUrl();
    const t = token ?? tokenRef.current;
    if (t) {
      wsUrl = `${getAiChatWsUrl()}?token=${encodeURIComponent(t)}`;
    } else {
      try {
        const res = await fetch('/api/auth/token');
        if (res.ok) {
          const { token: freshToken } = await res.json();
          tokenRef.current = freshToken;
          wsUrl = `${getAiChatWsUrl()}?token=${encodeURIComponent(freshToken)}`;
        }
      } catch {
        // Proceed without token — server will reject with 4001
      }
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => { setWsConnected(false); setLoading(false); };
    ws.onerror = () => {
      setWsError('Không kết nối được AI service. Kiểm tra AI service đang chạy chưa.');
      setWsConnected(false);
      setLoading(false);
    };
    ws.onmessage = (e) => handleWsEvent(JSON.parse(e.data));
  }

  function handleWsEvent(event: Record<string, any>) {
    switch (event.type as string) {
      case 'thinking':
        upsertCurrentAiMsg(msg => {
          // Mark previous running thinking steps done, then add new one
          const prev = (msg.activitySteps ?? []).map(s =>
            s.status === 'running' && s.type === 'thinking' ? { ...s, status: 'done' as const } : s
          );
          return {
            ...msg,
            isThinking: true,
            activitySteps: [...prev, {
              id: uuidv4(), type: 'thinking' as const,
              label: event.content, status: 'running' as const,
            }],
          };
        });
        break;

      case 'tool_call': {
        upsertCurrentAiMsg(msg => {
          // Mark any running thinking step done
          const prev = (msg.activitySteps ?? []).map(s =>
            s.status === 'running' && s.type === 'thinking' ? { ...s, status: 'done' as const } : s
          );
          return {
            ...msg,
            isThinking: true,
            activitySteps: [...prev, {
              id: uuidv4(), type: 'tool' as const,
              label: formatToolLabel(event.tool, event.args),
              status: 'running' as const,
            }],
          };
        });
        break;
      }

      case 'tool_result':
        upsertCurrentAiMsg(msg => {
          // Update the last running tool step with the result summary
          let updated = false;
          const steps = (msg.activitySteps ?? []).map(s => {
            if (!updated && s.status === 'running' && s.type === 'tool') {
              updated = true;
              return { ...s, detail: event.summary, status: 'done' as const };
            }
            return s;
          });
          return { ...msg, activitySteps: steps };
        });
        break;

      case 'text':
        upsertCurrentAiMsg(msg => ({
          ...msg,
          isThinking: false,
          text: (msg.text ?? '') + event.content,
        }));
        break;

      case 'chart': {
        const chart: ChartPayload = {
          chart_id: event.chart_id, chart_name: event.chart_name,
          chart_type: event.chart_type, data: event.data, role_config: event.role_config,
        };
        upsertCurrentAiMsg(msg => ({ ...msg, charts: [...(msg.charts ?? []), chart] }));
        break;
      }

      case 'suggestions':
        if (Array.isArray(event.suggestions) && event.suggestions.length > 0) {
          setSuggestions(event.suggestions);
        }
        break;

      case 'metrics':
        upsertCurrentAiMsg(msg => ({
          ...msg,
          messageId: event.message_id,
          metrics: event as MessageMetrics,
        }));
        break;

      case 'done':
        setLoading(false);
        upsertCurrentAiMsg(msg => {
          const cleanText = (msg.text ?? '').replace(/\[CHART:\d+\]/g, '').trim();
          const toolErrors = msg.metrics?.tool_errors ?? 0;
          // If AI finished but produced no text — show a clear fallback so the
          // user is never left staring at an empty bubble.
          const fallback = !cleanText
            ? (toolErrors > 0
                ? '⚠️ AI không thể hoàn thành yêu cầu (có lỗi trong quá trình lấy dữ liệu). Vui lòng tải lại trang và thử lại.'
                : '_(AI không có phản hồi. Vui lòng thử diễn đạt câu hỏi theo cách khác.)_')
            : undefined;
          return {
            ...msg,
            isThinking: false,
            text: fallback ?? msg.text,
            activitySteps: (msg.activitySteps ?? []).map(s => ({ ...s, status: 'done' as const })),
          };
        });
        currentAiMsgIdRef.current = null;
        setMessages(prev => {
          const first = prev.find(m => m.role === 'user');
          if (first?.text && sessionTitle === 'New Conversation') {
            setSessionTitle(first.text.slice(0, 60) + (first.text.length > 60 ? '…' : ''));
          }
          return prev;
        });
        break;

      case 'error':
        upsertCurrentAiMsg(msg => ({
          ...msg,
          isThinking: false,
          text: (msg.text ?? '') + `\n\n⚠️ ${event.content}`,
          activitySteps: (msg.activitySteps ?? []).map(s => ({ ...s, status: 'done' as const })),
        }));
        setLoading(false);
        currentAiMsgIdRef.current = null;
        break;

      default:
        break;
    }
  }

  function upsertCurrentAiMsg(updater: (prev: ChatMessageData) => ChatMessageData) {
    const id = currentAiMsgIdRef.current;
    if (!id) return;
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === id);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = updater(updated[idx]);
      return updated;
    });
  }

  const sendStop = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
    setLoading(false);
    upsertCurrentAiMsg(msg => ({
      ...msg,
      isThinking: false,
      activitySteps: (msg.activitySteps ?? []).map(s => ({ ...s, status: 'done' as const })),
      text: (msg.text ?? '').trim() || '_(đã dừng)_',
    }));
    currentAiMsgIdRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFeedback = useCallback(async (msgId: string, messageId: string, rating: 'up' | 'down') => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
      const res = await fetch(
        `${getAiChatHttpUrl()}/chat/sessions/${sessionId}/messages/${messageId}/feedback`,
        { method: 'POST', headers, body: JSON.stringify({ rating }) },
      );
      if (res.ok) {
        setMessages(prev => prev.map(m =>
          m.id === msgId ? { ...m, feedback: { rating } } : m
        ));
      }
    } catch {
      // ignore
    }
  }, [sessionId]);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim() || loading) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setWsError('WebSocket chưa kết nối. Đang thử lại...');
      connectWs();
      return;
    }
    setSuggestions([]); // clear previous suggestions
    const userMsgId = uuidv4();
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', text }]);
    const aiMsgId = uuidv4();
    currentAiMsgIdRef.current = aiMsgId;
    setMessages(prev => [...prev, {
      id: aiMsgId, role: 'assistant',
      isThinking: true, activitySteps: [], charts: [], text: '',
      userQuery: text,  // remember the user's question for the FeedbackModal
    }]);
    setLoading(true);
    setInput('');
    wsRef.current.send(JSON.stringify({ session_id: sessionId, message: text }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, sessionId]);

  const isEmpty = historyLoaded && messages.length === 0;
  const datasetLabel = sessionContext?.dataset_id
    ? sessionContext.dataset_name?.trim() || `Dataset #${sessionContext.dataset_id}`
    : null;
  const isLegacySession = historyLoaded && sessionContext !== null && !sessionContext?.dataset_id;

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200">
        <button
          onClick={() => router.push('/chat')}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
          title="Back to conversations"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-gray-900 truncate">{sessionTitle}</h1>
          <p className="text-xs flex items-center gap-1.5">
            {loading ? (
              <span className="text-blue-500 flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                Đang phân tích…
              </span>
            ) : wsConnected ? (
              <span className="text-green-600 flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                Sẵn sàng
              </span>
            ) : (
              <span className="text-red-500 flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400" />
                Mất kết nối
              </span>
            )}
          </p>
        </div>
        {canShare && (
          <button
            onClick={() => setIsShareOpen(true)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
            title="Chia sẻ cuộc hội thoại"
          >
            <Share2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Connection error banner */}
      {wsError && (
        <div className="mx-4 mt-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between">
          <span>{wsError}</span>
          <button onClick={() => connectWs()} className="ml-3 text-red-600 underline text-xs">Retry</button>
        </div>
      )}

      {datasetLabel && (
        <div className="mx-4 mt-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800">
          Phiên chat này đang được khóa trong <strong>{datasetLabel}</strong>. AI sẽ chỉ tìm chart, dashboard và dữ liệu trong dataset này.
        </div>
      )}

      {isLegacySession && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Phiên chat này chưa được khóa theo dataset. Để AI trả lời ổn định hơn, hãy tạo conversation mới và chọn dataset ngay từ đầu.
        </div>
      )}

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full gap-5 py-10">
            {/* Avatar */}
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-md">
              <Bot className="h-8 w-8 text-white" />
            </div>

            {/* Greeting */}
            <div className="text-center">
              <h2 className="text-lg font-semibold text-gray-800 mb-1">
                {datasetLabel
                  ? `Phân tích ${datasetLabel}`
                  : 'Xin chào! Tôi là AI Data Assistant'}
              </h2>
              <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
                {datasetLabel
                  ? `Hỏi tôi về dữ liệu trong dataset này — tra cứu số liệu, khám phá xu hướng, phân tích nguyên nhân hoặc tạo biểu đồ.`
                  : 'Hỏi tôi về dữ liệu trong hệ thống — tôi sẽ tìm chart phù hợp, chạy query và phân tích kết quả cho bạn.'}
              </p>
            </div>

            {/* Capability badges */}
            <div className="flex flex-wrap gap-2 justify-center">
              {[
                { icon: '🔍', label: 'Tra cứu số liệu' },
                { icon: '🔬', label: 'Khám phá dữ liệu' },
                { icon: '💡', label: 'Phân tích sâu' },
                { icon: '🎨', label: 'Tạo biểu đồ' },
              ].map(cap => (
                <span key={cap.label} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-50 border border-gray-200 rounded-full text-xs text-gray-600">
                  <span>{cap.icon}</span>{cap.label}
                </span>
              ))}
            </div>

            {/* Dynamic starter questions */}
            <div className="w-full max-w-xl">
              <p className="text-xs text-gray-400 text-center mb-2">
                {promptsLoading ? 'Đang tải gợi ý…' : 'Gợi ý câu hỏi:'}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {initialPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    disabled={!wsConnected || loading || promptsLoading}
                    className="text-left px-3.5 py-2.5 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50/60 transition-all disabled:opacity-40 disabled:cursor-not-allowed group"
                  >
                    <span className="group-hover:text-blue-700 transition-colors">{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map(msg => (
          <ChatMessage key={msg.id} message={msg} sessionId={sessionId} onFeedback={handleFeedback} />
        ))}
      </div>

      {/* Suggestion chips (appear after AI response) */}
      {!loading && suggestions.length > 0 && (
        <SuggestionChips
          suggestions={suggestions}
          onSelect={(s) => sendMessage(s)}
          disabled={!wsConnected || loading}
        />
      )}

      {/* Input */}
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={() => sendMessage(input)}
        onStop={sendStop}
        disabled={!wsConnected}
        loading={loading}
      />

      {isShareOpen && (
        <ShareDialog
          resourceType="chat_session"
          resourceId={sessionId}
          resourceName={sessionTitle}
          onClose={() => setIsShareOpen(false)}
        />
      )}
    </div>
  );
}

function formatToolLabel(toolName: string, args: Record<string, any>): string {
  const labels: Record<string, string> = {
    search_charts: '🔍 Tìm charts',
    run_chart: '▶ Chạy chart',
    search_dashboards: '🔍 Tìm dashboard',
    list_dataset_tables: '📋 Liệt kê bảng',
    run_dataset_table: '▶ Lấy dữ liệu bảng',
    query_table: '⚡ Truy vấn bảng',
    execute_sql: '🗄 Thực thi SQL',
    create_chart: '📊 Tạo biểu đồ',
    explore_data: '🔬 Khám phá dữ liệu',
    explain_insight: '💡 Phân tích chuyên sâu',
    create_dashboard: '🚀 Tạo dashboard',
    query_dataset: '📂 Truy vấn dataset',
  };
  const base = labels[toolName] ?? toolName;
  if (toolName === 'search_charts' && args.query) return `${base} "${args.query}"`;
  if (toolName === 'run_chart' && args.chart_id) return `${base} #${args.chart_id}`;
  if (toolName === 'search_dashboards' && args.query) return `${base} "${args.query}"`;
  if (toolName === 'create_chart' && args.name) return `${base}: "${args.name}"`;
  if (toolName === 'explore_data') return `${base} (${args.analysis_type || 'overview'})`;
  if (toolName === 'explain_insight' && args.metric_column) return `${base}: ${args.metric_column}`;
  if (toolName === 'create_dashboard' && args.topic) return `${base}: "${args.topic}"`;
  return base;
}
