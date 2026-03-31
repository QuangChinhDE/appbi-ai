/**
 * AI service URL helpers.
 *
 * NEXT_PUBLIC_AI_* env vars are intentionally left EMPTY in the default config.
 * When empty, URLs are derived at RUNTIME from window.location so the app works
 * on any domain (localhost, staging, production) without rebuilding.
 *
 * Nginx routes (production):  /chat/*  → ai-chat-service:8001
 *                             /agent/* → ai-agent-service:8001
 * Dev rewrites (next.config.js): same routes via Docker internal container URLs.
 *
 * To override explicitly (e.g. external AI service):
 *   NEXT_PUBLIC_AI_CHAT_WS_URL=wss://custom-host/chat/ws
 *   NEXT_PUBLIC_AI_AGENT_HTTP_URL=https://custom-agent-host
 */

const _chatWsEnv = process.env.NEXT_PUBLIC_AI_CHAT_WS_URL
  || process.env.NEXT_PUBLIC_AI_WS_URL  // legacy compat
  || '';
const _chatHttpEnv = process.env.NEXT_PUBLIC_AI_CHAT_HTTP_URL || '';
const _agentHttpEnv = process.env.NEXT_PUBLIC_AI_AGENT_HTTP_URL || '';

/** WebSocket URL for AI Chat. Derived from current domain if not explicitly configured. */
export function getAiChatWsUrl(): string {
  if (_chatWsEnv) return _chatWsEnv;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/chat/ws`;
  }
  return 'ws://localhost:8001/chat/ws';
}

/** HTTP base URL for AI Chat API. Derived from current domain if not explicitly configured. */
export function getAiChatHttpUrl(): string {
  if (_chatHttpEnv) return _chatHttpEnv;
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://localhost:8001';
}

/**
 * HTTP base URL for AI Agent API. Derived from current domain if not explicitly configured.
 * NOTE: Agent API routes live under /agent/ prefix on both the service and via nginx.
 *       Health check uses /agent/health, plan/build use /agent/plan|build/stream.
 */
export function getAiAgentHttpUrl(): string {
  if (_agentHttpEnv) return _agentHttpEnv;
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://localhost:8002';
}

