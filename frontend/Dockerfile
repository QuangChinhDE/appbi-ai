# Frontend Dockerfile for Next.js application
# Multi-stage build for optimal image size

# Stage 1: Dependencies
FROM node:18-alpine AS deps
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Stage 2: Builder
# Stage 2: Builder
FROM node:18-alpine AS builder
WORKDIR /app

# Public frontend settings must be available at build time so Next.js can
# inline them into the browser bundle.
ARG NEXT_PUBLIC_API_URL=/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_PASSWORD_LOGIN_ENABLED=true
ENV NEXT_PUBLIC_AUTH_PASSWORD_LOGIN_ENABLED=$NEXT_PUBLIC_AUTH_PASSWORD_LOGIN_ENABLED
ARG NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=false
ENV NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=$NEXT_PUBLIC_AUTH_GOOGLE_ENABLED
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
# WebSocket URL must be baked at build time — Next.js rewrites cannot proxy
# WebSocket upgrades. Set to ws://localhost:8001/chat/ws for local dev,
# or wss://yourdomain.com/chat/ws for production with nginx.
ARG NEXT_PUBLIC_AI_CHAT_WS_URL=
ENV NEXT_PUBLIC_AI_CHAT_WS_URL=$NEXT_PUBLIC_AI_CHAT_WS_URL

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY . .

# Set environment variable for build
ENV NEXT_TELEMETRY_DISABLED 1

# Build Next.js application
RUN npm run build

# Stage 3: Runner
FROM node:18-alpine AS runner
WORKDIR /app

# Set to production environment
ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Set correct permissions
RUN chown -R nextjs:nodejs /app

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Set port environment variable
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

# Start the application
CMD ["node", "server.js"]
