/**
 * Next.js API route — login proxy.
 *
 * Receives email/password, forwards to the backend, and sets the
 * access_token cookie on the NEXT.JS origin (port 3000) so that
 * the Edge middleware can read it during server-side navigation.
 */
import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000/api/v1';

export async function POST(req: NextRequest) {
  const body = await req.json();

  let backendRes: Response;
  try {
    backendRes = await fetch(`${BACKEND_URL}/auth/login`, {
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

  // Set access_token cookie on the Next.js origin so middleware can read it
  const token: string = data.access_token;
  const maxAge = 24 * 60 * 60; // 24 hours, matching backend

  const response = NextResponse.json(data, { status: 200 });
  response.cookies.set({
    name: 'access_token',
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge,
    path: '/',
  });

  return response;
}
