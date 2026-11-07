'use client';

/**
 * The publisher's options for a link's Public Read MCP (viewers connect their OWN Claude).
 * Shown only when the "Claude" mode is picked in the AI Bot tab (`mcp_access.enabled`).
 * Stored in the link's appearance (`mcp_access`); the server never serves it to viewers
 * (they learn only `mcp_enabled`) and re-checks it on every Claude request.
 */
import React from 'react';
import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import type { PublicLinkAppearanceConfig } from '@/types/api';

type McpAccess = NonNullable<PublicLinkAppearanceConfig['mcp_access']>;

export function ToggleRow({ checked, onChange, title, hint, testId }: {
  checked: boolean; onChange: (next: boolean) => void; title: string; hint?: string; testId?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} data-testid={testId} data-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-4 py-3 text-left">
      <span className="min-w-0">
        <span className="block text-caption font-emphasis text-text-primary">{title}</span>
        {hint && <span className="mt-0.5 block text-tiny leading-5 text-text-tertiary">{hint}</span>}
      </span>
      <span className={cn('mt-0.5 inline-flex h-5 w-9 flex-shrink-0 rounded-full p-0.5 transition-colors',
        checked ? 'bg-brand' : 'bg-[rgb(var(--border-strong))]')}>
        <span className={cn('h-4 w-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
      </span>
    </button>
  );
}

export function PublicLinkClaudeAccess({ value, onChange }: {
  value: PublicLinkAppearanceConfig;
  onChange: (next: PublicLinkAppearanceConfig) => void;
}) {
  const { t } = useI18n();
  const cfg = value.mcp_access || {};
  const set = (patch: Partial<McpAccess>) => onChange({ ...value, mcp_access: { ...cfg, ...patch } });
  return (
    <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm" data-testid="link-claude-access">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand" aria-hidden="true" />
        <h3 className="text-small font-strong text-text-primary">{t('publicClaude.owner.sectionTitle')}</h3>
      </div>
      <div className="mt-1 divide-y divide-[rgb(var(--border-line))]">
        <ToggleRow checked={cfg.share_guide === true} onChange={(v) => set({ share_guide: v })} testId="link-claude-share-guide"
          title={t('publicClaude.owner.shareGuide')} hint={t('publicClaude.owner.shareGuideHint')} />
        <ToggleRow checked={cfg.keep_history !== false} onChange={(v) => set({ keep_history: v })} testId="link-claude-keep-history"
          title={t('publicClaude.owner.keepHistory')} hint={t('publicClaude.owner.keepHistoryHint')} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[rgb(var(--border-line))] pt-3">
        <button type="button" className="text-tiny font-emphasis text-danger hover:underline" data-testid="link-claude-disconnect-all"
          onClick={() => set({ epoch: (cfg.epoch || 0) + 1 })}>
          {t('publicClaude.owner.disconnectAll')}
        </button>
        {(cfg.epoch || 0) > 0 && <span className="text-tiny text-text-quaternary">{t('publicClaude.owner.saveToApply')}</span>}
      </div>
    </section>
  );
}
