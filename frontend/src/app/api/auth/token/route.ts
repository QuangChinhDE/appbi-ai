/**
 * Returns the raw JWT access_token from the httpOnly cookie.
 * Used by client components that need to authenticate to external services
 * (e.g. AI service WebSocket) where cookies cannot be forwarded automatically.
 */
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const token = req.cookies.get('access_token')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  return NextResponse.json({ token });
}
