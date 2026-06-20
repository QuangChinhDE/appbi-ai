'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { AppLanguage, messages, TranslationValues } from '@/i18n/messages';

const STORAGE_KEY = 'appbi.language';

interface LanguageContextValue {
  language: AppLanguage;
  /** True once the viewer has made an explicit choice (or one was restored from localStorage). */
  hasLocalPreference: boolean;
  /** Explicit viewer choice — persists to localStorage. Does NOT touch the backend (see useUserLanguage). */
  setLanguage: (next: AppLanguage) => void;
  /** Apply a server-derived preference WITHOUT marking it as an explicit local choice. No-op if a local choice exists. */
  applyServerLanguage: (next: AppLanguage) => void;
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

/**
 * Public-safe language provider. Holds language state from localStorage / browser only.
 * It NEVER calls an authenticated endpoint, so it is safe to mount at the app root —
 * including public link / embed / workspace-portal routes that must not trigger a
 * 401 -> /login redirect. Backend preference sync lives in `useUserLanguage` and is
 * only used inside the authenticated app shell.
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
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
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: AppLanguage) => {
    setLanguageState(next);
    setHasLocalPreference(true);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const applyServerLanguage = useCallback((next: AppLanguage) => {
    setHasLocalPreference((hasLocal) => {
      if (!hasLocal) setLanguageState(next);
      return hasLocal;
    });
  }, []);

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
      hasLocalPreference,
      setLanguage,
      applyServerLanguage,
      t,
      locale: language === 'vi' ? 'vi-VN' : 'en-US',
    }),
    [language, hasLocalPreference, setLanguage, applyServerLanguage, t],
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
