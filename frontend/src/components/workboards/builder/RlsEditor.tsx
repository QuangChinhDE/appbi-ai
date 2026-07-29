/**
 * RlsEditor — per-screen, per-role row-level rules.
 *
 * Convention enforced here:
 *   - Every fact table must carry a fixed `miniapp_user` column whose value is
 *     the username of the row owner. RLS rules default to filtering on that
 *     column, so builders no longer pick `filter_column` for fact data.
 *   - "owner" never appears in the role dropdown — owners are full-access by
 *     definition (see backend roles.is_owner_role).
 *   - Admin scope still uses {{app_user.scope_usernames}} so one admin sees
 *     their branch; mark the rule unrestricted when a role should see every
 *     row.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Plus, Trash2 } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';
import { buildAppUserRoleOptions, normalizeAppUserRole } from './appUserRoles';
import {
  BuilderActionButton,
  BuilderIconButton,
  BuilderSubsection,
} from './BuilderChrome';
import { FixedExpressionInput, type SelectOption } from './BuilderValueControls';
import type { ScreenRlsRuleSpec, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';
import {
  type AccessAuditEntry,
  type AccessMode,
  workboardApi,
} from '@/lib/api/workboards';

const MINIAPP_USER_COLUMN = 'miniapp_user';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function rlsFilterVarOptions(t: Translate): SelectOption[] {
  return [
    { value: '{{app_user.username}}', label: t('workboards.rls.var.username') },
    { value: '{{app_user.scope_usernames}}', label: t('workboards.rls.var.scopeUsernames') },
    { value: '{{app_user.direct_report_usernames}}', label: t('workboards.rls.var.directReports') },
    { value: '{{app_user.scope_admin_usernames}}', label: t('workboards.rls.var.scopeAdmins') },
    { value: '{{app_user.manager_username}}', label: t('workboards.rls.var.manager') },
    { value: '{{app_user.full_name}}', label: t('workboards.rls.var.fullName') },
    { value: '{{app_user.role}}', label: t('workboards.rls.var.role') },
  ];
}

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

export default function RlsEditor({
  screen,
  tables,
  workboardId,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  workboardId?: number;
  onChange: (next: ScreenSpec) => void;
}) {
  const { t } = useI18n();
  const rules = screen.rls || [];
  const tableCols = tables.find((t) => t.id === screen.table_id)?.columns || [];
  const hasMiniappUserColumn = tableCols.some(
    (col) => col.name === MINIAPP_USER_COLUMN,
  );

  const [auditEntry, setAuditEntry] = useState<AccessAuditEntry | null>(null);

  useEffect(() => {
    if (!workboardId || !screen.table_id) {
      setAuditEntry(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const audit = await workboardApi.getAccessAudit(workboardId);
        if (cancelled) return;
        setAuditEntry(
          audit.tables.find((t) => t.table_id === screen.table_id) ?? null,
        );
      } catch {
        if (!cancelled) setAuditEntry(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workboardId, screen.table_id]);

  const accessMode: AccessMode | null = auditEntry?.mode ?? null;

  const update = (idx: number, patch: Partial<ScreenRlsRuleSpec>) => {
    const next = [...rules];
    next[idx] = { ...next[idx], ...patch };
    onChange({ ...screen, rls: next });
  };
  const add = () => {
    const fresh: ScreenRlsRuleSpec = {
      role: 'user',
      filter_column: MINIAPP_USER_COLUMN,
      filter_value: '{{app_user.username}}',
      can_create: true,
      can_update: true,
      can_delete: false,
    };
    onChange({ ...screen, rls: [...rules, fresh] });
  };
  const remove = (idx: number) =>
    onChange({ ...screen, rls: rules.filter((_, i) => i !== idx) });

  return (
    <div>
      <div className="mb-3 rounded-md border border-info/20 bg-info/5 p-2.5 text-caption text-text-secondary">
        <p className="font-emphasis text-text-primary">
          {t('workboards.rls.title')}
        </p>
        <p className="mt-0.5">
          {t('workboards.rls.description')}
        </p>
        <p className="mt-1 text-[11px] text-text-tertiary">
          {t('workboards.rls.conventionPrefix')}{' '}
          <code className="font-mono">{MINIAPP_USER_COLUMN}</code>{' '}
          {t('workboards.rls.conventionMiddle')}{' '}
          <code className="font-mono">{MINIAPP_USER_COLUMN}</code> ={' '}
          <code className="font-mono">{'{{app_user.username}}'}</code>
          {t('workboards.rls.conventionSuffix')}
        </p>
      </div>

      {screen.table_id && (
        <AccessModeBanner
          mode={accessMode}
          hasMiniappUserColumn={hasMiniappUserColumn}
          entry={auditEntry}
        />
      )}

      {rules.length === 0 &&
        !(screen as { rls_default?: unknown }).rls_default &&
        (screen.kind === 'form' || screen.kind === 'table') && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-caption">
            <p className="font-emphasis text-amber-900">
              {t('workboards.rls.noRuleWarningTitle')}
            </p>
            <p className="mt-0.5 text-amber-800">
              {t('workboards.rls.noRuleWarningPrefix')}{' '}
              <strong>{t('workboards.rls.zeroRows')}</strong>{' '}
              {t('workboards.rls.noRuleWarningMiddle')}{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code> ={' '}
              <code className="font-mono">{'{{app_user.username}}'}</code>).
            </p>
          </div>
        )}

      <div className="space-y-2">
        {rules.map((r, idx) => (
          <RuleCard
            key={idx}
            rule={r}
            onChange={(patch) => update(idx, patch)}
            onRemove={() => remove(idx)}
          />
        ))}
        {rules.length === 0 && (
          <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] p-3 text-center text-caption text-text-tertiary">
            {t('workboards.rls.empty')}
          </p>
        )}
      </div>

      <BuilderActionButton
        onClick={add}
        variant="brand"
        className="mt-3 w-full justify-center"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('workboards.rls.addRule')}
      </BuilderActionButton>
    </div>
  );
}

function RuleCard({
  rule,
  onChange,
  onRemove,
}: {
  rule: ScreenRlsRuleSpec;
  onChange: (patch: Partial<ScreenRlsRuleSpec>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  // Build options without `owner` — owner is full-access and editing a rule
  // for it would be misleading.
  const roleOptions = buildAppUserRoleOptions([rule.role], t).filter(
    (option) => option.value !== 'owner',
  );
  const normalizedRole = normalizeAppUserRole(rule.role) || 'user';
  const effectiveUnrestricted = !!rule.unrestricted;
  const legacyColumnInUse =
    !!rule.filter_column && rule.filter_column !== MINIAPP_USER_COLUMN;

  const handleRoleChange = (nextRole: string) => {
    onChange({ role: nextRole });
  };

  return (
    <BuilderSubsection title={t('workboards.rls.rule')} className="p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <select
          value={normalizedRole}
          onChange={(e) => handleRoleChange(e.target.value)}
          className={`${INPUT} flex-1`}
          style={{ fontWeight: 600 }}
        >
          {roleOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <BuilderIconButton onClick={onRemove} title={t('workboards.rls.deleteRule')} variant="danger">
          <Trash2 className="h-3.5 w-3.5 text-danger" />
        </BuilderIconButton>
      </div>

      <label className="mb-2 flex items-center gap-1.5 text-caption text-text-secondary">
        <input
          type="checkbox"
          checked={effectiveUnrestricted}
          onChange={(e) => onChange({ unrestricted: e.target.checked })}
          className="h-3 w-3"
        />
        {t('workboards.rls.unrestricted')}
      </label>

      {!effectiveUnrestricted && (
        <>
          <Lbl label={t('workboards.rls.matchValue', { column: MINIAPP_USER_COLUMN })}>
            <FixedExpressionInput
              value={rule.filter_value}
              onChange={(next) => onChange({ filter_value: next })}
              fixedPlaceholder={t('workboards.rls.fixedPlaceholder')}
              expressionPlaceholder={t('workboards.rls.expressionPlaceholder')}
              expressionOptions={rlsFilterVarOptions(t)}
            />
          </Lbl>
          {legacyColumnInUse && (
            <p className="mt-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-[11px] text-warning">
              {t('workboards.rls.legacyColumnPrefix')}{' '}
              <code className="font-mono">{rule.filter_column}</code> ({t('workboards.rls.legacy')}).
              {' '}{t('workboards.rls.legacyColumnMiddle')}{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code>{' '}
              {t('workboards.rls.legacyColumnActionPrefix')}{' '}
              <button
                type="button"
                onClick={() =>
                  onChange({
                    filter_column: MINIAPP_USER_COLUMN,
                    filter_value: '{{app_user.username}}',
                  })
                }
                className="font-emphasis underline hover:no-underline"
              >
                {t('workboards.rls.migrateToMiniappUser')}
              </button>
              .
            </p>
          )}
          {rule.filter_value && !legacyColumnInUse ? (
            <p className="mt-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-[11px] text-text-secondary">
              {t('workboards.rls.previewPrefix')} <strong>{normalizedRole}</strong>{' '}
              {t('workboards.rls.previewMiddle')}{' '}
              <code className="font-mono text-text-primary">
                {MINIAPP_USER_COLUMN}
              </code>{' '}
              {t('workboards.rls.previewMatches')}{' '}
              <code className="font-mono text-text-primary">
                {String(rule.filter_value)}
              </code>
              .
            </p>
          ) : null}
        </>
      )}

      <div className="mt-2">
        <div className="mb-1 text-[11px] font-emphasis text-text-tertiary">
          {t('workboards.rls.capabilitiesTitle')}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
          <label className="flex items-center gap-1" title={t('workboards.rls.allowCreateTitle')}>
            <input
              type="checkbox"
              checked={rule.can_create !== false}
              onChange={(e) => onChange({ can_create: e.target.checked })}
              className="h-3 w-3"
            />
            {t('workboards.rls.createRows')}
          </label>
          <label className="flex items-center gap-1" title={t('workboards.rls.allowUpdateTitle')}>
            <input
              type="checkbox"
              checked={rule.can_update !== false}
              onChange={(e) => onChange({ can_update: e.target.checked })}
              className="h-3 w-3"
            />
            {t('workboards.rls.updateRows')}
          </label>
          <label className="flex items-center gap-1" title={t('workboards.rls.allowDeleteTitle')}>
            <input
              type="checkbox"
              checked={!!rule.can_delete}
              onChange={(e) => onChange({ can_delete: e.target.checked })}
              className="h-3 w-3"
            />
            {t('workboards.rls.deleteRows')}
          </label>
        </div>
      </div>

      <div className="mt-2">
        <Lbl label={t('workboards.rls.readonlyColumns')}>
          <input
            value={(rule.readonly_columns || []).join(', ')}
            onChange={(e) =>
              onChange({
                readonly_columns: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className={INPUT}
            placeholder={t('workboards.rls.readonlyPlaceholder')}
          />
        </Lbl>
      </div>
    </BuilderSubsection>
  );
}

function AccessModeBanner({
  mode,
  hasMiniappUserColumn,
  entry,
}: {
  mode: AccessMode | null;
  hasMiniappUserColumn: boolean;
  entry: AccessAuditEntry | null;
}) {
  const { t } = useI18n();
  // Until the audit response arrives, fall back to the column check —
  // covers the "still loading" gap so the banner doesn't flicker.
  if (mode === null) {
    if (hasMiniappUserColumn) return null;
    return (
      <div className="mb-3 rounded-md border border-warning/30 bg-warning/5 p-2.5 text-caption text-warning">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-emphasis">
              {t('workboards.rls.audit.missingColumnTitle')}{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code>
            </p>
            <p className="mt-0.5 text-text-secondary">
              {t('workboards.rls.audit.loadingDescription')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'per_user') {
    return (
      <div className="mb-3 rounded-md border border-success/30 bg-success/5 p-2.5 text-caption text-success">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-emphasis">
              {t('workboards.rls.audit.perUserTitle')}{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code>
            </p>
            <p className="mt-0.5 text-text-secondary">
              {t('workboards.rls.audit.perUserDescriptionPrefix')}{' '}
              <em>{t('workboards.rls.matchValueShort')}</em>{' '}
              {t('workboards.rls.audit.perUserDescriptionSuffix')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'shared') {
    return (
      <div className="mb-3 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2.5 text-caption text-text-secondary">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <div>
            <p className="font-emphasis text-text-primary">
              {t('workboards.rls.audit.sharedTitle')}
            </p>
            <p className="mt-0.5">
              {t('workboards.rls.audit.sharedDescription')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'joined_through') {
    return (
      <div className="mb-3 rounded-md border border-info/30 bg-info/5 p-2.5 text-caption text-info">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-emphasis">
              {t('workboards.rls.audit.joinedTitle')}
            </p>
            <p className="mt-0.5 text-text-secondary">
              {t('workboards.rls.audit.joinedDescriptionPrefix')}{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code>{' '}
              {t('workboards.rls.audit.joinedDescriptionMiddle')}{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code>{' '}
              {t('workboards.rls.audit.joinedDescriptionSuffix')}
            </p>
            {entry?.chain && entry.chain.length > 0 && (
              <p className="mt-1 text-text-tertiary">
                {t('workboards.rls.audit.chain')}:{' '}
                {entry.chain.map((hop, idx) => (
                  <span key={idx}>
                    {idx > 0 ? ' → ' : ''}
                    <code className="rounded bg-surface-2 px-1">
                      {hop.from_view}.{hop.from_columns.join('+')}
                    </code>{' '}
                    ={' '}
                    <code className="rounded bg-surface-2 px-1">
                      {hop.to_view}.{hop.to_columns.join('+')}
                    </code>
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // mode === 'unknown'
  return (
    <div className="mb-3 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-caption text-danger">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-emphasis">
            {t('workboards.rls.audit.unknownTitle')}
          </p>
          <p className="mt-0.5 text-text-secondary">
            {t('workboards.rls.audit.unknownDescriptionPrefix')}{' '}
            <code className="font-mono">{MINIAPP_USER_COLUMN}</code>
            {t('workboards.rls.audit.unknownDescriptionSuffix')}{' '}
            <strong>{t('workboards.users.title')}</strong> {t('workboards.rls.audit.or')}{' '}
            <strong>Model</strong> {t('workboards.rls.audit.toFix')}.
          </p>
        </div>
      </div>
    </div>
  );
}
