const LEGACY_CHAT_WS_URL = process.env.NEXT_PUBLIC_AI_WS_URL;

export const AI_CHAT_WS_URL =
  process.env.NEXT_PUBLIC_AI_CHAT_WS_URL ||
  LEGACY_CHAT_WS_URL ||
  'ws://localhost:8001/chat/ws';

export const AI_CHAT_HTTP_URL =
  process.env.NEXT_PUBLIC_AI_CHAT_HTTP_URL ||
  AI_CHAT_WS_URL.replace(/^ws/, 'http').replace('/chat/ws', '');

export const AI_AGENT_HTTP_URL =
  process.env.NEXT_PUBLIC_AI_AGENT_HTTP_URL ||
  'http://localhost:8002';

