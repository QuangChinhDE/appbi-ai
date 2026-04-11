import { readFile } from 'fs/promises';
import path from 'path';

import { NextResponse } from 'next/server';

export async function GET() {
  const iconPath = path.join(process.cwd(), 'src', 'app', 'icon.svg');
  const svg = await readFile(iconPath, 'utf8');
  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}
