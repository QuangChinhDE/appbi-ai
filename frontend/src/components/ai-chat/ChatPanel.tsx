'use client';

/**
 * ChatPanel — full conversation UI.
 * Connects to AI service via WebSocket, streams events, renders messages.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Bot, RefreshCw, Sparkles } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import type { ChatMessageData, ChartPayload, ToolCallBadge } from './types';

const AI_WS_URL = process.env.NEXT_PUBLIC_AI_WS_URL || 'ws://localhost:8001/chat/ws';

const QUICK_PROMPTS = [
  'Top 10 đội có điểm FIFA cao nhất?',
  'So sánh điểm trung bình giữa các Confederation',
  'Cầu thủ ghi bàn nhiều nhất lịch sử World Cup?',
  'Tổng số bàn thắng theo từng kỳ World Cup',
  'Phân bổ các đội theo Confederation',
  'Dashboard nào liên quan đến World Cup?',
];

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // ID of the current AI reply being streamed
  const currentAiMsgIdRef = useRef<string | null>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Connect WebSocket once on mount
  useEffect(() => {
    connectWs();
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connectWs() {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setWsError(null);

    const ws = new WebSocket(AI_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => {
      setWsConnected(false);
      setLoading(false);
    };
    ws.onerror = () => {
      setWsError('Cannot connect to AI service. Make sure docker-compose.ai.yml is running.');
      setWsConnected(false);
      setLoading(false);
    };
    ws.onmessage = (e) => handleWsEvent(JSON.parse(e.data));
  }

  function handleWsEvent(event: Record<string, any>) {
    const type = event.type as string;

    switch (type) {
      case 'thinking': {
        upsertCurrentAiMsg(msg => ({
          ...msg,
          isThinking: true,
          thinkingContent: event.content,
        }));
        break;
      }

      case 'tool_call': {
        const badge: ToolCallBadge = {
          label: formatToolLabel(event.tool, event.args),
          done: false,
        };
        upsertCurrentAiMsg(msg => ({
          ...msg,
          isThinking: false,
          thinkingContent: undefined,
          toolCalls: [...(msg.toolCalls ?? []), badge],
        }));
        break;
      }

      case 'tool_result': {
        // Mark the last matching tool call as done
        upsertCurrentAiMsg(msg => {
          const toolCalls = (msg.toolCalls ?? []).map((tc, i, arr) => {
            // Mark the last non-done tool call matching this tool name
            const label = formatToolLabel(event.tool, {});
            if (!tc.done && tc.label.startsWith(label.split('(')[0])) {
              return { ...tc, label: `${tc.label} — ${event.summary}`, done: true };
            }
            return tc;
          });
          return { ...msg, toolCalls };
        });
        break;
      }

      case 'text': {
        upsertCurrentAiMsg(msg => ({
          ...msg,
          isThinking: false,
          thinkingContent: undefined,
          text: (msg.text ?? '') + event.content,
        }));
        break;
      }

      case 'chart': {
        const chart: ChartPayload = {
          chart_id: event.chart_id,
          chart_name: event.chart_name,
          chart_type: event.chart_type,
          data: event.data,
          role_config: event.role_config,
        };
        upsertCurrentAiMsg(msg => ({
          ...msg,
          charts: [...(msg.charts ?? []), chart],
        }));
        break;
      }

      case 'done': {
        setSessionId(event.session_id);
        setLoading(false);
        currentAiMsgIdRef.current = null;
        // Clean up thinking state on the last message
        upsertCurrentAiMsg(msg => ({ ...msg, isThinking: false, thinkingContent: undefined }));
        break;
      }

      case 'error': {
        upsertCurrentAiMsg(msg => ({
          ...msg,
          isThinking: false,
          text: (msg.text ?? '') + `\n\n⚠️ ${event.content}`,
        }));
        setLoading(false);
        currentAiMsgIdRef.current = null;
        break;
      }

      default:
        break;
    }
  }

  /** Update-or-insert the current AI reply in state. */
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
      setWsError('WebSocket not connected. Reconnecting...');
      connectWs();
      return;
    }

    // Add user message
    const userMsgId = uuidv4();
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', text }]);

    // Create placeholder AI reply
    const aiMsgId = uuidv4();
    currentAiMsgIdRef.current = aiMsgId;
    setMessages(prev => [...prev, {
      id: aiMsgId,
      role: 'assistant',
      isThinking: true,
      thinkingContent: '',
      toolCalls: [],
      charts: [],
      text: '',
    }]);

    setLoading(true);
    setInput('');

    wsRef.current.send(JSON.stringify({
      session_id: sessionId,
      message: text,
    }));
  }, [loading, sessionId]);

  const handleClearSession = () => {
    setMessages([]);
    setSessionId(null);
    currentAiMsgIdRef.current = null;
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-gray-900">AI Data Assistant</h1>
            <p className="text-xs text-gray-500">
              {wsConnected
                ? <span className="text-green-600">● Connected</span>
                : <span className="text-red-500">● Disconnected</span>}
              {sessionId && <span className="ml-2 text-gray-400">Session active</span>}
            </p>
          </div>
        </div>
        <button
          onClick={handleClearSession}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 px-2.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          title="New conversation"
        >
          <RefreshCw className="h-3.5 w-3.5" /> New chat
        </button>
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
        {messages.length === 0 && (
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
            {/* Quick prompts */}
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
