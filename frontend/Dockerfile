# Frontend Dockerfile for Next.js application
# Multi-stage build for optimal image size

# Stage 1: Dependencies
FROM node:18-alpine AS deps
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies. `npm ci` honors package-lock.json strictly and is
# reproducible — `npm install` could re-resolve caret ranges and pull a
# different minor/major across builds.
#
# Phase-15.72 — same resilience pattern as backend Dockerfile. npm
# defaults give up after 1 retry which is too brittle for spotty
# CI/dev networks. 5 retries × 60s timeout = 5min budget per request
# before fail; whole `npm ci` still bounded by the surrounding build
# timeout. fetch-retry-mintimeout/maxtimeout add jitter between
# retries so we don't slam the registry instantly.
RUN npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set fetch-timeout 60000 \
    && npm ci --prefer-offline --no-audit --no-fund

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
ARG NEXT_PUBLIC_WORKBOARDS_ENABLED=false
ENV NEXT_PUBLIC_WORKBOARDS_ENABLED=$NEXT_PUBLIC_WORKBOARDS_ENABLED
# PDF export delivery — false: progress on the report + download only;
# true also opens the finished PDF in a second tab. Inlined by `next build`.
ARG NEXT_PUBLIC_PDF_PREVIEW_TAB=false
ENV NEXT_PUBLIC_PDF_PREVIEW_TAB=$NEXT_PUBLIC_PDF_PREVIEW_TAB
# Home ("Trang chủ" / Overview) module. Off: the sidebar row is gone and `/`
# lands on Dashboards. See frontend/src/lib/feature-flags.ts.
ARG NEXT_PUBLIC_HOME_MODULE_ENABLED=false
ENV NEXT_PUBLIC_HOME_MODULE_ENABLED=$NEXT_PUBLIC_HOME_MODULE_ENABLED

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

# Copy necessary files from builder (--chown avoids a slow recursive chown)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Set port environment variable
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

# Start the application
CMD ["node", "server.js"]
