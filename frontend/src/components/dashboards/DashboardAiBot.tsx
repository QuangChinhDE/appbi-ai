'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, X, Send, Loader2, ChevronDown, Key, ExternalLink, AlertTriangle, CheckCircle2, Sparkles, ListChecks, BarChart3, Calculator, GitCompareArrows, Search, Filter, TrendingUp, Image as ImageIcon, Activity, Trash2, ThumbsUp, ThumbsDown, Brain, Zap } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import {
  fetchAiRecon,
  streamAiAgentChat,
  loadAiSession,
  saveAiSession,
  clearAiSession,
  type AiAgentEvent,
  type AiBriefing,
  type AiChatMessage,
  type AiConversationState,
  type AiProvider,
  type AiRecon,
} from '@/lib/api/public';
import { BriefingWizard, type BriefingWizardResult } from './BriefingWizard';

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

// Curated model list per provider. The first entry is the default — the
// strongest commonly-available BYOK option as of 2026-05.
const MODEL_OPTIONS: Record<AiProvider, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-5', label: 'GPT-5 (mạnh nhất, đắt — nhớ đặt giới hạn $)' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini (cân bằng)' },
    { value: 'gpt-5-nano', label: 'GPT-5 nano (rẻ, nhanh)' },
    { value: 'gpt-4o', label: 'GPT-4o (mạnh, đa dụng)' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini (rẻ, nhanh)' },
    { value: 'o3-mini', label: 'o3-mini (reasoning)' },
  ],
  anthropic: [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (đề xuất)' },
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (mạnh nhất)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (rẻ, nhanh)' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (cũ)' },
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

// Briefing is non-secret; remembering it across reopens of the bot panel
// avoids re-running the wizard for every chat session.
function getStoredBriefing(token: string): AiBriefing | null {
  try {
    const raw = sessionStorage.getItem(`dash_ai_briefing_${token}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AiBriefing;
    if (!parsed || typeof parsed !== 'object' || !parsed.confirmed) return null;
    return parsed;
  } catch { return null; }
}
function setStoredBriefing(token: string, briefing: AiBriefing | null): void {
  try {
    if (briefing) {
      sessionStorage.setItem(`dash_ai_briefing_${token}`, JSON.stringify(briefing));
    } else {
      sessionStorage.removeItem(`dash_ai_briefing_${token}`);
    }
  } catch { /* ignore */ }
}

// API key is stored in sessionStorage of the current tab ONLY when the user
// opts in via the "remember key" checkbox. It dies when the tab closes; it
// is never written to localStorage and never sent anywhere except the
// backend chat endpoint as the X-User-Ai-Key header.
// The value is XOR-encrypted with a per-tab secret so it is NOT readable
// as plain text in DevTools / browser storage panels.
function getStoredApiKey(token: string): string {
  try {
    const raw = sessionStorage.getItem(`dash_ai_apikey_${token}`);
    if (!raw) return '';
    return decryptKey(raw);
  } catch { return ''; }
}
function setStoredApiKey(token: string, key: string, persist: boolean): void {
  try {
    if (persist && key) {
      sessionStorage.setItem(`dash_ai_apikey_${token}`, encryptKey(key));
    } else {
      sessionStorage.removeItem(`dash_ai_apikey_${token}`);
    }
  } catch { /* ignore */ }
}

// ── API Key encryption ───────────────────────────────────────────────────────
// XOR-cipher with a per-tab random secret stored in sessionStorage.
// Prevents plain-text API keys from being visible in DevTools / storage inspection.

function getTabSecret(): string {
  try {
    const existing = sessionStorage.getItem('_tk');
    if (existing) return existing;
    const bytes = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('_tk', bytes);
    return bytes;
  } catch { return 'fallback-key-appbi'; }
}

function encryptKey(text: string): string {
  if (!text) return '';
  try {
    const secret = getTabSecret();
    const bytes = Array.from(text).map((c, i) =>
      c.charCodeAt(0) ^ secret.charCodeAt(i % secret.length),
    );
    return btoa(String.fromCharCode(...bytes));
  } catch { return ''; }
}

function decryptKey(encoded: string): string {
  if (!encoded) return '';
  try {
    const secret = getTabSecret();
    const bytes = Array.from(atob(encoded)).map((c, i) =>
      c.charCodeAt(0) ^ secret.charCodeAt(i % secret.length),
    );
    return bytes.map((b) => String.fromCharCode(b)).join('');
  } catch { return ''; }
}

// ── Thinking mode ─────────────────────────────────────────────────────────────
const DEFAULT_NORMAL_COST_CAP_USD = 0.05;
const DEFAULT_THINKING_COST_CAP_USD = 0.10;
const MIN_COST_CAP_USD = 0.01;
const MAX_COST_CAP_USD = 5.0;

function clampCostCapUsd(value: number): number {
  return Math.max(MIN_COST_CAP_USD, Math.min(MAX_COST_CAP_USD, value));
}

function resolveCostCapUsd(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampCostCapUsd(value)
    : fallback;
}

function getStoredThinkingMode(token: string): boolean {
  try { return sessionStorage.getItem(`dash_ai_thinking_${token}`) === '1'; } catch { return false; }
}
function setStoredThinkingMode(token: string, v: boolean): void {
  try { sessionStorage.setItem(`dash_ai_thinking_${token}`, v ? '1' : '0'); } catch { /* ignore */ }
}

// Session key — a client-generated UUID stored in localStorage (survives F5/tab close).
// Different sessions = different UUIDs. Never stored in the DB alongside the API key.
function getOrCreateSessionKey(token: string): string {
  try {
    const k = `dash_ai_session_key_${token}`;
    const existing = localStorage.getItem(k);
    if (existing) return existing;
    const next = crypto.randomUUID();
    localStorage.setItem(k, next);
    return next;
  } catch {
    return crypto.randomUUID();  // ephemeral fallback (private browsing, etc.)
  }
}
function clearStoredSessionKey(token: string): void {
  try { localStorage.removeItem(`dash_ai_session_key_${token}`); } catch { /* ignore */ }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage extends AiChatMessage {
  /** Tool status notes accumulated while this assistant message was streaming. */
  statusLog?: { tool: string; text: string; ok?: boolean; error?: string | null }[];
  /** User rating for this assistant message. */
  rating?: 'up' | 'down';
  /** Phase-15.71 — reading plan emitted by the bot before answering.
   *  Renders as a collapsible "AI đang đọc" panel above the answer.
   *  Phase 15.72 — each step carries a live status badge updated by
   *  plan_step events as the agent works through the plan. */
  readingPlan?: {
    items: { step: number; chart_id: number | null; phase: string; question: string }[];
    overallGoal?: string | null;
    stepStatuses?: ('pending' | 'running' | 'done')[];
  };
}

interface Props {
  token: string;
  sessionToken?: string | null;
  dashboardName: string;
  normalCostCapUsd?: number | null;
  thinkingCostCapUsd?: number | null;
  /** True when the admin has pre-configured an API key for this link.
   *  When set, skip the key-entry view and send no key header (backend uses stored key). */
  keyConfigured?: boolean;
  /** Viewer-applied slicer filters from the dashboard UI. Passed verbatim to
   *  every AI Bot call so the bot sees the same filtered data the user is
   *  looking at. When empty/missing the bot sees only the link's DA-defined
   *  Access filters (legacy behavior). */
  viewerFilters?: unknown[];
}

// ── Chart name resolution ────────────────────────────────────────────────────
//
// The model writes `[chart:N]` in its answers. The UI renders these as
// chips, but users don't read chart_id — they read chart NAMES. This
// context lets every nested chip resolve `N → "Chart Name"` without
// threading a prop through 4 components.
const ChartNamesContext = React.createContext<Map<number, string>>(new Map());

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

export function DashboardAiBot({
  token,
  sessionToken,
  dashboardName,
  normalCostCapUsd,
  thinkingCostCapUsd,
  keyConfigured,
  viewerFilters,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  // When keyConfigured the admin has pre-set a key server-side — start in 'chat'
  // (or 'briefing' if no stored briefing) instead of the key-entry view.
  const [view, setView] = useState<'key' | 'briefing' | 'chat'>(keyConfigured ? 'briefing' : 'key');
  const [provider, setProvider] = useState<AiProvider>(() => getStoredProvider(token));
  const [modelId, setModelId] = useState(() => getStoredModel(token, getStoredProvider(token)));
  // API key kept in component memory; optionally mirrored to sessionStorage
  // of the current tab so the user does not have to re-paste it on every
  // F5. Persistence is opt-out (default ON) via a checkbox in KeyInputView.
  const [apiKey, setApiKey] = useState<string>(() => getStoredApiKey(token));
  const [persistKey, setPersistKey] = useState<boolean>(true);
  const [keyError, setKeyError] = useState('');

  const [recon, setRecon] = useState<AiRecon | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState('');

  // Phase A — confirmed briefing (sent on every chat turn). Persisted in
  // sessionStorage per-link so reopening the bot in the same tab skips the
  // wizard.
  const [briefing, setBriefing] = useState<AiBriefing | null>(() => getStoredBriefing(token));
  // Phase B — conversation state (findings + seen charts) accumulated turn by
  // turn. Backend echoes the new state in the `state` SSE event.
  const [convState, setConvState] = useState<AiConversationState | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeStatus, setActiveStatus] = useState<string>('');
  const [thinkingMode, setThinkingMode] = useState<boolean>(() => getStoredThinkingMode(token));
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Session key is a UUID stored in localStorage that identifies this browser
  // across page reloads. Used to restore chat history from the server.
  const [sessionKey] = useState<string>(() => getOrCreateSessionKey(token));
  // Token usage counters — accumulated from SSE `usage` events and saved to DB.
  const totalPromptTokensRef = useRef<number>(0);
  const totalCompletionTokensRef = useRef<number>(0);
  // Whether a restored session banner should be shown
  const [sessionRestored, setSessionRestored] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<boolean>(false);
  const [idleNudge, setIdleNudge] = useState<string | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const resolvedNormalCostCapUsd = useMemo(
    () => resolveCostCapUsd(normalCostCapUsd, DEFAULT_NORMAL_COST_CAP_USD),
    [normalCostCapUsd],
  );
  const resolvedThinkingCostCapUsd = useMemo(
    () => resolveCostCapUsd(thinkingCostCapUsd, DEFAULT_THINKING_COST_CAP_USD),
    [thinkingCostCapUsd],
  );

  // ── Recon load ───────────────────────────────────────────────────────────

  const loadRecon = useCallback(async () => {
    if (recon) return;
    setReconLoading(true);
    setReconError('');
    try {
      const r = await fetchAiRecon(token, sessionToken ?? undefined);
      setRecon(r);
      // The briefing wizard / brief-skip path is responsible for seeding
      // the welcome message. We only set it here as a backup if the user
      // somehow lands in the chat view with no messages yet.
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Không thể tải dữ liệu dashboard.';
      setReconError(msg);
    } finally {
      setReconLoading(false);
    }
  }, [recon, sessionToken, token]);

  const handleOpen = useCallback(async () => {
    setIsOpen(true);
    const storedProvider = getStoredProvider(token);
    setProvider(storedProvider);
    setModelId(getStoredModel(token, storedProvider));

    // Try to restore a previous chat session from the server first.
    // We do this before deciding which view to show so we can jump straight
    // to 'chat' when there are saved messages.
    let restoredMessages: ChatMessage[] = [];
    let restoredBriefing: AiBriefing | null = null;
    try {
      const saved = await loadAiSession(token, sessionKey, sessionToken ?? undefined);
      if (saved && saved.messages && saved.messages.length > 0) {
        restoredMessages = saved.messages as ChatMessage[];
        if (saved.briefing) {
          restoredBriefing = saved.briefing as unknown as AiBriefing;
          setBriefing(restoredBriefing);
          setStoredBriefing(token, restoredBriefing);
        }
        if (saved.conv_state) setConvState(saved.conv_state as unknown as AiConversationState);
        if (saved.provider) setProvider(saved.provider as unknown as AiProvider);
        if (saved.model) setModelId(saved.model);
        totalPromptTokensRef.current = saved.prompt_tokens ?? 0;
        totalCompletionTokensRef.current = saved.completion_tokens ?? 0;
        setMessages(restoredMessages);
        setSessionRestored(true);
        setView('chat');
        return;
      }
    } catch {
      // Session load failed (network error etc.) — proceed normally
    }

    // When keyConfigured=true the admin key lives server-side; no key view needed.
    if (keyConfigured) {
      const currentBriefing = restoredBriefing ?? briefing;
      if (currentBriefing) {
        setView('chat');
      } else {
        setView('briefing');
      }
      return;
    }
    // If a key was persisted in this tab's sessionStorage, jump straight to
    // briefing/chat — saves the user from re-pasting on every F5.
    const storedKey = getStoredApiKey(token);
    const effectiveKey = apiKey || storedKey;
    if (storedKey && !apiKey) setApiKey(storedKey);
    const currentBriefing = restoredBriefing ?? briefing;
    if (!effectiveKey) {
      setView('key');
    } else if (currentBriefing) {
      setView('chat');
    } else {
      setView('briefing');
    }
  }, [apiKey, briefing, keyConfigured, sessionKey, sessionToken, token]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen, activeStatus]);

  // Idle nudge: 30s after the LAST stream completes, surface the strongest
  // [FOLLOWUP] chip as a "Tôi gợi ý hỏi tiếp:" pill that auto-dismisses on
  // user interaction. Reduces "blank-stare" when user doesn't know what to
  // ask next — DA-style proactive prompting.
  useEffect(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setIdleNudge(null);
    if (!isOpen || isStreaming || view !== 'chat') return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.content) return;
    // Pull the FIRST followup question out of the answer text
    const m = /\[FOLLOWUP\]\s*([^\n]+\?)/i.exec(last.content);
    if (!m) return;
    const candidate = m[1].trim();
    idleTimerRef.current = window.setTimeout(() => {
      setIdleNudge(candidate);
    }, 30_000);
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [isOpen, isStreaming, messages, view]);

  const handleStartChat = useCallback(() => {
    const trimmed = apiKey.trim();
    const chosenModel = modelId || DEFAULT_MODELS[provider];
    if (!trimmed) {
      setKeyError('Vui lòng nhập API key.');
      return;
    }
    setKeyError('');
    setApiKey(trimmed);
    setStoredApiKey(token, trimmed, persistKey);
    setStoredProvider(token, provider);
    setStoredModel(token, provider, chosenModel);
    setModelId(chosenModel);
    // Recon now happens IN the briefing wizard (it calls /briefing/guess
    // which itself runs the recon under the hood). The chat view will use
    // the manifest from /ai/recon for chip-name resolution; trigger it in
    // parallel so the user does not wait for both calls sequentially.
    loadRecon();
    // Skip the wizard if we already have a confirmed briefing from this tab
    // (sessionStorage). Reset state so the new chat session starts fresh
    // but keep the user briefing.
    const stored = getStoredBriefing(token);
    if (stored) {
      setBriefing(stored);
      setConvState({
        briefing: stored,
        findings: [],
        hypotheses: [],
        turn_index: 0,
        seen_chart_ids: [],
      });
      setMessages([{
        role: 'assistant',
        content:
          `Tôi nhớ bạn đang xem dashboard này với vai trò **${stored.role}**, ` +
          `lĩnh vực **${stored.domain_label}**, trọng tâm **${stored.focus}**. ` +
          'Hỏi gì cũng được — hoặc bấm "Đổi briefing" ở thanh trên để khảo sát lại.',
      }]);
      setView('chat');
    } else {
      setView('briefing');
    }
  }, [apiKey, loadRecon, modelId, persistKey, provider, token]);

  const handleBriefingDone = useCallback((result: BriefingWizardResult) => {
    setBriefing(result.briefing);
    setStoredBriefing(token, result.briefing);
    // Reset conversation state for a fresh session
    const initialState: AiConversationState = {
      briefing: result.briefing,
      findings: [],
      hypotheses: [],
      turn_index: 0,
      seen_chart_ids: [],
    };
    setConvState(initialState);
    // Seed the chat with the executive brief as the assistant's first message.
    const initialMessages: ChatMessage[] = [{ role: 'assistant', content: result.executiveBrief }];
    setMessages(initialMessages);
    setView('chat');
    // Persist to DB so the session survives F5
    saveAiSession(token, sessionKey, {
      session_key: sessionKey,
      provider,
      model: modelId,
      messages: initialMessages.map((m) => ({ role: m.role, content: m.content })),
      briefing: result.briefing as unknown as Record<string, unknown>,
      conv_state: initialState as unknown as Record<string, unknown>,
      turn_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
    }, sessionToken ?? undefined).catch(() => { /* silent */ });
  }, [modelId, provider, sessionKey, sessionToken, token]);

  const handleBriefingSkip = useCallback(() => {
    // Skip wizard — fall back to legacy welcome message from recon.
    setBriefing(null);
    setConvState({
      briefing: null,
      findings: [],
      hypotheses: [],
      turn_index: 0,
      seen_chart_ids: [],
    });
    if (recon) {
      setMessages([{
        role: 'assistant',
        content: buildWelcomeMessage(recon, dashboardName),
      }]);
    } else {
      setMessages([]);
    }
    setView('chat');
  }, [dashboardName, recon]);

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

    // Track the latest messages snapshot for session persistence after streaming
    let latestMessages: ChatMessage[] = [...messages, userMsg, { role: 'assistant', content: '', statusLog: [] }];
    let latestConvState = convState;
    const turnCount = Math.floor(messages.filter((m) => m.role === 'user').length / 1) + 1;

    setMessages(latestMessages);
    setInputText('');
    setIsStreaming(true);
    setActiveStatus('');
    abortRef.current = false;

    try {
      let answerSoFar = '';
      const gen = streamAiAgentChat(
        token,
        wireHistory,
        // When admin pre-configured a key server-side, send empty string so the
        // backend falls back to its stored key (the X-User-Ai-Key header will be
        // sent as empty and the backend treats a missing header as "use stored").
        keyConfigured ? '' : apiKey,
        provider,
        modelId.trim() || DEFAULT_MODELS[provider],
        sessionToken ?? undefined,
        briefing,
        convState,
        thinkingMode ? resolvedThinkingCostCapUsd : resolvedNormalCostCapUsd,
        thinkingMode ? 'thinking' : 'normal',
        viewerFilters,
      );
      for await (const ev of gen) {
        if (abortRef.current) break;
        // Accumulate token usage for session persistence
        if (ev.type === 'usage') {
          totalPromptTokensRef.current += ev.prompt_tokens ?? 0;
          totalCompletionTokensRef.current += ev.completion_tokens ?? 0;
        }
        applyEvent(ev, {
          appendText: (chunk) => {
            answerSoFar += chunk;
            // Update latestMessages directly (synchronous) so the finally block
            // always has the correct final state regardless of React batching.
            const lastIdx = latestMessages.length - 1;
            if (lastIdx >= 0 && latestMessages[lastIdx].role === 'assistant') {
              latestMessages = [
                ...latestMessages.slice(0, lastIdx),
                { ...latestMessages[lastIdx], content: answerSoFar },
              ];
            }
            setMessages(latestMessages);
          },
          setStatus: (s) => setActiveStatus(s),
          appendStatusLog: (entry) => {
            const lastIdx = latestMessages.length - 1;
            if (lastIdx >= 0 && latestMessages[lastIdx].role === 'assistant') {
              const log = [...(latestMessages[lastIdx].statusLog ?? []), entry];
              latestMessages = [
                ...latestMessages.slice(0, lastIdx),
                { ...latestMessages[lastIdx], statusLog: log },
              ];
            }
            setMessages(latestMessages);
          },
          setReadingPlan: (items, overallGoal) => {
            const lastIdx = latestMessages.length - 1;
            if (lastIdx >= 0 && latestMessages[lastIdx].role === 'assistant') {
              latestMessages = [
                ...latestMessages.slice(0, lastIdx),
                {
                  ...latestMessages[lastIdx],
                  readingPlan: {
                    items,
                    overallGoal,
                    stepStatuses: items.map(() => 'pending' as const),
                  },
                },
              ];
            }
            setMessages(latestMessages);
          },
          updatePlanStep: (stepIndex, status) => {
            const lastIdx = latestMessages.length - 1;
            if (lastIdx >= 0 && latestMessages[lastIdx].role === 'assistant') {
              const prev = latestMessages[lastIdx].readingPlan;
              if (!prev) return;
              const nextStatuses = (prev.stepStatuses ?? prev.items.map(() => 'pending' as const)).slice();
              if (stepIndex < 0 || stepIndex >= nextStatuses.length) return;
              nextStatuses[stepIndex] = status;
              latestMessages = [
                ...latestMessages.slice(0, lastIdx),
                {
                  ...latestMessages[lastIdx],
                  readingPlan: { ...prev, stepStatuses: nextStatuses },
                },
              ];
              setMessages(latestMessages);
            }
          },
          updateState: (s) => { setConvState(s); latestConvState = s; },
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định.';
      const lastIdx = latestMessages.length - 1;
      if (lastIdx >= 0 && latestMessages[lastIdx].role === 'assistant') {
        latestMessages = [
          ...latestMessages.slice(0, lastIdx),
          { ...latestMessages[lastIdx], content: `[Lỗi: ${msg}]` },
        ];
      }
      setMessages(latestMessages);
    } finally {
      setIsStreaming(false);
      setActiveStatus('');
      // Persist the session to DB so history survives F5
      const safeMessages = latestMessages
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map((m) => ({ role: m.role, content: m.content }));
      if (safeMessages.length > 0) {
        saveAiSession(token, sessionKey, {
          session_key: sessionKey,
          provider,
          model: modelId,
          messages: safeMessages,
          briefing: briefing as unknown as Record<string, unknown> | null,
          conv_state: latestConvState as unknown as Record<string, unknown> | null,
          turn_count: turnCount,
          prompt_tokens: totalPromptTokensRef.current,
          completion_tokens: totalCompletionTokensRef.current,
        }, sessionToken ?? undefined).catch(() => { /* silent */ });
      }
    }
  }, [
    apiKey,
    briefing,
    convState,
    inputText,
    isStreaming,
    keyConfigured,
    messages,
    modelId,
    provider,
    resolvedNormalCostCapUsd,
    resolvedThinkingCostCapUsd,
    sessionKey,
    sessionToken,
    thinkingMode,
    token,
  ]);

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
    setStoredApiKey(token, '', false);
    setMessages([]);
    setRecon(null);
    setBriefing(null);
    setStoredBriefing(token, null);
    setConvState(null);
    // Clear session from DB and generate a new session key for the next chat
    clearAiSession(token, sessionKey, sessionToken ?? undefined).catch(() => { /* silent */ });
    clearStoredSessionKey(token);
    totalPromptTokensRef.current = 0;
    totalCompletionTokensRef.current = 0;
    setSessionRestored(false);
    setView('key');
  }, [sessionKey, sessionToken, token]);

  const handleResetBriefing = useCallback(() => {
    setBriefing(null);
    setStoredBriefing(token, null);
    setConvState(null);
    setMessages([]);
    // Clear session from DB and start fresh
    clearAiSession(token, sessionKey, sessionToken ?? undefined).catch(() => { /* silent */ });
    clearStoredSessionKey(token);
    totalPromptTokensRef.current = 0;
    totalCompletionTokensRef.current = 0;
    setSessionRestored(false);
    setView('briefing');
  }, [sessionKey, sessionToken, token]);

  const handleToggleThinking = useCallback(() => {
    const next = !thinkingMode;
    setThinkingMode(next);
    setStoredThinkingMode(token, next);
  }, [thinkingMode, token]);

  const handleRateMessage = useCallback((msgIndex: number, rating: 'up' | 'down') => {
    setMessages((prev) => {
      const next = prev.map((m, i) => {
        if (i !== msgIndex) return m;
        // Toggle off if clicking the same rating again
        return { ...m, rating: m.rating === rating ? undefined : rating };
      });
      // Persist ratings to DB (silent)
      const safeMessages = next
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map((m) => ({ role: m.role, content: m.content, ...(m.rating ? { rating: m.rating } : {}) }));
      saveAiSession(token, sessionKey, {
        session_key: sessionKey,
        provider,
        model: modelId,
        messages: safeMessages,
        briefing: briefing as unknown as Record<string, unknown> | null,
        conv_state: convState as unknown as Record<string, unknown> | null,
        turn_count: Math.ceil(next.filter((m) => m.role === 'user').length),
        prompt_tokens: totalPromptTokensRef.current,
        completion_tokens: totalCompletionTokensRef.current,
      }, sessionToken ?? undefined).catch(() => { /* silent */ });
      return next;
    });
  }, [briefing, convState, modelId, provider, sessionKey, sessionToken, token]);

  // Build chart-id → name lookup once per recon, memoized so children don't
  // re-render on every state change. The model emits `[chart:N]` and the
  // chip renders the pretty name without us having to thread a prop.
  // NOTE: must stay above any early-return so hook order is stable.
  const chartNamesMap = useMemo(() => {
    const m = new Map<number, string>();
    if (recon?.manifest?.charts) {
      for (const c of recon.manifest.charts) {
        if (typeof c.chart_id === 'number' && c.chart_name) {
          m.set(c.chart_id, c.chart_name);
        }
      }
    }
    return m;
  }, [recon]);

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
    <ChartNamesContext.Provider value={chartNamesMap}>
    <div className="flex w-[400px] min-w-[300px] flex-shrink-0 flex-col my-3 mr-3 overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.18),0_2px_6px_-2px_rgba(0,0,0,0.08)] backdrop-blur-sm">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[rgb(var(--border-line))]/60 bg-gradient-to-b from-surface-2 to-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-brand to-brand/70 text-white shadow-sm">
            <Bot className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-caption font-strong text-text-primary">AI Analyst</span>
            {view === 'chat' && dashboardName && (
              <span className="text-micro text-text-tertiary truncate max-w-[180px]">{dashboardName}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {view === 'chat' && (
            <button
              onClick={handleToggleThinking}
              className={`flex items-center gap-1 rounded px-2 py-1 text-micro transition-colors ${
                thinkingMode
                  ? 'bg-brand/10 text-brand hover:bg-brand/20'
                  : 'text-text-tertiary hover:bg-surface-3 hover:text-text-primary'
              }`}
              title={
                thinkingMode
                  ? `Thinking mode · tối đa $${resolvedThinkingCostCapUsd.toFixed(2)}/câu`
                  : `Normal mode · tối đa $${resolvedNormalCostCapUsd.toFixed(2)}/câu`
              }
            >
              {thinkingMode ? <Brain className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              <span>{thinkingMode ? 'Thinking' : 'Normal'}</span>
            </button>
          )}
          {view === 'chat' && !keyConfigured && (
            <button
              onClick={handleChangeKey}
              className="flex items-center gap-1 rounded px-2 py-1 text-micro text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary"
              title="Thay đổi API key"
            >
              <Key className="h-3 w-3" />
              <span>Đổi key</span>
            </button>
          )}
          {view === 'chat' && (
            <button
              onClick={() => setShowClearConfirm(true)}
              className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-3 hover:text-danger"
              title="Xóa lịch sử chat"
              aria-label="Xóa lịch sử chat"
            >
              <Trash2 className="h-3.5 w-3.5" />
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

      {view === 'key' && (
        <KeyInputView
          provider={provider}
          modelId={modelId}
          apiKey={apiKey}
          keyError={keyError}
          persistKey={persistKey}
          onProviderChange={handleProviderChange}
          onModelChange={handleModelChange}
          onApiKeyChange={setApiKey}
          onPersistKeyChange={setPersistKey}
          onSubmit={handleStartChat}
        />
      )}
      {view === 'briefing' && (
        <BriefingWizard
          token={token}
          sessionToken={sessionToken}
          apiKey={apiKey}
          provider={provider}
          model={modelId.trim() || DEFAULT_MODELS[provider]}
          onSkip={handleBriefingSkip}
          onComplete={handleBriefingDone}
        />
      )}
      {view === 'chat' && (
        <>
          {sessionRestored && (
            <div className="flex items-center justify-between gap-2 px-4 py-2 bg-surface-2 border-b border-[rgb(var(--border-line))]/50">
              <span className="text-micro text-text-secondary">↩ Tiếp tục từ phiên trước</span>
              <button
                className="text-micro text-text-tertiary hover:text-text-primary transition-colors"
                onClick={() => setSessionRestored(false)}
              >
                ✕
              </button>
            </div>
          )}
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
            briefing={briefing}
            convState={convState}
            onResetBriefing={handleResetBriefing}
            idleNudge={idleNudge}
            onDismissNudge={() => setIdleNudge(null)}
            onAcceptNudge={(q) => { setIdleNudge(null); handleSend(q); }}
            onRateMessage={handleRateMessage}
          />
        </>
      )}
      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={() => {
          // Clear local session only — DB history is kept for admin analytics
          clearStoredSessionKey(token);
          totalPromptTokensRef.current = 0;
          totalCompletionTokensRef.current = 0;
          setSessionRestored(false);
          setBriefing(null);
          setStoredBriefing(token, null);
          setConvState(null);
          setMessages([]);
          setView('briefing');
        }}
        title="Xóa lịch sử chat?"
        description="Toàn bộ tin nhắn trong tab này sẽ bị xóa và phiên mới sẽ bắt đầu. Hành động này không thể hoàn tác."
        confirmLabel="Xóa lịch sử"
        cancelLabel="Hủy"
        variant="danger"
      />
    </div>
    </ChartNamesContext.Provider>
  );
}

// ── Event dispatch ───────────────────────────────────────────────────────────

function applyEvent(
  ev: AiAgentEvent,
  ops: {
    appendText: (chunk: string) => void;
    setStatus: (s: string) => void;
    appendStatusLog: (entry: { tool: string; text: string; ok?: boolean; error?: string | null }) => void;
    setReadingPlan: (
      items: { step: number; chart_id: number | null; phase: string; question: string }[],
      overallGoal?: string | null,
    ) => void;
    updatePlanStep: (stepIndex: number, status: 'pending' | 'running' | 'done') => void;
    updateState: (s: AiConversationState) => void;
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
  if (ev.type === 'reading_plan') {
    // Phase-15.71 — attach the bot's structured reading plan to the
    // current assistant message so a collapsible panel can render it
    // above the prose answer.
    ops.setReadingPlan(ev.items, ev.overall_goal ?? null);
    return;
  }
  if (ev.type === 'plan_step') {
    // Phase-15.72 — per-step status badge update.
    if (typeof ev.step_index === 'number' && ev.status) {
      ops.updatePlanStep(ev.step_index, ev.status);
    }
    return;
  }
  if (ev.type === 'state') {
    if (ev.state) ops.updateState(ev.state);
    return;
  }
  if (ev.type === 'cost' || ev.type === 'usage') {
    // Internal cost/usage telemetry — hidden from the user.
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
  persistKey,
  onProviderChange,
  onModelChange,
  onApiKeyChange,
  onPersistKeyChange,
  onSubmit,
}: {
  provider: AiProvider;
  modelId: string;
  apiKey: string;
  keyError: string;
  persistKey: boolean;
  onProviderChange: (p: AiProvider) => void;
  onModelChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onPersistKeyChange: (v: boolean) => void;
  onSubmit: () => void;
}) {
  const selectedProvider = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-label text-text-secondary">
        Nhập API key để bắt đầu chat. Key chỉ được giữ trong bộ nhớ tab này (sessionStorage) — đóng tab là mất; không bao giờ gửi về server của chúng tôi.
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
      <label className="flex items-start gap-2 text-micro text-text-secondary">
        <input
          type="checkbox"
          checked={persistKey}
          onChange={(e) => onPersistKeyChange(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 rounded border-[rgb(var(--border-line))] bg-surface-2 text-brand focus:ring-1 focus:ring-brand"
        />
        <span>
          Ghi nhớ key trong tab này (sessionStorage). Tự xóa khi đóng tab — không bao giờ ghi vào localStorage.
        </span>
      </label>
      <button
        onClick={onSubmit}
        disabled={!apiKey.trim()}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-caption font-strong text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Bot className="h-4 w-4" />
        Bắt đầu chat
      </button>
      <p className="text-center text-micro text-text-quaternary">
        Bỏ tick &quot;Ghi nhớ key&quot; nếu bạn dùng máy chung — khi đó key chỉ ở RAM cho đến khi đóng panel.
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
  briefing,
  convState,
  onResetBriefing,
  idleNudge,
  onDismissNudge,
  onAcceptNudge,
  onRateMessage,
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
  briefing: AiBriefing | null;
  convState: AiConversationState | null;
  onResetBriefing: () => void;
  idleNudge: string | null;
  onDismissNudge: () => void;
  onAcceptNudge: (q: string) => void;
  onRateMessage: (index: number, rating: 'up' | 'down') => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {briefing && (
        <BriefingPill briefing={briefing} convState={convState} onReset={onResetBriefing} />
      )}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {reconLoading && <ReconProgress />}
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
                  messageIndex={i}
                  streaming={showThinking}
                  disabled={isStreaming}
                  onPickSuggestion={onPickSuggestion}
                  onRate={onRateMessage}
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
      <div className="border-t border-[rgb(var(--border-line))]/60 bg-gradient-to-t from-surface-2/80 to-surface-1 p-3">
        {idleNudge && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/5 px-2.5 py-1.5 text-tiny text-text-secondary">
            <Sparkles className="h-3 w-3 flex-shrink-0 text-brand" />
            <span className="text-text-tertiary">Tôi gợi ý hỏi tiếp:</span>
            <button
              onClick={() => onAcceptNudge(idleNudge)}
              className="flex-1 truncate rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-left text-tiny font-strong text-brand transition-colors hover:bg-brand/20"
              title={idleNudge}
            >
              {idleNudge}
            </button>
            <button
              onClick={onDismissNudge}
              className="rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary"
              aria-label="Bỏ qua gợi ý"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 shadow-sm transition-all focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/20">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Hỏi về số liệu hoặc xu hướng..."
            rows={1}
            className="min-h-[28px] flex-1 resize-none border-0 bg-transparent text-caption text-text-primary placeholder:text-text-quaternary focus:outline-none focus:ring-0"
            style={{ maxHeight: 120 }}
            disabled={!!reconError}
          />
          <button
            onClick={onSend}
            disabled={!inputText.trim() || isStreaming || !!reconError}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand text-white shadow-sm transition-all hover:bg-brand/90 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            aria-label="Gửi"
          >
            {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
        <p className="mt-1.5 px-1 text-micro text-text-quaternary">Enter để gửi · Shift+Enter để xuống dòng</p>
      </div>
    </div>
  );
}

// ── BriefingPill ──────────────────────────────────────────────────────────────
//
// Compact chip that lives above the chat scrollback and shows the user the
// active briefing (domain / role / focus) plus how many findings the bot
// has accumulated. Reassures the user that "the bot remembers".

function BriefingPill({
  briefing, convState, onReset,
}: {
  briefing: AiBriefing;
  convState: AiConversationState | null;
  onReset: () => void;
}) {
  const findings = convState?.findings.length ?? 0;
  const seen = convState?.seen_chart_ids.length ?? 0;
  const roleLabel = ROLE_LABEL_VI[briefing.role] || briefing.role;
  const focusLabel = FOCUS_LABEL_VI[briefing.focus] || briefing.focus;
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-[rgb(var(--border-line))]/60 bg-surface-2/60 px-3 py-1.5 text-tiny text-text-secondary">
      <Sparkles className="h-3 w-3 text-brand" />
      <span className="truncate">
        <span className="font-strong">{briefing.domain_label}</span>
        {' · '}{roleLabel}{' · '}{focusLabel}
      </span>
      {(findings > 0 || seen > 0) && (
        <span className="ml-2 text-text-tertiary text-[0.7rem]">
          {findings > 0 && <span title="Số phát hiện đã nhớ">📌 {findings}</span>}
          {findings > 0 && seen > 0 && ' · '}
          {seen > 0 && <span title="Số chart đã đọc summary">🗂 {seen}</span>}
        </span>
      )}
      <button
        onClick={onReset}
        className="ml-auto rounded px-1.5 py-0.5 text-[0.7rem] text-text-tertiary transition-colors hover:bg-surface-3 hover:text-brand"
        title="Mở lại khảo sát mở đầu"
      >
        Đổi briefing
      </button>
    </div>
  );
}

const ROLE_LABEL_VI: Record<string, string> = {
  executive: 'Lãnh đạo',
  manager: 'Quản lý',
  analyst: 'Analyst',
  staff: 'Nhân viên',
};

const FOCUS_LABEL_VI: Record<string, string> = {
  overview: 'tổng thể',
  issues: 'vấn đề',
  compare: 'so sánh',
  deepdive: 'sâu',
};

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  messageIndex,
  streaming = false,
  disabled = false,
  onPickSuggestion,
  onRate,
}: {
  message: ChatMessage;
  messageIndex: number;
  streaming?: boolean;
  disabled?: boolean;
  onPickSuggestion?: (q: string) => void;
  onRate?: (index: number, rating: 'up' | 'down') => void;
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
        {!isUser && message.readingPlan && message.readingPlan.items.length > 0 && (
          <ReadingPlanPanel
            items={message.readingPlan.items}
            overallGoal={message.readingPlan.overallGoal}
            stepStatuses={message.readingPlan.stepStatuses}
            collapsed={!streaming}
          />
        )}
        {!isUser && message.statusLog && message.statusLog.length > 0 && (
          <StatusLog log={message.statusLog} collapsed={!streaming} />
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
        {!isUser && !streaming && message.content && onRate && (
          <div className="mt-1.5 flex items-center gap-1 border-t border-[rgb(var(--border-line))]/30 pt-1.5">
            <span className="text-micro text-text-quaternary mr-1">Phản hồi:</span>
            <button
              type="button"
              onClick={() => onRate(messageIndex, 'up')}
              className={`rounded p-1 transition-colors ${
                message.rating === 'up'
                  ? 'text-success bg-success/10'
                  : 'text-text-quaternary hover:text-success hover:bg-success/10'
              }`}
              title="Trả lời hữu ích"
              aria-label="Đánh giá tốt"
            >
              <ThumbsUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onRate(messageIndex, 'down')}
              className={`rounded p-1 transition-colors ${
                message.rating === 'down'
                  ? 'text-danger bg-danger/10'
                  : 'text-text-quaternary hover:text-danger hover:bg-danger/10'
              }`}
              title="Trả lời chưa tốt"
              aria-label="Đánh giá chưa tốt"
            >
              <ThumbsDown className="h-3 w-3" />
            </button>
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

// Phase-15.71 — analyst-style "AI đang đọc dashboard" panel. Shows the
// LLM's declared reading plan BEFORE the prose answer so the user sees
// the step-by-step flow (which charts, which phase, what question)
// rather than just the final synthesis.
const _PHASE_LABEL: Record<string, { label: string; cls: string }> = {
  triage:        { label: 'Quét nhanh',  cls: 'bg-text-quaternary/20 text-text-secondary' },
  health_check:  { label: 'Health check', cls: 'bg-info/15 text-info' },
  drilldown:     { label: 'Đào sâu',     cls: 'bg-brand/15 text-brand' },
  compare:       { label: 'So sánh',     cls: 'bg-warning/15 text-warning' },
  synthesize:    { label: 'Tổng hợp',    cls: 'bg-success/15 text-success' },
};

function ReadingPlanPanel({
  items,
  overallGoal,
  stepStatuses,
  collapsed = false,
}: {
  items: NonNullable<ChatMessage['readingPlan']>['items'];
  overallGoal?: string | null;
  stepStatuses?: ('pending' | 'running' | 'done')[];
  collapsed?: boolean;
}) {
  const [expanded, setExpanded] = useState(!collapsed);
  useEffect(() => { setExpanded(!collapsed); }, [collapsed]);
  if (!items || items.length === 0) return null;
  const doneCount = (stepStatuses ?? []).filter((s) => s === 'done').length;
  return (
    <div className="mb-2 rounded-md border border-brand/25 bg-brand/5 px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-tiny font-semibold text-brand"
      >
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand animate-pulse" />
          AI đang đọc dashboard ({doneCount}/{items.length} bước)
        </span>
        <span className="text-text-tertiary">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {overallGoal && (
            <div className="text-tiny italic text-text-tertiary">
              Mục tiêu: {overallGoal}
            </div>
          )}
          <ol className="space-y-1">
            {items.map((it, idx) => {
              const ph = _PHASE_LABEL[it.phase] || { label: it.phase, cls: 'bg-surface-2 text-text-secondary' };
              const status = stepStatuses?.[idx] ?? 'pending';
              return (
                <li key={it.step} className="flex items-start gap-2 text-tiny">
                  <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                    status === 'done'
                      ? 'bg-success/15 text-success'
                      : status === 'running'
                      ? 'bg-brand/20 text-brand animate-pulse'
                      : 'bg-brand/10 text-brand'
                  }`}>
                    {status === 'done' ? '✓' : it.step}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded px-1.5 py-px text-[10px] font-medium ${ph.cls}`}>
                        {ph.label}
                      </span>
                      {it.chart_id !== null && it.chart_id !== undefined && (
                        <span className="text-[10px] text-text-quaternary">
                          chart #{it.chart_id}
                        </span>
                      )}
                      {status === 'running' && (
                        <span className="text-[10px] font-medium text-brand">đang đọc…</span>
                      )}
                    </div>
                    <div className={`mt-0.5 leading-snug ${status === 'done' ? 'text-text-tertiary line-through' : 'text-text-secondary'}`}>
                      {it.question}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

function StatusLog({
  log,
  collapsed = false,
}: {
  log: NonNullable<ChatMessage['statusLog']>;
  collapsed?: boolean;
}) {
  // Collapse to one line per tool, showing OK/error after the run completes
  const visible = log.filter((l) => l.text || l.error);
  const [expanded, setExpanded] = useState(!collapsed);
  if (visible.length === 0) return null;
  // After streaming completes (collapsed=true), default to a single one-line
  // summary that the user can expand. Mirrors how Claude/ChatGPT collapse
  // tool traces after the answer is ready.
  if (collapsed && !expanded) {
    const errs = visible.filter((l) => l.ok === false || l.error).length;
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mb-1.5 flex items-center gap-1.5 border-b border-[rgb(var(--border-line))]/40 pb-1.5 text-tiny text-text-tertiary transition-colors hover:text-text-secondary"
      >
        <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-success" />
        <span className="italic">
          Đã đọc {visible.length} bước{errs ? ` · ${errs} lỗi` : ''} · xem chi tiết
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
    );
  }
  return (
    <div className="mb-1.5 flex flex-col gap-0.5 border-b border-[rgb(var(--border-line))]/40 pb-1.5 text-tiny text-text-tertiary">
      {collapsed && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="self-start text-tiny text-text-tertiary hover:text-text-secondary"
        >
          Ẩn chi tiết ▴
        </button>
      )}
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

function ReconProgress() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);
  const slow = elapsed >= 8;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-brand/20 bg-brand/5 px-3 py-2 text-tiny text-text-secondary">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
        <span className="font-strong text-brand">Đang quét nhanh dashboard…</span>
        <span className="ml-auto text-text-tertiary">{elapsed}s</span>
      </div>
      <div className="text-text-tertiary">
        {slow
          ? 'Dashboard có nhiều biểu đồ — đang tải insight pack ban đầu. Bạn có thể bắt đầu hỏi ngay, AI sẽ tự đọc thêm khi cần.'
          : 'Đang đọc cấu trúc các biểu đồ và tổng hợp insight pack đầu tiên.'}
      </div>
    </div>
  );
}

function toolIcon(tool: string | undefined): React.ReactNode {
  switch (tool) {
    case 'list_charts':
      return <ListChecks className="h-3.5 w-3.5" />;
    case 'get_chart_summary':
      return <BarChart3 className="h-3.5 w-3.5" />;
    case 'get_chart_data':
      return <Search className="h-3.5 w-3.5" />;
    case 'compare_segments':
    case 'compare_periods':
      return <GitCompareArrows className="h-3.5 w-3.5" />;
    case 'compute':
      return <Calculator className="h-3.5 w-3.5" />;
    case 'describe_distribution':
      return <Activity className="h-3.5 w-3.5" />;
    case 'correlate_charts':
      return <TrendingUp className="h-3.5 w-3.5" />;
    case 'detect_anomaly':
      return <AlertTriangle className="h-3.5 w-3.5" />;
    case 'get_chart_image':
      return <ImageIcon className="h-3.5 w-3.5" />;
    case 'smart_drilldown':
      return <Filter className="h-3.5 w-3.5" />;
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

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[chart:\d+(?:\s*[—–-]\s*"[^"\]]+")?\]|\[HIGH\]|\[MED\]|\[LOW\])/g;

function renderInline(text: string): React.ReactNode[] {
  if (!text) return [];
  const parts = text.split(INLINE_PATTERN);
  const out: React.ReactNode[] = [];
  parts.forEach((part, idx) => {
    if (!part) return;
    if (part.startsWith('**') && part.endsWith('**')) {
      // Recurse so [chart:N] / [HIGH] tags inside bold text still render as chips
      out.push(<strong key={idx}>{renderInline(part.slice(2, -2))}</strong>);
      return;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      // Recurse so tags inside italic text still render as chips
      out.push(<em key={idx}>{renderInline(part.slice(1, -1))}</em>);
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
    // Match either short `[chart:N]` or long `[chart:N — "Title"]`
    const cm = /^\[chart:(\d+)(?:\s*[—–-]\s*"([^"]+)")?\]$/.exec(part);
    if (cm) {
      out.push(<ChartChip key={idx} chartId={Number(cm[1])} chartName={cm[2] || undefined} />);
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

function ChartChip({ chartId, chartName }: { chartId: number; chartName?: string }) {
  // If the model only emitted `[chart:N]`, look up the name from the
  // dashboard manifest so the user sees the chart TITLE, not a raw id.
  const namesMap = React.useContext(ChartNamesContext);
  const resolvedName = chartName || namesMap.get(chartId);

  const handleClick = () => {
    const target = document.querySelector(`[data-chart-id="${chartId}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('ring-2', 'ring-brand', 'ring-offset-2');
      setTimeout(() => target.classList.remove('ring-2', 'ring-brand', 'ring-offset-2'), 1800);
    }
  };
  // Prefer the chart name as the visible label. Fall back to `chart:N` only
  // when we have no name (e.g. before recon has loaded). The id is shown as
  // a small monospace suffix only on hover via tooltip, never in-line.
  const label = resolvedName || `chart:${chartId}`;
  const tooltip = resolvedName
    ? `Bấm để xem "${resolvedName}" trên dashboard (#${chartId})`
    : `Bấm để xem biểu đồ #${chartId} trên dashboard`;
  return (
    <button
      onClick={handleClick}
      className="mx-0.5 inline-flex max-w-[260px] items-center gap-1 truncate rounded bg-brand/10 px-1.5 py-0 align-baseline text-[0.78em] font-strong text-brand transition-colors hover:bg-brand/20"
      title={tooltip}
    >
      <BarChart3 className="h-2.5 w-2.5 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

const _CONFIDENCE_TOOLTIPS: Record<'HIGH' | 'MED' | 'LOW', string> = {
  HIGH: 'Đọc trực tiếp từ dữ liệu biểu đồ',
  MED: 'Tính từ phép tính trên dữ liệu biểu đồ',
  LOW: 'Quan sát định tính, không khẳng định chắc chắn',
};

function ConfidenceBadge({ level }: { level: 'HIGH' | 'MED' | 'LOW' }) {
  const cls =
    level === 'HIGH' ? 'bg-success/15 text-success'
    : level === 'MED' ? 'bg-warning/15 text-warning'
    : 'bg-text-tertiary/15 text-text-tertiary';
  return (
    <span
      className={`mx-0.5 inline-flex cursor-help items-center rounded px-1 py-0 text-[0.65em] font-strong ${cls}`}
      title={_CONFIDENCE_TOOLTIPS[level]}
    >
      {level}
    </span>
  );
}
