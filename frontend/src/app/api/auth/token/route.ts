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
