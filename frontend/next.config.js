/** @type {import('next').NextConfig} */
const path = require('path');
const fs = require('fs');

// Load root .env (single source of truth for the whole project)
const rootEnvPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(rootEnvPath)) {
  fs.readFileSync(rootEnvPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
}

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Prevent Next.js from stripping trailing slashes via 308 redirects.
  // Without this, /api/v1/datasources/ gets redirected to /api/v1/datasources,
  // then FastAPI redirects back with Location: http://backend:8000/... exposing
  // the internal Docker hostname to the browser and causing CORS errors.
  skipTrailingSlashRedirect: true,
  // Proxy requests to backend and AI services so all NEXT_PUBLIC_* URLs can be
  // relative paths (domain-agnostic). These rewrites are the fallback when there
  // is NO nginx in front (localhost dev). On production nginx intercepts first.
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:8000/api/v1';
    const backendBase = backendUrl.replace(/\/api\/v1\/?$/, '');
    const chatBase = process.env.AI_CHAT_INTERNAL_URL || 'http://ai-chat-service:8001';
    const agentBase = process.env.AI_AGENT_INTERNAL_URL || 'http://ai-agent-service:8001';
    return [
      // REST API proxying is handled by middleware.ts (preserves trailing
      // slashes that next.config.js rewrites strip, avoiding FastAPI redirects
      // that leak the internal Docker hostname).
      // AI Chat: keep page routes like /chat/[sessionId] on Next.js and
      // proxy only the service endpoints that actually belong to ai-chat-service.
      // NOTE: /chat/ws WebSocket upgrade is NOT proxied by Next.js rewrites.
      // The browser must connect directly using NEXT_PUBLIC_AI_CHAT_WS_URL.
      { source: '/chat/ws', destination: `${chatBase}/chat/ws` },
      { source: '/chat/stream', destination: `${chatBase}/chat/stream` },
      { source: '/chat/sessions', destination: `${chatBase}/chat/sessions` },
      { source: '/chat/sessions/:path*', destination: `${chatBase}/chat/sessions/:path*` },
      { source: '/chat/cleanup', destination: `${chatBase}/chat/cleanup` },
      // New AI Chat endpoints (Phase 1-4 upgrade)
      { source: '/chat/initial-suggestions', destination: `${chatBase}/chat/initial-suggestions` },
      { source: '/chat/rate-limits', destination: `${chatBase}/chat/rate-limits` },
      { source: '/chat/usage/:path*', destination: `${chatBase}/chat/usage/:path*` },
      { source: '/chat/admin/:path*', destination: `${chatBase}/chat/admin/:path*` },
      // AI Agent
      { source: '/agent/:path*', destination: `${agentBase}/agent/:path*` },
    ];
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '/api/v1',
    // WebSocket URL must be baked — Next.js rewrites can't proxy WS upgrades.
    // Set NEXT_PUBLIC_AI_CHAT_WS_URL in .env:
    //   Local dev (no nginx): ws://localhost:8001/chat/ws
    //   Production (nginx):   wss://yourdomain.com/chat/ws  (or leave empty)
    NEXT_PUBLIC_AI_CHAT_WS_URL: process.env.NEXT_PUBLIC_AI_CHAT_WS_URL || '',
  },
};

module.exports = nextConfig;
