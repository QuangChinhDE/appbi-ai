'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { APPBI_BUILD_SHA } from '@/lib/build-info';
import { Toaster } from '@/lib/toast';
import { LanguageProvider } from '@/providers/LanguageProvider';

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5 * 60 * 1000,   // data fresh for 5 min — avoids re-querying DuckDB on every mount
          gcTime:   10 * 60 * 1000,    // keep cache for 10 min — prevents memory bloat from large datasets
          refetchOnWindowFocus: false,
        },
      },
    })
  );

  // The bundle the browser is RUNNING says which build it is (the <meta> only
  // says which server rendered the HTML) — a stale cached bundle shows here.
  useEffect(() => {
    document.documentElement.dataset.appbiBuild = APPBI_BUILD_SHA;
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        {children}
        <Toaster position="bottom-right" richColors closeButton theme="light" />
      </LanguageProvider>
    </QueryClientProvider>
  );
}

