/**
 * Home page - redirect to the Overview module
 */
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.push('/overview');
  }, [router]);

  return (
    <div className="min-h-screen bg-surface-2 flex items-center justify-center">
      <div className="text-center">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-brand"></div>
        <p className="text-text-secondary mt-4">Loading…</p>
      </div>
    </div>
  );
}
