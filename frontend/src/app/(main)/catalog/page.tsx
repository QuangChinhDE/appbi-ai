'use client';

// The single "Catalog" module was split into Govern + Observability.
// Keep this route as a redirect for any existing bookmarks.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function CatalogRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/govern');
  }, [router]);
  return null;
}
