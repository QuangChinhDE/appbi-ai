'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { authApi } from '@/lib/api-client';
import { useCurrentUser } from '@/hooks/use-current-user';
import { AppLanguage, messages, TranslationValues } from '@/i18n/messages';

const STORAGE_KEY = 'appbi.language';

interface LanguageContextValue {
  language: AppLanguage;
  setLanguage: (next: AppLanguage) => Promise<void>;
  t: (key: string, values?: TranslationValues) => string;
  locale: string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function isAppLanguage(value: string | null | undefined): value is AppLanguage {
  return value === 'en' || value === 'vi';
}

function interpolate(template: string, values?: TranslationValues): string {
  if (!values) return template;
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    template,
  );
}

function getBrowserLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'en';
  const language = window.navigator.language.toLowerCase();
  return language.startsWith('vi') ? 'vi' : 'en';
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [language, setLanguageState] = useState<AppLanguage>('en');
  const [hasLocalPreference, setHasLocalPreference] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current || typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isAppLanguage(stored)) {
      setLanguageState(stored);
      setHasLocalPreference(true);
    } else {
      setLanguageState(getBrowserLanguage());
    }
    initializedRef.current = true;
  }, []);

  useEffect(() => {
    if (!initializedRef.current || hasLocalPreference) return;
    if (currentUser?.preferred_language && isAppLanguage(currentUser.preferred_language)) {
      setLanguageState(currentUser.preferred_language);
    }
  }, [currentUser?.preferred_language, hasLocalPreference]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback(
    async (next: AppLanguage) => {
      setLanguageState(next);
      setHasLocalPreference(true);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
      if (!currentUser) return;
      try {
        await authApi.updatePreferences({ preferred_language: next });
        queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      } catch (error) {
        console.error('Failed to update language preference', error);
      }
    },
    [currentUser, queryClient],
  );

  const t = useCallback(
    (key: string, values?: TranslationValues) => {
      const template = messages[language][key] ?? messages.en[key] ?? key;
      return interpolate(template, values);
    },
    [language],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t,
      locale: language === 'vi' ? 'vi-VN' : 'en-US',
    }),
    [language, setLanguage, t],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useI18n must be used inside LanguageProvider');
  }
  return context;
}
