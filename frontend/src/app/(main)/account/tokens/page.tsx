'use client';

import { PersonalTokensPanel } from '@/components/settings/TokensTab';
import { useI18n } from '@/providers/LanguageProvider';

export default function PersonalAccessTokensPage() {
  const { t } = useI18n();
  return (
    <div className="w-full max-w-[1200px] px-8 py-6">
      <div className="mb-6">
        <h1 className="text-h1 font-emphasis text-text-primary">{t('settings.tokens.title')}</h1>
        <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.description')}</p>
      </div>
      <PersonalTokensPanel />
    </div>
  );
}
