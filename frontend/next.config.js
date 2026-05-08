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
  async rewrites() {
    return [
      // REST API proxying is handled by middleware.ts.
    ];
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '/api/v1',
  },
};

module.exports = nextConfig;
