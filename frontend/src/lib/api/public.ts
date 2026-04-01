/**
 * Public (unauthenticated) API calls for shared dashboard links.
 * Uses a plain fetch so no auth cookies are sent.
 *
 * Password-protected links:
 *   1. Call `publicDashboardApi.auth(token, password)` → get { session_token, expires_in }
 *   2. Store with `savePublicSession(token, session_token, expires_in)`
 *   3. Pass the token when calling get() / getChartData()
 *
 * Sessions expire after 2 hours (server-enforced via JWT expiry).
 */
import axios from 'axios';
import type { Dashboard } from '@/types/api';

// NEXT_PUBLIC_API_URL is baked as '/api/v1' (relative) so it works on any domain.
// Next.js rewrites or nginx proxy the requests to the backend.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

// Axios instance without credentials so no auth cookie leaks
const publicClient = axios.create({
  baseURL: API_BASE,
  withCredentials: false,
});

export const publicDashboardApi = {
  /** Exchange a link password for a 2-hour session token. */
  auth: async (
    token: string,
    password: string,
  ): Promise<{ session_token: string; expires_in: number }> => {
    const res = await publicClient.post(`/public/dashboards/${token}/auth`, { password });
    return res.data;
  },

  get: async (token: string, sessionToken?: string): Promise<Dashboard> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(`/public/dashboards/${token}`, { headers });
    return res.data;
  },

  getChartData: async (token: string, chartId: number, sessionToken?: string): Promise<any> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(
      `/public/dashboards/${token}/charts/${chartId}/data`,
      { headers },
    );
    return res.data;
  },
};

// ── Session storage helpers ──────────────────────────────────────────────────
// Sessions are stored per-link in sessionStorage so they are scoped to the tab
// and automatically cleared when the browser tab is closed.

const SESSION_KEY_PREFIX = 'appbi_pub_session_';

interface StoredSession {
  sessionToken: string;
  expiresAt: number; // ms since epoch
}

export function savePublicSession(
  linkToken: string,
  sessionToken: string,
  expiresIn: number,
): void {
  const payload: StoredSession = {
    sessionToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  try {
    sessionStorage.setItem(SESSION_KEY_PREFIX + linkToken, JSON.stringify(payload));
  } catch { /* sessionStorage unavailable (SSR or private mode) */ }
}

export function getPublicSession(linkToken: string): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PREFIX + linkToken);
    if (!raw) return null;
    const { sessionToken, expiresAt }: StoredSession = JSON.parse(raw);
    if (Date.now() >= expiresAt) {
      sessionStorage.removeItem(SESSION_KEY_PREFIX + linkToken);
      return null;
    }
    return sessionToken;
  } catch {
    return null;
  }
}

export function clearPublicSession(linkToken: string): void {
  try {
    sessionStorage.removeItem(SESSION_KEY_PREFIX + linkToken);
  } catch { /* ignore */ }
}

/** How many seconds remain in the stored session (0 if expired/missing). */
export function publicSessionRemainingSeconds(linkToken: string): number {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PREFIX + linkToken);
    if (!raw) return 0;
    const { expiresAt }: StoredSession = JSON.parse(raw);
    const remaining = Math.floor((expiresAt - Date.now()) / 1000);
    return Math.max(0, remaining);
  } catch {
    return 0;
  }
}

