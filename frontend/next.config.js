/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Enable standalone output for Docker
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1',
    NEXT_PUBLIC_AI_WS_URL: process.env.NEXT_PUBLIC_AI_WS_URL || 'ws://localhost:8001/chat/ws',
  },
}

module.exports = nextConfig
