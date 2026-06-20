'use client';

import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { authApi } from '@/lib/api-client';
import { useCurrentUser } from '@/hooks/use-current-user';
import { useI18n } from '@/providers/LanguageProvider';
import type { AppLanguage } from '@/i18n/messages';

/**
 * Authenticated-app language hook. Wraps the public-safe `useI18n` with the two
 * concerns that require an authenticated session and therefore must NEVER run on
 * public/embed/portal routes:
 *   1. apply the logged-in user's saved `preferred_language` (unless the viewer
 *      already made an explicit local choice), and
 *   2. persist explicit choices back to the backend.
 *
 * Only call this from components rendered inside the authenticated app shell
 * (e.g. the Sidebar). Public surfaces should call `useI18n` directly.
 */
export function useUserLanguage() {
  const { language, locale, t, setLanguage, applyServerLanguage, hasLocalPreference } = useI18n();
  const { data: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();

  useEffect(() => {
    const pref = currentUser?.preferred_language;
    if (pref === 'en' || pref === 'vi') {
      applyServerLanguage(pref);
    }
  }, [currentUser?.preferred_language, applyServerLanguage]);

  const setLanguagePersisted = useCallback(
    async (next: AppLanguage) => {
      setLanguage(next);
      try {
        await authApi.updatePreferences({ preferred_language: next });
        queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      } catch (error) {
        console.error('Failed to update language preference', error);
      }
    },
    [setLanguage, queryClient],
  );

  return { language, locale, t, setLanguage: setLanguagePersisted, hasLocalPreference };
}
