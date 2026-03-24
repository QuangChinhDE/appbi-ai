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
import { AI_CHAT_HTTP_URL, AI_CHAT_WS_URL } from '@/lib/ai-services';
import type { ActivityStep, ChatMessageData, ChartPayload, MessageMetrics, MessageFeedback } from './types';

interface SuggestionChipsProps {
  suggestions: string[];
  onSelect: (s: string) => void;
  disabled: boolean;
}

function SuggestionChips({ suggestions, onSelect, disabled }: SuggestionChipsProps) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 py-2">
      {suggestions.map((s, i) => (
        <button
          key={i}
          onClick={() => onSelect(s)}
          disabled={disabled}
          className="text-xs px-3 py-1.5 bg-blue-50 border border-blue-200 text-blue-700 rounded-full hover:bg-blue-100 hover:border-blue-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

const QUICK_PROMPTS = [
  'Top 10 đội có điểm FIFA cao nhất?',
  'So sánh điểm trung bình giữa các Confederation',
  'Cầu thủ ghi bàn nhiều nhất lịch sử World Cup?',
  'Tổng số bàn thắng theo từng kỳ World Cup',
  'Phân bổ các đội theo Confederation',
  'Dashboard nào liên quan đến World Cup?',
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
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

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
      }
    }

    init();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function loadHistory(token?: string) {
    try {
      const headers: Record<string, string> = {};
      const t = token ?? tokenRef.current;
      if (t) headers['Authorization'] = `Bearer ${t}`;
      const res = await fetch(`${AI_CHAT_HTTP_URL}/chat/sessions/${sessionId}`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      setSessionTitle(data.title ?? 'New Conversation');
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
    let wsUrl = AI_CHAT_WS_URL;
    const t = token ?? tokenRef.current;
    if (t) {
      wsUrl = `${AI_CHAT_WS_URL}?token=${encodeURIComponent(t)}`;
    } else {
      try {
        const res = await fetch('/api/auth/token');
        if (res.ok) {
          const { token: freshToken } = await res.json();
          tokenRef.current = freshToken;
          wsUrl = `${AI_CHAT_WS_URL}?token=${encodeURIComponent(freshToken)}`;
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
        upsertCurrentAiMsg(msg => ({
          ...msg,
          isThinking: false,
          activitySteps: (msg.activitySteps ?? []).map(s => ({ ...s, status: 'done' as const })),
        }));
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
        `${AI_CHAT_HTTP_URL}/chat/sessions/${sessionId}/messages/${messageId}/feedback`,
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
          <p className="text-xs">
            {wsConnected
              ? <span className="text-green-600">● Connected</span>
              : <span className="text-red-500">● Disconnected</span>}
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

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full gap-6 py-12">
            <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center">
              <Bot className="h-8 w-8 text-blue-500" />
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-gray-800 mb-1">Xin chào! Tôi là AI Data Assistant</h2>
              <p className="text-sm text-gray-500 max-w-sm">
                Hỏi tôi về dữ liệu trong hệ thống — tôi sẽ tìm chart phù hợp, chạy query và phân tích kết quả cho bạn.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => sendMessage(prompt)}
                  disabled={!wsConnected || loading}
                  className="text-left px-3.5 py-2.5 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {prompt}
                </button>
              ))}
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
    list_workspace_tables: '📋 Liệt kê bảng',
    run_workspace_table: '▶ Lấy dữ liệu bảng',
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
