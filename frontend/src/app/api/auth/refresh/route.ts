/**
 * Next.js API route — token refresh proxy.
 *
 * Forwards the refresh_token cookie to the backend /auth/refresh endpoint,
 * and sets updated access_token + refresh_token cookies on the Next.js origin.
 */
import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000/api/v1';
const ACCESS_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const LEGACY_REFRESH_COOKIE_PATH = '/api/auth/refresh';

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('refresh_token')?.value;

  if (!refreshToken) {
    const response = NextResponse.json({ error: 'No refresh token' }, { status: 401 });
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
    return response;
  }

  let backendRes: Response;
  try {
    backendRes = await fetch(`${BACKEND_URL}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${refreshToken}`,
      },
    });
  } catch {
    return NextResponse.json({ detail: 'Cannot reach backend' }, { status: 502 });
  }

  const data = await backendRes.json();

  if (!backendRes.ok) {
    // Clear stale cookies on auth failure
    const errorResponse = NextResponse.json(data, { status: backendRes.status });
    errorResponse.cookies.set({
      name: 'access_token',
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE !== 'false',
      maxAge: 0,
      path: '/',
    });
    errorResponse.cookies.set({
      name: 'refresh_token',
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE !== 'false',
      maxAge: 0,
      path: '/',
    });
    errorResponse.cookies.set({
      name: 'refresh_token',
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE !== 'false',
      maxAge: 0,
      path: LEGACY_REFRESH_COOKIE_PATH,
    });
    return errorResponse;
  }

  const token: string = data.access_token;
  const response = NextResponse.json(data, { status: 200 });

  // Set new access token
  response.cookies.set({
    name: 'access_token',
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    path: '/',
  });

  // Proxy new refresh token from backend
  const setCookieHeaders = backendRes.headers.getSetCookie?.() ?? [];
  for (const cookieStr of setCookieHeaders) {
    if (cookieStr.startsWith('refresh_token=')) {
      const value = cookieStr.split('=')[1]?.split(';')[0] ?? '';
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
        value,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE !== 'false',
        maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
        path: '/',
      });
    }
  }

  return response;
}
