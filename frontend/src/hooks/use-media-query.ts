'use client';

import { useEffect, useState } from 'react';

/** Tailwind's default breakpoints, so a JS decision matches the CSS one. */
export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } as const;
export type Breakpoint = keyof typeof BREAKPOINTS;

/** True when the viewport is at least `bp` (a breakpoint or px) wide. False during SSR. */
export function useMinWidth(bp: Breakpoint | number): boolean {
  const query = `(min-width: ${typeof bp === 'number' ? bp : BREAKPOINTS[bp]}px)`;
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
