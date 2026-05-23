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

const RLS_FILTER_VAR_OPTIONS: SelectOption[] = [
  { value: '{{app_user.username}}', label: 'Signed-in user - username (default)' },
  { value: '{{app_user.scope_usernames}}', label: 'Visible users - username scope' },
  { value: '{{app_user.direct_report_usernames}}', label: 'Direct reports - usernames' },
  { value: '{{app_user.scope_admin_usernames}}', label: 'Visible admins - username scope' },
  { value: '{{app_user.manager_username}}', label: 'Manager - username' },
  { value: '{{app_user.full_name}}', label: 'Signed-in user - full name' },
  { value: '{{app_user.role}}', label: 'Signed-in user - role' },
];

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
        <p className="font-emphasis text-text-primary">Role-based data access rules</p>
        <p className="mt-0.5">
          Mỗi rule gán cho một <em>role</em> (user / admin / …) quyền view /
          create / update / delete trên các dòng. Owner luôn thấy mọi dòng;
          admin/user chỉ thấy dòng khớp rule (trừ khi tick &quot;Unrestricted&quot;).
        </p>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Convention: bảng fact phải có cột{' '}
          <code className="font-mono">{MINIAPP_USER_COLUMN}</code> chứa username
          của app user sở hữu dòng. RLS mặc định lọc{' '}
          <code className="font-mono">{MINIAPP_USER_COLUMN}</code> ={' '}
          <code className="font-mono">{'{{app_user.username}}'}</code>, không
          cần builder chọn cột.
        </p>
      </div>

      {screen.table_id && (
        <AccessModeBanner
          mode={accessMode}
          hasMiniappUserColumn={hasMiniappUserColumn}
          entry={auditEntry}
        />
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
            No rules yet. Default: only Owner can see every row; Admin/User see
            nothing until you add a rule.
          </p>
        )}
      </div>

      <BuilderActionButton
        onClick={add}
        variant="brand"
        className="mt-3 w-full justify-center"
      >
        <Plus className="h-3.5 w-3.5" />
        Add rule
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
  // Build options without `owner` — owner is full-access and editing a rule
  // for it would be misleading.
  const roleOptions = buildAppUserRoleOptions([rule.role]).filter(
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
    <BuilderSubsection title="Rule" className="p-2.5">
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
        <BuilderIconButton onClick={onRemove} title="Delete rule" variant="danger">
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
        Unrestricted (see every row)
      </label>

      {!effectiveUnrestricted && (
        <>
          <Lbl label={`Match value (filter on column ${MINIAPP_USER_COLUMN})`}>
            <FixedExpressionInput
              value={rule.filter_value}
              onChange={(next) => onChange({ filter_value: next })}
              fixedPlaceholder="e.g. HN, branch-01, ..."
              expressionPlaceholder="e.g. {{app_user.username}}"
              expressionOptions={RLS_FILTER_VAR_OPTIONS}
            />
          </Lbl>
          {legacyColumnInUse && (
            <p className="mt-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-[11px] text-warning">
              Rule này đang dùng cột{' '}
              <code className="font-mono">{rule.filter_column}</code> (legacy).
              Hãy chuyển dữ liệu sang cột{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code> và bấm{' '}
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
                migrate sang miniapp_user
              </button>
              .
            </p>
          )}
          {rule.filter_value && !legacyColumnInUse ? (
            <p className="mt-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-[11px] text-text-secondary">
              Role <strong>{normalizedRole}</strong> chỉ thấy dòng có{' '}
              <code className="font-mono text-text-primary">
                {MINIAPP_USER_COLUMN}
              </code>{' '}
              khớp{' '}
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
          What can this role do with visible rows?
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
          <label className="flex items-center gap-1" title="Allow creating new rows">
            <input
              type="checkbox"
              checked={rule.can_create !== false}
              onChange={(e) => onChange({ can_create: e.target.checked })}
              className="h-3 w-3"
            />
            Create rows
          </label>
          <label className="flex items-center gap-1" title="Allow updating rows">
            <input
              type="checkbox"
              checked={rule.can_update !== false}
              onChange={(e) => onChange({ can_update: e.target.checked })}
              className="h-3 w-3"
            />
            Update rows
          </label>
          <label className="flex items-center gap-1" title="Allow deleting rows">
            <input
              type="checkbox"
              checked={!!rule.can_delete}
              onChange={(e) => onChange({ can_delete: e.target.checked })}
              className="h-3 w-3"
            />
            Delete rows
          </label>
        </div>
      </div>

      <div className="mt-2">
        <Lbl label="Readonly columns (this role cannot edit)">
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
            placeholder="Column names, comma-separated - e.g. id, created_at"
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
              Bảng nguồn chưa có cột{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code>
            </p>
            <p className="mt-0.5 text-text-secondary">
              Audit đang tải — nếu bảng này là dim/shared, banner sẽ tắt sau khi
              audit xong.
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
              Per-user — RLS tự lọc qua{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code>
            </p>
            <p className="mt-0.5 text-text-secondary">
              Builder không cần chọn cột lọc nữa. Bạn vẫn có thể tùy biến{' '}
              <em>Match value</em> để mở rộng scope (vd. theo manager).
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
              Bảng shared — không lọc theo user
            </p>
            <p className="mt-0.5">
              Bảng được đánh dấu là reference/dim. Mọi app user đều thấy
              toàn bộ dòng. Rule bạn thêm dưới đây vẫn áp dụng nếu muốn
              giới hạn theo role (vd. chỉ admin xem được).
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
              Quyền kế thừa qua quan hệ
            </p>
            <p className="mt-0.5 text-text-secondary">
              Bảng này không có{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code> nhưng
              nối với bảng fact qua model. Auto-RLS qua join chưa được engine
              hỗ trợ — tạm thời rule sẽ chỉ chạy khi bạn nhập SQL thủ công
              trong cột tùy biến phía dưới, hoặc cân nhắc thêm{' '}
              <code className="font-mono">{MINIAPP_USER_COLUMN}</code> để
              chuyển sang per-user.
            </p>
            {entry?.chain && entry.chain.length > 0 && (
              <p className="mt-1 text-text-tertiary">
                Chain:{' '}
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
            Bảng chưa rõ phân quyền theo user
          </p>
          <p className="mt-0.5 text-text-secondary">
            Bảng không có cột{' '}
            <code className="font-mono">{MINIAPP_USER_COLUMN}</code>, không có
            relationship đến bảng fact nào có cột đó, và chưa được tick
            shared. Mini-app sẽ trả 0 dòng cho non-owner. Vào tab{' '}
            <strong>App users</strong> hoặc <strong>Model</strong> để xử lý.
          </p>
        </div>
      </div>
    </div>
  );
}
