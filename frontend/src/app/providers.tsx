'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

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

  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        {children}
        <Toaster position="bottom-right" richColors />
      </LanguageProvider>
    </QueryClientProvider>
  );
}

