/**
 * Returns a short-lived, single-use WebSocket ticket.
 * The ticket is a JWT with a 30-second TTL and purpose="ws_ticket".
 * Used by client components to authenticate WebSocket/SSE connections
 * to AI services where cookies cannot be forwarded automatically.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SignJWT, jwtVerify } from 'jose';

function getSecret(): Uint8Array {
  const secret = process.env.SECRET_KEY ?? 'change-this-in-production';
  return new TextEncoder().encode(secret);
}

export async function GET(req: NextRequest) {
  const accessToken = req.cookies.get('access_token')?.value;
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Verify the access token first
  let payload: Record<string, unknown>;
  try {
    const { payload: p } = await jwtVerify(accessToken, getSecret(), {
      algorithms: ['HS256'],
    });
    payload = p as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  // Issue a short-lived WS ticket (30 seconds, single purpose)
  const ticket = await new SignJWT({
    sub: payload.sub as string,
    ai_level: payload.ai_level,
    ai_chat_level: payload.ai_chat_level,
    ai_agent_level: payload.ai_agent_level,
    purpose: 'ws_ticket',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30s')
    .setJti(crypto.randomUUID())
    .sign(getSecret());

  return NextResponse.json({ token: ticket });
}
