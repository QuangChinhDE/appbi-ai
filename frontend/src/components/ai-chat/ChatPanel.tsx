'use client';

/**
 * ChatPanel — full conversation UI for a specific session.
 * Connects to AI service via WebSocket, streams events, renders messages.
 * Restores history from the AI service on mount.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft, Bot, Sparkles } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import type { ChatMessageData, ChartPayload, ToolCallBadge } from './types';

const AI_WS_URL = process.env.NEXT_PUBLIC_AI_WS_URL || 'ws://localhost:8001/chat/ws';
const AI_HTTP_URL = AI_WS_URL.replace(/^ws/, 'http').replace('/chat/ws', '');

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

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentAiMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    loadHistory();
    connectWs();
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function loadHistory() {
    try {
      const res = await fetch(`${AI_HTTP_URL}/chat/sessions/${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSessionTitle(data.title ?? 'New Conversation');
      const restored: ChatMessageData[] = (data.messages ?? []).map(
        (m: { role: string; content: string }) => ({
          id: uuidv4(),
          role: m.role as 'user' | 'assistant',
          text: m.content,
          toolCalls: [],
          charts: [],
        })
      );
      setMessages(restored);
    } catch {
      // History unavailable — ignore
    } finally {
      setHistoryLoaded(true);
    }
  }

  function connectWs() {
    wsRef.current?.close();
    setWsError(null);
    const ws = new WebSocket(AI_WS_URL);
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
        upsertCurrentAiMsg(msg => ({ ...msg, isThinking: true, thinkingContent: event.content }));
        break;

      case 'tool_call': {
        const badge: ToolCallBadge = { label: formatToolLabel(event.tool, event.args), done: false };
        upsertCurrentAiMsg(msg => ({
          ...msg, isThinking: false, thinkingContent: undefined,
          toolCalls: [...(msg.toolCalls ?? []), badge],
        }));
        break;
      }

      case 'tool_result':
        upsertCurrentAiMsg(msg => {
          const toolCalls = (msg.toolCalls ?? []).map(tc => {
            const base = formatToolLabel(event.tool, {}).split('(')[0];
            if (!tc.done && tc.label.startsWith(base)) {
              return { ...tc, label: `${tc.label} — ${event.summary}`, done: true };
            }
            return tc;
          });
          return { ...msg, toolCalls };
        });
        break;

      case 'text':
        upsertCurrentAiMsg(msg => ({
          ...msg, isThinking: false, thinkingContent: undefined,
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

      case 'done':
        setLoading(false);
        currentAiMsgIdRef.current = null;
        upsertCurrentAiMsg(msg => ({ ...msg, isThinking: false, thinkingContent: undefined }));
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
          ...msg, isThinking: false,
          text: (msg.text ?? '') + `\n\n⚠️ ${event.content}`,
        }));
        setLoading(false);
        currentAiMsgIdRef.current = null;
        break;

      default:
        break;
    }
  }

  function upsertCurrentAiMsg(updater: (prev: ChatMessageData) => ChatMessageData) {
    setMessages(prev => {
      if (!currentAiMsgIdRef.current) return prev;
      const id = currentAiMsgIdRef.current;
      const idx = prev.findIndex(m => m.id === id);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = updater(updated[idx]);
      return updated;
    });
  }

  const sendMessage = useCallback((text: string) => {
    if (!text.trim() || loading) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setWsError('WebSocket chưa kết nối. Đang thử lại...');
      connectWs();
      return;
    }
    const userMsgId = uuidv4();
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', text }]);
    const aiMsgId = uuidv4();
    currentAiMsgIdRef.current = aiMsgId;
    setMessages(prev => [...prev, {
      id: aiMsgId, role: 'assistant',
      isThinking: true, thinkingContent: '', toolCalls: [], charts: [], text: '',
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
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center flex-shrink-0">
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
      </div>

      {/* Connection error banner */}
      {wsError && (
        <div className="mx-4 mt-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between">
          <span>{wsError}</span>
          <button onClick={connectWs} className="ml-3 text-red-600 underline text-xs">Retry</button>
        </div>
      )}

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full gap-6 py-12">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-100 to-blue-100 flex items-center justify-center">
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
          <ChatMessage key={msg.id} message={msg} />
        ))}
      </div>

      {/* Input */}
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={() => sendMessage(input)}
        disabled={!wsConnected}
        loading={loading}
      />
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
  };
  const base = labels[toolName] ?? toolName;
  if (toolName === 'search_charts' && args.query) return `${base} "${args.query}"`;
  if (toolName === 'run_chart' && args.chart_id) return `${base} #${args.chart_id}`;
  if (toolName === 'search_dashboards' && args.query) return `${base} "${args.query}"`;
  return base;
}
