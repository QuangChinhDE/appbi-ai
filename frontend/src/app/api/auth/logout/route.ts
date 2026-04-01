/**
 * Next.js API route — logout proxy.
 *
 * Calls backend logout, then clears the access_token cookie on the
 * Next.js origin.
 */
import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000/api/v1';

export async function POST(req: NextRequest) {
  const cookie = req.cookies.get('access_token')?.value;

  // Forward to backend (ignore errors — we clear client cookie regardless)
  try {
    await fetch(`${BACKEND_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: `access_token=${cookie}` } : {}),
      },
    });
  } catch {
    // Ignore backend errors — clear client cookie anyway
  }

  const response = NextResponse.json({ ok: true });
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
    path: '/api/auth/refresh',
  });

  return response;
}
