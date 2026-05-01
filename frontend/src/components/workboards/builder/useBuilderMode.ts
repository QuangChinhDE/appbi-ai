'use client';

import { useEffect, useState } from 'react';

export type BuilderMode = 'basic' | 'advanced';

const KEY = 'workboard-builder-mode';

export function useBuilderMode(): [BuilderMode, (next: BuilderMode) => void] {
  const [mode, setMode] = useState<BuilderMode>('basic');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'basic' || saved === 'advanced') setMode(saved);
  }, []);

  const update = (next: BuilderMode) => {
    setMode(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(KEY, next);
    }
  };

  return [mode, update];
}
