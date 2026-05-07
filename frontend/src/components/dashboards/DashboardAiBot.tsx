'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, X, Send, Loader2, ChevronDown, Key, ExternalLink } from 'lucide-react';
import {
  fetchAiContext,
  streamAiChat,
  type AiChatMessage,
  type AiDashboardContext,
  type AiProvider,
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

// ── Storage helpers ───────────────────────────────────────────────────────────

function getStoredKey(token: string): string {
  try { return sessionStorage.getItem(`dash_ai_key_${token}`) ?? ''; } catch { return ''; }
}
function setStoredKey(token: string, key: string): void {
  try { sessionStorage.setItem(`dash_ai_key_${token}`, key); } catch { /* ignore */ }
}
function getStoredProvider(token: string): AiProvider {
  try {
    const v = sessionStorage.getItem(`dash_ai_provider_${token}`);
    if (v === 'anthropic' || v === 'openai' || v === 'gemini') return v;
  } catch { /* ignore */ }
  return 'gemini';
}
function setStoredProvider(token: string, provider: AiProvider): void {
  try { sessionStorage.setItem(`dash_ai_provider_${token}`, provider); } catch { /* ignore */ }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  token: string;
  sessionToken?: string | null;
  dashboardName: string;
}

// ── BotIcon (inline SVG) ──────────────────────────────────────────────────────

function BotIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* antenna */}
      <line x1="12" y1="2" x2="12" y2="5" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="12" cy="2" r="1.1" fill="white"/>
      {/* head */}
      <rect x="3" y="5" width="18" height="13" rx="4" fill="white" fillOpacity="0.95"/>
      {/* eyes */}
      <circle cx="8.5" cy="11" r="1.6" fill="#06b6d4"/>
      <circle cx="15.5" cy="11" r="1.6" fill="#06b6d4"/>
      {/* smile */}
      <path d="M9 14.5 Q12 16.5 15 14.5" stroke="#3b82f6" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
      {/* ears */}
      <rect x="1" y="9" width="2" height="4" rx="1" fill="white" fillOpacity="0.85"/>
      <rect x="21" y="9" width="2" height="4" rx="1" fill="white" fillOpacity="0.85"/>
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DashboardAiBot({ token, sessionToken, dashboardName }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<'key' | 'chat'>('key');
  const [provider, setProvider] = useState<AiProvider>(() => getStoredProvider(token));
  const [apiKey, setApiKey] = useState(() => getStoredKey(token));
  const [keyError, setKeyError] = useState('');

  const [context, setContext] = useState<AiDashboardContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState('');

  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<boolean>(false);

  // Load context when chat view opens
  const loadContext = useCallback(async () => {
    if (context) return; // already loaded
    setContextLoading(true);
    setContextError('');
    try {
      const ctx = await fetchAiContext(token, sessionToken ?? undefined);
      setContext(ctx);
      // Welcome message
      setMessages([{
        role: 'assistant',
        content: `Xin chào! Tôi là trợ lý AI cho dashboard **${ctx.dashboard_name}**. Tôi có dữ liệu từ ${ctx.chart_count} biểu đồ và có thể giúp bạn phân tích số liệu. Bạn muốn hỏi gì?`,
      }]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Không thể tải dữ liệu dashboard.';
      setContextError(msg);
    } finally {
      setContextLoading(false);
    }
  }, [context, sessionToken, token]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    const stored = getStoredKey(token);
    if (stored) {
      setApiKey(stored);
      setView('chat');
      loadContext();
    } else {
      setView('key');
    }
  }, [loadContext, token]);

  // Scroll to bottom after new message
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleStartChat = useCallback(() => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setKeyError('Vui lòng nhập API key.');
      return;
    }
    setKeyError('');
    setStoredKey(token, trimmed);
    setStoredProvider(token, provider);
    setView('chat');
    loadContext();
  }, [apiKey, loadContext, provider, token]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isStreaming || !context) return;

    const userMsg: AiChatMessage = { role: 'user', content: text };
    const allMessages: AiChatMessage[] = [...messages, userMsg];
    setMessages([...allMessages, { role: 'assistant', content: '' }]);
    setInputText('');
    setIsStreaming(true);
    abortRef.current = false;

    try {
      let accumulated = '';
      const gen = streamAiChat(
        token,
        allMessages,
        context,
        apiKey,
        provider,
        sessionToken ?? undefined,
      );
      for await (const chunk of gen) {
        if (abortRef.current) break;
        accumulated += chunk;
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: accumulated };
          return next;
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định.';
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: 'assistant',
          content: `[Lỗi: ${msg}]`,
        };
        return next;
      });
    } finally {
      setIsStreaming(false);
    }
  }, [apiKey, context, inputText, isStreaming, messages, provider, sessionToken, token]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleChangeKey = useCallback(() => {
    abortRef.current = true;
    setMessages([]);
    setContext(null);
    setView('key');
  }, []);

  const selectedProvider = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];

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

  // ── Render: open state ─────────────────────────────────────────────────────

  return (
    <div className="flex w-[380px] min-w-[260px] flex-shrink-0 flex-col border-l border-[rgb(var(--border-line))] bg-surface-1">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-brand" />
          <span className="text-caption font-strong text-text-primary">AI Assistant</span>
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

      {/* Body */}
      {view === 'key' ? (
        <KeyInputView
          provider={provider}
          apiKey={apiKey}
          keyError={keyError}
          onProviderChange={(p) => { setProvider(p); setStoredProvider(token, p); }}
          onApiKeyChange={setApiKey}
          onSubmit={handleStartChat}
        />
      ) : (
        <ChatView
          messages={messages}
          contextLoading={contextLoading}
          contextError={contextError}
          inputText={inputText}
          isStreaming={isStreaming}
          messagesEndRef={messagesEndRef}
          inputRef={inputRef}
          onInputChange={setInputText}
          onKeyDown={handleKeyDown}
          onSend={handleSend}
        />
      )}
    </div>
  );
}

// ── KeyInputView ──────────────────────────────────────────────────────────────

function KeyInputView({
  provider,
  apiKey,
  keyError,
  onProviderChange,
  onApiKeyChange,
  onSubmit,
}: {
  provider: AiProvider;
  apiKey: string;
  keyError: string;
  onProviderChange: (p: AiProvider) => void;
  onApiKeyChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const selectedProvider = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-label text-text-secondary">
        Nhập API key để bắt đầu chat. Key được lưu trong tab này và không bao giờ được gửi đến server của chúng tôi.
      </p>

      {/* Provider selector */}
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

      {/* API key input */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-micro font-strong text-text-secondary">
            API Key
          </label>
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
        {keyError && (
          <p className="mt-1 text-tiny text-danger">{keyError}</p>
        )}
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
        API key chỉ tồn tại trong tab này, không được lưu vĩnh viễn.
      </p>
    </div>
  );
}

// ── ChatView ──────────────────────────────────────────────────────────────────

function ChatView({
  messages,
  contextLoading,
  contextError,
  inputText,
  isStreaming,
  messagesEndRef,
  inputRef,
  onInputChange,
  onKeyDown,
  onSend,
}: {
  messages: AiChatMessage[];
  contextLoading: boolean;
  contextError: string;
  inputText: string;
  isStreaming: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  onInputChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Messages */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {contextLoading && (
          <div className="flex items-center gap-2 text-label text-text-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Đang tải dữ liệu dashboard...
          </div>
        )}
        {contextError && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-micro text-danger">
            {contextError}
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {isStreaming && messages[messages.length - 1]?.content === '' && (
          <div className="flex items-center gap-1.5 text-tiny text-text-tertiary">
            <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary" style={{ animationDelay: '0ms' }} />
            <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary" style={{ animationDelay: '150ms' }} />
            <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary" style={{ animationDelay: '300ms' }} />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[rgb(var(--border-line))] p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Nhập câu hỏi... (Enter để gửi)"
            rows={1}
            className="min-h-[32px] flex-1 resize-none rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-caption text-text-primary placeholder:text-text-quaternary focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            style={{ maxHeight: 100 }}
            disabled={contextLoading || !!contextError}
          />
          <button
            onClick={onSend}
            disabled={!inputText.trim() || isStreaming || contextLoading || !!contextError}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Gửi"
          >
            {isStreaming
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Send className="h-4 w-4" />
            }
          </button>
        </div>
        <p className="mt-1 text-micro text-text-quaternary">
          Shift+Enter để xuống dòng
        </p>
      </div>
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: AiChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-caption leading-relaxed ${
          isUser
            ? 'bg-brand text-white'
            : 'border border-[rgb(var(--border-line))] bg-surface-2 text-text-primary'
        }`}
      >
        <MarkdownText text={message.content} />
      </div>
    </div>
  );
}

// ── Simple markdown renderer (bold + code only) ───────────────────────────────

function MarkdownText({ text }: { text: string }) {
  if (!text) return null;

  // Split by code blocks and bold
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="rounded bg-black/10 px-1 font-mono text-[0.85em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        // Preserve newlines
        return (
          <span key={i}>
            {part.split('\n').map((line, j, arr) => (
              <span key={j}>
                {line}
                {j < arr.length - 1 && <br />}
              </span>
            ))}
          </span>
        );
      })}
    </>
  );
}
