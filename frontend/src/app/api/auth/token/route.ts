/**
 * Returns a WebSocket ticket for AI services.
 * If the browser access token just expired, this route silently refreshes the
 * AppBI session first so active users are not forced back to login mid-session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SignJWT, jwtVerify } from 'jose';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000/api/v1';
const ACCESS_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const LEGACY_REFRESH_COOKIE_PATH = '/api/auth/refresh';

function getSecret(): Uint8Array {
  const secret = process.env.SECRET_KEY ?? 'change-this-in-production';
  return new TextEncoder().encode(secret);
}

async function verifyAccessToken(token?: string): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'],
    });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clearAuthCookies(response: NextResponse): void {
  response.cookies.set({
    name: 'access_token',
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: 0,
    path: '/',
  });
  response.cookies.set({
    name: 'refresh_token',
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: 0,
    path: '/',
  });
  response.cookies.set({
    name: 'refresh_token',
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: 0,
    path: LEGACY_REFRESH_COOKIE_PATH,
  });
}

function applyAuthCookies(response: NextResponse, accessToken: string, refreshToken?: string): void {
  response.cookies.set({
    name: 'access_token',
    value: accessToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    path: '/',
  });

  if (!refreshToken) return;

  response.cookies.set({
    name: 'refresh_token',
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: 0,
    path: LEGACY_REFRESH_COOKIE_PATH,
  });
  response.cookies.set({
    name: 'refresh_token',
    value: refreshToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
    path: '/',
  });
}

async function refreshSession(refreshToken?: string): Promise<{ accessToken: string; refreshToken?: string } | null> {
  if (!refreshToken) return null;

  try {
    const backendRes = await fetch(`${BACKEND_URL}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${refreshToken}`,
      },
    });

    if (!backendRes.ok) {
      return null;
    }

    const data = await backendRes.json();
    const setCookieHeaders = backendRes.headers.getSetCookie?.() ?? [];
    const newRefreshToken = setCookieHeaders
      .find((cookieStr) => cookieStr.startsWith('refresh_token='))
      ?.split('=')[1]
      ?.split(';')[0];

    return {
      accessToken: data.access_token,
      refreshToken: newRefreshToken,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  let accessToken = req.cookies.get('access_token')?.value;
  let payload = await verifyAccessToken(accessToken);

  if (!payload) {
    const refreshed = await refreshSession(req.cookies.get('refresh_token')?.value);
    if (!refreshed) {
      const response = NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      clearAuthCookies(response);
      return response;
    }

    accessToken = refreshed.accessToken;
    payload = await verifyAccessToken(accessToken);
    if (!payload) {
      const response = NextResponse.json({ error: 'Invalid token' }, { status: 401 });
      clearAuthCookies(response);
      return response;
    }

    // Issue a WS ticket scoped to AI service use.
    // TTL is 2h so it covers the longest AI sessions (intent=INSIGHT can take minutes).
    const ticket = await new SignJWT({
      sub: payload.sub as string,
      ai_level: payload.ai_level,
      ai_chat_level: payload.ai_chat_level,
      ai_agent_level: payload.ai_agent_level,
      purpose: 'ws_ticket',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('2h')
      .setJti(crypto.randomUUID())
      .sign(getSecret());

    const response = NextResponse.json({ token: ticket });
    applyAuthCookies(response, accessToken, refreshed.refreshToken);
    return response;
  }

  // Issue a WS ticket scoped to AI service use.
  // TTL is 2h so it covers the longest AI sessions (intent=INSIGHT can take minutes).
  // The ticket is signed with the same key as the access_token so the security
  // level is equivalent — extending TTL does not weaken the signature.
  const ticket = await new SignJWT({
    sub: payload.sub as string,
    ai_level: payload.ai_level,
    ai_chat_level: payload.ai_chat_level,
    ai_agent_level: payload.ai_agent_level,
    purpose: 'ws_ticket',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .setJti(crypto.randomUUID())
    .sign(getSecret());

  return NextResponse.json({ token: ticket });
}
