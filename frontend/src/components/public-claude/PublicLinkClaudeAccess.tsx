'use client';

/**
 * The publisher's switch for a link's Public Read MCP: viewers may connect their OWN Claude.
 * Off by default. Stored in the link's appearance (`mcp_access`); the server never serves
 * it to viewers (they learn only `mcp_enabled`) and re-checks it on every Claude request.
 */
import React from 'react';

import { useI18n } from '@/providers/LanguageProvider';
import type { PublicLinkAppearanceConfig } from '@/types/api';

export function PublicLinkClaudeAccess({ value, onChange }: {
  value: PublicLinkAppearanceConfig;
  onChange: (next: PublicLinkAppearanceConfig) => void;
}) {
  const { t } = useI18n();
  const cfg = value.mcp_access || {};
  const set = (patch: Partial<NonNullable<PublicLinkAppearanceConfig['mcp_access']>>) =>
    onChange({ ...value, mcp_access: { ...cfg, ...patch } });
  return (
    <div className="mb-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3" data-testid="link-claude-access">
      <label className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-0.5" checked={cfg.enabled === true} data-testid="link-claude-enabled"
          onChange={(e) => set({ enabled: e.target.checked })} />
        <span>
          <span className="block text-small font-emphasis text-text-primary">{t('publicClaude.owner.enable')}</span>
          <span className="block text-caption text-text-tertiary">{t('publicClaude.owner.enableHint')}</span>
        </span>
      </label>
      {cfg.enabled === true && (
        <div className="mt-3 space-y-2 pl-6">
          <label className="flex items-start gap-2.5">
            <input type="checkbox" className="mt-0.5" checked={cfg.share_guide === true} data-testid="link-claude-share-guide"
              onChange={(e) => set({ share_guide: e.target.checked })} />
            <span>
              <span className="block text-caption font-emphasis text-text-secondary">{t('publicClaude.owner.shareGuide')}</span>
              <span className="block text-caption text-text-tertiary">{t('publicClaude.owner.shareGuideHint')}</span>
            </span>
          </label>
          <button type="button" className="text-caption text-red-600 underline" data-testid="link-claude-disconnect-all"
            onClick={() => set({ epoch: (cfg.epoch || 0) + 1 })}>
            {t('publicClaude.owner.disconnectAll')}
          </button>
          {(cfg.epoch || 0) > 0 && <span className="ml-2 text-caption text-text-quaternary">{t('publicClaude.owner.saveToApply')}</span>}
        </div>
      )}
    </div>
  );
}
