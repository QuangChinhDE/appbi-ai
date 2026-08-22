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
  experimental: {
    // HOW LONG THE PROXY WAITS FOR THE BACKEND.
    //
    // Every /api/v1/* call reaches FastAPI through the rewrite in middleware.ts,
    // and Next's default patience for a proxied request is 30 seconds. Past that
    // it hangs up the socket and answers the browser 500 — while the backend keeps
    // going and COMPLETES the work. That failure mode is worse than a slow call:
    // an Agent Flow test on a cold report takes ~28-40s, the author saw "test
    // failed", and the run had in fact succeeded and was already written to the
    // Runs tab. The same wall sits in front of every other long operation that
    // answers in one response — building a snapshot, publishing a dataset,
    // exporting a PDF — which is why this is set here rather than worked around
    // in one screen.
    //
    // Two minutes: comfortably past the slowest real operation, and still short
    // enough that a genuinely hung request fails instead of holding a socket open.
    proxyTimeout: 120_000,
  },
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
