/**
 * Next.js API route - Google login proxy.
 *
 * Receives a Google credential, forwards it to the backend, and sets the
 * access_token cookie on the Next.js origin so middleware can read it.
 */
import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000/api/v1';
const ACCESS_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;
const LEGACY_REFRESH_COOKIE_PATH = '/api/auth/refresh';

export async function POST(req: NextRequest) {
  const body = await req.json();

  let backendRes: Response;
  try {
    backendRes = await fetch(`${BACKEND_URL}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ detail: 'Cannot reach backend' }, { status: 502 });
  }

  const data = await backendRes.json();

  if (!backendRes.ok) {
    return NextResponse.json(data, { status: backendRes.status });
  }

  const token: string = data.access_token;
  const response = NextResponse.json(data, { status: 200 });
  response.cookies.set({
    name: 'access_token',
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    path: '/',
  });

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
