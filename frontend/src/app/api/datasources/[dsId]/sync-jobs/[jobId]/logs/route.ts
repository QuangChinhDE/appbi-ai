import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{
    dsId: string;
    jobId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: Params) {
  const { dsId, jobId } = await params;
  const backendUrl = process.env.BACKEND_URL || 'http://backend:8000/api/v1';
  const url = new URL(`${backendUrl}/datasources/${dsId}/sync-jobs/${jobId}/logs`);
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const cookieHeader = req.headers.get('cookie') || '';
  const upstream = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    cache: 'no-store',
  });

  if (!upstream.ok || !upstream.body) {
    const message = await upstream.text();
    return new Response(message || 'Failed to open sync log stream', {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}