import { NextRequest, NextResponse } from 'next/server';

// Server-side proxy to a routing provider so the browser never calls it
// directly (avoids CORS/CSP differences across mini-app deployments). The
// provider base URL is env-configurable — the public OSRM demo server
// (router.project-osrm.org) is rate-limited and not meant for heavy/commercial
// use, so a deployment should point OSRM_BASE_URL at its own instance.
const OSRM_BASE = (
  process.env.OSRM_BASE_URL || 'https://router.project-osrm.org'
).replace(/\/+$/, '');

type CoordinateInput = {
  lat?: unknown;
  lng?: unknown;
};

const MAX_OSRM_STOPS = 50;

function parseCoordinate(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

export async function POST(request: NextRequest) {
  let body: { coordinates?: CoordinateInput[]; profile?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON body.' }, { status: 400 });
  }

  const profile = body.profile === 'driving' || !body.profile ? 'driving' : null;
  if (!profile) {
    return NextResponse.json({ detail: 'Unsupported route profile.' }, { status: 400 });
  }

  const coordinates = Array.isArray(body.coordinates)
    ? body.coordinates
        .map((item) => {
          const lat = parseCoordinate(item?.lat);
          const lng = parseCoordinate(item?.lng);
          return lat == null || lng == null ? null : { lat, lng };
        })
        .filter((item): item is { lat: number; lng: number } => !!item)
    : [];

  if (coordinates.length < 2) {
    return NextResponse.json({ line: null, reason: 'not_enough_points' });
  }
  if (coordinates.length > MAX_OSRM_STOPS) {
    return NextResponse.json({ line: null, reason: 'too_many_points' });
  }

  const osrmCoordinates = coordinates
    .map((point) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`)
    .join(';');
  const url = `${OSRM_BASE}/route/v1/${profile}/${osrmCoordinates}?overview=full&geometries=geojson&steps=false`;

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        'User-Agent': 'AppBI-Workboards/1.0 route-map',
      },
    });
    if (!response.ok) {
      return NextResponse.json({ line: null, reason: 'provider_error' }, { status: 200 });
    }
    const payload = await response.json();
    const rawLine = payload?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(rawLine)) {
      return NextResponse.json({ line: null, reason: payload?.code || 'no_route' });
    }
    const line: Array<[number, number]> = rawLine
      .map((item: unknown): [number, number] | null => {
        if (!Array.isArray(item) || item.length < 2) return null;
        const lng = Number(item[0]);
        const lat = Number(item[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
      })
      .filter((item): item is [number, number] => !!item);

    return NextResponse.json({
      line: line.length >= 2 ? line : null,
      provider: 'osrm',
      profile,
      reason: line.length >= 2 ? null : 'empty_route',
    });
  } catch {
    return NextResponse.json({ line: null, reason: 'request_failed' }, { status: 200 });
  }
}
