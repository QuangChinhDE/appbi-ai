'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * URL-as-state for tabbed / master-detail pages. Reading a param drives the
 * view; `set` updates the query string (soft replace, no scroll jump) so the
 * tab/detail survives F5, is shareable, and back/forward works — instead of
 * React state that resets to the main screen on refresh.
 */
export function useUrlNav() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const set = useCallback(
    (updates: Record<string, string | null | undefined>, opts?: { push?: boolean }) => {
      const next = new URLSearchParams(Array.from(sp.entries()));
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      // Default stays a soft replace. `push` adds a history entry, for a move
      // between distinct views (list -> detail) that Back should undo.
      if (opts?.push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, pathname, sp],
  );

  return { get: (k: string) => sp.get(k), set };
}
