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
  // Proxy requests to backend and AI services so all NEXT_PUBLIC_* URLs can be
  // relative paths (domain-agnostic). These rewrites are the fallback when there
  // is NO nginx in front (localhost dev). On production nginx intercepts first.
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:8000/api/v1';
    const backendBase = backendUrl.replace(/\/api\/v1\/?$/, '');
    const chatBase = process.env.AI_CHAT_INTERNAL_URL || 'http://ai-chat-service:8001';
    const agentBase = process.env.AI_AGENT_INTERNAL_URL || 'http://ai-agent-service:8001';
    return [
      // REST API → backend
      { source: '/api/v1/:path*', destination: `${backendBase}/api/v1/:path*` },
      // AI Chat (HTTP + WebSocket)
      { source: '/chat/:path*', destination: `${chatBase}/chat/:path*` },
      // AI Agent
      { source: '/agent/:path*', destination: `${agentBase}/agent/:path*` },
    ];
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '/api/v1',
    // AI URLs are intentionally NOT baked here.
    // frontend/src/lib/ai-services.ts derives them at runtime from window.location,
    // unless the deploy environment explicitly sets NEXT_PUBLIC_AI_* overrides.
  },
};

module.exports = nextConfig;
