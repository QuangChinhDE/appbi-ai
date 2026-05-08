'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, X, Send, Loader2, ChevronDown, Key, ExternalLink, AlertTriangle, CheckCircle2, Sparkles, ListChecks, BarChart3, Calculator, GitCompareArrows, Search } from 'lucide-react';
import {
  fetchAiRecon,
  streamAiAgentChat,
  type AiAgentEvent,
  type AiChatMessage,
  type AiProvider,
  type AiRecon,
} from '@/lib/api/public';

// ── Constants ────────────────────────────────────────────────────────────────

const PROVIDERS: { value: AiProvider; label: string; keyLink: string; placeholder: string }[] = [
  {
    value: 'gemini',
    label: 'Google Gemini',
    keyLink: 'https://aistudio.google.com/app/apikey',
    placeholder: 'AIza...',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Claude',
    keyLink: 'https://console.anthropic.com/settings/keys',
    placeholder: 'sk-ant-...',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    keyLink: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-...',
  },
];

// Curated model list per provider. The first entry is the default (strongest
// general-purpose model commonly available to BYOK users as of 2025-2026).
const MODEL_OPTIONS: Record<AiProvider, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (mạnh nhất)' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini (rẻ, nhanh)' },
    { value: 'o3-mini', label: 'o3-mini (reasoning)' },
  ],
  anthropic: [
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (mạnh nhất)' },
    { value: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (rẻ, nhanh)' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
  ],
  gemini: [
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (mạnh nhất)' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (rẻ, nhanh)' },
  ],
};

const DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: MODEL_OPTIONS.openai[0].value,
  anthropic: MODEL_OPTIONS.anthropic[0].value,
  gemini: MODEL_OPTIONS.gemini[0].value,
};

// ── Storage helpers ───────────────────────────────────────────────────────────
// API key is intentionally NOT persisted anywhere — it lives only in React
// state and disappears the moment the panel is closed or the page reloads.
// Provider and model preference (non-secret) are remembered per tab.

function getStoredProvider(token: string): AiProvider {
  try {
    const v = sessionStorage.getItem(`dash_ai_provider_${token}`);
    if (v === 'anthropic' || v === 'openai' || v === 'gemini') return v;
  } catch { /* ignore */ }
  return 'openai';
}
function setStoredProvider(token: string, provider: AiProvider): void {
  try { sessionStorage.setItem(`dash_ai_provider_${token}`, provider); } catch { /* ignore */ }
}
function getStoredModel(token: string, provider: AiProvider): string {
  try {
    const stored = sessionStorage.getItem(`dash_ai_model_${token}_${provider}`);
    if (stored && MODEL_OPTIONS[provider].some((m) => m.value === stored)) return stored;
  } catch { /* ignore */ }
  return DEFAULT_MODELS[provider];
}
function setStoredModel(token: string, provider: AiProvider, model: string): void {
  try { sessionStorage.setItem(`dash_ai_model_${token}_${provider}`, model); } catch { /* ignore */ }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage extends AiChatMessage {
  /** Tool status notes accumulated while this assistant message was streaming. */
  statusLog?: { tool: string; text: string; ok?: boolean; error?: string | null }[];
}

interface Props {
  token: string;
  sessionToken?: string | null;
  dashboardName: string;
}

// ── BotIcon ───────────────────────────────────────────────────────────────────

function BotIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <line x1="12" y1="2" x2="12" y2="5" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="2" r="1.1" fill="white" />
      <rect x="3" y="5" width="18" height="13" rx="4" fill="white" fillOpacity="0.95" />
      <circle cx="8.5" cy="11" r="1.6" fill="#06b6d4" />
      <circle cx="15.5" cy="11" r="1.6" fill="#06b6d4" />
      <path d="M9 14.5 Q12 16.5 15 14.5" stroke="#3b82f6" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <rect x="1" y="9" width="2" height="4" rx="1" fill="white" fillOpacity="0.85" />
      <rect x="21" y="9" width="2" height="4" rx="1" fill="white" fillOpacity="0.85" />
    </svg>
  );
}

// ── Welcome message builder ───────────────────────────────────────────────────

function buildWelcomeMessage(recon: AiRecon, dashboardName: string): string {
  const charts = recon.manifest.charts || [];
  const summaries = recon.summaries || [];
  if (charts.length === 0) {
    return `Xin chào! Tôi là AI Analyst của dashboard **${dashboardName}**. Hiện chưa có biểu đồ nào để phân tích.`;
  }

  const lines: string[] = [];
  lines.push(`Xin chào! Tôi đã xem qua dashboard **${dashboardName}** (${charts.length} biểu đồ).`);

  const notable = summaries
    .map((pack) => {
      if (pack.trend && pack.trend.direction !== 'flat' && pack.trend.pct_change !== null) {
        const arrow = pack.trend.direction === 'up' ? '↑' : '↓';
        const pct = Math.abs(pack.trend.pct_change).toFixed(1);
        return `- ${arrow} **${pack.chart_name}**: ${pack.primary_measure ?? 'số liệu'} ${arrow === '↑' ? 'tăng' : 'giảm'} ${pct}% (${pack.trend.first.x} → ${pack.trend.last.x}) [chart:${pack.chart_id}]`;
      }
      if (pack.outliers && pack.outliers.length > 0) {
        return `- ⚠️ **${pack.chart_name}**: phát hiện ${pack.outliers.length} điểm bất thường [chart:${pack.chart_id}]`;
      }
      if (pack.top_5 && pack.top_5.length > 0 && pack.primary_measure && pack.primary_dimension) {
        const top = pack.top_5[0];
        const dimVal = top[pack.primary_dimension];
        return `- **${pack.chart_name}**: ${pack.primary_dimension} dẫn đầu là *${dimVal}* [chart:${pack.chart_id}]`;
      }
      return null;
    })
    .filter((s): s is string => !!s);

  if (notable.length > 0) {
    lines.push('');
    lines.push('**Một vài điểm đáng chú ý:**');
    lines.push(...notable.slice(0, 3));
  }

  lines.push('');
  lines.push('Bạn có thể hỏi tôi sâu hơn về bất kỳ biểu đồ nào.');
  return lines.join('\n');
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DashboardAiBot({ token, sessionToken, dashboardName }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<'key' | 'chat'>('key');
  const [provider, setProvider] = useState<AiProvider>(() => getStoredProvider(token));
  const [modelId, setModelId] = useState(() => getStoredModel(token, getStoredProvider(token)));
  // API key kept only in component memory — never written to storage.
  const [apiKey, setApiKey] = useState('');
  const [keyError, setKeyError] = useState('');

  const [recon, setRecon] = useState<AiRecon | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState('');

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeStatus, setActiveStatus] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<boolean>(false);

  // ── Recon load ───────────────────────────────────────────────────────────

  const loadRecon = useCallback(async () => {
    if (recon) return;
    setReconLoading(true);
    setReconError('');
    try {
      const r = await fetchAiRecon(token, sessionToken ?? undefined);
      setRecon(r);
      setMessages([{
        role: 'assistant',
        content: buildWelcomeMessage(r, dashboardName),
      }]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Không thể tải dữ liệu dashboard.';
      setReconError(msg);
    } finally {
      setReconLoading(false);
    }
  }, [dashboardName, recon, sessionToken, token]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    const storedProvider = getStoredProvider(token);
    setProvider(storedProvider);
    setModelId(getStoredModel(token, storedProvider));
    // Always require key entry on open. Key stays in memory only and we
    // never restore it from storage so it can never leak across sessions.
    setView(apiKey ? 'chat' : 'key');
  }, [apiKey, token]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen, activeStatus]);

  const handleStartChat = useCallback(() => {
    const trimmed = apiKey.trim();
    const chosenModel = modelId || DEFAULT_MODELS[provider];
    if (!trimmed) {
      setKeyError('Vui lòng nhập API key.');
      return;
    }
    setKeyError('');
    setApiKey(trimmed);
    setStoredProvider(token, provider);
    setStoredModel(token, provider, chosenModel);
    setModelId(chosenModel);
    setView('chat');
    loadRecon();
  }, [apiKey, loadRecon, modelId, provider, token]);

  const handleProviderChange = useCallback((nextProvider: AiProvider) => {
    setProvider(nextProvider);
    setStoredProvider(token, nextProvider);
    setModelId(getStoredModel(token, nextProvider));
  }, [token]);

  const handleModelChange = useCallback((nextModel: string) => {
    setModelId(nextModel);
    setStoredModel(token, provider, nextModel);
  }, [provider, token]);

  // ── Send a chat turn ──────────────────────────────────────────────────────

  const handleSend = useCallback(async (override?: string) => {
    const text = (override ?? inputText).trim();
    if (!text || isStreaming) return;

    const userMsg: ChatMessage = { role: 'user', content: text };
    // Build wire history: only role+content (no statusLog)
    const wireHistory: AiChatMessage[] = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', statusLog: [] }]);
    setInputText('');
    setIsStreaming(true);
    setActiveStatus('');
    abortRef.current = false;

    try {
      let answerSoFar = '';
      const gen = streamAiAgentChat(
        token,
        wireHistory,
        apiKey,
        provider,
        modelId.trim() || DEFAULT_MODELS[provider],
        sessionToken ?? undefined,
      );
      for await (const ev of gen) {
        if (abortRef.current) break;
        applyEvent(ev, {
          appendText: (chunk) => {
            answerSoFar += chunk;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: answerSoFar };
              }
              return next;
            });
          },
          setStatus: (s) => setActiveStatus(s),
          appendStatusLog: (entry) => {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                const log = [...(last.statusLog ?? []), entry];
                next[next.length - 1] = { ...last, statusLog: log };
              }
              return next;
            });
          },
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định.';
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { ...last, content: `[Lỗi: ${msg}]` };
        }
        return next;
      });
    } finally {
      setIsStreaming(false);
      setActiveStatus('');
    }
  }, [apiKey, inputText, isStreaming, messages, modelId, provider, sessionToken, token]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handlePickSuggestion = useCallback((q: string) => {
    if (isStreaming) return;
    handleSend(q);
  }, [handleSend, isStreaming]);

  const handleChangeKey = useCallback(() => {
    abortRef.current = true;
    setApiKey('');
    setMessages([]);
    setRecon(null);
    setView('key');
  }, []);

  // ── Render: closed state ───────────────────────────────────────────────────

  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className="fixed bottom-5 right-5 z-50 flex h-11 w-11 items-center justify-center rounded-full shadow-lg transition-all hover:scale-105 active:scale-95"
        style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)', boxShadow: '0 4px 16px rgba(6,182,212,0.45)' }}
        title="Hỏi AI về dashboard này"
        aria-label="Mở AI Assistant"
      >
        <BotIcon />
      </button>
    );
  }

  return (
    <div className="flex w-[380px] min-w-[260px] flex-shrink-0 flex-col border-l border-[rgb(var(--border-line))] bg-surface-1">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-brand" />
          <span className="text-caption font-strong text-text-primary">AI Analyst</span>
          {view === 'chat' && (
            <span className="text-micro text-text-tertiary">{dashboardName}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {view === 'chat' && (
            <button
              onClick={handleChangeKey}
              className="flex items-center gap-1 rounded px-2 py-1 text-micro text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary"
              title="Thay đổi API key"
            >
              <Key className="h-3 w-3" />
              <span>Đổi key</span>
            </button>
          )}
          <button
            onClick={() => setIsOpen(false)}
            className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary"
            aria-label="Đóng"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {view === 'key' ? (
        <KeyInputView
          provider={provider}
          modelId={modelId}
          apiKey={apiKey}
          keyError={keyError}
          onProviderChange={handleProviderChange}
          onModelChange={handleModelChange}
          onApiKeyChange={setApiKey}
          onSubmit={handleStartChat}
        />
      ) : (
        <ChatView
          messages={messages}
          reconLoading={reconLoading}
          reconError={reconError}
          inputText={inputText}
          isStreaming={isStreaming}
          activeStatus={activeStatus}
          messagesEndRef={messagesEndRef}
          inputRef={inputRef}
          onInputChange={setInputText}
          onKeyDown={handleKeyDown}
          onSend={handleSend}
          onPickSuggestion={handlePickSuggestion}
        />
      )}
    </div>
  );
}

// ── Event dispatch ───────────────────────────────────────────────────────────

function applyEvent(
  ev: AiAgentEvent,
  ops: {
    appendText: (chunk: string) => void;
    setStatus: (s: string) => void;
    appendStatusLog: (entry: { tool: string; text: string; ok?: boolean; error?: string | null }) => void;
  },
) {
  if (ev.type === 'text') {
    ops.appendText(ev.text);
    return;
  }
  if (ev.type === 'status') {
    ops.setStatus(ev.text);
    // Internal "thinking" pings drive the live indicator only — don't pollute
    // the permanent per-message tool log.
    if (ev.tool && ev.tool !== '_thinking') {
      ops.appendStatusLog({ tool: ev.tool, text: ev.text });
    }
    return;
  }
  if (ev.type === 'tool_result') {
    ops.appendStatusLog({ tool: ev.tool, text: '', ok: ev.ok, error: ev.error ?? null });
    return;
  }
  if (ev.type === 'error') {
    ops.appendText(`\n\n_⚠️ ${ev.text}_`);
  }
}

// ── KeyInputView ──────────────────────────────────────────────────────────────

function KeyInputView({
  provider,
  modelId,
  apiKey,
  keyError,
  onProviderChange,
  onModelChange,
  onApiKeyChange,
  onSubmit,
}: {
  provider: AiProvider;
  modelId: string;
  apiKey: string;
  keyError: string;
  onProviderChange: (p: AiProvider) => void;
  onModelChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const selectedProvider = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-label text-text-secondary">
        Nhập API key để bắt đầu chat. Key chỉ tồn tại trong bộ nhớ trang đang mở: không lưu vào trình duyệt và không gửi về server của chúng tôi. Reload hoặc đóng panel sẽ xóa key, bạn cần nhập lại.
      </p>
      <div>
        <label className="mb-1.5 block text-micro font-strong text-text-secondary">
          Nhà cung cấp AI
        </label>
        <div className="relative">
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as AiProvider)}
            className="w-full appearance-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 py-1.5 pl-3 pr-8 text-caption text-text-primary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
        </div>
      </div>
      <div>
        <label className="mb-1.5 block text-micro font-strong text-text-secondary">Model</label>
        <div className="relative">
          <select
            value={modelId}
            onChange={(e) => onModelChange(e.target.value)}
            className="w-full appearance-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 py-1.5 pl-3 pr-8 text-caption text-text-primary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          >
            {MODEL_OPTIONS[provider].map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
        </div>
        <p className="mt-1 text-micro text-text-quaternary">
          Mặc định là model mạnh nhất. Đổi sang bản nhẹ hơn nếu key của bạn chưa được cấp quyền.
        </p>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-micro font-strong text-text-secondary">API Key</label>
          <a
            href={selectedProvider.keyLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-micro text-brand hover:underline"
          >
            Lấy key miễn phí
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          placeholder={selectedProvider.placeholder}
          className="w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-caption text-text-primary placeholder:text-text-quaternary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          autoFocus
        />
        {keyError && <p className="mt-1 text-tiny text-danger">{keyError}</p>}
      </div>
      <button
        onClick={onSubmit}
        disabled={!apiKey.trim()}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-caption font-strong text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Bot className="h-4 w-4" />
        Bắt đầu chat
      </button>
      <p className="text-center text-micro text-text-quaternary">
        API key chỉ nằm trong bộ nhớ tạm của trang này. Reload trang sẽ xóa.
      </p>
    </div>
  );
}

// ── ChatView ──────────────────────────────────────────────────────────────────

function ChatView({
  messages,
  reconLoading,
  reconError,
  inputText,
  isStreaming,
  activeStatus,
  messagesEndRef,
  inputRef,
  onInputChange,
  onKeyDown,
  onSend,
  onPickSuggestion,
}: {
  messages: ChatMessage[];
  reconLoading: boolean;
  reconError: string;
  inputText: string;
  isStreaming: boolean;
  activeStatus: string;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  onInputChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onPickSuggestion: (q: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {reconLoading && (
          <div className="flex items-center gap-2 text-label text-text-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Đang quét nhanh dashboard...
          </div>
        )}
        {reconError && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-micro text-danger">
            {reconError}
          </div>
        )}
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          const showThinking =
            isStreaming &&
            isLast &&
            msg.role === 'assistant' &&
            !msg.content;
          return (
            <React.Fragment key={i}>
              {!(showThinking && !msg.content) && (
                <MessageBubble
                  message={msg}
                  streaming={showThinking}
                  disabled={isStreaming}
                  onPickSuggestion={onPickSuggestion}
                />
              )}
              {showThinking && (
                <ThinkingBubble status={activeStatus} log={msg.statusLog ?? []} />
              )}
            </React.Fragment>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      <div className="border-t border-[rgb(var(--border-line))] p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Hỏi về số liệu hoặc xu hướng... (Enter để gửi)"
            rows={1}
            className="min-h-[32px] flex-1 resize-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-caption text-text-primary placeholder:text-text-quaternary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            style={{ maxHeight: 100 }}
            disabled={reconLoading || !!reconError}
          />
          <button
            onClick={onSend}
            disabled={!inputText.trim() || isStreaming || reconLoading || !!reconError}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Gửi"
          >
            {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-1 text-micro text-text-quaternary">Shift+Enter để xuống dòng</p>
      </div>
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  streaming = false,
  disabled = false,
  onPickSuggestion,
}: {
  message: ChatMessage;
  streaming?: boolean;
  disabled?: boolean;
  onPickSuggestion?: (q: string) => void;
}) {
  const isUser = message.role === 'user';
  // Strip [FOLLOWUP] lines from the body so they render as chips, not text.
  // While the message is still streaming, hold the chips back — the markers
  // may still be partial tokens.
  const { body, suggestions } = useMemo(
    () => (isUser || streaming ? { body: message.content, suggestions: [] } : extractFollowups(message.content)),
    [message.content, isUser, streaming],
  );
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-caption leading-relaxed ${
          isUser
            ? 'bg-brand text-white'
            : 'border border-[rgb(var(--border-line))] bg-surface-2 text-text-primary'
        }`}
      >
        {!isUser && message.statusLog && message.statusLog.length > 0 && (
          <StatusLog log={message.statusLog} />
        )}
        <RichMarkdown text={body} />
        {!isUser && suggestions.length > 0 && onPickSuggestion && (
          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-[rgb(var(--border-line))]/40 pt-2">
            {suggestions.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onPickSuggestion(q)}
                disabled={disabled}
                className="rounded-full border border-brand/40 bg-brand/10 px-2.5 py-1 text-tiny text-brand transition-colors hover:bg-brand/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Extract `[FOLLOWUP] ...?` lines from assistant content. Returns the
// remaining body (with the markers removed) plus the list of suggestion
// questions in original order.
function extractFollowups(text: string): { body: string; suggestions: string[] } {
  if (!text) return { body: '', suggestions: [] };
  const suggestions: string[] = [];
  const bodyLines: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\[FOLLOWUP\]\s*(.+?)\s*$/i.exec(line);
    if (m && m[1]) {
      const q = m[1].trim();
      if (q && suggestions.length < 5) suggestions.push(q);
      continue;
    }
    bodyLines.push(line);
  }

  // Fallback: model forgot the marker. Pull trailing standalone question
  // lines (max 5) — only if explicit markers gave us nothing.
  if (suggestions.length === 0) {
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
      bodyLines.pop();
    }
    const tail: string[] = [];
    while (bodyLines.length && tail.length < 5) {
      const candidate = bodyLines[bodyLines.length - 1].trim();
      // Strip leading bullet / number markers the model may have prepended.
      const cleaned = candidate.replace(/^[-*\u2022\d.\)\s]+/, '').trim();
      const isQuestion = cleaned.length > 0
        && cleaned.length <= 160
        && cleaned.endsWith('?')
        // Reject lines that look like a real bullet of the analysis (have a
        // leading "-" before stripping → that was a body bullet, not a
        // standalone follow-up).
        && !/^[-*\u2022]/.test(candidate);
      if (!isQuestion) break;
      tail.unshift(cleaned);
      bodyLines.pop();
      // Eat blank separator lines too
      while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
        bodyLines.pop();
      }
    }
    // Need at least 2 trailing questions to be confident this is a follow-up
    // block and not a single rhetorical question in the body.
    if (tail.length >= 2) suggestions.push(...tail);
    else if (tail.length === 1) {
      // Put it back — single rhetorical question stays in body.
      bodyLines.push('', tail[0]);
    }
  }

  // Trim trailing blank lines left behind after stripping markers
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }
  return { body: bodyLines.join('\n'), suggestions };
}

function StatusLog({
  log,
}: {
  log: NonNullable<ChatMessage['statusLog']>;
}) {
  // Collapse to one line per tool, showing OK/error after the run completes
  const visible = log.filter((l) => l.text || l.error);
  if (visible.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-col gap-0.5 border-b border-[rgb(var(--border-line))]/40 pb-1.5 text-tiny text-text-tertiary">
      {visible.map((entry, i) => (
        <div key={i} className="flex items-start gap-1.5">
          {entry.ok === false ? (
            <AlertTriangle className="h-3 w-3 flex-shrink-0 text-warning" />
          ) : entry.ok === true ? (
            <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-success" />
          ) : (
            <Loader2 className="h-3 w-3 flex-shrink-0" />
          )}
          <span className="italic">
            {entry.text || (entry.error ? `${entry.tool}: ${entry.error}` : entry.tool)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── ThinkingBubble ───────────────────────────────────────────────────────────
//
// Renders an in-flight assistant bubble while the bot is working — shows the
// running tool log + a live "thinking" line so the user always has visible
// feedback even between provider deltas.

function toolIcon(tool: string | undefined): React.ReactNode {
  switch (tool) {
    case 'list_charts':
      return <ListChecks className="h-3.5 w-3.5" />;
    case 'get_chart_summary':
      return <BarChart3 className="h-3.5 w-3.5" />;
    case 'get_chart_data':
      return <Search className="h-3.5 w-3.5" />;
    case 'compare_segments':
      return <GitCompareArrows className="h-3.5 w-3.5" />;
    case 'compute':
      return <Calculator className="h-3.5 w-3.5" />;
    default:
      return <Sparkles className="h-3.5 w-3.5" />;
  }
}

function ThinkingBubble({
  status,
  log,
}: {
  status: string;
  log: NonNullable<ChatMessage['statusLog']>;
}) {
  const liveText = (status && status.trim()) || 'Đang suy nghĩ…';
  const visible = log.filter((l) => l.text || l.error);
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%] rounded-xl border border-brand/30 bg-brand/5 px-3 py-2 text-caption shadow-sm">
        <div className="mb-1.5 flex items-center gap-1.5 text-tiny font-strong text-brand">
          <Sparkles className="h-3.5 w-3.5 animate-pulse" />
          <span>AI Analyst đang phân tích</span>
        </div>
        {visible.length > 0 && (
          <div className="mb-1.5 flex flex-col gap-1 border-y border-brand/15 py-1.5 text-tiny text-text-secondary">
            {visible.map((entry, i) => {
              const isLast = i === visible.length - 1;
              const stillRunning = isLast && entry.ok === undefined;
              return (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="mt-[1px] flex-shrink-0 text-text-tertiary">
                    {entry.ok === false ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                    ) : entry.ok === true ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    ) : stillRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
                    ) : (
                      toolIcon(entry.tool)
                    )}
                  </span>
                  <span className={stillRunning ? 'italic text-text-primary' : 'text-text-secondary'}>
                    {entry.text || (entry.error ? `${entry.tool}: ${entry.error}` : entry.tool)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-2 text-text-tertiary">
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-brand"
              style={{ animationDelay: '0ms' }}
            />
            <span
              className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-brand"
              style={{ animationDelay: '150ms' }}
            />
            <span
              className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-brand"
              style={{ animationDelay: '300ms' }}
            />
          </span>
          <span className="text-tiny italic">{liveText}</span>
        </div>
      </div>
    </div>
  );
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
//
// Hand-rolled (no dependency). Supports:
//   - paragraphs separated by blank lines
//   - headings: # h1, ## h2, ### h3
//   - unordered list: lines starting with `- ` or `* `
//   - inline: **bold**, *italic*, `code`
//   - citation: [chart:N] → small chip
//   - confidence: [HIGH] [MED] [LOW] → coloured badge

interface RichMarkdownProps { text: string }

function RichMarkdown({ text }: RichMarkdownProps) {
  const blocks = useMemo(() => parseBlocks(normalizeAgentText(text)), [text]);
  return <div className="flex flex-col gap-2">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul'; items: string[] };

function parseBlocks(text: string): Block[] {
  if (!text) return [];
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') { i++; continue; }

    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }

    // List
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Paragraph: collect until blank line
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3})\s+/.test(lines[i].trim()) && !/^[-*]\s+/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', text: paraLines.join('\n') });
  }
  return blocks;
}

function renderBlock(block: Block, key: number): React.ReactNode {
  if (block.kind === 'h') {
    const cls =
      block.level === 1 ? 'text-base font-strong'
      : block.level === 2 ? 'text-sm font-strong'
      : 'text-caption font-strong';
    return <div key={key} className={cls}>{renderInline(block.text)}</div>;
  }
  if (block.kind === 'ul') {
    return (
      <ul key={key} className="list-disc space-y-1 pl-4">
        {block.items.map((it, i) => (
          <li key={i}>{renderInline(it)}</li>
        ))}
      </ul>
    );
  }
  return <div key={key}>{renderInline(block.text)}</div>;
}

// Some models forget the brackets and emit `chart:10HIGH` instead of
// `[chart:10] [HIGH]`. Pre-normalize so the inline tokenizer can render
// proper chips.
function normalizeAgentText(text: string): string {
  if (!text) return text;
  let out = text;
  // 1. Bracket-less citations: `chart:10` → `[chart:10]`. Skip ones already
  //    bracketed by negative look-behind (regex literal won't allow lookbehind
  //    in older targets, so do it via a guard prefix capture).
  out = out.replace(/(^|[^\[\w])(chart:\d+)/gi, (_m, pre, body) => `${pre}[${body.toLowerCase()}]`);
  // 2. Bracket-less confidence tags glued onto a citation: `]HIGH` / `]MED` /
  //    `]LOW` → `] [HIGH]`. Also matches a number stuck right after `chart:N`.
  out = out.replace(/(\[chart:\d+\])\s*(HIGH|MED|LOW)\b/g, (_m, c, lvl) => `${c} [${lvl}]`);
  // 3. Bare confidence tag right after a closing bracket of a chart chip with
  //    a space already there (idempotent for already-bracketed forms).
  out = out.replace(/(\[chart:\d+\])\s+\[?(HIGH|MED|LOW)\]?(?!\w)/g, (_m, c, lvl) => `${c} [${lvl}]`);
  return out;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[chart:\d+\]|\[HIGH\]|\[MED\]|\[LOW\])/g;

function renderInline(text: string): React.ReactNode[] {
  if (!text) return [];
  const parts = text.split(INLINE_PATTERN);
  const out: React.ReactNode[] = [];
  parts.forEach((part, idx) => {
    if (!part) return;
    if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={idx}>{part.slice(2, -2)}</strong>);
      return;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      out.push(<em key={idx}>{part.slice(1, -1)}</em>);
      return;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      out.push(
        <code key={idx} className="rounded bg-black/10 px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    const cm = /^\[chart:(\d+)\]$/.exec(part);
    if (cm) {
      out.push(<ChartChip key={idx} chartId={Number(cm[1])} />);
      return;
    }
    if (part === '[HIGH]' || part === '[MED]' || part === '[LOW]') {
      out.push(<ConfidenceBadge key={idx} level={part.slice(1, -1) as 'HIGH' | 'MED' | 'LOW'} />);
      return;
    }
    // Plain text — preserve newlines as <br/>
    const lines = part.split('\n');
    lines.forEach((line, j) => {
      out.push(<span key={`${idx}-${j}`}>{line}</span>);
      if (j < lines.length - 1) out.push(<br key={`${idx}-${j}-br`} />);
    });
  });
  return out;
}

function ChartChip({ chartId }: { chartId: number }) {
  const handleClick = () => {
    const target = document.querySelector(`[data-chart-id="${chartId}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('ring-2', 'ring-brand');
      setTimeout(() => target.classList.remove('ring-2', 'ring-brand'), 1600);
    }
  };
  return (
    <button
      onClick={handleClick}
      className="mx-0.5 inline-flex items-center rounded bg-brand/10 px-1 py-0 text-[0.7em] font-strong text-brand hover:bg-brand/20"
      title="Xem biểu đồ này"
    >
      chart:{chartId}
    </button>
  );
}

function ConfidenceBadge({ level }: { level: 'HIGH' | 'MED' | 'LOW' }) {
  const cls =
    level === 'HIGH' ? 'bg-success/15 text-success'
    : level === 'MED' ? 'bg-warning/15 text-warning'
    : 'bg-text-tertiary/15 text-text-tertiary';
  return (
    <span className={`mx-0.5 inline-flex items-center rounded px-1 py-0 text-[0.65em] font-strong ${cls}`}>
      {level}
    </span>
  );
}
