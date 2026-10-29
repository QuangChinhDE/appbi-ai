import { readFile } from 'fs/promises';
import path from 'path';

import { NextResponse } from 'next/server';

export async function GET() {
  const iconPath = path.join(process.cwd(), 'public', 'icon-192.png');
  const png = await readFile(iconPath);
  return new NextResponse(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}
