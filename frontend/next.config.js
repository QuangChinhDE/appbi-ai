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
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1',
    NEXT_PUBLIC_AI_WS_URL: process.env.NEXT_PUBLIC_AI_WS_URL || 'ws://localhost:8001/chat/ws',
    NEXT_PUBLIC_AI_CHAT_WS_URL:
      process.env.NEXT_PUBLIC_AI_CHAT_WS_URL || process.env.NEXT_PUBLIC_AI_WS_URL || 'ws://localhost:8001/chat/ws',
    NEXT_PUBLIC_AI_CHAT_HTTP_URL:
      process.env.NEXT_PUBLIC_AI_CHAT_HTTP_URL || 'http://localhost:8001',
    NEXT_PUBLIC_AI_AGENT_HTTP_URL:
      process.env.NEXT_PUBLIC_AI_AGENT_HTTP_URL || 'http://localhost:8002',
  },
};

module.exports = nextConfig;
